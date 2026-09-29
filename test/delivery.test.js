/**
 * delivery.js 单测：交付轮提醒一次且只一次、纯问答零提醒、冷却命中放弃且不补发。
 *
 * 已定死的语义（设计 §17.3／§14.57–§14.63）：
 *   - **交付信号只有一个**：`deliverables/presented`（DSH `present` 工具成功呈现
 *     文件后追加的事件）。文件怎么写、命令长什么样都不参与判定；
 *   - 交付轮在 `completionIdleTurns<=1` 时即完成轮，立即提醒一次；
 *   - 只读工具、纯文本问答、纯 shell 落盘都不算交付（否则会被提醒）；
 *   - 同一任务的后续轮次不重复提醒（含响应提醒去写记忆的那一轮）；
 *   - 同一轮内 turn-stopping 可能被求值多次，交付标志是**一次性**的；
 *   - 其后出现**新的**交付事件视为新任务，重新武装提醒；
 *   - 冷却命中时**放弃**这一发：置 `taskReminded`、返回 `cooldownHit:true`、
 *     **不更新** `lastRemindTurn`、**不补发**；
 *   - `turn` 不是正整数（0／负数／小数／undefined／NaN／'2' 字符串）一律不提醒，
 *     且不动任何状态；
 *   - 轮界复位负责兜住「被 abort 打断、没走到 turn-stopping」的轮次。
 *
 * 纪律（INTERFACES §0 第 9 条）：只用 `node:test` + `node:assert/strict`，
 * **不依赖当前时间、不碰任何真实文件**——本模块是纯逻辑。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeliveryState,
  evaluateTurnStopping,
  onDeliverablePresented,
  onToolResult,
  onTurnStart,
} from '../src/delivery.js';

/** @typedef {import('../src/delivery.js').DeliveryState} DeliveryState */

/**
 * @typedef {object} TurnParams
 * @property {number} turn
 * @property {boolean} [delivered] 本轮是否出现过交付事件。
 * @property {boolean} [toolCall] 本轮是否出现过工具活动（默认与交付同步）。
 * @property {number} [completionIdleTurns]
 * @property {number} [reminderCooldownTurns]
 * @property {boolean} [remindOnDelivery]
 */

/** @typedef {{ remind: boolean, completedNow: boolean, cooldownHit?: boolean }} Decision */

/**
 * @param {Decision} decision
 * @returns {boolean} 是否真的命中了冷却（忽略 `cooldownHit` 缺省的情况）。
 */
function hitCooldown(decision) {
  return decision.cooldownHit === true;
}

/**
 * 模拟一轮：轮界先复位标志（对应真实的 `session/event` `turn/start`），
 * 再累加本轮活动，最后求值 turn-stopping。
 *
 * 交付事件发生在求值**之前**，与真实顺序一致（`present` 的事件由它自己的
 * `tools/result` 监听器同步追加，必然早于同轮 turn-stopping）。
 *
 * @param {DeliveryState} state
 * @param {TurnParams} params
 * @returns {Decision}
 */
function runTurn(state, params) {
  onTurnStart(state);
  const toolCall = params.toolCall ?? params.delivered === true;
  if (toolCall) onToolResult(state);
  if (params.delivered === true) onDeliverablePresented(state, params.turn);
  return evaluate(state, params);
}

/**
 * 只求值，不复位、不累加 —— 用于模拟「同一轮内被求值两次」
 * （steer 出来的额外步会让 turn-stopping 在同轮再派发一次）。
 *
 * @param {DeliveryState} state
 * @param {TurnParams} params
 * @returns {Decision}
 */
function evaluate(state, params) {
  return evaluateTurnStopping({
    state,
    turn: params.turn,
    completionIdleTurns: params.completionIdleTurns ?? 1,
    reminderCooldownTurns: params.reminderCooldownTurns ?? 1,
    remindOnDelivery: params.remindOnDelivery ?? true,
  });
}

/**
 * 求值「形状可疑的轮次号」，用于验证入口校验。为了能传 `undefined`／`'2'` 这类
 * 真实宿主可能给到的值，参数类型特意放宽成 `unknown`。
 *
 * @param {DeliveryState} state
 * @param {unknown} turnValue
 * @param {Partial<TurnParams>} [rest]
 * @returns {Decision}
 */
