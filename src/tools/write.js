/**
 * `memory_write`（设计 §7.1）。
 *
 * 职责边界：本文件负责**参数契约与判定**（形状校验、逐条机械校验、重复／相似／冲突／敏感），
 * 以及把结果整理成模型看得懂的三段式文本；落盘一律交给 `deps.applyBatch`（唯一写入入口，§12.1）。
 *
 * 关键行为：
 *  - 整批校验，**任何一条失败则整批不写入**，并按 entry 序号逐条给原因（§7.1 最后两条）；
 *  - `status` 只接受 `active`／`candidate`；`expiresAt` 早于今天一律拒绝（原话照搬设计）；
 *  - `supersedes` 只接受存在且未归档的编号；指向已 superseded 的条目要拒绝并返回它现有的 `取代者`；
 *  - 机械冲突 → 不写入该条，给出冲突列表与"重发并带 supersedes"的下一步；
 *    冲突判定排除本批 `supersedes` 指向的编号（§7.1 的 R1.4 排除规则）；
 *  - 高度相似只提示不拒绝（§8.3）。
 */

import { CONFIDENCES, KIND_LABEL, KINDS, LABEL_KIND, PRIORITIES } from '../parse.js';
import {
  EXPIRES_TEXT,
  asRecord,
  asStringList,
  boundarySectionText,
  canonicalId,
  checkCall,
  defineMemoryTool,
  failureText,
  failResult,
  joinSections,
  modulesOf,
  normalizeDetail,
  nowOf,
  okResult,
  storeWarningsSection,
  takeBoundaryWarnings,
  throwParamError,
  todayOf,
  unknownKeys,
  warningsSection,
  workspaceOf,
} from './shared.js';

const TOOL = 'memory_write';

/** 一条 entry 允许出现的键（**不含** `pinned`／`scope`／`置顶`，§7.1／§14.19）。 */
const ENTRY_KEYS = [
  'kind',
  'title',
  'detail',
  'priority',
  'confidence',
  'status',
  'tags',
  'aliases',
  'source',
  'relatedJournal',
  'relatedMemory',
  'supersedes',
  'expiresAt',
];

/** 设计 §7.1 指定的原话（模型看到它才知道该怎么改；与 shared.js 的同名常量同源）。 */
const EXPIRES_REASON = EXPIRES_TEXT;

const DESCRIPTION = [
  '写入可复用的长期记忆（约定／事实／流程／经验四类）。一次调用完成"新增"以及（可选）"取代旧条"。',
  '什么时候用：用户明确要求记住某条约定、或你已验证出一个可复用的结论/踩坑经验时。',
  '什么时候不要用：只想记录过程与尝试 → 用 memory_log；只想修正既有条目措辞 → 用 memory_edit。',
  '写作要求：title 必须是一条能独立看懂的完整陈述（不要关键词堆、不要正文截断），长解释放 detail。',
  '禁止：不要写入密钥、Token、Cookie、私钥、口令、含账号口令的 URL、身份证号、完整手机号、银行卡号；命中会被整批拒绝。',
  '禁止：不要用 write/pwsh 等通用工具直接改 memory/ 下的文件，也不要试图写「置顶」——本工具不接受这些字段。',
  '替代旧结论：一次调用带上 supersedes:["#0011"] 即可原子完成"新增 + 取代"，不要分两步。',
].join('\n');

