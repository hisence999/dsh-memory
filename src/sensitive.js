/**
 * 敏感信息检测（设计 §7.6）。
 *
 * 策略（写死，不要放宽）：
 *  - 检测范围 = 标题、详细、标签、别名、日志标题与内容；**不检测机器字段**；
 *  - 命中类别三档：凭据（密钥／Token／Cookie／会话票据／私钥／口令）、连接串（含账号口令的 URL）、身份（身份证号／完整手机号／银行卡号）；
 *  - 处置：拒绝整批写入，只返回"序号 + 字段名 + 类别"；
 *  - **绝不回显命中原文**——否则等于把秘密搬进会话上下文，一次拒绝就变成一次泄漏。
 *
 * 误伤是刻意接受的（保守优先）：中文说明性文字里的"TOKEN 刷新流程"不会命中，因为
 * 键名后面必须紧跟 `:`／`=`／`：` 且值必须是"像密钥"的 ASCII 串（≥6 字符）。
 */

/** 三个命中类别（设计 §7.6）。 @type {readonly string[]} */
export const CATEGORIES = Object.freeze(['credential', 'connection', 'identity']);

/** 类别 → 中文展示名。 @type {Record<string, string>} */
export const CATEGORY_LABEL = { credential: '凭据', connection: '连接串', identity: '身份' };

/** 误伤提示（设计 §7.6 原文口径；在任何敏感拒绝的返回里都要带上这一句）。 */
export const SENSITIVE_HINT =
  '若确为无害的说明性文字（例如描述"如何配置 TOKEN 刷新流程"），请改写为不含具体值后再写入。';

/**
 * 凭据类键名——ASCII 部分（作为"键"，必须再跟 `:`／`=`／`：`／`=>` 与一个像密钥的值才算命中）。
 */
const CREDENTIAL_ASCII_KEY = String.raw`(?:authorization|proxy[\s_-]?authorization|api[\s_-]?key|apikey|access[\s_-]?token|refresh[\s_-]?token|auth[\s_-]?token|id[\s_-]?token|bearer[\s_-]?token|client[\s_-]?secret|secret[\s_-]?key|secret|token|password|passwd|pwd|passphrase|cookie|set[\s_-]?cookie|credential|private[\s_-]?key|session[\s_-]?(?:token|id|ticket))`;

/**
 * 凭据类键名——中文部分。中文键**不能**加"前一字符不是字母"的守卫：
 * 汉字本身是 `\p{L}`，加守卫会让"数据库口令：xxx"漏检。
 */
const CREDENTIAL_CJK_KEY = String.raw`(?:密钥|令牌|口令|密码|私钥|凭据)`;

/**
 * 赋值形凭据：`Authorization: Bearer abc123`、`api_key = "xxxxxx"`、`数据库口令：s3cr3t-pass-9`。
 *
 * 值必须是 ASCII 的"密钥样"串（`[A-Za-z0-9!@#$%^&*._\-+/=]`，≥6 字符）：
 * 这样 `如何配置 TOKEN 刷新流程`、`令牌：请向管理员索取` 这类说明文字不会误伤。
 * @type {RegExp}
 */
const CREDENTIAL_ASSIGN_ASCII_RE = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}_])${CREDENTIAL_ASCII_KEY}\s*(?:[:=：]|=>)\s*["'\x60]?([A-Za-z0-9!@#$%^&*._\-+/=]{6,})`,
  'iu',
);

/** @type {RegExp} */
const CREDENTIAL_ASSIGN_CJK_RE = new RegExp(
  String.raw`${CREDENTIAL_CJK_KEY}\s*(?:[:=：]|=>)\s*["'\x60]?([A-Za-z0-9!@#$%^&*._\-+/=]{6,})`,
  'u',
);

/** @type {RegExp[]} */
const CREDENTIAL_ASSIGN_RES = [CREDENTIAL_ASSIGN_ASCII_RE, CREDENTIAL_ASSIGN_CJK_RE];