function evaluateRaw(state, turnValue, rest) {
  const params = rest ?? {};
  return evaluateTurnStopping({
    state,
    turn: /** @type {number} */ (turnValue),
    completionIdleTurns: params.completionIdleTurns ?? 1,
    reminderCooldownTurns: params.reminderCooldownTurns ?? 1,
    remindOnDelivery: params.remindOnDelivery ?? true,
  });
}

test('纯问答轮次永不提醒', () => {
  const state = createDeliveryState();
  for (let turn = 1; turn <= 5; turn += 1) {
    assert.equal(runTurn(state, { turn, toolCall: false }).remind, false, `第 ${turn} 轮不应提醒`);
  }
  assert.equal(state.awaitingClosure, false);
  assert.equal(state.lastRemindTurn, -1);
});

test('只读工具（read/grep/glob）不算交付物，不提醒', () => {
  const state = createDeliveryState();
  assert.equal(runTurn(state, { turn: 1, toolCall: true }).remind, false);
  assert.equal(runTurn(state, { turn: 2, toolCall: false }).remind, false);
  assert.equal(state.awaitingClosure, false, '不应进入收尾态');
});

/**
 * 回归（本插件历史上最贵的一次误报）：交付信号曾靠正则猜「这条 shell 命令
 * 是不是在写文件」，结果 `ssh -G us 2>&1 | Select-String …` 因为含 `2>&1` 里的
 * `>` 被判成交付物，凭空触发一次提醒。现在交付只认 `deliverables/presented`，
 * 任何工具调用（包括真在落盘的 shell、write、edit）都不再产生交付信号；
 * 只在 shell 里落盘、从不调用 present 的任务**不会**被提醒（§17.2 的已知代价）。
 */
test('回归：工具活动本身不构成交付，只有 deliverables/presented 才算', () => {
  const state = createDeliveryState();
  for (const turn of [1, 2, 3]) {
    assert.equal(runTurn(state, { turn, toolCall: true }).remind, false, `第 ${turn} 轮不应提醒`);
  }
  assert.equal(state.awaitingClosure, false, '不应进入收尾态');
  const decision = runTurn(state, { turn: 4, toolCall: true, delivered: true });
  assert.equal(decision.remind, true, '交付事件应提醒');
  assert.equal(decision.completedNow, true);
});

test('交付轮即完成轮：立即提醒一次', () => {
  const state = createDeliveryState();
  const decision = runTurn(state, { turn: 1, delivered: true });
  assert.equal(decision.remind, true);
  assert.equal(decision.completedNow, true);
  assert.equal(hitCooldown(decision), false, '没撞冷却就不该有冷却日志');
  assert.equal(state.lastRemindTurn, 1);
  assert.equal(state.taskReminded, true);
});

test('提醒后继续静默轮不再重复提醒', () => {
  const state = createDeliveryState();
  assert.equal(runTurn(state, { turn: 1, delivered: true }).remind, true);
  assert.equal(runTurn(state, { turn: 2, toolCall: false }).remind, false);
  assert.equal(runTurn(state, { turn: 3, toolCall: false }).remind, false);
  assert.equal(state.lastRemindTurn, 1, '重复提醒不得改写冷却基准');
});

test('响应提醒去写记忆的那一轮不产生第二次提醒', () => {
  const state = createDeliveryState();
  assert.equal(runTurn(state, { turn: 1, delivered: true }).remind, true);
  // 第 2 轮：模型按提醒调用 memory_write（工具活动，但无交付事件），属于同一任务
  assert.equal(runTurn(state, { turn: 2, toolCall: true }).remind, false);
  assert.equal(runTurn(state, { turn: 3, toolCall: false }).remind, false);
});

test('新的交付事件视为新任务，重新武装提醒', () => {
  const state = createDeliveryState();
  assert.equal(runTurn(state, { turn: 1, delivered: true }).remind, true);
  assert.equal(runTurn(state, { turn: 2, toolCall: true }).remind, false);
  assert.equal(runTurn(state, { turn: 3, delivered: true }).remind, true, '新任务应再次提醒');
  assert.equal(state.lastRemindTurn, 3);
});

test('completionIdleTurns=2：交付轮不提醒，攒满 2 个静默轮后提醒', () => {
  const state = createDeliveryState();
  assert.equal(runTurn(state, { turn: 1, delivered: true, completionIdleTurns: 2 }).remind, false);
  assert.equal(runTurn(state, { turn: 2, toolCall: false, completionIdleTurns: 2 }).remind, false);
  assert.equal(runTurn(state, { turn: 3, toolCall: false, completionIdleTurns: 2 }).remind, true);
});