const PARAMETERS = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      minItems: 1,
      description: '要写入的长期记忆条目。整批校验：一条不通过则整批不写入。',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...KINDS], description: '必填：convention 约定／fact 事实／procedure 流程／lesson 经验' },
          title: { type: 'string', description: '必填：单行、非空、≤160 字符的完整陈述（建议 ≤60）' },
          detail: { type: 'string', description: '原因、边界、例外、验证结果（≤8000 字符）。注意：**不能包含空行**，也**不要用 `- `／`* ` 项目符号分行**——两者都会让后半段被解析成条目字段或"无法归类的行"、落盘后工具无法清理且逐代累积；需要分段请用中文分号／句号写在同一段里' },
          priority: { type: 'string', enum: [...PRIORITIES], description: '通常不必填，缺省按类型推导' },
          confidence: { type: 'string', enum: [...CONFIDENCES], description: '缺省 observed' },
          status: { type: 'string', enum: ['active', 'candidate'], description: '缺省 active；未验证的结论必须显式写 candidate' },
          tags: { type: 'array', items: { type: 'string' }, description: '主题标签（逗号分隔的字符串也可）' },
          aliases: { type: 'array', items: { type: 'string' }, description: '检索别名' },
          source: { type: 'string', description: '来源：用户确认／实测／文档／日志' },
          relatedJournal: { type: 'array', items: { type: 'string' }, description: '关联日志编号，如 J-20260920-1432' },
          relatedMemory: { type: 'array', items: { type: 'string' }, description: '关联记忆编号，如 #0007（必须已存在）' },
          supersedes: { type: 'array', items: { type: 'string' }, description: '被本条取代的编号（必须已存在、未归档）' },
          expiresAt: { type: ['string', 'null'], description: '有效至 YYYY-MM-DD；不填或 null = 永久；早于今天会被拒绝' },
        },
        required: ['kind', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['entries'],
  additionalProperties: false,
};

/**
 * 命中类别 → 中文（返回文本里用中文，括号里保留英文码便于对齐设计文档）。
 *
 * @param {any} sensitive
 * @param {Array<{ field: string, category: string }>} hits
 * @returns {string}
 */
function describeSensitive(sensitive, hits) {
  return typeof sensitive.describeHits === 'function'
    ? sensitive.describeHits(hits)
    : hits.map((hit) => `${hit.field}（${hit.category}）`).join('、');
}

/**
 * 一条 entry 的机械校验 + 判定；不改动任何状态。
 *
 * @param {unknown} raw
 * @param {number} index
 * @param {{ deps: any, parse: any, dedup: any, sensitive: any, today: string, known: any[], claimed: Map<string, number>, similar: Array<{ id: string, reason: string }> }} ctx
 * @returns {{ ok: true, entry: Record<string, unknown>, candidate: any, similar: Array<{ id: string, reason: string }> } | { ok: false, failures: Array<{ entryIndex: number, code: string, message: string, nextStep?: string }>, similar: Array<{ id: string, reason: string }> }}
 */
