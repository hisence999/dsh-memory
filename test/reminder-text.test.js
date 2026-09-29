/**
 * reminder-text.js 单测：消息形状与提醒文案。
 *
 * 依据：§17.4（投递形态，硬要求）、§14.60–§14.61、§10.1（`[记忆插件]` 标记）、
 * 手册 §4.2（`UserMessage` 形状与 `role` 缺失的 P0 后果）。
 *
 * 纪律：只用 `node:test` + `node:assert/strict`，**不依赖当前时间、不碰真实文件**。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReminderMessage, buildReminderText } from '../src/reminder-text.js';

/** 测试用的当日文件（形状按 §5.1：`M-YYYY-MM-DD.md`），不指向真实文件。 */
const FILE_NAME = 'M-2026-09-20.md';
const FILE_PATH = 'D:\\demo-project\\memory\\M-2026-09-20.md';

/**
 * @param {string} text
 * @returns {string} 首行（不含行尾换行）。
 */
function firstLine(text) {
  return text.split('\n')[0];
}

test('消息键集合恰为 content/id/role/source，且 role === user', () => {
  const message = buildReminderMessage({
    msgPrefix: '[记忆插件]',
    fileName: FILE_NAME,
    filePath: FILE_PATH,
    pluginName: 'memory',
  });

  assert.deepEqual(Object.keys(message).sort(), ['content', 'id', 'role', 'source']);
  assert.equal(message.role, 'user', '漏 role 会让上游拒绝整个请求');
  assert.deepEqual(message.source, { kind: 'plugin:memory' });
  assert.equal(Array.isArray(message.content), true);
  assert.equal(message.content.length, 1);
  assert.equal(message.content[0].type, 'text');
  assert.equal(typeof message.content[0].text, 'string');
});

test('source.kind 是生产者自有取值：非空且不得为已退役的 plugin（V4 原生准入硬拒）', () => {
  for (const pluginName of ['memory', 'other-plugin']) {
    const message = buildReminderMessage({ fileName: FILE_NAME, filePath: FILE_PATH, pluginName });
    assert.equal(typeof message.source.kind, 'string');
    assert.equal(message.source.kind.length > 0, true, 'kind 必须非空');
    assert.notEqual(
      message.source.kind,
      'plugin',
      "V4 原生准入对 kind === 'plugin' 抛 format v4 message requires a producer-owned source kind（2026-09-28 真机 P0）",
    );
    assert.equal(Object.hasOwn(message.source, 'plugin'), false, 'V3 的 plugin 字段不再出现');
  }
});

test('id 是随机 uuid：形状合法且两次调用不同', () => {
  const first = buildReminderMessage({ fileName: FILE_NAME, filePath: FILE_PATH });
  const second = buildReminderMessage({ fileName: FILE_NAME, filePath: FILE_PATH });
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(typeof second.id, 'string');
  assert.notEqual(first.id, second.id, 'id 必须每条消息新生成');
});

test('pluginName 缺省为 memory，显式传入时透传', () => {
  const fallback = buildReminderMessage({ fileName: FILE_NAME, filePath: FILE_PATH });
  assert.deepEqual(fallback.source, { kind: 'plugin:memory' });
  const custom = buildReminderMessage({ fileName: FILE_NAME, filePath: FILE_PATH, pluginName: 'other-plugin' });
  assert.deepEqual(custom.source, { kind: 'plugin:other-plugin' });
});

test('提醒正文首行以 [记忆插件] 开头（默认前缀）', () => {
  const text = buildReminderText({ fileName: FILE_NAME, filePath: FILE_PATH });
  assert.equal(firstLine(text).startsWith('[记忆插件]'), true, `首行应为前缀开头，实际：${firstLine(text)}`);
  assert.equal(text.startsWith('[记忆插件]'), true);
});

test('msgPrefix 可覆盖，且覆盖后不再出现默认前缀', () => {
  const text = buildReminderText({ msgPrefix: '[自定义]', fileName: FILE_NAME, filePath: FILE_PATH });
  assert.equal(firstLine(text).startsWith('[自定义]'), true);
  assert.equal(text.includes('[记忆插件]'), false);
});

test('正文只推动两种落笔：memory_write 与 memory_log', () => {
  const text = buildReminderText({ fileName: FILE_NAME, filePath: FILE_PATH });
  assert.equal(text.includes('memory_write'), true, '可复用结论应指向 memory_write');
  assert.equal(text.includes('memory_log'), true, '过程与证据应指向 memory_log');
  for (const forbidden of ['memory_edit', 'memory_archive', 'memory_search']) {
    assert.equal(text.includes(forbidden), false, `提醒不得提到 ${forbidden}`);
  }
});

test('正文带上当日文件名与路径', () => {
  const text = buildReminderText({ fileName: FILE_NAME, filePath: FILE_PATH });
  assert.equal(text.includes(FILE_NAME), true);
  assert.equal(text.includes(FILE_PATH), true);
});

test('正文明确允许忽略：没有值得沉淀的内容可以无视这条提醒', () => {
  const text = buildReminderText({ fileName: FILE_NAME, filePath: FILE_PATH });
  assert.match(text, /没有值得沉淀的内容/);
  assert.match(text, /忽略/);
  assert.match(text, /不是任务/, '提醒是资料不是指令（§1.4／§17.4）');
});

test('消息正文与 buildReminderText 的产物逐字一致', () => {
  const params = { msgPrefix: '[记忆插件]', fileName: FILE_NAME, filePath: FILE_PATH };
  const message = buildReminderMessage({ ...params, pluginName: 'memory' });
  assert.equal(message.content[0].text, buildReminderText(params));
});

test('同一入参两次调用正文恒定（前缀与模板不随会话变化）', () => {
  const params = { fileName: FILE_NAME, filePath: FILE_PATH };
  assert.equal(buildReminderText(params), buildReminderText(params));
});