test('静默轮达阈值才算完成轮：阈值 3 时第 2 个静默轮仍不提醒', () => {
  const state = createDeliveryState();
  assert.equal(runTurn(state, { turn: 1, delivered: true, completionIdleTurns: 3 }).remind, false);
  assert.equal(runTurn(state, { turn: 2, toolCall: false, completionIdleTurns: 3 }).remind, false);
  assert.equal(runTurn(state, { turn: 3, toolCall: false, completionIdleTurns: 3 }).remind, false);
  assert.equal(runTurn(state, { turn: 4, toolCall: false, completionIdleTurns: 3 }).remind, true);
});

test('交付后又有工具活动则静默计数归零', () => {
  const state = createDeliveryState();
  assert.equal(runTurn(state, { turn: 1, delivered: true, completionIdleTurns: 3 }).remind, false);
  assert.equal(runTurn(state, { turn: 2, toolCall: true, completionIdleTurns: 3 }).remind, false);
  assert.equal(runTurn(state, { turn: 3, toolCall: false, completionIdleTurns: 3 }).remind, false);
  assert.equal(runTurn(state, { turn: 4, toolCall: false, completionIdleTurns: 3 }).remind, false);
  assert.equal(runTurn(state, { turn: 5, toolCall: false, completionIdleTurns: 3 }).remind, true);
});

test('remindOnDelivery=false 时永久不提醒，也不留下冷却痕迹', () => {
  const state = createDeliveryState();
  const first = runTurn(state, { turn: 1, delivered: true, remindOnDelivery: false, reminderCooldownTurns: 0 });
  assert.equal(first.completedNow, true);
  assert.equal(first.remind, false);
  assert.equal(hitCooldown(first), false, '总开关关掉时不该记冷却 warn');
  assert.equal(state.lastRemindTurn, -1, '关闭状态下不得写冷却基准');
  assert.equal(state.taskReminded, false);
  assert.equal(runTurn(state, { turn: 2, toolCall: false, remindOnDelivery: false }).remind, false);
  assert.equal(runTurn(state, { turn: 3, delivered: true, remindOnDelivery: false }).remind, false);
  assert.equal(state.lastRemindTurn, -1);
});

test('reminderCooldownTurns=0 表示不限流（配置接受 0 就该生效）', () => {
  const state = createDeliveryState();
  const first = runTurn(state, { turn: 1, delivered: true, reminderCooldownTurns: 0 });
  assert.equal(first.remind, true);
  assert.equal(hitCooldown(first), false);
  const second = runTurn(state, { turn: 2, delivered: true, reminderCooldownTurns: 0 });
  assert.equal(second.remind, true);
  assert.equal(hitCooldown(second), false);
});

/**
 * §17.3「冷却命中」的完整语义（R1.4 相对旧实现的三处必改之一）：
 * 放弃这一发、置 `taskReminded = true`、返回 `cooldownHit: true`、
 * **不更新** `lastRemindTurn`、**不补发**。
 */
test('冷却命中：返回 cooldownHit、置 taskReminded、不更新 lastRemindTurn、不补发', () => {
  const state = createDeliveryState();

  // 第 1 轮交付 -> 提醒，冷却基准 = 1
  const first = runTurn(state, { turn: 1, delivered: true, reminderCooldownTurns: 5 });
  assert.equal(first.remind, true);
  assert.equal(hitCooldown(first), false);
  assert.equal(state.lastRemindTurn, 1);

  // 第 2 轮是新任务交付，但距上次提醒不到 5 轮 -> 命中冷却，放弃
  const second = runTurn(state, { turn: 2, delivered: true, reminderCooldownTurns: 5 });
  assert.equal(second.completedNow, true);
  assert.equal(second.remind, false);
  assert.equal(hitCooldown(second), true, '命中冷却必须让调用方能记一条 warn');
  assert.equal(state.taskReminded, true, '置位是为了让同轮后续求值不再重复判定');
  assert.equal(state.lastRemindTurn, 1, '被放弃的这一发不是冷却基准，不得更新');

  // 同轮再求值一次：不得冒出第二发，也不该重复记冷却
  const again = evaluate(state, { turn: 2, reminderCooldownTurns: 5 });
  assert.equal(again.remind, false, '同一轮内不得再提醒');
  assert.equal(hitCooldown(again), false, 'taskReminded 已置位，不再重复记冷却');

  // 后续轮次不得凭空冒出「补发」的提醒（旧 README 写成"推迟补发"，语义以代码为准）
  assert.equal(runTurn(state, { turn: 3, delivered: true, reminderCooldownTurns: 5 }).remind, false);
  assert.equal(runTurn(state, { turn: 4, toolCall: true, reminderCooldownTurns: 5 }).remind, false);
  assert.equal(runTurn(state, { turn: 5, toolCall: false, reminderCooldownTurns: 5 }).remind, false);
  assert.equal(state.lastRemindTurn, 1, '冷却基准始终是第 1 轮，没有被补发改写');

  // 距上次提醒满 5 轮：新交付可正常提醒
  const sixth = runTurn(state, { turn: 6, delivered: true, reminderCooldownTurns: 5 });
  assert.equal(sixth.remind, true);
  assert.equal(hitCooldown(sixth), false);
  assert.equal(state.lastRemindTurn, 6);
});

