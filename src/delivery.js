/**
 * 交付态状态机（纯逻辑，无 IO、无运行时依赖）。
 *
 * 目标：一个任务真正交付后提醒一次；纯问答轮次零打扰。
 *
 * 交付信号只有一个：DSH 的 `deliverables/presented` 会话事件。
 * `present` 是 DSH 的「交付文件」工具（`dsh-tool-present`），它**只在成功时**
 * 追加这个事件，载荷是 `{ turn, callId, files }` —— 也就是模型自己声明的
 * 「这就是交付物」。因此这里不需要对工具参数做任何猜测。
 *
 * 早期版本靠 `tools/result` + 正则判断「这条 shell 命令看起来在写文件」，
 * 结果 `ssh -G us 2>&1 | Select-String …` 这种只读命令因为含 `2>&1` 里的 `>`
 * 被误判成交付物，凭空触发一次提醒。该路径已整块删除。
 *
 * 事件顺序（关键，手册 §3.4）：
 *   轮内  `tools/result`                  -> 只记录「本轮有过工具活动」
 *   轮内  `session/event` 的 `deliverables/presented` -> 记录交付物
 *   轮末  `agent/turn-stopping`           -> 按本轮事实推进状态并决定是否提醒
 *   轮界  `session/event` 的 `turn/start` -> 丢弃上一轮的本轮标志
 *
 * 复位只能发生在**轮界**，不能在求值函数入口按轮次号变化就复位 —— 那会把同一轮
 * 刚刚记录的交付物擦掉。工具结果不携带轮次号（`ToolExecution` 没有 turn 字段），
 * 所以轮次边界一律由 `turn/start` 驱动；交付事件自带 turn，但也**不据此复位**，
 * 而是用于「迟到事件」的归属校验（见 `onDeliverablePresented`）。
 *
 * 两个判据各司其职：
 *   `taskReminded` —— 当前任务是否已提醒过。只在**新的交付轮**重置。
 *   `reminderCooldownTurns` —— 距上次提醒的轮数下限，负责跨任务限流；`0` 表示不限流。
 *   冷却命中时**放弃**这一发提醒（不记账、不补发）：补发既不要求任务完成、也不绑定
 *   任务，会落在"正在干活的轮"或"另一个任务"上，还会与同轮二次交付叠加成同一任务
 *   提醒两次。漏一发只是少一次提示，多发一发才是真伤害（手册 §9.5）。
 *
 * 相对旧实现（`D:\dsh-memory\src\delivery.js`）的三处**有意**差异（设计 §17.3／§17.9）：
 *   1. 轮次号校验上移到状态机入口：必须 `Number.isInteger(turn) && turn > 0`，
 *      否则立即返回且**不动任何状态**。旧实现只用 `Number.isFinite`，
 *      `0`／负数／小数会被放行（`Number(null)`／`Number('')` 都是 `0`，手册 §9.8）。
 *   2. 冷却命中语义写死：置 `taskReminded = true`、**不更新** `lastRemindTurn`、
 *      返回 `cooldownHit: true`（供调用方记一条 warn，§14.59 要求这条日志）。
 *   3. 不补发：冷却命中一律放弃这一发，绝不记账补发。旧 README 写的"推迟补发"是错的，
 *      以代码语义为准（设计 §17.3 措辞纠正）。
 */

/**
 * @typedef {object} DeliveryState
 * @property {boolean} turnHadToolCall 本轮是否出现过工具调用。
 * @property {boolean} turnHadDeliverable 本轮是否出现过交付物（`deliverables/presented`），**求值时消费**。
 * @property {boolean} awaitingClosure 曾交付过、处于可能收尾的状态。
 * @property {boolean} taskReminded 当前任务是否已提醒过（新交付轮时重置）。
 * @property {number} idleTurns 连续零工具调用的轮次计数。
 * @property {number} lastRemindTurn 上次提醒所在的轮次号，-1 表示从未提醒。
 * @property {number} lastEvaluatedTurn 最近一次被求值的轮次号，-1 表示尚未求值；用于识别迟到事件。
 */

/**
 * @returns {DeliveryState} 全新状态。
 */
export function createDeliveryState() {
  return {
    turnHadToolCall: false,
    turnHadDeliverable: false,
    awaitingClosure: false,
    taskReminded: false,
    idleTurns: 0,
    lastRemindTurn: -1,
    lastEvaluatedTurn: -1,
  };
}

/**
 * 轮次开始（由会话日志的 `turn/start` 驱动）：丢弃上一轮的本轮标志。
 *
 * 交付标志虽然也在求值时消费掉，这里仍要清一次：被 abort/error 打断的轮次不会
 * 派发 `agent/turn-stopping`（`dsh-agent-loop` 的 catch 分支直接结束该轮），
 * 那种情况下标志只能靠轮界复位，否则会漏到下一轮（手册 §3.4 第 3 条）。
 *
 * @param {DeliveryState} state
 * @returns {void}
 */
export function onTurnStart(state) {
  state.turnHadToolCall = false;
  state.turnHadDeliverable = false;
}

/**
 * 记录一次工具结果（轮内累加）。只用来判断「本轮是否有活动」。
 *
 * 刻意不接收轮次号：`ToolExecution` 里并没有 turn 字段，轮次边界一律由
 * `session/event` 的 `turn/start` 驱动复位（见 `onTurnStart`）。
 *
 * 交付物**不在这里**判定：交付信号来自 `deliverables/presented`（见
 * `onDeliverablePresented`）。因此本函数不再需要工具名、参数或错误状态。
 *
 * @param {DeliveryState} state
 * @returns {void}
 */
export function onToolResult(state) {
  state.turnHadToolCall = true;
}

