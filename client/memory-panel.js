/**
 * dsh-memory 的客户端半边：在对话窗视图标签条里、"轨迹"旁边新增「记忆」视图。
 *
 * 形态：**手写 classic script，不需要打包器**（与宿主半边同为「源码即产物」）。
 *   加载器格式取自官方/第三方双面包的既有产物（`dsh-context/lib/client.js` 头尾）：
 *     window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports; } })
 *   插件对象形状：`module.exports = { name, inject, apply }`（Cordis 插件）。
 *
 * 数据通路（只读）：`ctx.remote.workspaceFiles.list/read`，按 sessionId 作用域；
 *   宿主把 `memory/xxx.md` 这类**工作区相对路径**按会话 workspaceRoot 解析
 *   （依据：`@deepseek-ai/dsh-api-workspace-files` 的 `inspect/confine` 使用 `cwd: workspaceRoot`）。
 * 数据通路（写）：仅通过宿主命令 `/memory archive|restore`（见 `src/index.js`），
 *   复用 store 的锁/编号/索引，绝不在客户端拼文件写入。
 *
 * 解析规则**逐条对齐 `src/parse.js`**（真实解析器，优先级高于设计文档样例）：
 *   条目行 TITLE_RE、字段行 matchFieldLine、缩进深度 depthOf、H2 类型映射 LABEL_KIND、
 *   字段值归一化与缺省值（newEntry）、续行只对 `详细` 生效。
 *   `test/panel-model.test.js` 用同一条夹具跑两边解析器做交叉验证，防止此份移植漂移。
 */