function planEntry(raw, index, ctx) {
  const { deps, parse, dedup, sensitive, today, known, claimed } = ctx;
  const config = deps.config ?? {};
  const maxTitleChars = typeof config.maxTitleChars === 'number' ? config.maxTitleChars : 160;
  const detailMaxChars = typeof config.detailMaxChars === 'number' ? config.detailMaxChars : 8000;

  /** @type {Array<{ entryIndex: number, code: string, message: string, nextStep?: string }>} */
  const failures = [];
  /** @param {string} code @param {string} message @param {string} nextStep */
  const fail = (code, message, nextStep) => {
    failures.push({ entryIndex: index, code, message, nextStep });
  };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('invalid_param', `entry 必须是对象（收到 ${Array.isArray(raw) ? 'array' : typeof raw}）`, '按 schema 给出条目对象');
    return { ok: false, failures, similar: [] };
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  const extraKeys = unknownKeys(input, ENTRY_KEYS);
  if (extraKeys.length > 0) {
    fail('invalid_param', `不接受的字段：${extraKeys.join('、')}（本工具不接受 置顶／pinned／scope 之类字段）`, '删掉这些字段后重试');
  }

  // ── kind ──
  const kindRaw = input.kind;
  const kind = typeof kindRaw === 'string' ? (/** @type {Record<string, string>} */ (LABEL_KIND)[kindRaw] ?? kindRaw) : '';
  if (kind === '' || !KINDS.includes(/** @type {any} */ (kind))) {
    fail('invalid_param', `kind 非法：${String(kindRaw)}；合法值 ${KINDS.join(' / ')}`, '用四类之一，且必须显式给出');
  }

  // ── title（§7.1 机械校验：单行、非空、≤ maxTitleChars；违反即 invalid_param）──
  const titleRaw = input.title;
  let title = '';
  if (typeof titleRaw !== 'string' || titleRaw.trim().length === 0) {
    fail('invalid_param', `title 必填且不能为空（收到 ${titleRaw === undefined ? 'undefined' : JSON.stringify(titleRaw)}）`, '给出一条能独立看懂的短陈述');
  } else {
    title = titleRaw.trim();
    if (title.includes('\n') || title.includes('\r')) {
      fail('invalid_param', 'title 必须是单行（不含换行符）', '把长解释放进 detail');
    } else if ([...title].length > maxTitleChars) {
      fail('invalid_param', `title 长度 ${[...title].length} 超过上限 ${maxTitleChars} 个字符`, '精简标题（建议 ≤60 字），把细节放进 detail');
    }
  }

  // ── detail ──
  let detail = '';
  if (input.detail !== undefined && input.detail !== null) {
    if (typeof input.detail !== 'string') {
      fail('invalid_param', 'detail 必须是字符串', '去掉该字段或用字符串');
    } else {
      // 空行会终止条目（§5.5 第 5 条）：落盘后再解析时后半段会变成孤儿行／未知字段，
      // 而且**每次编辑都会累积一批残留**（真实宿主冒烟发现的缺陷）。因此工具侧直接拒绝。
      detail = normalizeDetail(input.detail, (reason, nextStep) => fail('invalid_param', reason, nextStep));
      if ([...detail].length > detailMaxChars) {
        fail('too_long', `detail 长度 ${[...detail].length} 超过上限 ${detailMaxChars}`, '拆成多条或精简详细');
      }
    }
  }

  // ── status（只接受 active／candidate）──
  let status = 'active';
  if (input.status !== undefined && input.status !== null) {
    if (input.status !== 'active' && input.status !== 'candidate') {
      fail('invalid_param', `status 非法：${String(input.status)}；只接受 active / candidate`, '未验证的结论请显式写 candidate');
    } else {
      status = input.status;
    }
  }

  // ── priority / confidence ──
  let priority = typeof type_defaultPriority(parse, kind) === 'string' ? type_defaultPriority(parse, kind) : 'medium';
  if (input.priority !== undefined && input.priority !== null) {
    if (typeof input.priority !== 'string' || !PRIORITIES.includes(/** @type {any} */ (input.priority))) {
      fail('invalid_param', `priority 非法：${String(input.priority)}；合法值 ${PRIORITIES.join(' / ')}`, '省略该字段即按类型推导');
    } else {
      priority = input.priority;
    }
  }
  let confidence = 'observed';
  if (input.confidence !== undefined && input.confidence !== null) {
    if (typeof input.confidence !== 'string' || !CONFIDENCES.includes(/** @type {any} */ (input.confidence))) {
      fail('invalid_param', `confidence 非法：${String(input.confidence)}；合法值 ${CONFIDENCES.join(' / ')}`, '省略该字段即按 observed 处理');
    } else {
      confidence = input.confidence;
    }
  }

  // ── expiresAt（早于今天一律拒绝，§7.1）──
  /** @type {string|null} */
  let expiresAt = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const value = input.expiresAt;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fail('invalid_param', `expiresAt 必须是 YYYY-MM-DD 或不填（收到 ${String(value)}）`, '不填或 null 表示永久');
    } else if (value < today) {
      fail('invalid_param', EXPIRES_REASON, '改成今天或之后，或留空表示永久');
    } else {
      expiresAt = value;
    }
  }

  // ── 列表字段 ──
  /** @param {string} key @returns {string[]} */
  const listOf = (key) => {
    const list = asStringList(input[key]);
    if (list === null) {
      fail('invalid_param', `${key} 必须是字符串数组`, '给出字符串数组，或省略该字段');
      return [];
    }
    return list;
  };

  const tags = listOf('tags');
  const aliases = listOf('aliases');
  const relatedJournal = listOf('relatedJournal');

  /** @type {string[]} */
  let related = [];
  for (const rawId of listOf('relatedMemory')) {
    const id = canonicalId(rawId);
    if (id === null) {
      fail('invalid_param', `relatedMemory 里的编号非法：${rawId}`, '请用形如 #0007 的编号');
      continue;
    }
    if (!known.some((entry) => entry?.id === id)) {
      fail('not_found', `relatedMemory 指向的编号 ${id} 不存在`, '用 memory_search 确认编号');
      continue;
    }
    related.push(id);
  }

  /** @type {string[]} */
  const supersedes = [];
  for (const rawId of listOf('supersedes')) {
    const id = canonicalId(rawId);
    if (id === null) {
      fail('invalid_param', `supersedes 里的编号非法：${rawId}`, '请用形如 #0011 的编号');
      continue;
    }
    const target = known.find((entry) => entry?.id === id && !isArchivedEntry(entry));
    if (target === undefined) {
      fail('not_found', `supersedes 指向的编号 ${id} 不存在或已归档`, 'supersedes 只接受存在且未被归档的编号');
      continue;
    }
    if (target.status === 'superseded') {
      const next = typeof target.supersededBy === 'string' && target.supersededBy.length > 0 ? target.supersededBy : '最新的那条';
      fail(
        'conflict',
        `${id} 已被 ${String(target.supersededBy ?? '(未知)')} 取代，不能再被取代`,
        `请改为指向 ${next}，避免把取代链压平`,
      );
      continue;
    }
    if (claimed.has(id)) {
      fail('conflict', `同一批里有两条新条目都要取代 ${id}`, '让一条新条目取代它，或拆成两次调用');
      continue;
    }
    claimed.set(id, index);
    supersedes.push(id);
  }

  // ── 敏感信息（§7.6：拒绝整批、不回显原文、附误伤提示）──
  const hits = sensitive.scanEntryTexts({ title, detail, tags, aliases });
  if (Array.isArray(hits) && hits.length > 0) {
    fail(
      'sensitive',
      `命中敏感信息：${describeSensitive(sensitive, hits)}；不回显命中原文。${sensitive.SENSITIVE_HINT ?? ''}`,
      '改写为不含具体值的说明性文字后重试',
    );
  }

  // ── 重复 / 相似 / 冲突（§8.3）──
  const candidate = { kind, title, tags, aliases };
  if (title.length > 0 && KINDS.includes(/** @type {any} */ (kind))) {
    const duplicate = dedup.findDuplicate(title, known, { today });
    if (duplicate !== null && duplicate !== undefined) {
      const other = known.find((entry) => entry?.id === duplicate.id);
      const archived = other !== undefined && isArchivedEntry(other);
      const note = duplicate.id.startsWith('#') ? '' : '（同批中另一条新记忆）';
      fail(
        'duplicate',
        `标题规范化后与 ${duplicate.id}${note} 完全相同${archived ? '（该条已归档；如需复用，可直接 restore 它）' : ''}`,
        duplicate.id.startsWith('#') ? `改用 memory_edit 补充 ${duplicate.id}，或改写标题` : '改写标题，或只保留一条',
      );
    }

    const similar = dedup.findSimilar(title, known, { today });
    for (const hit of Array.isArray(similar) ? similar : []) {
      ctx.similar.push({ id: hit.id, reason: hit.reason });
    }

    const conflicts = dedup.findConflicts(candidate, known, { today, excludeIds: supersedes });
    if (Array.isArray(conflicts) && conflicts.length > 0) {
      const list = conflicts.map((item) => `${item.id}（${item.reason}）`).join('、');
      const ids = conflicts.map((item) => item.id).filter((id) => /^#\d{4}$/.test(id));
      const advice =
        ids.length > 0
          ? `如需替换，请重发一次并带 supersedes:[${ids.map((id) => `"${id}"`).join(', ')}]`
          : '先改写新条目的数值，或先处理冲突的那一条';
      fail('conflict', `与已有记忆冲突：${list}`, advice);
    }
  }

  if (failures.length > 0) return { ok: false, failures, similar: [] };

  return {
    ok: true,
    entry: {
      kind,
      title,
      detail,
      priority,
      confidence,
      status,
      tags,
      aliases,
      source: typeof input.source === 'string' ? input.source : '',
      relatedJournal,
      relatedMemory: related,
      supersedes,
      expiresAt,
    },
    candidate,
    similar: [],
  };
}