/** 典型密钥字面量（不需要键名也能判定）。 @type {RegExp[]} */
const CREDENTIAL_TOKEN_RES = [
  /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/, // PEM 私钥
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/, // OpenAI 风格
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub PAT
  /\bglpat-[A-Za-z0-9_-]{16,}\b/, // GitLab PAT
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
];

/** 连接串：URL 里带"账号:口令@"（设计中"含账号口令的 URL"）。 @type {RegExp} */
const CONNECTION_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]+:[^\s/?#@]+@/i;

/** 身份证号（18 位，末位可为 X）。 @type {RegExp} */
const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/;

/** 完整手机号（中国大陆 11 位，可带 +86）。 @type {RegExp} */
const MOBILE_RE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/;

/** 银行卡号（16–19 位连续数字）。 @type {RegExp} */
const BANK_CARD_RE = /(?<!\d)\d{16,19}(?!\d)/;

/**
 * 扫描一段文本。
 *
 * @param {unknown} text
 * @returns {{ hit: boolean, category?: string }} 命中类别按"凭据 > 连接串 > 身份"取第一个；
 *   返回值里**只有类别，没有原文**（不回显是硬要求）
 */
export function scanSensitive(text) {
  if (typeof text !== 'string' || text.length === 0) return { hit: false };

  for (const pattern of CREDENTIAL_ASSIGN_RES) {
    if (pattern.test(text)) return { hit: true, category: 'credential' };
  }
  for (const pattern of CREDENTIAL_TOKEN_RES) {
    if (pattern.test(text)) return { hit: true, category: 'credential' };
  }
  if (CONNECTION_RE.test(text)) return { hit: true, category: 'connection' };
  if (ID_CARD_RE.test(text)) return { hit: true, category: 'identity' };
  if (MOBILE_RE.test(text)) return { hit: true, category: 'identity' };
  if (BANK_CARD_RE.test(text)) return { hit: true, category: 'identity' };

  return { hit: false };
}

/**
 * 字段名映射：内部键 → 设计 §7.2 的中文字段名（返回给模型的位置信息用中文）。
 * @type {Array<[string, string]>}
 */
const FIELDS = [
  ['title', '标题'],
  ['detail', '详细'],
  ['tags', '标签'],
  ['aliases', '别名'],
];

/**
 * 扫描一条记忆／日志的可见文本字段，返回命中清单。
 *
 * 解析阶段与 store 的日志路径都用同一个形状：`{ field, category }`，
 * 其中 `field` 是中文名、`category` 是三档之一，**不含命中原文**。
 *
 * @param {{ title?: unknown, detail?: unknown, tags?: unknown, aliases?: unknown }} parts
 * @returns {Array<{ field: string, category: string }>}
 */
export function scanEntryTexts(parts) {
  /** @type {Array<{ field: string, category: string }>} */
  const hits = [];
  if (parts === null || typeof parts !== 'object') return hits;

  for (const [key, label] of FIELDS) {
    const raw = /** @type {Record<string, unknown>} */ (parts)[key];
    /** @type {string[]} */
    const texts = Array.isArray(raw) ? raw.map((item) => (typeof item === 'string' ? item : '')) : typeof raw === 'string' ? [raw] : [];
    const seen = new Set();
    for (const text of texts) {
      const result = scanSensitive(text);
      if (result.hit && result.category !== undefined && !seen.has(result.category)) {
        seen.add(result.category);
        hits.push({ field: label, category: result.category });
      }
    }
  }
  return hits;
}

/**
 * 命中清单 → 一行中文说明（含中文类别名与英文码，便于模型与人工对齐）。
 *
 * @param {Array<{ field: string, category: string }>} hits
 * @returns {string} 形如 `标题（凭据 credential）`
 */
export function describeHits(hits) {
  return (Array.isArray(hits) ? hits : [])
    .map((hit) => `${hit.field}（${CATEGORY_LABEL[hit.category] ?? hit.category} ${hit.category}）`)
    .join('、');
}
