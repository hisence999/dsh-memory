/**
 * 插件配置：默认值、校验与回退。
 *
 * 设计依据：§2.1（路径固定，不提供路径配置）、§5.6（长度上限）、§9.2／§9.3（注入构成与预算）、
 * §12（锁超时）、§17.6（提醒开关）、§7.0（子代理逃生门）。
 * 纪律（手册 §8.1）：`apply` 顶层抛异常会让整个 profile 加载失败，因此这里
 * **非法值一律回退默认值并记 warn，绝不抛错**。
 */

/** 插件名：进日志、进 `MessageSource.plugin`、进固定提示词的自指文本。 */
export const PLUGIN_NAME = 'memory';

/** 提示词贡献的 name（必须全局唯一，重名注册会抛异常 → 一律带插件前缀）。 */
export const PROMPT_NAME = 'memory:context';

/** 提示词贡献的 order（不同 order 按升序拼接）。 */
export const PROMPT_ORDER = 50;

/** 快照标签（设计 §10.3：所有会话保持一致）。 */
export const SNAPSHOT_TAGS = Object.freeze({
  open: '<project_memory_snapshot>',
  close: '</project_memory_snapshot>',
});

/**
 * 解析后的完整配置（每个键都有值）。
 * @typedef {object} MemoryConfig
 * @property {boolean} enabled
 * @property {string} memoryDirName
 * @property {number} maxSnapshotChars
 * @property {number} maxPinnedItems
 * @property {number} maxIndexItems
 * @property {number} maxJournalItems
 * @property {number} maxTitleChars
 * @property {number} detailMaxChars
 * @property {number} itemMaxChars
 * @property {number} maxSearchLimit
 * @property {number} lockTimeoutMs
 * @property {number} staleLockMs
 * @property {boolean} remindOnDelivery
 * @property {number} completionIdleTurns
 * @property {number} reminderCooldownTurns
 * @property {string} reminderPrefix
 * @property {boolean} includeSubagents
 */

/** 默认配置（与 cordis.patch.yml 的键一一对应）。 */
/** @type {MemoryConfig} */
export const DEFAULTS = Object.freeze({
  enabled: true,
  memoryDirName: 'memory',
  // §9.3 注入预算
  maxSnapshotChars: 6000,
  maxPinnedItems: 10,
  // 2026-09-20 交付后调整：40 → 100（用户要求）。注意 6000 字符是**共享总额**，
  // 索引段条数抬高后**并不会**多出字符预算——条数上限只是兜底，先撞到的仍是字符上限。
  maxIndexItems: 100,
  // §9.2 日志标题注入：`[项目日志]` 段条数上限（0 = 关闭该能力）
  maxJournalItems: 100,
  // §5.6 长度上限
  maxTitleChars: 160,
  detailMaxChars: 8000,
  itemMaxChars: 8600,
  // §7.4 单次 ids 上限
  maxSearchLimit: 10,
  // §12 跨进程锁
  lockTimeoutMs: 5000,
  staleLockMs: 60000,
  // §17 交付完成提醒
  remindOnDelivery: true,
  completionIdleTurns: 1,
  reminderCooldownTurns: 1,
  reminderPrefix: '[记忆插件]',
  // §7.0 子代理逃生门（默认严格隔离）
  includeSubagents: false,
});

/**
 * 整数键的合法区间：越界或非整数即回退默认并记 warn。
 * @type {Array<[keyof typeof DEFAULTS, number, number]>}
 */
const INT_KEYS = [
  ['maxSnapshotChars', 200, 100_000],
  ['maxPinnedItems', 0, 200],
  ['maxIndexItems', 0, 500],
  ['maxJournalItems', 0, 1000],
  ['maxTitleChars', 1, 10_000],
  ['detailMaxChars', 1, 1_000_000],
  ['itemMaxChars', 1, 1_000_000],
  ['maxSearchLimit', 1, 100],
  ['lockTimeoutMs', 0, 600_000],
  ['staleLockMs', 0, 86_400_000],
  ['completionIdleTurns', 1, 50],
  ['reminderCooldownTurns', 0, 100],
];

/** @type {Array<keyof MemoryConfig>} */
const BOOL_KEYS = ['enabled', 'remindOnDelivery', 'includeSubagents'];

/** @type {Array<keyof MemoryConfig>} */
const STRING_KEYS = ['memoryDirName', 'reminderPrefix'];

/**
 * 解析配置：合法值覆盖默认，非法值回退默认并把原因收进 `warnings`。
 *
 * @param {unknown} raw patch 里 `config:` 的原样对象。
 * @returns {{ config: MemoryConfig, warnings: string[] }}
 */
export function resolveConfig(raw) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, unknown>} */
  const config = { ...DEFAULTS };

  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    warnings.push('配置不是对象，已全部使用默认值');
    return { config: /** @type {MemoryConfig} */ (config), warnings };
  }
  const input = /** @type {Record<string, unknown>} */ (raw ?? {});

  for (const [key, min, max] of INT_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      warnings.push(`${key} 取值非法（应为 ${min}–${max} 的整数），已回退默认 ${String(DEFAULTS[key])}`);
      continue;
    }
    config[key] = value;
  }

  for (const key of BOOL_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== 'boolean') {
      warnings.push(`${key} 取值非法（应为布尔），已回退默认 ${String(DEFAULTS[key])}`);
      continue;
    }
    config[key] = value;
  }

  for (const key of STRING_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      warnings.push(`${key} 取值非法（应为非空字符串），已回退默认 ${String(DEFAULTS[key])}`);
      continue;
    }
    config[key] = value;
  }

  // 记忆目录名必须是安全的单层相对目录名：含分隔符或跳级会写到项目外。
  const dirName = String(config.memoryDirName);
  if (!isSafeDirName(dirName)) {
    warnings.push(`memoryDirName「${dirName}」含路径分隔符或非法字符，已回退默认 ${DEFAULTS.memoryDirName}`);
    config.memoryDirName = DEFAULTS.memoryDirName;
  }

  // 预算自洽：单条上限必须容得下标题 + 详细，否则任何条目都会被判超长。
  const maxTitleChars = Number(config.maxTitleChars);
  const detailMaxChars = Number(config.detailMaxChars);
  const itemMaxChars = Number(config.itemMaxChars);
  if (itemMaxChars < maxTitleChars + detailMaxChars) {
    const fixed = maxTitleChars + detailMaxChars;
    warnings.push(`itemMaxChars(${itemMaxChars}) 小于 maxTitleChars+detailMaxChars(${fixed})，已抬到 ${fixed}`);
    config.itemMaxChars = fixed;
  }

  return { config: /** @type {MemoryConfig} */ (config), warnings };
}

/**
 * 目录名是否安全：单层、非空、不含分隔符、不是 `.`／`..`。
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeDirName(name) {
  if (name.length === 0 || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  // Windows 非法字符 + 控制字符
  return !/[\u0000-\u001f<>:"|?*]/.test(name);
}