/**
 * 类型默认优先级（`deps.parse` 缺 `defaultPriority` 时按 §5.3 的固定表兜底）。
 *
 * @param {any} parse
 * @param {string} kind
 * @returns {string}
 */
function type_defaultPriority(parse, kind) {
  if (typeof parse?.defaultPriority === 'function') return parse.defaultPriority(kind);
  return kind === 'convention' ? 'high' : 'medium';
}

/**
 * @param {any} entry
 * @returns {boolean}
 */
function isArchivedEntry(entry) {
  return entry?.status === 'archived' || (typeof entry?.archivedAt === 'string' && entry.archivedAt.length > 0);
}

/**
 * 冲突失败时的下一步：把 store 的通用措辞换成带具体编号的版本（§7.1 的返回示例）。
 *
 * @param {any} error
 * @returns {any}
 */
function withConflictIds(error) {
  if (error?.code !== 'conflict') return error;
  const ids = [...String(error.message ?? '').matchAll(/#\d{4}/g)].map((match) => match[0]);
  const unique = [...new Set(ids)];
  if (unique.length === 0) return error;
  return { ...error, nextStep: `如需替换，请重发一次并带 supersedes:[${unique.map((id) => `"${id}"`).join(', ')}]` };
}

/**
 * 成功返回文本。
 *
 * @param {Record<string, unknown>[]} prepared
 * @param {any} result
 * @param {Array<{ id: string, reason: string }>} similar
 * @returns {string}
 */
function successText(prepared, result, similar) {
  /** @type {string[]} */
  const assigned = Array.isArray(result?.assignedIds) ? result.assignedIds : [];
  /** @type {unknown[]} */
  const rawPaths = Array.isArray(result?.paths) ? result.paths : [];
  const paths = [...new Set(rawPaths.map((item) => basenameOf(item)))];
  /** @type {string[]} */
  const lines = [
    '[memory_write 完成]',
    `做了什么：整批校验通过，写入 ${assigned.length} 条长期记忆${paths.length > 0 ? `（文件：${paths.join('、')}）` : ''}。`,
    '结果：',
  ];

  for (let index = 0; index < prepared.length; index += 1) {
    const entry = prepared[index];
    const id = assigned[index] ?? '(未分配)';
    const kindLabel = /** @type {Record<string, string>} */ (KIND_LABEL)[String(entry.kind)] ?? String(entry.kind);
    lines.push(
      `- ${id} · ${kindLabel} · ${String(entry.title)}（状态：${String(entry.status)} · 置信度：${String(entry.confidence)} · 优先级：${String(entry.priority)}）`,
    );
    const supersedes = Array.isArray(entry.supersedes) ? entry.supersedes : [];
    if (supersedes.length > 0) lines.push(`  已取代 ${supersedes.join('、')}：它们已标为 superseded，正文保留、退出注入与默认搜索。`);
  }

  if (similar.length > 0) {
    lines.push('相似提示（未自动覆盖，请自行判断是否需要改写或另写）：');
    for (const hit of similar) lines.push(`- ${hit.id}（${hit.reason}）`);
  }

  const first = assigned[0];
  lines.push(
    typeof first === 'string'
      ? `下一步建议：本会话已注入的快照不会刷新；需要查看新值请用 memory_search(ids:["${first}"], detail:"full")。`
      : '下一步建议：本会话已注入的快照不会刷新；需要查看新值请用 memory_search 查询。',
  );
  return lines.join('\n');
}

/**
 * @param {unknown} filePath
 * @returns {string}
 */
function basenameOf(filePath) {
  const text = String(filePath ?? '');
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1] ?? text;
}

/**
 * 五工具之一：`memory_write`。
 *
 * @param {any} deps INTERFACES §3.12 的冻结形状
 * @returns {any} ToolDefinition
 */
export function createWriteTool(deps) {
  return defineMemoryTool({
    name: TOOL,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(rawArgs, exec) {
      const sessionId = checkCall(deps, exec, TOOL);
      const { dedup, sensitive, errors } = modulesOf(deps);
      const args = asRecord(rawArgs, TOOL);

      const extra = unknownKeys(args, ['entries']);
      if (extra.length > 0) throwParamError(TOOL, `不接受的参数：${extra.join('、')}；本工具只接受 entries`, '去掉多余参数后重试');

      const rawEntries = args.entries;
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
        throwParamError(TOOL, 'entries 必须是非空数组', '至少给出一条要写入的记忆');
      }

      const today = todayOf(deps);
      const boundary = takeBoundaryWarnings(deps, sessionId);
      const model = await deps.loadProject({ workspace: workspaceOf(exec), config: deps.config });

      /** @type {any[]} */
      const known = Array.isArray(model?.entries) ? [...model.entries] : [];
      /** @type {Map<string, number>} */
      const claimed = new Map();
      /** @type {Array<{ entryIndex: number, code: string, message: string, nextStep?: string }>} */
      const failures = [];
      /** @type {Array<Record<string, unknown>>} */
      const prepared = [];
      /** @type {Array<{ id: string, reason: string }>} */
      const similar = [];

      for (let index = 0; index < rawEntries.length; index += 1) {
        const planned = planEntry(rawEntries[index], index, {
          deps,
          parse: modulesOf(deps).parse,
          dedup,
          sensitive,
          today,
          known,
          claimed,
          similar,
        });
        if (planned.ok === false) {
          failures.push(...planned.failures);
          continue;
        }
        prepared.push(planned.entry);
        similar.push(...planned.similar);
        // 同批内的后一条要能看到前一条（与 store 的 known 口径一致）
        known.push({ id: null, ...planned.entry });
      }

      if (failures.length > 0) {
        const text = failureText({
          toolName: TOOL,
          action: `校验了 ${rawEntries.length} 条记忆，其中 ${failures.length} 处不通过，按"整批全成或全败"没有写入任何一条。`,
          failures,
          nextStep: '按上面每条的原因修正后重发整批；本次一条都没有写入，记忆文件未被改动。',
        });
        return failResult(joinSections(text, [boundarySectionText(boundary)]), boundary);
      }

      const result = await deps.applyBatch(
        model,
        [{ type: 'write', entries: prepared }],
        {
          config: deps.config,
          today,
          now: nowOf(deps),
          validators: {
            findDuplicate: dedup.findDuplicate,
            findSimilar: dedup.findSimilar,
            findConflicts: dedup.findConflicts,
            scanEntryTexts: sensitive.scanEntryTexts,
          },
        },
      );

      if (result?.ok !== true) {
        const failure = withConflictIds({
          ok: false,
          code: typeof result?.code === 'string' ? result.code : 'degraded',
          message: typeof result?.message === 'string' ? result.message : '写入未完成',
          nextStep: typeof result?.nextStep === 'string' ? result.nextStep : '稍后重试',
          entryIndex: Number.isInteger(result?.entryIndex) ? result.entryIndex : undefined,
          action: '整批写入在落盘阶段失败，已回滚／未改动记忆文件。',
        });
        const text = errors.errorToText(failure, { title: `[${TOOL} 未执行]` });
        const boundaryText = boundarySectionText(boundary);
        return failResult(
          joinSections(text, [storeWarningsSection(result?.warnings), boundaryText]),
          [...boundary],
        );
      }

      const text = successText(prepared, result.result, similar);
      return okResult(joinSections(text, [storeWarningsSection(result.warnings), boundarySectionText(boundary)]), boundary);
    },
  });
}