test('冷却轮数阻止过密提醒（含冷却窗口内的静默轮）', () => {
  const state = createDeliveryState();
  // 第 1 轮交付 -> 提醒
  assert.equal(runTurn(state, { turn: 1, delivered: true, reminderCooldownTurns: 5 }).remind, true);
  // 第 2 轮新任务交付，但冷却未过 -> 本次放弃（不记账、不补发）
  assert.equal(runTurn(state, { turn: 2, delivered: true, reminderCooldownTurns: 5 }).remind, false);
  // 冷却窗口内的后续轮次也不得凭空冒出提醒
  assert.equal(runTurn(state, { turn: 3, toolCall: true, reminderCooldownTurns: 5 }).remind, false);
  assert.equal(runTurn(state, { turn: 4, toolCall: true, reminderCooldownTurns: 5 }).remind, false);
  assert.equal(runTurn(state, { turn: 5, toolCall: false, reminderCooldownTurns: 5 }).remind, false);
  // 第 6 轮：距上次提醒满 5 轮，新的交付可正常提醒
  assert.equal(runTurn(state, { turn: 6, delivered: true, reminderCooldownTurns: 5 }).remind, true);
});

/**
 * 回归（P1）：同一轮内 turn-stopping 可能被派发多次 —— steer 出来的额外步跑完后
 * 会再派发一次，而 `turn/start` 要到下一轮才复位标志。若交付标志不被消费，
 * 第二次求值会再次重置 `taskReminded`，配合冷却变出一发"下一轮补发"的重复提醒。
 * 真实先例：模型被提醒后，在同一轮里 `present` 了记忆文件。
 */
test('回归：同一轮内二次求值 + 再次交付，不产生重复提醒', () => {
  const state = createDeliveryState();
  // 第一次求值：交付 -> 提醒
  assert.equal(runTurn(state, { turn: 1, delivered: true }).remind, true);
  // 同轮第二次交付（steer 出的新步里又 present 一次）
  onDeliverablePresented(state, 1);
  assert.equal(evaluate(state, { turn: 1 }).remind, false, '同一轮内不得再提醒');
  // 下一轮：不得冒出被推迟的重复提醒
  assert.equal(runTurn(state, { turn: 2, toolCall: false }).remind, false);
  assert.equal(runTurn(state, { turn: 3, toolCall: false }).remind, false);
});

test('回归：交付标志取出即消费（同轮第二次求值看不到它）', () => {
  const state = createDeliveryState();
  onTurnStart(state);
  onDeliverablePresented(state, 1);
  assert.equal(state.turnHadDeliverable, true);
  assert.equal(evaluate(state, { turn: 1 }).remind, true);
  assert.equal(state.turnHadDeliverable, false, '求值必须把它取走');
});

/**
 * 归属校验的边界：同轮之内、turn-stopping 之后到达的交付事件是**合法**顺序
 * （额外步跑完会再派发一次 turn-stopping），必须收下；只有来自**更早轮次**的
 * 事件才说明顺序被破坏，需要丢弃并记 warn（§17.3「迟到交付事件」）。
 */