(function () {
  'use strict';

  // ══════════════════════════ 常量（对齐 src/parse.js） ══════════════════════════

  /** 类型枚举。 */
  var KINDS = ['convention', 'fact', 'procedure', 'lesson'];

  /** 类型 → 中文分节名。 */
  var KIND_LABEL = { convention: '约定', fact: '事实', procedure: '流程', lesson: '经验' };

  /** 中文分节名 → 类型。 */
  var LABEL_KIND = { 约定: 'convention', 事实: 'fact', 流程: 'procedure', 经验: 'lesson' };

  /** 状态枚举。 */
  var STATUSES = ['active', 'candidate', 'superseded', 'archived'];

  /** 优先级枚举。 */
  var PRIORITIES = ['high', 'medium', 'low'];

  /** 置信度枚举。 */
  var CONFIDENCES = ['confirmed', 'observed', 'inferred', 'temporary'];

  /** 类型默认优先级（src/parse.js:113）。 */
  var KIND_DEFAULT_PRIORITY = { convention: 'high', fact: 'medium', procedure: 'medium', lesson: 'medium' };

  /** 内部键 → 中文字段名（src/parse.js:116）。 */
  var KEY_FIELD = {
    status: '状态',
    pinned: '置顶',
    priority: '优先级',
    confidence: '置信度',
    created: '创建',
    updated: '更新',
    expiresAt: '有效至',
    tags: '标签',
    aliases: '别名',
    related: '关联',
    supersedes: '取代',
    supersededBy: '取代者',
    relatedJournal: '关联日志',
    source: '来源',
    detail: '详细',
    archivedAt: '归档时间',
    archivedReason: '归档原因',
    archivedStatusBefore: '归档前状态',
  };

  /** 中文字段名 → 内部键。 */
  var FIELD_KEY = (function () {
    var out = {};
    for (var key in KEY_FIELD) {
      if (Object.prototype.hasOwnProperty.call(KEY_FIELD, key)) out[KEY_FIELD[key]] = key;
    }
    return out;
  })();

  /** 条目行正则（src/parse.js:150）：顶格的 `- [#0007] 陈述`。 */
  var TITLE_RE = /^([-*])\s+(?:\[#(\d{1,6})\]\s*)?(.*)$/;

  /** 日志分节标题（src/parse.js:153）。 */
  var JOURNAL_HEADING_RE = /^##\s+(J-\d{8}-\d{4}(?:-\d+)?)\s*(?:[·:：]\s*(.*))?$/;

  /** 记忆目录名（与 cordis.patch.yml 的默认 `memoryDirName` 一致）。 */
  var MEMORY_DIR = 'memory';

  /** 记忆文件名 / 日志文件名。 */
  var MEMORY_FILE_RE = /^M-\d{4}-\d{2}-\d{2}\.md$/;
  var JOURNAL_FILE_RE = /^JOURNAL-\d{4}-\d{2}-\d{2}\.md$/;

  /**
   * 翻页保险丝（**不是** `read` 的 `limit`）。
   *
   * 客户端**故意不发 `limit`**：页长由宿主的 `maxLines` 配置决定，而宿主对
   * `limit > maxLines` 直接抛 `gateway/bad-request`（`dsh-api-workspace-files/lib/index.js`）。
   * 若这里硬编码 400，某天有人把 `maxLines` 调到 400 以下，整个面板就会变成"读取失败"。
   * 官方客户端同样刻意不发 limit（`dsh-client-ui-sidebar-documentpreview/lib/client.js`：
   * "The page length is the Host's configured cap, so no limit travels"）。
   */
  var MAX_READ_PAGES = 200;

  /** 单次加载最多读取的文件数（防御异常目录）。 */
  var MAX_FILES = 200;

  // ══════════════════════════ 小工具（对齐 src/parse.js） ══════════════════════════

  /**
   * 拆行：统一 CRLF/LF，丢掉末尾空行。
   * @param {string} content
   * @returns {string[]}
   */
  function splitLines(content) {
    var lines = String(content === null || content === undefined ? '' : content).replace(/\r\n?/g, '\n').split('\n');
    while (lines.length > 0 && String(lines[lines.length - 1]).trim().length === 0) lines.pop();
    return lines;
  }

  /**
   * 缩进深度：Tab、全角空格、半角空格等价（src/parse.js:177）。
   * @param {string} prefix
   * @returns {number}
   */
  function depthOf(prefix) {
    return prefix.replace(/\t/g, '  ').replace(/\u3000/g, '  ').length;
  }

  /**
   * 字段行匹配：`<缩进>[- ]字段名：值`（中英文冒号均可）。
   * 必须显式吃掉可选的 `- `/`* ` 列表标记（src/parse.js:191 的注释里记着这个坑）。
   * @param {string} line
   * @returns {{prefix: string, name: string, value: string}|null}
   */
  function matchFieldLine(line) {
    var m = /^([ \t\u3000]*)(?:[-*][ \t\u3000]+)?([^ \t\u3000][^：:]*?)[ \t\u3000]*[：:][ \t\u3000]?([\s\S]*)$/.exec(line);
    if (m === null) return null;
    var prefix = m[1] || '';
    var name = (m[2] || '').trim();
    var value = m[3] || '';
    if (name.length === 0) return null;
    return { prefix: prefix, name: name, value: value };
  }

  /**
   * 逗号分隔列表 → 数组（中英文逗号、顿号都接受）。
   * @param {string} value
   * @returns {string[]}
   */
  function splitList(value) {
    return String(value === null || value === undefined ? '' : value)
      .split(/[,，、]/)
      .map(function (item) {
        return item.trim();
      })
      .filter(function (item) {
        return item.length > 0;
      });
  }

  /**
   * 从文件名推导归属日期。
   * @param {string} filePath
   * @returns {string|null}
   */
  function fileDateOf(filePath) {
    var parts = String(filePath === null || filePath === undefined ? '' : filePath).replace(/\\/g, '/').split('/');
    var base = parts[parts.length - 1] || '';
    var m = /^(?:M|JOURNAL)-(\d{4})-(\d{2})-(\d{2})\.md$/.exec(base);
    return m === null ? null : m[1] + '-' + m[2] + '-' + m[3];
  }

  /**
   * 本机本地日期（不用 UTC）。
   * @returns {string}
   */
  function todayLocal() {
    var now = new Date();
    var m = String(now.getMonth() + 1).padStart(2, '0');
    var d = String(now.getDate()).padStart(2, '0');
    return now.getFullYear() + '-' + m + '-' + d;
  }

  /**
   * 类型默认优先级。
   * @param {string} kind
   * @returns {string}
   */
  function defaultPriority(kind) {
    return KIND_DEFAULT_PRIORITY[kind] || 'medium';
  }

  /**
   * 类型 → 中文标签；未知类型给「未知」。
   * @param {string} kind
   * @returns {string}
   */
  function formatKind(kind) {
    return KIND_LABEL[kind] || '未知';
  }

  /**
   * 造一条带全部缺省值的条目（src/parse.js:580 的 newEntry）。
   * @param {{id: string|null, kind: string, title: string, filePath: string, fileDate: string, order: number}} input
   * @returns {object}
   */
  function newEntry(input) {
    return {
      id: input.id,
      kind: input.kind,
      title: input.title,
      detail: '',
      status: 'active',
      pinned: false,
      priority: defaultPriority(input.kind),
      confidence: 'observed',
      created: input.fileDate,
      updated: input.fileDate,
      expiresAt: '永久',
      tags: [],
      aliases: [],
      related: [],
      supersedes: [],
      supersededBy: null,
      relatedJournal: [],
      source: '',
      archivedAt: null,
      archivedReason: null,
      archivedStatusBefore: null,
      unknownFields: [],
      presentFields: [],
      orphanNotes: [],
      filePath: input.filePath,
      fileDate: input.fileDate,
      order: input.order,
      raw: '',
    };
  }

  /**
   * 一条警告。
   * @param {string} code
   * @param {string} message
   * @param {string} [filePath]
   * @param {string|null} [id]
   * @returns {{code: string, message: string, filePath?: string, id?: string}}
   */
  function warn(code, message, filePath, id) {
    var out = { code: code, message: message };
    if (filePath !== undefined) out.filePath = filePath;
    if (id !== undefined && id !== null) out.id = id;
    return out;
  }

  // ══════════════════════════ 解析（移植 src/parse.js） ══════════════════════════

  /**
   * 解析一个长期记忆文件。
   *
   * **绝不抛错**：异常收敛为 `damaged: true` + 一条 `parse-damaged` 警告。
   *
   * @param {string} content 文件全文
   * @param {string} filePath 文件名或路径（用于推导归属日期）
   * @returns {{entries: object[], warnings: object[], damaged: boolean, preamble: string[]}}
   */
  function parseMemoryFile(content, filePath) {
    /** @type {object[]} */
    var entries = [];
    /** @type {object[]} */
    var warnings = [];
    /** @type {string[]} */
    var preamble = [];
    var fileDate = fileDateOf(filePath) || todayLocal();

    try {
      var lines = splitLines(content);
      var current = null;
      var sectionKind = null;
      var sectionSeen = false;
      var titleDepth = 0;
      var lastFieldDepth = 0;
      var lastKnownField = null;
      var lastFieldName = null;
      var startIndex = 0;
      var orphanOwner = null;
      var blankOwner = null;
      var sawContentLine = false;

      var closeEntry = function (endIndex) {
        if (current !== null) {
          current.raw = lines.slice(startIndex, endIndex).join('\n');
          entries.push(current);
        }
        current = null;
        lastFieldName = null;
        lastKnownField = null;
      };

      var applyField = function (entry, name, value) {
        var key = FIELD_KEY[name];
        if (key === undefined) return;
        if (entry.presentFields.indexOf(name) !== -1) {
          warnings.push(warn('duplicate-field', '条目 ' + (entry.id || '(无编号)') + ' 的字段「' + name + '」出现多次，后一次胜出', filePath));
        }
        entry.presentFields.push(name);
        var text = value.trim();
        switch (key) {
          case 'status':
            if (STATUSES.indexOf(text) !== -1) entry.status = text;
            else warnings.push(warn('bad-value', '条目 ' + (entry.id || '(无编号)') + ' 的状态「' + text + '」非法，按 active 处理', filePath));
            break;
          case 'pinned':
            entry.pinned = text.toLowerCase() === 'true';
            break;
          case 'priority':
            if (PRIORITIES.indexOf(text) !== -1) entry.priority = text;
            else warnings.push(warn('bad-value', '优先级「' + text + '」非法，按类型默认值处理', filePath));
            break;
          case 'confidence':
            if (CONFIDENCES.indexOf(text) !== -1) entry.confidence = text;
            else warnings.push(warn('bad-value', '置信度「' + text + '」非法，按 observed 处理', filePath));
            break;
          case 'created':
            entry.created = text;
            break;
          case 'updated':
            entry.updated = text;
            break;
          case 'expiresAt':
            entry.expiresAt = text.length === 0 ? '永久' : text;
            break;
          case 'tags':
            entry.tags = splitList(text);
            break;
          case 'aliases':
            entry.aliases = splitList(text);
            break;
          case 'related':
            entry.related = splitList(text);
            break;
          case 'supersedes':
            entry.supersedes = splitList(text);
            break;
          case 'supersededBy':
            entry.supersededBy = text.length === 0 ? null : text;
            break;
          case 'relatedJournal':
            entry.relatedJournal = splitList(text);
            break;
          case 'source':
            entry.source = text;
            break;
          case 'detail':
            entry.detail = text;
            break;
          case 'archivedAt':
            entry.archivedAt = text.length === 0 ? null : text;
            break;
          case 'archivedReason':
            entry.archivedReason = text.length === 0 ? null : text;
            break;
          case 'archivedStatusBefore': {
            var allowed = ['active', 'candidate', 'superseded'];
            entry.archivedStatusBefore = allowed.indexOf(text) !== -1 ? text : null;
            if (entry.archivedStatusBefore === null && text.length > 0) {
              warnings.push(warn('bad-value', '归档前状态「' + text + '」非法', filePath));
            }
            break;
          }
          default:
            break;
        }
      };

      var appendToField = function (entry, name, text) {
        var key = FIELD_KEY[name];
        if (key === undefined) {
          warnings.push(warn('free-field', '续行无法归属已知字段「' + name + '」，已原样保留', filePath));
          entry.orphanNotes.push(text);
          return;
        }
        if (key === 'detail') {
          entry.detail = entry.detail + '\n' + text;
          return;
        }
        warnings.push(warn('free-field', '字段「' + name + '」不接受续行，已原样保留', filePath));
        entry.orphanNotes.push(text);
      };

      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index] || '';

        // H1：固定行，渲染时重新生成
        if (/^#\s+记忆\s*·/.test(line)) {
          closeEntry(index);
          continue;
        }

        // H2：分节标题
        if (/^##\s+/.test(line)) {
          closeEntry(index);
          orphanOwner = null;
          blankOwner = null;
          sectionSeen = true;
          var label = line.replace(/^##\s+/, '').trim();
          var kind = LABEL_KIND[label];
          if (kind === undefined) {
            sectionKind = null;
            warnings.push(warn('unknown-section', '无法识别的分节「' + label + '」，其下条目按「事实」处理', filePath));
          } else {
            sectionKind = kind;
          }
          continue;
        }

        // 空行：终止当前条目
        if (line.trim().length === 0) {
          if (current !== null) {
            current.orphanNotes.push('');
            orphanOwner = current;
            blankOwner = current;
            closeEntry(index);
          }
          continue;
        }

        var indentMatch = /^([ \t\u3000]*)/.exec(line);
        var prefix = indentMatch === null ? '' : indentMatch[1] || '';
        var depth = depthOf(prefix);
        var body = line.slice(prefix.length);
        sawContentLine = true;

        var titleLike = TITLE_RE.exec(line);

        // 顶格（相对标题行不更深）且不是列表项
        if (titleLike === null && (current === null || depth <= titleDepth)) {
          var field0 = matchFieldLine(line);
          if (current !== null && field0 !== null && FIELD_KEY[field0.name] !== undefined) {
            warnings.push(warn('field-no-indent', '条目 ' + (current.id || '(无编号)') + ' 的字段「' + field0.name + '」缺少缩进，已按字段处理', filePath));
            applyField(current, field0.name, field0.value);
            lastKnownField = field0.name;
            lastFieldName = field0.name;
            lastFieldDepth = depth;
            continue;
          }
          if (current !== null && field0 !== null && FIELD_KEY[field0.name] === undefined && depth > 0) {
            current.unknownFields.push({ name: field0.name, value: field0.value, anchor: lastKnownField });
            lastFieldName = null;
            continue;
          }
          if (current !== null && field0 === null) {
            warnings.push(warn('free-field', '条目 ' + (current.id || '(无编号)') + ' 下出现既非字段也非续行的行，已原样保留', filePath));
            current.orphanNotes.push(line);
            continue;
          }
        }

        // 新条目：标题行
        if (titleLike !== null) {
          closeEntry(index);
          startIndex = index;
          orphanOwner = null;
          blankOwner = null;
          var idText = titleLike[2];
          var title = (titleLike[3] || '').trim();
          current = newEntry({
            id: idText === undefined ? null : '#' + idText.padStart(4, '0'),
            kind: sectionKind || 'fact',
            title: title,
            filePath: filePath,
            fileDate: fileDate,
            order: entries.length,
          });
          titleDepth = depth;
          lastFieldDepth = depth;
          lastFieldName = null;
          lastKnownField = null;
          if (!sectionSeen) {
            warnings.push(warn('entry-before-section', '条目 ' + (current.id || '(无编号)') + ' 出现在任何 H2 分节之前，已按「事实」暂存', filePath));
          }
          if (title.length === 0) {
            warnings.push(warn('empty-title', '条目 ' + (current.id || '(无编号)') + ' 的标题为空', filePath));
          }
          continue;
        }

        // 字段行 / 续行
        var field = matchFieldLine(line);
        if (current !== null && field !== null) {
          var known = FIELD_KEY[field.name] !== undefined;
          var isField = depth > titleDepth || (depth >= titleDepth && known && field.name.length > 0 && depth === titleDepth);
          if (isField) {
            if (known) {
              applyField(current, field.name, field.value);
              lastKnownField = field.name;
              lastFieldName = field.name;
              lastFieldDepth = depth;
            } else {
              current.unknownFields.push({ name: field.name, value: field.value, anchor: lastKnownField });
              lastFieldName = null;
              lastFieldDepth = depth;
            }
            continue;
          }
          if (depth > lastFieldDepth && lastFieldName !== null) {
            appendToField(current, lastFieldName, body.replace(/^[-*][ \t\u3000]+/, ''));
            continue;
          }
        }

        if (current !== null) {
          if (lastFieldName !== null && depth > titleDepth) {
            appendToField(current, lastFieldName, body.replace(/^[-*][ \t\u3000]+/, ''));
          } else {
            warnings.push(warn('free-field', '条目 ' + (current.id || '(无编号)') + ' 下出现无法归类的行，已原样保留', filePath));
            current.orphanNotes.push(line);
          }
          continue;
        }

        // 被空行终止的条目：其后的缩进行按人类备注挂回它
        if (orphanOwner !== null && depth > 0) {
          orphanOwner.orphanNotes.push(line);
          if (blankOwner === orphanOwner) {
            warnings.push(warn('entry-blank-line', '条目 ' + (orphanOwner.id || '(无编号)') + ' 的空行之后仍有缩进行，已按备注保留（内容不丢）', filePath, orphanOwner.id));
            blankOwner = null;
          }
          continue;
        }

        preamble.push(line);
      }

      closeEntry(lines.length);

      if (entries.length === 0 && sawContentLine) {
        warnings.push(warn('empty-file', '文件有内容但未解析出任何条目', filePath));
      }

      return { entries: entries, warnings: warnings, damaged: false, preamble: preamble };
    } catch (error) {
      return {
        entries: [],
        warnings: warnings.concat([warn('parse-damaged', '解析失败，已按无内容处理并保留原文：' + (error && error.message ? error.message : String(error)), filePath)]),
        damaged: true,
        preamble: preamble,
      };
    }
  }

  /**
   * 解析一个项目日志文件。
   * @param {string} content
   * @param {string} filePath
   * @returns {{entries: object[], warnings: object[]}}
   */
  function parseJournalFile(content, filePath) {
    /** @type {object[]} */
    var entries = [];
    /** @type {object[]} */
    var warnings = [];
    var date = fileDateOf(filePath) || todayLocal();

    try {
      var current = null;
      var lines = splitLines(content);
      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index] || '';
        if (/^#\s+项目日志\s*·/.test(line)) continue;
        if (line.trim().length === 0) continue;

        var heading = JOURNAL_HEADING_RE.exec(line);
        if (heading !== null) {
          if (current !== null) entries.push(current);
          current = {
            id: heading[1] || null,
            title: (heading[2] || '').trim(),
            content: '',
            date: date,
            fields: [],
            filePath: filePath,
            order: entries.length,
            raw: '',
          };
          continue;
        }
        if (/^##\s+/.test(line)) {
          if (current !== null) entries.push(current);
          current = null;
          warnings.push(warn('journal-heading-invalid', '日志分节标题不符合 J-YYYYMMDD-HHMM 规范：' + line.trim(), filePath));
          continue;
        }

        var field = /^[-*]\s*([^：:]+)[：:]\s?([\s\S]*)$/.exec(line);
        if (current !== null && field !== null) {
          var name = (field[1] || '').trim();
          var value = (field[2] || '').trim();
          var existing = null;
          for (var i = 0; i < current.fields.length; i += 1) {
            if (current.fields[i].name === name) {
              existing = current.fields[i];
              break;
            }
          }
          if (existing === null) current.fields.push({ name: name, value: value });
          else existing.value = existing.value + '\n' + value;
          continue;
        }

        if (current !== null) {
          var last = current.fields[current.fields.length - 1];
          if (last === undefined) {
            current.fields.push({ name: '内容', value: line.trim() });
          } else {
            last.value = last.value + '\n' + line.replace(/^\s+/, '');
          }
        }
      }
      if (current !== null) entries.push(current);

      for (var e = 0; e < entries.length; e += 1) {
        var entry = entries[e];
        var content2 = fieldValueOf(entry, '内容');
        if (content2 === null) content2 = fieldValueOf(entry, '详细');
        if (content2 === null) content2 = fieldValueOf(entry, '结果');
        entry.content = content2 === null ? '' : content2;
        if (entry.id === null) warnings.push(warn('journal-id-invalid', '日志条目的编号缺失或非法', filePath));
        if (entry.title.length === 0) warnings.push(warn('empty-title', '日志条目 ' + (entry.id || '(无编号)') + ' 缺少标题', filePath, entry.id));
        if (entry.content.length === 0) warnings.push(warn('journal-no-content', '日志条目 ' + (entry.id || '(无编号)') + ' 缺少内容', filePath, entry.id));
      }

      // 同一文件内编号重复（跨文件唯一性由写入方保证），与 src/parse.js:985-994 同口径
      var seenJournalIds = {};
      for (var d = 0; d < entries.length; d += 1) {
        var duplicateId = entries[d].id;
        if (duplicateId === null) continue;
        var count = (seenJournalIds[duplicateId] || 0) + 1;
        seenJournalIds[duplicateId] = count;
        if (count > 1) {
          warnings.push(warn('duplicate-journal-id', '日志编号 ' + duplicateId + ' 在同一文件内重复，写入方必须重发', filePath, duplicateId));
        }
      }

      return { entries: entries, warnings: warnings };
    } catch (error) {
      return {
        entries: [],
        warnings: warnings.concat([warn('parse-damaged', '日志解析失败，已按无内容处理：' + (error && error.message ? error.message : String(error)), filePath)]),
      };
    }
  }

  /**
   * 取日志条目的字段值。
   * @param {object} entry
   * @param {string} name
   * @returns {string|null}
   */
  function fieldValueOf(entry, name) {
    for (var i = 0; i < entry.fields.length; i += 1) {
      if (entry.fields[i].name === name) return entry.fields[i].value;
    }
    return null;
  }

  // ══════════════════════════ 展示整形 ══════════════════════════

  /** 状态在列表里的权重（越小越靠前）。 */
  var STATUS_WEIGHT = { active: 0, candidate: 1, superseded: 2, expired: 3, archived: 4 };

  /**
   * 一条条目在面板里的**稳定行身份**。
   *
   * 不能用 `id`：编号可以为空（`id === null`，解析器明确支持），同一编号也可以出现在
   * 不同文件里（`parse.js` 只在写入侧保证跨文件唯一，手改/异常中断会留下重复）。
   * `order` 是**每文件内**序号，所以必须与 `filePath` 组合才唯一。
   *
   * 它同时被用作：React 列表 key、selection 的比较键、高亮判定。三者必须一致，
   * 否则会出现"点第二行、详情显示第一行、归档的是第一行"这类错目标问题。
   *
   * @param {object} entry
   * @returns {string}
   */
  function rowKey(entry) {
    return String((entry && entry.filePath) || '') + '#' + String((entry && entry.order) || 0);
  }

  /**
   * 按状态分组。
   * @param {object[]} entries
   * @returns {{active: object[], candidate: object[], superseded: object[], archived: object[]}}
   */
  function groupByStatus(entries) {
    var out = { active: [], candidate: [], superseded: [], archived: [] };
    var list = Array.isArray(entries) ? entries : [];
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      var status = entry && entry.status;
      if (status === 'candidate' || status === 'superseded' || status === 'archived') out[status].push(entry);
      else out.active.push(entry);
    }
    return out;
  }

  /**
   * 展示排序：置顶优先 → 状态权重 → 创建日期倒序 → 编号升序。
   * @param {object[]} entries
   * @returns {object[]}
   */
  function sortForDisplay(entries) {
    var list = Array.isArray(entries) ? entries.slice() : [];
    list.sort(function (a, b) {
      var pa = a && a.pinned === true ? 0 : 1;
      var pb = b && b.pinned === true ? 0 : 1;
      if (pa !== pb) return pa - pb;
      var wa = STATUS_WEIGHT[a && a.status] === undefined ? 9 : STATUS_WEIGHT[a.status];
      var wb = STATUS_WEIGHT[b && b.status] === undefined ? 9 : STATUS_WEIGHT[b.status];
      if (wa !== wb) return wa - wb;
      var ca = String((a && a.created) || '');
      var cb = String((b && b.created) || '');
      if (ca !== cb) return ca < cb ? 1 : -1;
      var ia = String((a && a.id) || '');
      var ib = String((b && b.id) || '');
      if (ia === ib) return 0;
      return ia < ib ? -1 : 1;
    });
    return list;
  }

  /**
   * 构造写给宿主命令的一行。
   * @param {'archive'|'restore'} action
   * @param {string} id 允许带或不带 `#`
   * @param {string} [reason] 归档原因（换行会被压成空格）
   * @returns {string}
   */
  function buildActionLine(action, id, reason) {
    var digits = String(id === null || id === undefined ? '' : id).replace(/[^0-9]/g, '');
    if (digits.length === 0) throw new Error('buildActionLine: 需要一个形如 #0012 的编号');
    var normalized = '#' + digits.padStart(4, '0');
    if (action === 'restore') return '/memory restore ' + normalized;
    if (action === 'archive') {
      var text = String(reason === null || reason === undefined ? '' : reason).replace(/\s+/g, ' ').trim();
      return text.length === 0 ? '/memory archive ' + normalized : '/memory archive ' + normalized + ' ' + text;
    }
    throw new Error('buildActionLine: 未知动作「' + String(action) + '」');
  }

  // ══════════════════════════ 数据加载 ══════════════════════════

  /** 加载失败时携带宿主错误码的异常。 */
  function LoadError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  /**
   * 列一个工作区目录。
   * @param {object} remote
   * @param {string} sessionId
   * @param {string} path 工作区相对路径
   * @param {AbortSignal|undefined} signal
   * @returns {Promise<{path: string, entries: object[], truncated: boolean}>}
   */
  async function listDir(remote, sessionId, path, signal) {
    var result = await remote.workspaceFiles.list(sessionId, path, signal);
    if (!result || result.ok !== true) {
      var code = result && result.error && result.error.code ? result.error.code : 'workspace-file/unknown';
      throw LoadError(code, '列目录失败（' + path + '）：' + code);
    }
    return result.value;
  }

  /**
   * 读一个文本文件（按行翻页到 EOF）。
   *
   * **不发 `limit`**：页长由宿主的 `maxLines` 配置决定（见 `MAX_READ_PAGES` 的注释）。
   *
   * @param {object} remote
   * @param {string} sessionId
   * @param {string} path
   * @param {AbortSignal|undefined} signal
   * @returns {Promise<{text: string, complete: boolean}>} `complete=false` 表示保险丝熔断，内容可能被截断
   */
  async function readText(remote, sessionId, path, signal) {
    var chunks = [];
    var offset = 1;
    var pages = 0;
    var eof = false;
    var complete = false;
    while (!eof && pages < MAX_READ_PAGES) {
      var result = await remote.workspaceFiles.read(sessionId, path, { offset: offset }, signal);
      if (!result || result.ok !== true) {
        var code = result && result.error && result.error.code ? result.error.code : 'workspace-file/unknown';
        throw LoadError(code, '读文件失败（' + path + '）：' + code);
      }
      var page = result.value;
      chunks.push(page.text);
      pages += 1;
      if (page.eof === true) {
        complete = true;
        break;
      }
      if (!page.lines) break;
      offset = page.offset + page.lines;
    }
    return { text: chunks.join('\n'), complete: complete };
  }

  /**
   * 加载整个记忆模型。
   *
   * 失败语义：目录不存在 → `LoadError('workspace-file/not-found')`，由调用方转成空态。
   *
   * @param {object} remote
   * @param {string} sessionId
   * @param {AbortSignal|undefined} signal
   * @returns {Promise<{entries: object[], journals: object[], archived: object[], notices: string[], memoryDir: string}>}
   */
  async function loadModel(remote, sessionId, signal) {
    var notices = [];
    var root = await listDir(remote, sessionId, MEMORY_DIR, signal);
    if (root.truncated === true) notices.push('memory/ 的文件数超出宿主上限，列表已截断（可能漏文件）');

    var memoryNames = [];
    var journalNames = [];
    var hasArchive = false;
    var indexName = null;
    for (var i = 0; i < root.entries.length; i += 1) {
      var item = root.entries[i];
      if (!item || typeof item.name !== 'string') continue;
      if (item.type === 'directory' && item.name === 'archive') hasArchive = true;
      if (item.type !== 'file') continue;
      if (MEMORY_FILE_RE.test(item.name)) memoryNames.push(item.name);
      else if (JOURNAL_FILE_RE.test(item.name)) journalNames.push(item.name);
      else if (item.name === 'INDEX.md') indexName = item.name;
    }
    memoryNames.sort().reverse();
    journalNames.sort().reverse();

    var archivedNames = [];
    if (hasArchive) {
      var archiveDir = await listDir(remote, sessionId, MEMORY_DIR + '/archive', signal);
      if (archiveDir.truncated === true) notices.push('memory/archive/ 的文件数超出宿主上限，列表已截断（可能漏文件）');
      for (var a = 0; a < archiveDir.entries.length; a += 1) {
        var archiveItem = archiveDir.entries[a];
        if (archiveItem && archiveItem.type === 'file' && MEMORY_FILE_RE.test(archiveItem.name)) archivedNames.push(archiveItem.name);
      }
      archivedNames.sort().reverse();
    }

    var entries = [];
    var archived = [];
    var warnings = [];
    var readOne = async function (name, intoList, isArchived) {
      var rel = MEMORY_DIR + (isArchived ? '/archive/' : '/') + name;
      var read = await readText(remote, sessionId, rel, signal);
      if (!read.complete) notices.push('文件过长，只读了前 ' + MAX_READ_PAGES + ' 页：' + rel);
      // filePath 用**工作区相对路径**（归档带 archive/ 前缀）：它同时是行身份与列表 key 的一部分，
      // 否则同名文件（如 M-2026-09-20.md 同时在活动区与归档区）会撞 key。
      var parsed = parseMemoryFile(read.text, rel);
      for (var w = 0; w < parsed.warnings.length; w += 1) {
        if (parsed.warnings[w].code !== 'empty-file') warnings.push(parsed.warnings[w].code);
      }
      for (var e = 0; e < parsed.entries.length; e += 1) intoList.push(parsed.entries[e]);
    };

    var names = memoryNames.slice(0, MAX_FILES);
    if (memoryNames.length > names.length) notices.push('记忆文件超过 ' + MAX_FILES + ' 个，只显示了前 ' + MAX_FILES + ' 个');
    for (var m = 0; m < names.length; m += 1) await readOne(names[m], entries, false);

    var archivedUsed = archivedNames.slice(0, MAX_FILES);
    if (archivedNames.length > archivedUsed.length) notices.push('归档文件超过 ' + MAX_FILES + ' 个，只显示了前 ' + MAX_FILES + ' 个');
    for (var r = 0; r < archivedUsed.length; r += 1) await readOne(archivedUsed[r], archived, true);

    var journals = [];
    var journalUsed = journalNames.slice(0, MAX_FILES);
    if (journalNames.length > journalUsed.length) notices.push('日志文件超过 ' + MAX_FILES + ' 个，只显示了前 ' + MAX_FILES + ' 个');
    for (var j = 0; j < journalUsed.length; j += 1) {
      var journalRel = MEMORY_DIR + '/' + journalUsed[j];
      var journalRead = await readText(remote, sessionId, journalRel, signal);
      if (!journalRead.complete) notices.push('文件过长，只读了前 ' + MAX_READ_PAGES + ' 页：' + journalRel);
      var parsedJournal = parseJournalFile(journalRead.text, journalRel);
      for (var jw = 0; jw < parsedJournal.warnings.length; jw += 1) {
        warnings.push(parsedJournal.warnings[jw].code);
      }
      for (var je = 0; je < parsedJournal.entries.length; je += 1) journals.push(parsedJournal.entries[je]);
    }
    journals.sort(function (x, y) {
      var ix = String(x.id || '');
      var iy = String(y.id || '');
      if (ix === iy) return 0;
      return ix < iy ? 1 : -1;
    });

    var uniqueWarnings = [];
    for (var u = 0; u < warnings.length; u += 1) {
      if (uniqueWarnings.indexOf(warnings[u]) === -1) uniqueWarnings.push(warnings[u]);
    }
    if (uniqueWarnings.length > 0) notices.push('解析告警：' + uniqueWarnings.join('、'));

    return {
      entries: sortForDisplay(entries),
      journals: journals,
      archived: sortForDisplay(archived),
      notices: notices,
      memoryDir: MEMORY_DIR,
      indexName: indexName,
      rootPath: root.path,
    };
  }

  // ══════════════════════════ UI ══════════════════════════

  /**
   * 面板样式表。
   *
   * **所有选择器都带 `.dshmem-` 前缀**：这份 CSS 会被注入宿主页面的 <head>，
   * 任何不带前缀的选择器都可能改到宿主自己（含别的插件）的样式。
   *
   * 视觉取自已评审原型 `docs/prototype/memory-panel.html`（无卡片、细分隔线、类型图标、
   * 行内展开、日志时间线、记忆图谱）。与原型的唯一差异是配色：原型自带 dark/light 两套变量，
   * 面板必须跟随宿主主题，而宿主**没有**对外暴露主题变量（已核查 DSH 产物里不存在 `--dsh-*` 系列），
   * 所以这里只用 rgba(128,128,128,x) 系列中性灰 + currentColor 继承，深浅宿主下都可读；
   * 只有类型色沿用原型取值（中间调，两种主题下都看得出）。
   */
  var CSS = [
    '.dshmem-root {',
    '  position: relative;',
    '  display: flex;',
    '  flex-direction: column;',
    '  height: 100%;',
    '  min-height: 0;',
    '  box-sizing: border-box;',
    '  font-family: inherit;',
    '  font-size: 14px;',
    '  line-height: 1.6;',
    '  color: inherit;',
    '  --dshmem-line: rgba(128,128,128,0.28);',
    '  --dshmem-line-soft: rgba(128,128,128,0.16);',
    '  --dshmem-line-strong: rgba(128,128,128,0.45);',
    '  --dshmem-dim: rgba(128,128,128,0.95);',
    '  --dshmem-faint: rgba(128,128,128,0.7);',
    '  --dshmem-hover: rgba(128,128,128,0.12);',
    '  --dshmem-sel: rgba(128,128,128,0.16);',
    '  --dshmem-accent: var(--dsh-accent, #4f7cff);',
    '  --dshmem-danger: #e06c75;',
    '  --dshmem-k-convention: #7aa2d8;',
    '  --dshmem-k-fact: #9d8cd8;',
    '  --dshmem-k-procedure: #5fb8a4;',
    '  --dshmem-k-lesson: #cfa14a;',
    '  --dshmem-k-archived: #8a8a8a;',
    '}',
    '.dshmem-root * { box-sizing: border-box; }',
    '.dshmem-root button, .dshmem-root input { font: inherit; color: inherit; }',
    '.dshmem-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }',
    '.dshmem-grow { flex: 1 1 auto; }',
    '.dshmem-faint { color: var(--dshmem-faint); }',

    /* ── 顶栏：标题 + 统计 + 刷新，下方 2px 三段预算条 ── */
    '.dshmem-bar { display: flex; height: 2px; background: var(--dshmem-line-soft); flex: 0 0 auto; overflow: hidden; }',
    '.dshmem-bar span { display: block; height: 100%; }',
    '.dshmem-bar-pinned { background: var(--dshmem-k-lesson); }',
    '.dshmem-bar-index { background: var(--dshmem-accent); }',
    '.dshmem-bar-journal { background: var(--dshmem-k-procedure); }',
    '.dshmem-header { display: flex; align-items: center; gap: 10px; padding: 10px 16px 8px; flex: 0 0 auto; }',
    '.dshmem-title { font-size: 14px; font-weight: 600; }',
    '.dshmem-stat { font-size: 12px; color: var(--dshmem-dim); }',
    '.dshmem-stat b { color: inherit; font-weight: 500; }',
    '.dshmem-ghost { border: none; background: transparent; color: var(--dshmem-dim); cursor: pointer; padding: 3px 7px; border-radius: 6px; font-size: 12px; }',
    '.dshmem-ghost:hover { background: var(--dshmem-hover); color: inherit; }',
    '.dshmem-ghost[aria-pressed=true] { color: inherit; background: var(--dshmem-sel); }',

    /* ── 分页签 ── */
    '.dshmem-nav { display: flex; gap: 16px; padding: 0 16px; border-bottom: 1px solid var(--dshmem-line); flex: 0 0 auto; }',
    '.dshmem-nav button { border: none; background: transparent; color: var(--dshmem-dim); cursor: pointer; padding: 6px 0 8px; font-size: 13px; border-bottom: 1px solid transparent; margin-bottom: -1px; }',
    '.dshmem-nav button[aria-selected=true] { color: inherit; border-bottom-color: currentColor; }',
    '.dshmem-nav .dshmem-n { color: var(--dshmem-faint); font-size: 11px; margin-left: 4px; }',

    /* ── 提示条（归档受理 / 建议指令） ── */
    '.dshmem-notice { flex: 0 0 auto; display: flex; align-items: baseline; gap: 8px; padding: 6px 16px; font-size: 12px; color: var(--dshmem-dim); border-bottom: 1px solid var(--dshmem-line-soft); }',
    '.dshmem-notice .dshmem-note-line { user-select: text; word-break: break-all; }',

    /* ── 主体 ── */
    '.dshmem-main { flex: 1 1 auto; min-height: 0; overflow: auto; }',
    '.dshmem-wrap { padding: 4px 0 28px; }',
    '.dshmem-phase { padding: 14px 16px; font-size: 12px; color: var(--dshmem-faint); line-height: 1.7; }',

    /* ── 记忆列表：吸顶组头 + 细分隔线 + 行内手风琴 ── */
    '.dshmem-gh { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; padding: 8px 16px; font-size: 13px; color: var(--dshmem-dim); cursor: pointer; user-select: none; background: rgba(128,128,128,0.08); backdrop-filter: blur(6px); border-bottom: 1px solid var(--dshmem-line-soft); }',
    '.dshmem-gh .dshmem-ico { display: block; color: var(--dshmem-faint); }',
    '.dshmem-gh .dshmem-caret { margin-left: auto; display: inline-flex; color: var(--dshmem-faint); transition: transform .12s; }',
    '.dshmem-gh[data-open=false] .dshmem-caret { transform: rotate(-90deg); }',
    '.dshmem-gh .dshmem-cnt { color: var(--dshmem-faint); }',
    '.dshmem-g-convention .dshmem-gh-ico { color: var(--dshmem-k-convention); }',
    '.dshmem-g-fact .dshmem-gh-ico { color: var(--dshmem-k-fact); }',
    '.dshmem-g-procedure .dshmem-gh-ico { color: var(--dshmem-k-procedure); }',
    '.dshmem-g-lesson .dshmem-gh-ico { color: var(--dshmem-k-lesson); }',
    '.dshmem-g-archived .dshmem-gh-ico { color: var(--dshmem-k-archived); }',
    '.dshmem-r { display: flex; align-items: baseline; gap: 8px; padding: 6px 16px 6px 20px; cursor: pointer; border-left: 2px solid transparent; }',
    '.dshmem-r:hover { background: var(--dshmem-hover); }',
    '.dshmem-r[aria-expanded=true] { background: var(--dshmem-sel); border-left-color: var(--dshmem-accent); }',
    '.dshmem-r .dshmem-id { flex: 0 0 auto; font-size: 12.5px; color: var(--dshmem-faint); }',
    '.dshmem-r .dshmem-t { flex: 1 1 auto; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.dshmem-r .dshmem-c { flex: 0 0 auto; font-size: 12px; color: var(--dshmem-faint); }',
    '.dshmem-r .dshmem-off { flex: 0 0 auto; font-size: 12px; color: var(--dshmem-k-archived); }',
    '.dshmem-star { color: var(--dshmem-k-lesson); }',
    '.dshmem-exp { padding: 2px 16px 14px 20px; background: var(--dshmem-sel); border-left: 2px solid var(--dshmem-accent); }',
    '.dshmem-exp .dshmem-meta { font-size: 13px; color: var(--dshmem-dim); }',
    '.dshmem-exp .dshmem-meta i { font-style: normal; margin: 0 6px; color: var(--dshmem-faint); }',
    '.dshmem-body { margin: 10px 0 0; font-size: 14px; line-height: 1.75; white-space: pre-wrap; word-break: break-word; max-width: 860px; }',
    '.dshmem-tags { margin-top: 8px; font-size: 13px; color: var(--dshmem-dim); }',
    '.dshmem-arch { margin-top: 8px; font-size: 13px; color: var(--dshmem-dim); }',
    '.dshmem-links { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin-top: 10px; }',
    '.dshmem-links .dshmem-lb { font-size: 12.5px; color: var(--dshmem-faint); }',
    '.dshmem-lnk { padding: 1px 8px; border: 1px solid var(--dshmem-line); border-radius: 999px; background: transparent; color: var(--dshmem-accent); cursor: pointer; font-size: 12.5px; }',
    '.dshmem-lnk:hover { border-color: var(--dshmem-accent); }',
    '.dshmem-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }',
    '.dshmem-acts .dshmem-input { flex: 0 1 240px; padding: 4px 9px; border: 1px solid var(--dshmem-line); border-radius: 6px; background: transparent; outline: none; font-size: 12px; }',
    '.dshmem-acts .dshmem-input:focus { border-color: var(--dshmem-line-strong); }',
    '.dshmem-acts .dshmem-act { padding: 4px 12px; border: 1px solid var(--dshmem-line); border-radius: 6px; background: transparent; color: var(--dshmem-dim); cursor: pointer; font-size: 12px; }',
    '.dshmem-acts .dshmem-act:hover { background: var(--dshmem-hover); color: inherit; }',
    '.dshmem-acts .dshmem-act.dshmem-danger { color: var(--dshmem-danger); border-color: rgba(224,108,117,0.45); }',
    '.dshmem-notices { padding: 8px 16px 12px; font-size: 11px; color: var(--dshmem-faint); line-height: 1.7; }',

    /* ── 日志时间线 ── */
    '.dshmem-day { display: flex; align-items: center; gap: 10px; padding: 16px 16px 6px; font-size: 13px; color: var(--dshmem-dim); }',
    '.dshmem-day .dshmem-rule { flex: 1 1 auto; height: 1px; background: var(--dshmem-line-soft); }',
    '.dshmem-tl { position: relative; padding-left: 68px; }',
    '.dshmem-tl::before { content: ""; position: absolute; left: 56px; top: 4px; bottom: 6px; width: 1px; background: var(--dshmem-line); }',
    '.dshmem-ev { position: relative; padding: 6px 16px 10px 0; cursor: pointer; }',
    '.dshmem-ev .dshmem-time { position: absolute; left: -68px; width: 44px; padding-top: 3px; text-align: right; font-size: 12px; color: var(--dshmem-faint); }',
    '.dshmem-ev::before { content: ""; position: absolute; left: -16px; top: 11px; width: 5px; height: 5px; border-radius: 50%; background: var(--dshmem-faint); }',
    '.dshmem-ev[aria-expanded=true]::before { background: var(--dshmem-accent); }',
    '.dshmem-evh { display: flex; align-items: baseline; gap: 8px; }',
    '.dshmem-evh .dshmem-id { flex: 0 0 auto; font-size: 12.5px; color: var(--dshmem-faint); }',
    '.dshmem-evh .dshmem-ti { flex: 1 1 auto; font-size: 14px; }',
    '.dshmem-f { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; font-size: 13px; color: var(--dshmem-dim); }',
    '.dshmem-frow { display: flex; align-items: baseline; gap: 8px; }',
    '.dshmem-frow b { flex: 0 0 auto; min-width: 4.5em; color: inherit; font-weight: 500; }',
    '.dshmem-fv { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; word-break: break-word; }',

    /* ── 记忆图谱 ── */
    '.dshmem-graphbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px 0; }',
    '.dshmem-graphbar .dshmem-hint { margin-left: auto; font-size: 11.5px; color: var(--dshmem-faint); }',
    '.dshmem-graph { position: relative; }',
    '.dshmem-svg { display: block; width: 100%; max-width: 1000px; margin: 0 auto; height: auto; touch-action: none; }',
    '.dshmem-svg .dshmem-edge { fill: none; stroke: var(--dshmem-line-strong); stroke-width: 1; opacity: .55; }',
    '.dshmem-svg .dshmem-edge-rel { stroke: var(--dshmem-faint); opacity: .45; }',
    '.dshmem-svg .dshmem-edge-sup { stroke: var(--dshmem-k-archived); stroke-dasharray: 3 3; opacity: .6; }',
    '.dshmem-svg .dshmem-edge-log { stroke: var(--dshmem-k-procedure); opacity: .35; }',
    '.dshmem-svg .dshmem-edge-on { stroke: var(--dshmem-accent); stroke-width: 1.4; opacity: .95; }',
    '.dshmem-svg .dshmem-node { cursor: grab; }',
    '.dshmem-svg .dshmem-node.dshmem-dragging { cursor: grabbing; }',
    '.dshmem-svg .dshmem-hit { fill: transparent; stroke: none; }',
    '.dshmem-svg .dshmem-dot { fill: rgba(128,128,128,0.16); stroke-width: 1.4; }',
    '.dshmem-svg .dshmem-kind-convention .dshmem-dot { stroke: var(--dshmem-k-convention); }',
    '.dshmem-svg .dshmem-kind-fact .dshmem-dot { stroke: var(--dshmem-k-fact); }',
    '.dshmem-svg .dshmem-kind-procedure .dshmem-dot { stroke: var(--dshmem-k-procedure); }',
    '.dshmem-svg .dshmem-kind-lesson .dshmem-dot { stroke: var(--dshmem-k-lesson); }',
    '.dshmem-svg .dshmem-kind-archived .dshmem-dot { stroke: var(--dshmem-k-archived); stroke-dasharray: 3 2; }',
    '.dshmem-svg .dshmem-kind-journal .dshmem-dot { stroke: var(--dshmem-k-procedure); }',
    '.dshmem-svg .dshmem-node-label { font: 12px/1 ui-monospace, Menlo, Consolas, monospace; fill: var(--dshmem-faint); pointer-events: none; user-select: none; }',
    '.dshmem-svg .dshmem-node.dshmem-dim { opacity: .22; }',
    '.dshmem-svg .dshmem-node.dshmem-on .dshmem-dot { stroke-width: 2.2; }',
    '.dshmem-svg .dshmem-node.dshmem-on .dshmem-node-label { fill: inherit; }',
    '.dshmem-svg .dshmem-cluster text { font: 12px/1 system-ui, sans-serif; fill: var(--dshmem-faint); letter-spacing: .5px; }',
    '.dshmem-gcap { display: flex; align-items: baseline; gap: 8px; min-height: 24px; padding: 2px 16px 10px; font-size: 12px; color: var(--dshmem-dim); }',
    '.dshmem-gcap b { color: inherit; font-weight: 500; }',
    '.dshmem-gdetail { padding: 0 16px 20px; }',
    '.dshmem-gdetail .dshmem-ghd { display: flex; align-items: center; gap: 8px; padding-bottom: 4px; }',
    '.dshmem-gdetail .dshmem-ghd .dshmem-who { font-size: 12px; color: var(--dshmem-faint); }',
    '',
  ].join('\n');

  /**
   * 把样式表插进文档 head。
   * @param {Document} doc
   * @returns {Function} 卸载函数（把 <style> 摘掉）
   */
  function installStyle(doc) {
    var el = doc.createElement('style');
    el.textContent = CSS;
    if (typeof el.setAttribute === 'function') el.setAttribute('data-dsh-memory', 'panel');
    doc.head.appendChild(el);
    return function () {
      if (typeof el.remove === 'function') el.remove();
      else if (el.parentNode) el.parentNode.removeChild(el);
    };
  }

  // ────────────────────────── 类型图标（形状取自原型 ICON 表） ──────────────────────────

  /**
   * 每个图标 = 基础属性 + 若干图元；`viewBox`/描边宽度与原型的 13px 内联 SVG 一致。
   * 用 React.createElement 拼（宿主不提供 JSX），属性名按 React 的驼峰写法。
   */
  var ICON = {
    convention: { shapes: [['path', { d: 'M4.2 2.6h7.6v11l-3.8-2.5-3.8 2.5z', strokeLinejoin: 'round' }]] },
    fact: {
      shapes: [
        ['circle', { cx: 8, cy: 8, r: 6 }],
        ['path', { d: 'M8 7.4v3.4M8 5.4v.7', strokeLinecap: 'round' }],
      ],
    },
    procedure: {
      shapes: [
        ['circle', { cx: 3.6, cy: 8, r: 1.5 }],
        ['circle', { cx: 12.4, cy: 8, r: 1.5 }],
        ['path', { d: 'M5.1 8h5.2M9.6 6.4 11.4 8l-1.8 1.6', strokeLinecap: 'round' }],
      ],
    },
    lesson: {
      shapes: [
        ['path', { d: 'M8 2.4a4.1 4.1 0 0 0-2.5 7.4v1.5h5V9.8A4.1 4.1 0 0 0 8 2.4z', strokeLinejoin: 'round' }],
        ['path', { d: 'M6.4 13.4h3.2', strokeLinecap: 'round' }],
      ],
    },
    archived: {
      shapes: [
        ['path', { d: 'M2.6 6h10.8v7H2.6z', strokeLinejoin: 'round' }],
        ['path', { d: 'M2 3.4h12V6H2z', strokeLinejoin: 'round' }],
      ],
    },
    caret: { size: 12, strokeWidth: 1.4, shapes: [['path', { d: 'M4.5 6.5 8 10l3.5-3.5', strokeLinecap: 'round', strokeLinejoin: 'round' }]] },
  };

  /**
   * 造一个图标元素。
   * @param {Function} createElement React.createElement
   * @param {string} name ICON 里的键
   * @param {string} [extraClass] 附加 class（用来单独给某个位置的图标上色）
   * @returns {object|null}
   */
  function iconElement(createElement, name, extraClass) {
    var def = ICON[name];
    if (def === undefined) return null;
    var size = def.size === undefined ? 13 : def.size;
    var children = [];
    for (var i = 0; i < def.shapes.length; i += 1) {
      var tag = def.shapes[i][0];
      var attrs = def.shapes[i][1];
      var props = { key: 's' + i };
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) props[k] = attrs[k];
      }
      children.push(createElement(tag, props));
    }
    return createElement(
      'svg',
      {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: def.strokeWidth === undefined ? 1.3 : def.strokeWidth,
        className: 'dshmem-ico' + (extraClass === undefined ? '' : ' ' + extraClass),
      },
      children,
    );
  }

  // ────────────────────────── 注入字数估算（只读展示，纯函数） ──────────────────────────

  /**
   * 注入预算分母（字）。
   *
   * **客户端拿不到宿主生效的 `maxSnapshotChars`**（它是插件配置，宿主的 workspaceFiles 面
   * 不读插件配置——见记忆 #0025）。这里取本仓库 `cordis.patch.yml` 的当前值 9000，
   * 与原型 `BUDGET = 9000` 一致；用户改过配置时顶栏分母会不准（数字仍是"估算"）。
   */
  var SNAPSHOT_BUDGET = 9000;

  /** 千位分隔用空格（原型口径 `9 000`），不依赖 Intl。 */
  function formatNumber(value) {
    var n = Number(value);
    if (!isFinite(n)) return String(value);
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  /**
   * 单条记忆的注入字数估算：`[#0019] 事实 · 标题`（src/snapshot.js:185 的 indexLine）+ 1 个换行。
   * @param {object} entry
   * @returns {number}
   */
  function idxCost(entry) {
    if (!entry) return 0;
    var id = entry.id === null || entry.id === undefined ? '' : String(entry.id);
    return ('[' + id + '] ' + formatKind(entry.kind) + ' · ' + String(entry.title || '')).length + 1;
  }

  /**
   * 置顶条目的注入字数：`[★ #0019] 事实 · 标题`（src/snapshot.js:176 的 pinnedLine）。
   * @param {object} entry
   * @returns {number}
   */
  function pinnedCost(entry) {
    if (!entry) return 0;
    var id = entry.id === null || entry.id === undefined ? '' : String(entry.id);
    return ('[★ ' + id + '] ' + formatKind(entry.kind) + ' · ' + String(entry.title || '')).length + 1;
  }

  /**
   * 单条日志标题的注入字数估算：`[J-20260929-1350] 标题`（src/snapshot.js:254 的 journalLine）。
   * @param {object} journal
   * @returns {number}
   */
  function logCost(journal) {
    if (!journal) return 0;
    var id = journal.id === null || journal.id === undefined ? '' : String(journal.id);
    return ('[' + id + '] ' + String(journal.title || '')).length + 1;
  }

  /**
   * 三段注入预算估算（顶栏统计 + 2px 三段条）。
   *
   * 与真实注入的口径对齐：
   *   - 只有 active / candidate 会进快照；
   *   - 置顶条目**只**进 `[置顶记忆]` 段，不重复进索引段（`src/snapshot.js` 的 usable 分流）；
   *   - 索引段多算 16 字、日志段多算 110 字（段名行 / 说明行 / 提示行 / 结束标签的固定开销）。
   *
   * @param {object[]} entries 记忆行（含归档，归档不参与注入）
   * @param {object[]} journals 日志条目
   * @param {number} [budget] 预算分母，缺省用 SNAPSHOT_BUDGET
   * @returns {{pinned: number, index: number, journal: number, total: number, budget: number, injectable: number, pinnedCount: number, journalCount: number}}
   */
  function injectionStats(entries, journals, budget) {
    var rows = Array.isArray(entries) ? entries : [];
    var logs = Array.isArray(journals) ? journals : [];
    var limit = typeof budget === 'number' && budget > 0 ? budget : SNAPSHOT_BUDGET;
    var pinnedChars = 0;
    var indexChars = 0;
    var injectable = 0;
    var pinnedCount = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var entry = rows[i];
      if (!entry) continue;
      if (entry.status !== 'active' && entry.status !== 'candidate') continue;
      injectable += 1;
      if (entry.pinned === true) {
        pinnedChars += pinnedCost(entry);
        pinnedCount += 1;
      } else {
        indexChars += idxCost(entry);
      }
    }
    var journalChars = 0;
    for (var j = 0; j < logs.length; j += 1) journalChars += logCost(logs[j]);
    var index = indexChars + 16;
    var journal = journalChars + 110;
    return {
      pinned: pinnedChars,
      index: index,
      journal: journal,
      total: pinnedChars + index + journal,
      budget: limit,
      injectable: injectable,
      pinnedCount: pinnedCount,
      journalCount: logs.length,
    };
  }

  // ────────────────────────── 记忆页分组（纯函数） ──────────────────────────

  /** 一组条目的注入字数合计。 */
  function sumCost(entries) {
    var total = 0;
    var list = Array.isArray(entries) ? entries : [];
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      if (!entry) continue;
      // 只有 active / candidate 参与会话边界注入；已取代与归档条目不计入这组字数，
      // 否则分组头的"字数"会比顶栏的注入估算虚高（两者必须同口径）。
      if (entry.status !== 'active' && entry.status !== 'candidate') continue;
      total += idxCost(entry);
    }
    return total;
  }

  /**
   * 按类型分组：约定 / 事实 / 流程 / 经验 + 归档（归档殿后）。
   *
   * 归档组 = `memory/archive/` 里的条目 + 仍写在活动文件里但 `status === 'archived'` 的条目
   * （手改或写入中断会留下后者；它们必须可见，否则"计数里有、列表里没有"）。
   * 空组也返回（由 UI 决定是否渲染），组内保持调用方给的顺序（loadModel 已按展示顺序排好）。
   *
   * @param {object[]} entries 活动文件里的条目
   * @param {object[]} archivedEntries 归档目录里的条目
   * @returns {Array<{key: string, label: string, items: object[], cost: number}>}
   */
  function groupByKind(entries, archivedEntries) {
    var list = Array.isArray(entries) ? entries : [];
    var archived = Array.isArray(archivedEntries) ? archivedEntries : [];
    var groups = [];
    for (var k = 0; k < KINDS.length; k += 1) {
      var kind = KINDS[k];
      var items = [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].kind === kind && list[i].status !== 'archived') items.push(list[i]);
      }
      groups.push({ key: kind, label: KIND_LABEL[kind], items: items, cost: sumCost(items) });
    }
    var archivedItems = archived.slice();
    for (var a = 0; a < list.length; a += 1) {
      if (list[a] && list[a].status === 'archived') archivedItems.push(list[a]);
    }
    groups.push({ key: 'archived', label: '归档', items: archivedItems, cost: sumCost(archivedItems) });
    return groups;
  }

  // ────────────────────────── 记忆图谱（纯函数） ──────────────────────────

  /** 图谱画布尺寸（与原型一致）。 */
  var GRAPH_WIDTH = 900;
  var GRAPH_HEIGHT = 560;

  /** 各簇中心（与原型一致：约定 / 事实 / 流程 / 经验 / 归档 / 日志）。 */
  var GRAPH_CENTERS = {
    convention: [150, 150],
    fact: [450, 180],
    procedure: [740, 130],
    lesson: [270, 420],
    archived: [600, 420],
    journal: [780, 420],
  };

  /** 图谱簇顺序（归档殿后；日志簇在开关打开时追加）。 */
  var GRAPH_KINDS = ['convention', 'fact', 'procedure', 'lesson', 'archived'];

  /**
   * 图谱簇的中文名。
   * 不能直接用 `KIND_LABEL`：那张表（对齐 src/parse.js）只有四种条类型，没有 `archived`，
   * 用它渲染归档簇会得到 `undefined`（真渲染冒烟抓到的）。这里补一张**只给图谱用**的表，
   * 冻结段的常量一个字不动。
   */
  var GRAPH_LABEL = { convention: '约定', fact: '事实', procedure: '流程', lesson: '经验', archived: '归档', journal: '日志' };

  /** 节点归属簇：归档条目单独成簇，未知类型按事实放。 */
  function graphKindOf(entry) {
    if (entry && entry.status === 'archived') return 'archived';
    if (entry && GRAPH_KINDS.indexOf(entry.kind) !== -1) return entry.kind;
    return 'fact';
  }

  /** 半径按单条注入字数开方缩放（原型公式，夹在 6..17）。 */
  function graphRadius(cost) {
    return Math.max(6, Math.min(17, 5 + Math.sqrt(Math.max(0, cost)) / 2.4));
  }

  /**
   * 造一张**确定性**的记忆图谱：节点按类型分簇摆放，边按关系连。
   *
   * 纯函数：同样的入参必然得到同样的坐标（拖动产生的坐标由调用方覆盖，见 copyPositions）。
   * 节点 id 用 `rowKey`（filePath + order），不是 `id`：编号可以为空、也可以跨文件重复。
   * 边的三种样式：`rel` 关联、`sup` 取代（含"被取代"）、`log` 关联日志（仅在含日志时）。
   *
   * @param {object[]} memoryRows 记忆行（含归档）
   * @param {object[]} journalRows 日志条目
   * @param {{logs?: boolean, rel?: boolean}} [options] logs=画出日志簇与日志边；rel=false 时不画关联边
   * @returns {{width: number, height: number, nodes: object[], edges: object[], pos: object}}
   */
  function buildGraph(memoryRows, journalRows, options) {
    var opts = options === null || options === undefined ? {} : options;
    var rows = Array.isArray(memoryRows) ? memoryRows : [];
    var journals = Array.isArray(journalRows) ? journalRows : [];
    /** @type {object[]} */
    var nodes = [];
    var clusters = {};
    for (var i = 0; i < rows.length; i += 1) {
      var bucket = graphKindOf(rows[i]);
      if (clusters[bucket] === undefined) clusters[bucket] = [];
      clusters[bucket].push(rows[i]);
    }

    var placeRing = function (list, center, perRing, baseRadius, stepRadius, squash, make) {
      for (var index = 0; index < list.length; index += 1) {
        var ring = Math.floor(index / perRing);
        var slot = index % perRing;
        var count = Math.min(perRing, list.length - ring * perRing);
        var radius = baseRadius + ring * stepRadius;
        var angle = (slot / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
        nodes.push(make(list[index], center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius * squash));
      }
    };

    for (var c = 0; c < GRAPH_KINDS.length; c += 1) {
      var kind = GRAPH_KINDS[c];
      var list = clusters[kind] === undefined ? [] : clusters[kind];
      if (list.length === 0) continue;
      placeRing(list, GRAPH_CENTERS[kind], 6, 34, 30, 0.82, function (entry, x, y) {
        return {
          id: rowKey(entry),
          kind: kind,
          label: entry.id === null || entry.id === undefined ? '·' : String(entry.id),
          x: x,
          y: y,
          r: graphRadius(idxCost(entry)),
          entry: entry,
          isJournal: false,
        };
      });
    }
    if (opts.logs === true) {
      placeRing(journals, GRAPH_CENTERS.journal, 7, 30, 28, 0.82, function (journal, x, y) {
        var id = String(journal.id === null || journal.id === undefined ? '' : journal.id);
        return { id: rowKey(journal), kind: 'journal', label: id.slice(2, 15), x: x, y: y, r: 5, entry: journal, isJournal: true };
      });
    }

    var pos = {};
    for (var n = 0; n < nodes.length; n += 1) pos[nodes[n].id] = nodes[n];

    // 关系是按「编号」写的（`关联：#0019`），节点 id 是行身份，所以要一张编号 → 节点 的表
    var memoryNodeOf = {};
    for (var m = 0; m < rows.length; m += 1) {
      var row = rows[m];
      if (!row || row.id === null || row.id === undefined) continue;
      if (memoryNodeOf[row.id] === undefined) memoryNodeOf[row.id] = rowKey(row);
    }
    var journalNodeOf = {};
    for (var jn = 0; jn < journals.length; jn += 1) {
      var journal = journals[jn];
      if (!journal || journal.id === null || journal.id === undefined) continue;
      if (journalNodeOf[journal.id] === undefined) journalNodeOf[journal.id] = rowKey(journal);
    }

    /** @type {object[]} */
    var edges = [];
    var seen = {};
    var add = function (a, b, type) {
      if (a === null || a === undefined || b === null || b === undefined) return;
      if (pos[a] === undefined || pos[b] === undefined) return;
      if (a === b) return;
      var pair = a < b ? a + '|' + b : b + '|' + a;
      var key = pair + '|' + type;
      if (seen[key] === true) return;
      seen[key] = true;
      edges.push({ a: a, b: b, type: type });
    };

    for (var e = 0; e < rows.length; e += 1) {
      var entry = rows[e];
      if (!entry) continue;
      var self = rowKey(entry);
      if (opts.rel !== false) {
        var related = Array.isArray(entry.related) ? entry.related : [];
        for (var r = 0; r < related.length; r += 1) add(self, memoryNodeOf[related[r]], 'rel');
      }
      var supersedes = Array.isArray(entry.supersedes) ? entry.supersedes : [];
      for (var s = 0; s < supersedes.length; s += 1) add(self, memoryNodeOf[supersedes[s]], 'sup');
      if (entry.supersededBy !== null && entry.supersededBy !== undefined) add(self, memoryNodeOf[entry.supersededBy], 'sup');
      if (opts.logs === true) {
        var links = Array.isArray(entry.relatedJournal) ? entry.relatedJournal : [];
        for (var l = 0; l < links.length; l += 1) add(self, journalNodeOf[links[l]], 'log');
      }
    }

    return { width: GRAPH_WIDTH, height: GRAPH_HEIGHT, nodes: nodes, edges: edges, pos: pos };
  }

  /**
   * 把上一次的坐标搬到新图上：切换开关或重算布局时**保留用户拖过的位置**。
   * @param {object} graph
   * @param {object|null} previousPos
   * @returns {object}
   */
  function copyPositions(graph, previousPos) {
    if (previousPos === null || previousPos === undefined) return graph;
    var pos = {};
    for (var i = 0; i < graph.nodes.length; i += 1) {
      var node = graph.nodes[i];
      var old = previousPos[node.id];
      if (old !== undefined && old !== null) {
        node.x = old.x;
        node.y = old.y;
      }
      pos[node.id] = node;
    }
    graph.pos = pos;
    return graph;
  }

  /** 图谱节点的拖动边界（画布内留一点边距）。 */
  var GRAPH_PADDING = 18;

  /** 拖动判定阈值（像素）：位移超过它才算拖，否则 pointerup 当点击。 */
  var DRAG_THRESHOLD = 2;

  // ────────────────────────── 面板组件 ──────────────────────────

  /**
   * 造面板组件（闭包持有 remote / sessions）。
   * @param {object} remote
   * @param {object} sessions
   * @param {Function} React
   * @returns {Function}
   */
  function makeMemoryPanel(remote, sessions, React) {
    var h = React.createElement;

    /**
     * 通过会话执行一行命令。
     * @param {string} sessionId
     * @param {string} line
     * @returns {Promise<object>}
     */
    var runCommand = async function (sessionId, line) {
      return await sessions.using(sessionId, { source: 'memoryPanel' }, async function (reference) {
        var snapshot = reference.binding.session.getSnapshot();
        if (snapshot.openState !== 'open') {
          throw new Error('会话未打开：' + (snapshot.openError && snapshot.openError.message ? snapshot.openError.message : sessionId));
        }
        return await reference.binding.session.command(line);
      });
    };

    /** 条目编号的展示文本。 */
    var idTextOf = function (entry) {
      return entry.id === null || entry.id === undefined ? '(无编号)' : String(entry.id);
    };

    /** 条目所属分组键（归档条目归「归档」组）。 */
    var groupKeyOf = function (entry) {
      if (entry.status === 'archived') return 'archived';
      return KIND_LABEL[entry.kind] === undefined ? 'fact' : entry.kind;
    };

    /**
     * 「在对话中修改」的建议指令。
     * 面板**不会**替用户发消息（用户明确要求）：只把这一行显示在提示条里，让用户自己复制。
     */
    var suggestEditLine = function (entry) {
      return '请修改 ' + idTextOf(entry) + ' 的详细：<把新的详细写在这里>';
    };

    /** 关系 chip：标签 + 可点击的编号。 */
    var relationChips = function (into, ui, label, ids, target) {
      if (!Array.isArray(ids) || ids.length === 0) return;
      into.push(h('span', { key: 'lb-' + label, className: 'dshmem-lb' }, label));
      for (var i = 0; i < ids.length; i += 1) {
        (function (id, index) {
          into.push(
            h(
              'button',
              {
                key: label + '-chip-' + index,
                type: 'button',
                className: 'dshmem-lnk',
                onClick: function () {
                  if (target === 'journal') ui.onOpenJournalId(id);
                  else ui.onJumpId(id);
                },
              },
              String(id),
            ),
          );
        })(ids[i], i);
      }
    };

    /**
     * 记忆条目的详情渲染（**记忆页行内展开与图谱下方共用同一份**）。
     * @param {object} entry
     * @param {object} ui 回调与小状态
     * @returns {object[]} 子元素数组
     */
    var detailChildren = function (entry, ui) {
      var children = [];
      // 解析器保证这些字段有形（detail 是字符串、tags 是数组），但手改/降级条目可能缺字段：
      // 面板宁可显示"（无详细）"也不能因为一条畸形数据把整页渲染炸掉。
      var detailText = entry.detail === null || entry.detail === undefined ? '' : String(entry.detail);
      var tags = Array.isArray(entry.tags) ? entry.tags : [];
      var metaParts = [
        idTextOf(entry),
        formatKind(entry.kind),
        entry.status,
        entry.priority,
        entry.confidence,
        String(entry.created || ''),
        idxCost(entry) + ' 字',
      ];
      var metaChildren = [];
      for (var m = 0; m < metaParts.length; m += 1) {
        if (m > 0) metaChildren.push(h('i', { key: 'sep' + m }, '·'));
        metaChildren.push(h('span', { key: 'meta' + m }, metaParts[m]));
      }
      children.push(h('div', { key: 'meta', className: 'dshmem-meta' }, metaChildren));
      children.push(h('div', { key: 'body', className: 'dshmem-body' }, detailText.length > 0 ? detailText : '（无详细）'));
      if (tags.length > 0) children.push(h('div', { key: 'tags', className: 'dshmem-tags' }, tags.join(' · ')));
      var chips = [];
      relationChips(chips, ui, '关联', entry.related, 'entry');
      relationChips(chips, ui, '取代', entry.supersedes, 'entry');
      if (entry.supersededBy !== null && entry.supersededBy !== undefined) relationChips(chips, ui, '被取代', [entry.supersededBy], 'entry');
      relationChips(chips, ui, '关联日志', entry.relatedJournal, 'journal');
      if (chips.length > 0) children.push(h('div', { key: 'links', className: 'dshmem-links' }, chips));
      if (entry.archivedAt !== null || entry.archivedReason !== null || entry.archivedStatusBefore !== null) {
        var archParts = [];
        if (entry.archivedAt !== null) archParts.push('归档时间 ' + entry.archivedAt);
        if (entry.archivedStatusBefore !== null) archParts.push('归档前状态 ' + entry.archivedStatusBefore);
        if (entry.archivedReason !== null) archParts.push('归档原因 ' + entry.archivedReason);
        children.push(h('div', { key: 'arch', className: 'dshmem-arch' }, archParts.join(' · ')));
      }
      var isArchived = entry.status === 'archived';
      children.push(
        h('div', { key: 'acts', className: 'dshmem-acts' }, [
          h('input', {
            key: 'reason',
            type: 'text',
            className: 'dshmem-input',
            value: ui.reason,
            placeholder: '归档原因（可选）',
            onChange: function (event) {
              ui.setReason(event.target.value);
            },
          }),
          h(
            'button',
            {
              key: 'act',
              type: 'button',
              className: 'dshmem-act' + (isArchived ? '' : ' dshmem-danger'),
              disabled: ui.busy === true,
              onClick: function () {
                ui.onAct(isArchived ? 'restore' : 'archive');
              },
            },
            isArchived ? '恢复' : '归档',
          ),
          h(
            'button',
            {
              key: 'ask',
              type: 'button',
              className: 'dshmem-act',
              onClick: function () {
                ui.onAsk();
              },
            },
            '在对话中修改',
          ),
        ]),
      );
      return children;
    };

    /** 日志条目的时刻（`J-20260929-1350` → `13:50`）。 */
    var timeOf = function (journal) {
      var m = /^J-\d{8}-(\d{2})(\d{2})/.exec(String(journal.id === null || journal.id === undefined ? '' : journal.id));
      return m === null ? '' : m[1] + ':' + m[2];
    };

    /**
     * 日志条目的详情：**把所有 fields 逐行渲染**（用户明确要求：原来只能看到"结果"，现在要能展开看详情），
     * 长文本（内容/详细/证据/后续…）用 pre-wrap 完整显示。
     * @param {object} journal
     * @returns {object[]}
     */
    var journalFieldChildren = function (journal) {
      var children = [];
      var fields = Array.isArray(journal.fields) ? journal.fields : [];
      var content = journal.content === null || journal.content === undefined ? '' : String(journal.content);
      var contentShown = false;
      for (var i = 0; i < fields.length; i += 1) {
        var field = fields[i];
        if (field.value === content && (field.name === '内容' || field.name === '详细' || field.name === '结果')) contentShown = true;
        children.push(
          h('div', { key: 'f' + i, className: 'dshmem-frow' }, [
            h('b', { key: 'n' }, field.name),
            h('span', { key: 'v', className: 'dshmem-fv' }, field.value),
          ]),
        );
      }
      // 解析器已经把「内容 → 详细 → 结果」的取值算进 content。若它没有作为上面某个字段露出来（例如
      // 字段名不在三者之列、或值被后一行续写改写），这里补一行，保证展开一定能看到正文。
      if (content.length > 0 && !contentShown) {
        children.push(
          h('div', { key: 'content', className: 'dshmem-frow' }, [
            h('b', { key: 'n' }, '内容'),
            h('span', { key: 'v', className: 'dshmem-fv' }, content),
          ]),
        );
      }
      if (children.length === 0) children.push(h('div', { key: 'none', className: 'dshmem-faint' }, '无字段'));
      return children;
    };

    /**
     * 记忆面板。
     * @param {{sessionId: string}} props
     * @returns {object}
     */
    return function MemoryPanel(props) {
      var sessionId = props.sessionId;

      var tabState = React.useState('memory');
      var tab = tabState[0];
      var setTab = tabState[1];
      var loadState = React.useState({ phase: 'loading' });
      var load = loadState[0];
      var setLoad = loadState[1];
      var reloadState = React.useState(0);
      var reload = reloadState[0];
      var setReload = reloadState[1];
      var openState = React.useState(['convention', 'fact', 'procedure', 'lesson']);
      var openGroups = openState[0];
      var setOpenGroups = openState[1];
      var expandedState = React.useState(null);
      var expandedKey = expandedState[0];
      var setExpandedKey = expandedState[1];
      var reasonState = React.useState('');
      var reason = reasonState[0];
      var setReason = reasonState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var noticeState = React.useState('');
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var journalOpenState = React.useState([]);
      var openEvents = journalOpenState[0];
      var setOpenEvents = journalOpenState[1];
      var graphLogsState = React.useState(false);
      var graphLogs = graphLogsState[0];
      var setGraphLogs = graphLogsState[1];
      var graphRelState = React.useState(true);
      var graphRel = graphRelState[0];
      var setGraphRel = graphRelState[1];
      var graphSelState = React.useState(null);
      var graphSel = graphSelState[0];
      var setGraphSel = graphSelState[1];
      var graphHoverState = React.useState(null);
      var graphHover = graphHoverState[0];
      var setGraphHover = graphHoverState[1];
      var dragState = React.useState(null);
      var dragId = dragState[0];
      var setDragId = dragState[1];
      // 拖动过程中的重绘节流：坐标写在 ref 里（不触发渲染），每个动画帧 tick 一次。
      // `tick` 只用来**触发重渲染**（渲染时直接读 ref 里的最新坐标），值本身不参与渲染。
      var tickState = React.useState(0);
      var setTick = tickState[1];

      var rowRefs = React.useRef({});
      var eventRefs = React.useRef({});
      var pendingScroll = React.useRef(null);
      var graphRef = React.useRef(null);
      var dragRef = React.useRef(null);
      var frameRef = React.useRef(0);

      React.useEffect(
        function () {
          var cancelled = false;
          var controller = typeof AbortController === 'function' ? new AbortController() : null;
          setLoad({ phase: 'loading' });
          loadModel(remote, sessionId, controller ? controller.signal : undefined).then(
            function (model) {
              if (!cancelled) setLoad({ phase: 'ready', model: model });
            },
            function (error) {
              if (cancelled) return;
              var code = error && error.code ? error.code : '';
              if (code === 'workspace-file/not-found') setLoad({ phase: 'empty' });
              else setLoad({ phase: 'error', message: error && error.message ? error.message : String(error) });
            },
          );
          return function () {
            cancelled = true;
            if (controller) controller.abort();
          };
        },
        [sessionId, reload],
      );

      // 卸载时收掉没跑完的动画帧，避免对着已卸载组件 setState
      React.useEffect(function () {
        return function () {
          if (frameRef.current !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current);
          frameRef.current = 0;
        };
      }, []);

      // 跳转后的滚动（每次渲染后检查一次待办；没有待办时立即返回）
      React.useEffect(function () {
        var target = pendingScroll.current;
        if (target === null) return;
        pendingScroll.current = null;
        var store = target.kind === 'journal' ? eventRefs.current : rowRefs.current;
        var el = store[target.key];
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
      });

      /** 把 DOM 节点登记进 ref 表（React 卸载时会用 null 回调）。 */
      var refSetter = function (store, key) {
        return function (el) {
          if (el === null || el === undefined) delete store.current[key];
          else store.current[key] = el;
        };
      };

      /**
       * 归档 / 恢复：命令只表示"受理"，成败是对话流里的节点，不会回传到面板。
       * @param {object} entry
       * @param {'archive'|'restore'} action
       */
      var act = function (entry, action) {
        if (entry === null || entry === undefined) return;
        setBusy(true);
        setNotice('');
        var line;
        try {
          line = buildActionLine(action, entry.id, action === 'archive' ? reason : '');
        } catch (error) {
          setBusy(false);
          setNotice(String(error && error.message ? error.message : error));
          return;
        }
        runCommand(sessionId, line).then(
          function (result) {
            setBusy(false);
            if (result && result.ok === true) {
              if (result.value && result.value.matched === false) {
                setNotice('宿主未识别该命令（可能是不支持 /memory 的旧版本）');
              } else {
                // 命令返回值只表示"被受理"：handler 的成败是对话流里的节点，不会回传到面板
                // （契约：outcomes render as flow nodes, never as a response echo）。
                setNotice((action === 'archive' ? '已提交归档 ' : '已提交恢复 ') + (entry.id || '(无编号)') + '；结果见对话流');
                setReason('');
              }
              setReload(reload + 1);
            } else {
              setNotice('命令失败：' + (result && result.error && result.error.message ? result.error.message : '未知错误'));
            }
          },
          function (error) {
            setBusy(false);
            setNotice('命令失败：' + (error && error.message ? error.message : String(error)));
          },
        );
      };

      var toggleGroup = function (key) {
        setOpenGroups(function (prev) {
          if (prev.indexOf(key) === -1) return prev.concat([key]);
          var next = [];
          for (var i = 0; i < prev.length; i += 1) if (prev[i] !== key) next.push(prev[i]);
          return next;
        });
      };

      var toggleEvent = function (key) {
        setOpenEvents(function (prev) {
          if (prev.indexOf(key) === -1) return prev.concat([key]);
          var next = [];
          for (var i = 0; i < prev.length; i += 1) if (prev[i] !== key) next.push(prev[i]);
          return next;
        });
      };

      var model = load.phase === 'ready' ? load.model : null;
      var allRows = model === null ? [] : model.entries.concat(model.archived);
      var stats = injectionStats(allRows, model === null ? [] : model.journals, SNAPSHOT_BUDGET);

      /** 在记忆行里按编号找一条（同编号重复时取第一条）。 */
      var findEntryById = function (id) {
        for (var i = 0; i < allRows.length; i += 1) {
          if (allRows[i].id !== null && allRows[i].id !== undefined && String(allRows[i].id) === String(id)) return allRows[i];
        }
        return null;
      };

      /** 在日志里按编号找一条。 */
      var findJournalById = function (id) {
        if (model === null) return null;
        for (var i = 0; i < model.journals.length; i += 1) {
          var journal = model.journals[i];
          if (journal.id !== null && journal.id !== undefined && String(journal.id) === String(id)) return journal;
        }
        return null;
      };

      /** 在记忆列表里打开一条并滚到它。 */
      var openEntryInList = function (entry) {
        setTab('memory');
        setExpandedKey(rowKey(entry));
        var key = groupKeyOf(entry);
        setOpenGroups(function (prev) {
          return prev.indexOf(key) === -1 ? prev.concat([key]) : prev;
        });
        pendingScroll.current = { kind: 'entry', key: rowKey(entry) };
        setNotice('');
      };

      /** 在日志页打开一条并滚到它。 */
      var openJournalInTimeline = function (journal) {
        setTab('journal');
        var key = rowKey(journal);
        setOpenEvents(function (prev) {
          return prev.indexOf(key) === -1 ? prev.concat([key]) : prev;
        });
        pendingScroll.current = { kind: 'journal', key: key };
        setNotice('');
      };

      var jumpToEntryId = function (id) {
        var entry = findEntryById(id);
        if (entry === null) {
          setNotice('没有找到条目 ' + String(id) + '（可能已被归档或编号被改）');
          return;
        }
        openEntryInList(entry);
      };

      var jumpToJournalId = function (id) {
        var journal = findJournalById(id);
        if (journal === null) {
          setNotice('没有找到日志 ' + String(id));
          return;
        }
        openJournalInTimeline(journal);
      };

      // ── 图谱拖动：pointerdown 抓取 → pointermove 改坐标 → pointerup 定夺（没移动就算点击） ──

      /** 屏幕坐标 → viewBox 坐标的比例。事件挂在 <svg> 上，currentTarget 就是它。 */
      var svgMetrics = function (svg) {
        if (!svg || typeof svg.getBoundingClientRect !== 'function') return null;
        var rect = svg.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) return null;
        return { rect: rect, sx: GRAPH_WIDTH / rect.width, sy: GRAPH_HEIGHT / rect.height };
      };

      /**
       * 找事件目标所属的节点。
       * 注意：SVG 子元素不是 HTMLElement，**不能**用 `instanceof Element` 之类的守卫，
       * 否则在图谱上按节点时会静默失效（踩过这个坑）。这里只要求目标有 closest。
       */
      var closestNodeId = function (target) {
        if (!target || typeof target.closest !== 'function') return null;
        var node = target.closest('[data-node]');
        if (!node || typeof node.getAttribute !== 'function') return null;
        return node.getAttribute('data-node');
      };

      var scheduleRepaint = function () {
        if (frameRef.current !== 0) return;
        var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (cb) { return setTimeout(cb, 16); };
        frameRef.current = raf(function () {
          frameRef.current = 0;
          setTick(function (value) {
            return value + 1;
          });
        });
      };

      var onPointerDown = function (event) {
        if (event.button !== undefined && event.button !== 0 && event.pointerType === 'mouse') return;
        var id = closestNodeId(event.target);
        if (id === null) return;
        var graph = graphRef.current;
        if (!graph || graph.pos[id] === undefined) return;
        var metrics = svgMetrics(event.currentTarget);
        if (metrics === null) return;
        var point = graph.pos[id];
        dragRef.current = {
          id: id,
          originX: point.x,
          originY: point.y,
          dx: point.x - (event.clientX - metrics.rect.left) * metrics.sx,
          dy: point.y - (event.clientY - metrics.rect.top) * metrics.sy,
          moved: false,
        };
        setDragId(id);
        // 指针捕获：移出 <svg> 后仍收得到 pointermove/pointerup
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch (error) {
            // 不支持捕获的环境照样能拖（只是移出画布会丢事件）
          }
        }
        if (typeof event.preventDefault === 'function') event.preventDefault();
      };

      var onPointerMove = function (event) {
        var drag = dragRef.current;
        if (drag === null) return;
        var graph = graphRef.current;
        if (!graph || graph.pos[drag.id] === undefined) return;
        var metrics = svgMetrics(event.currentTarget);
        if (metrics === null) return;
        var point = graph.pos[drag.id];
        var nextX = (event.clientX - metrics.rect.left) * metrics.sx + drag.dx;
        var nextY = (event.clientY - metrics.rect.top) * metrics.sy + drag.dy;
        point.x = Math.max(GRAPH_PADDING, Math.min(GRAPH_WIDTH - GRAPH_PADDING, nextX));
        point.y = Math.max(GRAPH_PADDING, Math.min(GRAPH_HEIGHT - GRAPH_PADDING, nextY));
        // 阈值看的是**相对按下点**的总位移（不是上一帧的位移），否则慢速小步拖动会被误判成点击
        if (Math.abs(point.x - drag.originX) > DRAG_THRESHOLD || Math.abs(point.y - drag.originY) > DRAG_THRESHOLD) drag.moved = true;
        scheduleRepaint();
      };

      var onPointerUp = function (event) {
        var drag = dragRef.current;
        if (drag === null) return;
        dragRef.current = null;
        setDragId(null);
        if (typeof event.currentTarget.releasePointerCapture === 'function' && event.pointerId !== undefined) {
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch (error) {
            // 没捕获成功时释放会抛错，忽略
          }
        }
        if (drag.moved) {
          setTick(function (value) {
            return value + 1;
          });
          return;
        }
        // 没超过阈值 = 点击：选中/取消选中该节点（详情开在图下方）
        setGraphSel(function (prev) {
          return prev === drag.id ? null : drag.id;
        });
      };

      var resetGraph = function () {
        graphRef.current = null;
        setGraphSel(null);
        setTick(function (value) {
          return value + 1;
        });
        setNotice('布局已重置');
      };

      /** 组装整个面板（包在 try/catch 里：任何异常都不许抛到 UI 外）。 */
      var buildShell = function () {
        var headerChildren = [
          h('span', { key: 'title', className: 'dshmem-title' }, '记忆'),
          h(
            'span',
            { key: 'stat', className: 'dshmem-stat' },
            [
              // "N 条" 只数**参与注入**的条目（active + candidate），与右侧字数同一口径；
              // 归档条目与已取代条目不参与会话边界注入，故不混进这个数——归档另起一段单独显示。
              h('b', { key: 'n' }, formatNumber(stats.injectable)),
              ' 条 · 注入 ',
              h('b', { key: 'x' }, formatNumber(stats.total)),
              ' / ' + formatNumber(stats.budget) + ' 字',
            ].concat(
              model !== null && model.archived.length > 0
                ? [' · 归档 ', h('b', { key: 'a' }, formatNumber(model.archived.length))]
                : [],
            ),
          ),
          h('span', { key: 'grow', className: 'dshmem-grow' }),
          h(
            'button',
            {
              key: 'refresh',
              type: 'button',
              className: 'dshmem-ghost',
              onClick: function () {
                setReload(reload + 1);
              },
            },
            '刷新',
          ),
        ];

        var barChildren = [];
        if (model !== null) {
          var percent = function (chars) {
            var ratio = (chars / stats.budget) * 100;
            return Math.max(0, Math.min(100, ratio)) + '%';
          };
          barChildren.push(h('span', { key: 'pinned', className: 'dshmem-bar-pinned', style: { width: percent(stats.pinned) } }));
          barChildren.push(h('span', { key: 'index', className: 'dshmem-bar-index', style: { width: percent(stats.index) } }));
          barChildren.push(h('span', { key: 'journal', className: 'dshmem-bar-journal', style: { width: percent(stats.journal) } }));
        }

        var navChildren = [
          h(
            'button',
            {
              key: 'tab-memory',
              type: 'button',
              'aria-selected': tab === 'memory' ? 'true' : 'false',
              onClick: function () {
                setTab('memory');
              },
            },
            ['记忆', h('span', { key: 'n', className: 'dshmem-n' }, model === null ? '' : String(stats.injectable))],
          ),
          h(
            'button',
            {
              key: 'tab-journal',
              type: 'button',
              'aria-selected': tab === 'journal' ? 'true' : 'false',
              onClick: function () {
                setTab('journal');
              },
            },
            ['日志', h('span', { key: 'n', className: 'dshmem-n' }, model === null ? '' : String(model.journals.length))],
          ),
          h(
            'button',
            {
              key: 'tab-graph',
              type: 'button',
              'aria-selected': tab === 'graph' ? 'true' : 'false',
              onClick: function () {
                setTab('graph');
              },
            },
            '图谱',
          ),
        ];

        var main = null;
        if (load.phase === 'loading') {
          main = h('div', { key: 'main', className: 'dshmem-main' }, h('div', { className: 'dshmem-phase' }, '正在读取 ' + MEMORY_DIR + '/ …'));
        } else if (load.phase === 'empty') {
          main = h(
            'div',
            { key: 'main', className: 'dshmem-main' },
            h(
              'div',
              { className: 'dshmem-phase' },
              '该项目还没有记忆目录（' + MEMORY_DIR + '/）。用记忆工具写入第一条后回来刷新。'
                + '（面板只读 ' + MEMORY_DIR + '/；若本项目把配置 memoryDirName 改成了别的目录名，面板目前看不到内容。）',
            ),
          );
        } else if (load.phase === 'error') {
          main = h('div', { key: 'main', className: 'dshmem-main' }, h('div', { className: 'dshmem-phase' }, '读取失败：' + load.message));
        } else if (tab === 'journal') {
          main = h('div', { key: 'main', className: 'dshmem-main' }, buildJournalView());
        } else if (tab === 'graph') {
          main = h('div', { key: 'main', className: 'dshmem-main' }, buildGraphView());
        } else {
          main = h('div', { key: 'main', className: 'dshmem-main' }, buildMemoryView());
        }

        var noticeBar =
          notice.length === 0
            ? null
            : h('div', { key: 'notice', className: 'dshmem-notice' }, [
                h('span', { key: 'line', className: 'dshmem-note-line' }, notice),
                h(
                  'button',
                  {
                    key: 'close',
                    type: 'button',
                    className: 'dshmem-ghost',
                    onClick: function () {
                      setNotice('');
                    },
                  },
                  '关闭',
                ),
              ]);

        return h('div', { className: 'dshmem-root' }, [
          h('div', { key: 'bar', className: 'dshmem-bar' }, barChildren),
          h('div', { key: 'header', className: 'dshmem-header' }, headerChildren),
          h('div', { key: 'nav', className: 'dshmem-nav' }, navChildren),
          noticeBar,
          main,
        ]);
      };

      /** 记忆页：按类型分组 + 行内手风琴。 */
      var buildMemoryView = function () {
        var groups = groupByKind(model.entries, model.archived);
        var children = [];
        var visible = 0;
        for (var g = 0; g < groups.length; g += 1) {
          var group = groups[g];
          if (group.items.length === 0) continue;
          visible += 1;
          var open = openGroups.indexOf(group.key) !== -1;
          children.push(
            h(
              'div',
              {
                key: 'gh-' + group.key,
                className: 'dshmem-gh dshmem-g-' + group.key,
                'data-open': open ? 'true' : 'false',
                role: 'button',
                onClick: function () {
                  var key = group.key;
                  return function () {
                    toggleGroup(key);
                  };
                }(),
              },
              [
                h('span', { key: 'ico', className: 'dshmem-ico-wrap' }, iconElement(h, group.key, 'dshmem-gh-ico')),
                h('span', { key: 'name' }, group.label),
                h(
                  'span',
                  { key: 'cnt', className: 'dshmem-cnt' },
                  // 归档组/全是已取代的组不参与注入，"字数"为 0 时不显示，免得读成"这条数占了 0 字"
                  group.cost > 0 ? group.items.length + ' · ' + formatNumber(group.cost) + ' 字' : String(group.items.length),
                ),
                h('span', { key: 'caret', className: 'dshmem-caret' }, iconElement(h, 'caret')),
              ],
            ),
          );
          if (!open) continue;
          for (var i = 0; i < group.items.length; i += 1) {
            // ⚠️ 必须用立即执行的闭包把 entry 钉住：`var` 是函数作用域，若让 onAct / onAsk 直接
            // 捕获循环变量，它们会读到**循环结束后**的那个 entry —— 点 #0001 的「归档」会去归档
            // 最后渲染的那一条（这正是 rowKey 改造要防的"错目标"问题的另一种形态；真渲染冒烟抓到的）。
            (function (entry) {
              var key2 = rowKey(entry);
              var expanded = expandedKey === key2;
              var idChildren = [];
              if (entry.pinned === true) {
                idChildren.push(h('span', { key: 'star', className: 'dshmem-star' }, '★'));
                idChildren.push(' ');
              }
              idChildren.push(idTextOf(entry));
              children.push(
                h(
                  'div',
                  {
                    key: 'row-' + key2,
                    className: 'dshmem-r',
                    'aria-expanded': expanded ? 'true' : 'false',
                    ref: refSetter(rowRefs, key2),
                    onClick: function () {
                      setExpandedKey(function (prev) {
                        return prev === key2 ? null : key2;
                      });
                    },
                  },
                  [
                    h('span', { key: 'id', className: 'dshmem-id' }, idChildren),
                    h('span', { key: 'title', className: 'dshmem-t', title: entry.title }, entry.title),
                    entry.status === 'superseded' ? h('span', { key: 'off', className: 'dshmem-off' }, '已取代') : null,
                    h('span', { key: 'cost', className: 'dshmem-c' }, String(idxCost(entry))),
                  ],
                ),
              );
              if (!expanded) return;
              // 手风琴：同时只开一条；展开区紧跟在该行下方，左侧 2px 强调竖线
              children.push(
                h(
                  'div',
                  { key: 'exp-' + key2, className: 'dshmem-exp' },
                  detailChildren(entry, {
                    reason: reason,
                    setReason: setReason,
                    busy: busy,
                    onAct: function (action) {
                      act(entry, action);
                    },
                    onAsk: function () {
                      setNotice('建议指令（复制到对话框自行发送）：' + suggestEditLine(entry));
                    },
                    onJumpId: jumpToEntryId,
                    onOpenJournalId: jumpToJournalId,
                  }),
                ),
              );
            })(group.items[i]);
          }
        }
        if (visible === 0) children.push(h('div', { key: 'none', className: 'dshmem-phase' }, '没有解析出任何条目。'));
        if (model.notices.length > 0) children.push(h('div', { key: 'notices', className: 'dshmem-notices' }, model.notices.join('；')));
        return h('div', { className: 'dshmem-wrap' }, children);
      };

      /** 日志页：按日期倒序 + 时间线 + 展开看全部字段。 */
      var buildJournalView = function () {
        var journals = model.journals;
        if (journals.length === 0) return h('div', { className: 'dshmem-wrap' }, h('div', { className: 'dshmem-phase' }, '没有日志'));
        var days = [];
        for (var i = 0; i < journals.length; i += 1) {
          if (days.indexOf(journals[i].date) === -1) days.push(journals[i].date);
        }
        days.sort();
        days.reverse();
        var children = [];
        for (var d = 0; d < days.length; d += 1) {
          var day = days[d];
          var items = [];
          for (var j = 0; j < journals.length; j += 1) if (journals[j].date === day) items.push(journals[j]);
          children.push(
            h('div', { key: 'day-' + day, className: 'dshmem-day' }, [
              day,
              h('span', { key: 'rule', className: 'dshmem-rule' }),
              h('span', { key: 'cnt', className: 'dshmem-faint' }, String(items.length)),
            ]),
          );
          var events = [];
          for (var e = 0; e < items.length; e += 1) {
            var journal = items[e];
            var key = rowKey(journal);
            var open = openEvents.indexOf(key) !== -1;
            var eventChildren = [
              h('div', { key: 't', className: 'dshmem-time dshmem-mono' }, timeOf(journal)),
              h('div', { key: 'h', className: 'dshmem-evh' }, [
                h('span', { key: 'id', className: 'dshmem-id' }, journal.id === null || journal.id === undefined ? '(无编号)' : String(journal.id)),
                h('span', { key: 'ti', className: 'dshmem-ti' }, journal.title),
              ]),
            ];
            if (open) eventChildren.push(h('div', { key: 'f', className: 'dshmem-f' }, journalFieldChildren(journal)));
            events.push(
              h(
                'div',
                {
                  key: 'ev-' + key,
                  className: 'dshmem-ev',
                  'aria-expanded': open ? 'true' : 'false',
                  ref: refSetter(eventRefs, key),
                  onClick: function () {
                    var target = key;
                    return function () {
                      toggleEvent(target);
                    };
                  }(),
                },
                eventChildren,
              ),
            );
          }
          children.push(h('div', { key: 'tl-' + day, className: 'dshmem-tl' }, events));
        }
        if (model.notices.length > 0) children.push(h('div', { key: 'notices', className: 'dshmem-notices' }, model.notices.join('；')));
        return h('div', { className: 'dshmem-wrap' }, children);
      };

      /** 图谱页：工具条 + 确定性布局（拖动坐标保留在 ref 里）+ 节点详情。 */
      var buildGraphView = function () {
        var cache = graphRef.current;
        if (cache === null || cache.model !== model || cache.logs !== graphLogs || cache.rel !== graphRel) {
          var previous = cache === null ? null : cache.pos;
          var built = buildGraph(allRows, model.journals, { logs: graphLogs, rel: graphRel });
          cache = copyPositions(built, previous);
          cache.model = model;
          cache.logs = graphLogs;
          cache.rel = graphRel;
          graphRef.current = cache;
        }

        var focus = dragId !== null ? dragId : graphHover !== null ? graphHover : graphSel;
        var near = {};
        if (focus !== null) {
          near[focus] = true;
          for (var e = 0; e < cache.edges.length; e += 1) {
            if (cache.edges[e].a === focus) near[cache.edges[e].b] = true;
            if (cache.edges[e].b === focus) near[cache.edges[e].a] = true;
          }
        }

        var svgChildren = [];
        for (var c = 0; c < GRAPH_KINDS.length; c += 1) {
          var kind = GRAPH_KINDS[c];
          var center = GRAPH_CENTERS[kind];
          var labelY = kind === 'lesson' || kind === 'archived' ? center[1] + 108 : center[1] - 118;
          svgChildren.push(
            h('g', { key: 'cluster-' + kind, className: 'dshmem-cluster' }, h('text', { x: center[0] - 30, y: labelY, textAnchor: 'middle' }, GRAPH_LABEL[kind])),
          );
        }
        if (graphLogs === true) {
          var journalCenter = GRAPH_CENTERS.journal;
          svgChildren.push(
            h('g', { key: 'cluster-journal', className: 'dshmem-cluster' }, h('text', { x: journalCenter[0] - 30, y: journalCenter[1] + 108, textAnchor: 'middle' }, '日志')),
          );
        }

        for (var i = 0; i < cache.edges.length; i += 1) {
          var edge = cache.edges[i];
          var from = cache.pos[edge.a];
          var to = cache.pos[edge.b];
          if (from === undefined || to === undefined) continue;
          var midX = (from.x + to.x) / 2;
          var midY = (from.y + to.y) / 2 - Math.abs(from.x - to.x) * 0.08 - 10;
          var on = focus !== null && (edge.a === focus || edge.b === focus);
          svgChildren.push(
            h('path', {
              key: 'edge-' + i,
              className: 'dshmem-edge dshmem-edge-' + edge.type + (on ? ' dshmem-edge-on' : ''),
              d: 'M' + from.x + ' ' + from.y + ' Q' + midX + ' ' + midY + ' ' + to.x + ' ' + to.y,
            }),
          );
        }

        for (var n = 0; n < cache.nodes.length; n += 1) {
          var node = cache.nodes[n];
          var dim = focus !== null && near[node.id] !== true;
          svgChildren.push(
            h(
              'g',
              {
                key: 'node-' + node.id,
                className:
                  'dshmem-node dshmem-kind-' + node.kind
                  + (dim ? ' dshmem-dim' : '')
                  + (focus === node.id ? ' dshmem-on' : '')
                  + (dragId === node.id ? ' dshmem-dragging' : ''),
                'data-node': node.id,
                onMouseEnter: function () {
                  var target = node.id;
                  return function () {
                    if (dragRef.current === null) setGraphHover(target);
                  };
                }(),
                onMouseLeave: function () {
                  var target = node.id;
                  return function () {
                    setGraphHover(function (prev) {
                      return prev === target ? null : prev;
                    });
                  };
                }(),
              },
              [
                h('circle', { key: 'hit', className: 'dshmem-hit', cx: node.x, cy: node.y, r: node.r + 7 }),
                h('circle', { key: 'dot', className: 'dshmem-dot', cx: node.x, cy: node.y, r: node.r }),
                h('text', { key: 'label', className: 'dshmem-node-label', x: node.x + node.r + 4, y: node.y + 3.5 }, node.label),
              ],
            ),
          );
        }

        var svg = h(
          'svg',
          {
            key: 'svg',
            className: 'dshmem-svg',
            viewBox: '0 0 ' + cache.width + ' ' + cache.height,
            preserveAspectRatio: 'xMidYMid meet',
            onPointerDown: onPointerDown,
            onPointerMove: onPointerMove,
            onPointerUp: onPointerUp,
            onPointerCancel: onPointerUp,
          },
          svgChildren,
        );

        var hoverNode = graphHover === null ? undefined : cache.pos[graphHover];
        var caption =
          hoverNode === undefined
            ? h('div', { key: 'cap', className: 'dshmem-gcap dshmem-faint' }, '点节点看详情 · 拖动可移动 · 连线的两端是关联关系')
            : h('div', { key: 'cap', className: 'dshmem-gcap' }, [h('b', { key: 'id' }, hoverNode.label), h('span', { key: 't' }, hoverNode.entry.title)]);

        var detail = null;
        var selected = graphSel === null ? undefined : cache.pos[graphSel];
        if (selected !== undefined) {
          var nodeUi = {
            reason: reason,
            setReason: setReason,
            busy: busy,
            onAct: function (action) {
              act(selected.entry, action);
            },
            onAsk: function () {
              setNotice('建议指令（复制到对话框自行发送）：' + suggestEditLine(selected.entry));
            },
            onJumpId: jumpToEntryId,
            onOpenJournalId: jumpToJournalId,
          };
          var detailChildrenList = [
            h('div', { key: 'ghd', className: 'dshmem-ghd' }, [
              h('span', { key: 'who', className: 'dshmem-who' }, selected.label + (selected.isJournal === true ? ' · 日志详情' : ' · 详情')),
              h('span', { key: 'grow', className: 'dshmem-grow' }),
              h(
                'button',
                {
                  key: 'open',
                  type: 'button',
                  className: 'dshmem-lnk',
                  onClick: function () {
                    if (selected.isJournal === true) {
                      openJournalInTimeline(selected.entry);
                    } else {
                      openEntryInList(selected.entry);
                    }
                  },
                },
                selected.isJournal === true ? '在日志里打开' : '在记忆里打开',
              ),
              h(
                'button',
                {
                  key: 'close',
                  type: 'button',
                  className: 'dshmem-ghost',
                  onClick: function () {
                    setGraphSel(null);
                  },
                },
                '关闭',
              ),
            ]),
          ];
          if (selected.isJournal === true) {
            detailChildrenList.push(h('div', { key: 'fields', className: 'dshmem-f' }, journalFieldChildren(selected.entry)));
          } else {
            detailChildrenList = detailChildrenList.concat(detailChildren(selected.entry, nodeUi));
          }
          detail = h('div', { key: 'gdetail', className: 'dshmem-gdetail' }, detailChildrenList);
        }

        return h('div', { className: 'dshmem-wrap' }, [
          h('div', { key: 'bar', className: 'dshmem-graphbar' }, [
            h(
              'button',
              {
                key: 'logs',
                type: 'button',
                className: 'dshmem-ghost',
                'aria-pressed': graphLogs === true ? 'true' : 'false',
                onClick: function () {
                  setGraphLogs(!graphLogs);
                },
              },
              '含日志',
            ),
            h(
              'button',
              {
                key: 'rel',
                type: 'button',
                className: 'dshmem-ghost',
                'aria-pressed': graphRel === true ? 'true' : 'false',
                onClick: function () {
                  setGraphRel(!graphRel);
                },
              },
              '关联',
            ),
            h(
              'button',
              {
                key: 'reset',
                type: 'button',
                className: 'dshmem-ghost',
                onClick: resetGraph,
              },
              '重置布局',
            ),
            h('span', { key: 'hint', className: 'dshmem-hint' }, '拖动可移动节点 · 圆点大小 = 单条注入字数'),
          ]),
          h('div', { key: 'graph', className: 'dshmem-graph' }, svg),
          caption,
          detail,
        ]);
      };

      try {
        return buildShell();
      } catch (error) {
        return h(
          'div',
          { className: 'dshmem-root' },
          h('div', { className: 'dshmem-phase' }, '面板渲染失败：' + (error && error.message ? error.message : String(error))),
        );
      }
    };
  }

  // ══════════════════════════ 挂载 ══════════════════════════

  /** 可测试的纯函数出口。 */
  var PURE_EXPORTS = {
    KINDS: KINDS,
    KIND_LABEL: KIND_LABEL,
    LABEL_KIND: LABEL_KIND,
    formatKind: formatKind,
    parseMemoryFile: parseMemoryFile,
    parseJournalFile: parseJournalFile,
    fieldValueOf: fieldValueOf,
    groupByStatus: groupByStatus,
    sortForDisplay: sortForDisplay,
    rowKey: rowKey,
    buildActionLine: buildActionLine,
    splitList: splitList,
    fileDateOf: fileDateOf,
    matchFieldLine: matchFieldLine,
    depthOf: depthOf,
    makeMemoryPanel: makeMemoryPanel,
    MEMORY_DIR: MEMORY_DIR,
    // UI 段新增的纯函数 / 常量（桩 DOM 冒烟与后续回归用）
    CSS: CSS,
    ICON: ICON,
    installStyle: installStyle,
    formatNumber: formatNumber,
    idxCost: idxCost,
    pinnedCost: pinnedCost,
    logCost: logCost,
    injectionStats: injectionStats,
    groupByKind: groupByKind,
    buildGraph: buildGraph,
    copyPositions: copyPositions,
    SNAPSHOT_BUDGET: SNAPSHOT_BUDGET,
    GRAPH_WIDTH: GRAPH_WIDTH,
    GRAPH_HEIGHT: GRAPH_HEIGHT,
  };

  /** 插件对象工厂。 */
  var createPlugin = function (React) {
    /**
     * @param {object} ctx 客户端 Cordis 上下文
     */
    var apply = function (ctx) {
      var panel = makeMemoryPanel(ctx.remote, ctx.sessions, React);
      ctx.effect(
        function () {
          // 样式注入与槽位注册合并在**同一个** effect 里：随插件卸载一起撤销，
          // 也保持 `ctx.effect` 只被调用一次（test/panel-loader.test.js 的契约）。
          var uninstallStyle = null;
          if (typeof document !== 'undefined' && document !== null && document.head) {
            try {
              uninstallStyle = installStyle(document);
            } catch (error) {
              uninstallStyle = null;
            }
          }
          var dispose = ctx.slots.inject('conversation.view', function () {
            return ctx.slots.register(
              {
                name: 'conversation.view',
                id: 'memory',
                order: 20,
                label: function () {
                  return '记忆';
                },
              },
              panel,
            );
          });
          return function () {
            if (uninstallStyle !== null) {
              try {
                uninstallStyle();
              } catch (error) {
                // 卸载期不再抛错
              }
            }
            if (typeof dispose === 'function') dispose();
          };
        },
        'dsh-memory: 记忆视图（含面板样式）',
      );
    };

    return {
      name: 'dsh-memory-panel',
      inject: ['slots', 'remote', 'remote.workspaceFiles', 'sessions'],
      apply: apply,
    };
  };

  // 浏览器：交给宿主模块加载器
  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: 'dsh-memory',
      factory: function (require) {
        var module = { exports: {} };
        var React = require('react');
        module.exports = createPlugin(React);
        return module.exports;
      },
    });
  }

  // Node（测试）：把纯函数区交出去
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PURE_EXPORTS;
  }
})();
