/**
 * `.state/` 机器状态的读写：编号水位线（`.state/ids`）与读取统计（`.state/usage.json`）。
 *
 * 设计依据：§2.3（目录结构）、§6.1（水位线两处存放）、§12.3 降级表
 * （`.state/ids` 丢失 → 扫描重建；`usage.json` 损坏 → 清空 usage，不影响搜索与注入）、
 * §9.4（`usage` 只参与搜索排序，不参与注入排序）。
 *
 * 纪律：
 *  1. 两处状态都走**原子写**（`memory-files.writeAtomic`），落盘顺序固定为
 *     `usage.json` → `.state/ids`（§12.1：`.state/ids` 最后写）；
 *  2. 任何损坏都只降级、不抛错：`ids` 取 `null`（由 store 按 §6.1 扫描重建），
 *     `usage` 清空（**不影响任何操作**）；
 *  3. 只依赖 `node:` 内置模块。
 */

import path from 'node:path';
import { readText, writeAtomic, mkdirp } from './memory-files.js';
import { formatId, parseId } from './ids.js';

/** 机器状态目录（相对 `memoryDir`）。 */
export const STATE_DIR = '.state';

/** 编号水位线文件（相对 `memoryDir`）。 */
export const IDS_FILE = '.state/ids';

/** 读取统计文件（相对 `memoryDir`）。 */
export const USAGE_FILE = '.state/usage.json';

/**
 * @typedef {object} Warning
 * @property {string} code
 * @property {string} message
 * @property {string} [filePath]
 */

/**
 * @typedef {object} UsageEntry
 * @property {number} count 正文读取次数
 * @property {string} lastUsedAt 最后一次读取时间（调用方传入的 ISO 字符串）
 */

/**
 * @typedef {object} LoadedState
 * @property {number|null} ids 水位线；缺失/损坏为 `null`（调用方按 §6.1 重建）
 * @property {Record<string, UsageEntry>} usage 读取统计；损坏即清空
 * @property {Warning[]} warnings
 */

/**
 * 读取 `.state/` 状态。
 *
 * 绝不抛错：`.state` 不存在（首次使用）、是普通文件、内容损坏，都按降级返回
 * 并给出告警，让会话与工具继续走下去（§12.3）。
 *
 * @param {string} memoryDir 记忆目录绝对路径
 * @returns {Promise<LoadedState>}
 */
export async function loadState(memoryDir) {
  /** @type {Warning[]} */
  const warnings = [];

  const idsPath = path.join(memoryDir, IDS_FILE);
  const idsRaw = await readText(idsPath);
  /** @type {number|null} */
  let ids = null;
  if (idsRaw.error !== undefined) {
    warnings.push({
      code: 'watermark-rebuilt',
      message: `读取编号水位线失败（${idsRaw.error}），已按缺失处理，将由扫描活动与归档编号重建`,
      filePath: idsPath,
    });
  } else if (idsRaw.content.trim() !== '') {
    const parsed = parseId(idsRaw.content.trim());
    if (parsed === null) {
      warnings.push({
        code: 'watermark-rebuilt',
        message: '编号水位线内容非法，已按缺失处理，将由扫描活动与归档编号重建',
        filePath: idsPath,
      });
    } else {
      ids = parsed;
    }
  }

  const usagePath = path.join(memoryDir, USAGE_FILE);
  const usageRaw = await readText(usagePath);
  /** @type {Record<string, UsageEntry>} */
  let usage = {};
  if (usageRaw.error !== undefined) {
    warnings.push({
      code: 'usage-reset',
      message: `读取 usage 失败（${usageRaw.error}），已清空；不影响搜索与注入`,
      filePath: usagePath,
    });
  } else if (usageRaw.content.trim() !== '') {
    const parsedUsage = parseUsageFile(usageRaw.content);
    usage = parsedUsage.usage;
    if (parsedUsage.reset) {
      warnings.push({
        code: 'usage-reset',
        message: `usage.json 损坏或格式非法（丢弃 ${parsedUsage.dropped} 项），已清空无效部分；不影响搜索与注入`,
        filePath: usagePath,
      });
    }
  }

  return { ids, usage, warnings };
}