/**
 * 记录一次交付：由 `session/event` 的 `deliverables/presented` 驱动。
 *
 * DSH 的 `present` 工具只在**成功呈现过文件**之后追加该事件（手册 §3.3），等于模型
 * 自己声明「这就是交付物」，比推断工具参数可靠得多。
 *
 * 交付事件自带 `event.data.turn`，用它做**归属校验**，只丢弃「比最近一次求值更早的
 * 轮次」发来的事件 —— 那说明顺序已经被破坏（该轮早已收尾），收下只会污染下一轮。
 *
 * 注意判据必须是「更早」而不是「不大于」：同一轮内 `turn-stopping` 会被派发多次
 * （steer 出来的额外步跑完再派发一次），**同轮**之后再来的交付事件是合法顺序，
 * 丢了就真漏提醒。边界留给集成层验证，这里只守最后一道。
 *
 * @param {DeliveryState} state
 * @param {number} [turn] 事件自带的轮次号（`event.data.turn`）。
 * @param {(message: string) => void} [warn] 丢弃迟到事件时的告警出口。
 * @returns {void}
 */
export function onDeliverablePresented(state, turn, warn) {
  if (typeof turn === 'number' && Number.isFinite(turn) && turn < state.lastEvaluatedTurn) {
    warn?.(`交付事件迟到：turn=${turn} < 最近求值轮 ${state.lastEvaluatedTurn}，本次交付不计`);
    return;
  }
  state.turnHadDeliverable = true;
}

/**
 * `agent/turn-stopping` 求值：按本轮事实推进状态，返回是否提醒。
 *
 * 三个容易踩的点：
 *   - 入口先校验轮次号：不是正整数就直接返回、**不动任何状态**（不清交付标志、
 *     不推进 `lastEvaluatedTurn`）。`Number(null)`／`Number('')` 都是 `0`，
 *     只判 `isFinite` 会让"缺轮次号"蒙混过关（手册 §9.8）。缺轮次号的 warn 由
 *     调用方负责——本函数没有日志出口（签名冻结见 INTERFACES §3.10）。
 *   - `turnHadDeliverable` 是**一次性**的：同轮内可能被求值多次（steer 出来的
 *     额外步会再派发一次 turn-stopping）。若不消费，第二次求值会再次重置
 *     `taskReminded`，命中冷却后变出一发"下一轮补发"的重复提醒。
 *   - 冷却命中时置 `taskReminded = true` 并返回 `cooldownHit: true`（调用方据此记
 *     warn），但**不更新 `lastRemindTurn`**、也**不补发**：补发既不要求任务完成、
 *     也不绑定任务，会落在"正在干活的轮"或"另一个任务"上。
 *
 * `completionIdleTurns`／`reminderCooldownTurns` 由配置层保证是范围内的整数
 * （`config.js` 的 `INT_KEYS`：前者 1–50、后者 0–100），这里只做下界收敛。
 *
 * @param {object} params
 * @param {DeliveryState} params.state
 * @param {number} params.turn 当前轮次号（来自 payload）。
 * @param {number} params.completionIdleTurns 连续零工具轮次达到该值即判定完成。
 * @param {number} params.reminderCooldownTurns 两次提醒之间至少间隔的轮数；`0` 表示不限流。
 * @param {boolean} params.remindOnDelivery 是否启用提醒；`false` 时永不提醒。
 * @returns {{ remind: boolean, completedNow: boolean, cooldownHit?: boolean }} 决策结果。
 *   `cooldownHit` 只在"本该提醒但撞上冷却"时为 `true`（此时 `remind` 为 `false`）。
 */
export function evaluateTurnStopping({ state, turn, completionIdleTurns, reminderCooldownTurns, remindOnDelivery }) {
  // 轮次号必须是正整数：非整数（含 0、负数、小数、undefined/NaN/null/''）直接返回，
  // 且不留下任何副作用 —— 差值为负会让冷却判定恒假、提醒永久静默且无从察觉。
  if (!Number.isInteger(turn) || turn <= 0) return { remind: false, completedNow: false };

  // 取出后立刻消费：本轮交付是「这一次求值」的事实，不是留给下一轮的。
  const hadDeliverable = state.turnHadDeliverable;
  state.turnHadDeliverable = false;
  state.lastEvaluatedTurn = turn;

  const threshold = Math.max(1, Math.floor(completionIdleTurns));
  const interval = Math.max(0, Math.floor(reminderCooldownTurns));
  const cooled = state.lastRemindTurn >= 0 && turn - state.lastRemindTurn < interval;

  /** @type {boolean} */
  let completedNow = false;

  if (hadDeliverable) {
    // 新的交付轮 = 新任务：重置「本任务已提醒」，并结束上一段收尾计数。
    state.awaitingClosure = true;
    state.taskReminded = false;
    state.idleTurns = 0;
    if (threshold <= 1) completedNow = true;
  } else if (state.turnHadToolCall) {
    // 有工具活动但无交付物：任务尚未收尾。
    state.idleTurns = 0;
  } else if (state.awaitingClosure) {
    // 静默轮：累积收尾计数。
    state.idleTurns += 1;
    if (state.idleTurns >= threshold) completedNow = true;
  }

  /** @type {boolean} */
  let remind = false;
  /** @type {boolean} */
  let cooldownHit = false;

  if (completedNow && !state.taskReminded && remindOnDelivery) {
    if (cooled) {
      // 命中冷却：放弃这一发。置 taskReminded 是为了让同轮后续求值不再重复判定，
      // 但**不**更新 lastRemindTurn —— 被放弃的这一发不是冷却基准，也绝不补发。
      cooldownHit = true;
      state.taskReminded = true;
    } else {
      remind = true;
      state.taskReminded = true;
      state.lastRemindTurn = turn;
    }
  }

  return { remind, completedNow, cooldownHit };
}