test('回归：同轮迟到的交付事件仍然生效，更早轮次的才丢弃并 warn', () => {
  const state = createDeliveryState();
  // 第 1 轮：先求值（无交付），再收到同轮交付事件 -> 应生效
  assert.equal(runTurn(state, { turn: 1, toolCall: true }).remind, false);
  onDeliverablePresented(state, 1);
  assert.equal(evaluate(state, { turn: 1 }).remind, true, '同轮迟到的事件必须生效');

  // 第 3 轮：来自更早轮次（1）的事件应被丢弃，并留下 warn
  assert.equal(runTurn(state, { turn: 3, toolCall: true }).remind, false);
  /** @type {string[]} */
  const warnings = [];
  onDeliverablePresented(state, 1, (message) => warnings.push(message));
  assert.equal(warnings.length, 1, '迟到事件必须留下一条 warn');
  assert.match(warnings[0], /迟到/);
  assert.match(warnings[0], /turn=1/);
  assert.equal(state.turnHadDeliverable, false, '迟到事件不得计入本轮');
  assert.equal(evaluate(state, { turn: 3 }).remind, false, '更早轮次的事件不得触发提醒');

  // 没有 warn 出口时不得抛错（事件监听器里的异常会连累会话）
  assert.doesNotThrow(() => onDeliverablePresented(state, 1));
});

/**
 * §17.3「轮次号校验」：必须是 `Number.isInteger(turn) && turn > 0`。
 * 旧实现的纯逻辑层只用 `Number.isFinite`，0／负数／小数会被放行；
 * 且 `Number(null)`／`Number('')` 都是 0，只判 isFinite 会让"缺轮次号"蒙混过关。
 * 这里额外锁死「直接返回、不动任何状态」——否则一轮脏数据会污染 `lastEvaluatedTurn`。
 */
test('turn 为 0／负数／小数／undefined／NaN／字符串时一律不提醒，且不动状态', () => {
  /** @type {unknown[]} */
  const badTurns = [0, -1, -5, 1.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '', '2', true];

  for (const bad of badTurns) {
    const state = createDeliveryState();
    onTurnStart(state);
    onDeliverablePresented(state, 1);

    const decision = evaluateRaw(state, bad);
    assert.equal(decision.remind, false, `turn=${String(bad)} 不应提醒`);
    assert.equal(decision.completedNow, false, `turn=${String(bad)} 不应判完成`);
    assert.equal(hitCooldown(decision), false, `turn=${String(bad)} 不该记冷却 warn`);
    assert.equal(state.lastEvaluatedTurn, -1, `turn=${String(bad)} 不得推进求值轮次`);
    assert.equal(state.taskReminded, false);
    assert.equal(state.lastRemindTurn, -1);
    assert.equal(state.turnHadDeliverable, true, `turn=${String(bad)} 不得消费本轮交付标志`);

    // 同一轮随后拿到合法轮次号时，交付仍然生效（脏数据不该把提醒吃掉）
    assert.equal(evaluate(state, { turn: 1 }).remind, true, `turn=${String(bad)} 之后的合法求值仍应提醒`);
  }
});

test('回归：轮界复位是必要的 —— 不复位则静默判断永不成立', () => {
  const state = createDeliveryState();
  runTurn(state, { turn: 1, toolCall: true });
  assert.equal(state.turnHadToolCall, true, '轮内标志应在求值后保留到轮界');

  onTurnStart(state);
  assert.equal(state.turnHadToolCall, false);
  assert.equal(state.turnHadDeliverable, false);

  assert.equal(runTurn(state, { turn: 2, delivered: true }).remind, true);
});

/**
 * 被 abort 打断的轮次不会派发 `turn-stopping`（`dsh-agent-loop` 的 catch 分支直接
 * 结束该轮），残留的本轮标志只能靠轮界复位兜底，否则会漏到下一轮变成误提醒。
 */
test('回归：abort 打断的轮次靠轮界复位兜底，不把交付漏到下一轮', () => {
  const state = createDeliveryState();
  onTurnStart(state);
  onToolResult(state);
  onDeliverablePresented(state, 1);
  // 本轮被 abort，turn-stopping 从未派发 —— 标志原样留着

  onTurnStart(state); // 下一轮的轮界
  assert.equal(state.turnHadDeliverable, false, '轮界必须清掉上一轮的交付标志');
  assert.equal(runTurn(state, { turn: 2, toolCall: false }).remind, false, '不得把上一轮的交付算到这一轮');
});