/**
 * 写入 `.state/` 状态（原子写）。
 *
 * 只写 `patch` 里明确给出的键：`ids` 为 `undefined` 或 `null` 表示"本次不动水位线"。
 * 落盘顺序：`usage.json` 先写，`.state/ids` **最后**写（§12.1 的固定顺序要求
 * 水位线是最后一个落盘的派生物）。
 *
 * @param {string} memoryDir 记忆目录绝对路径
 * @param {{ ids?: number|null, usage?: Record<string, UsageEntry> }} patch
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function saveState(memoryDir, patch = {}) {
  const ensured = await mkdirp(path.join(memoryDir, STATE_DIR));
  if (!ensured.ok) return { ok: false, error: `创建 .state 目录失败：${ensured.error}` };

  if (patch.usage !== undefined) {
    const usagePath = path.join(memoryDir, USAGE_FILE);
    const written = await writeAtomic(usagePath, `${JSON.stringify(patch.usage ?? {}, null, 2)}\n`);
    if (!written.ok) return { ok: false, error: written.error ?? written.code ?? '写入 usage 失败' };
  }

  if (patch.ids !== undefined && patch.ids !== null) {
    const idsPath = path.join(memoryDir, IDS_FILE);
    const value = Number.isFinite(patch.ids) ? Math.max(0, Math.trunc(patch.ids)) : null;
    if (value === null) return { ok: false, error: `水位线取值非法：${String(patch.ids)}` };
    const written = await writeAtomic(idsPath, `${String(value)}\n`);
    if (!written.ok) return { ok: false, error: written.error ?? written.code ?? '写入水位线失败' };
  }

  return { ok: true };
}

/**
 * 记一次正文读取（**纯函数，不落盘**）：返回新的 usage，不修改入参。
 *
 * 口径（§8.2、§7.0）：只有返回长期记忆正文才计入，因此只统计 `#NNNN` 形态的编号，
 * 日志编号（`J-...`）与其他非法值一律忽略；同一次调用里重复出现的同一编号只计一次。
 *
 * @param {Record<string, UsageEntry>|undefined|null} usage 现有统计
 * @param {string[]} ids 本次读取正文的长期记忆编号
 * @param {string} nowDateIso 本次读取时间（调用方给的时间字符串）
 * @returns {Record<string, UsageEntry>} 新的统计对象（新对象，入参不变）
 */
export function bumpUsage(usage, ids, nowDateIso) {
  /** @type {Record<string, UsageEntry>} */
  const next = {};
  const source = usage !== null && typeof usage === 'object' ? usage : {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = normalizeUsageEntry(value);
    if (normalized !== null) next[key] = normalized;
  }

  const stamp = typeof nowDateIso === 'string' ? nowDateIso : '';
  const touched = new Set();
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const value = parseId(typeof rawId === 'string' ? rawId : '');
    if (value === null) continue;
    const key = formatId(value);
    if (touched.has(key)) continue;
    touched.add(key);
    const previous = next[key];
    next[key] = { count: (previous === undefined ? 0 : previous.count) + 1, lastUsedAt: stamp };
  }
  return next;
}

/**
 * 解析 `usage.json`：整体非法即清空；单条非法只丢那一条（其余照常可用）。
 *
 * @param {string} content
 * @returns {{ usage: Record<string, UsageEntry>, reset: boolean, dropped: number }}
 */
function parseUsageFile(content) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { usage: {}, reset: true, dropped: 0 };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { usage: {}, reset: true, dropped: 0 };
  }

  /** @type {Record<string, UsageEntry>} */
  const usage = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (parsed))) {
    const normalized = normalizeUsageEntry(value);
    if (normalized === null) {
      dropped += 1;
      continue;
    }
    const normalizedKey = normalizeUsageKey(key);
    const existing = usage[normalizedKey];
    // 键归一后撞车（'#0007' 与 '0007'）：保留读取次数更多的那个。
    usage[normalizedKey] = existing !== undefined && existing.count > normalized.count ? existing : normalized;
  }
  return { usage, reset: dropped > 0, dropped };
}

/**
 * 校验并归一单条 usage 记录；结构非法返回 `null`（由调用方丢弃）。
 *
 * @param {unknown} value
 * @returns {UsageEntry|null}
 */
function normalizeUsageEntry(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const count = record.count;
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
  const lastUsedAt = typeof record.lastUsedAt === 'string' ? record.lastUsedAt : '';
  return { count: Math.trunc(count), lastUsedAt };
}

/**
 * 键归一：`'0007'` → `'#0007'`；其他形态原样保留。
 *
 * @param {string} key
 * @returns {string}
 */
function normalizeUsageKey(key) {
  const value = parseId(key);
  return value === null ? key : formatId(value);
}
