/**
 * `errors` 的验收测试（设计 §7.6）。
 *
 * 硬要求：九个错误码齐全；模型看到的文本必须含"做了什么／结果如何／下一步建议"三段。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CODES, errorToText, isCode, makeError } from '../src/errors.js';

describe('CODES：九种错误码', () => {
  test('码表与设计 §7.6 一致', () => {
    assert.deepEqual(
      [...CODES],
      ['invalid_param', 'not_found', 'duplicate', 'conflict', 'sensitive', 'too_long', 'write_conflict', 'locked', 'degraded'],
    );
    assert.equal(new Set(CODES).size, 9);
  });

  test('isCode 只认码表里的值', () => {
    assert.equal(isCode('conflict'), true);
    assert.equal(isCode('nope'), false);
    assert.equal(isCode(undefined), false);
  });
});

describe('makeError', () => {
  test('返回 ok:false 与三段所需字段', () => {
    const error = makeError('duplicate', { message: '标题与 #0003 完全相同', nextStep: '改用 memory_edit', entryIndex: 1 });
    assert.equal(error.ok, false);
    assert.equal(error.code, 'duplicate');
    assert.equal(error.message, '标题与 #0003 完全相同');
    assert.equal(error.nextStep, '改用 memory_edit');
    assert.equal(error.entryIndex, 1);
  });

  test('缺 message／nextStep 时有兜底，绝不返回半成品', () => {
    const error = makeError('locked', {});
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
    assert.ok(error.nextStep.length > 0);
  });

  test('非法错误码抛 TypeError（码表是闭集）', () => {
    assert.throws(() => makeError('whatever', {}), TypeError);
    assert.throws(() => makeError('', {}), TypeError);
    assert.throws(() => makeError(/** @type {any} */ (null), {}), TypeError);
  });
});

describe('errorToText：三段式', () => {
  test('永远包含"做了什么 / 结果 / 下一步建议"与错误码', () => {
    const text = errorToText(makeError('sensitive', { message: '命中敏感信息：标题（凭据 credential）', nextStep: '改写后重试' }));
    assert.match(text, /做了什么：/);
    assert.match(text, /结果：/);
    assert.match(text, /下一步建议：/);
    assert.match(text, /错误码：sensitive/);
    assert.match(text, /凭据/);
  });

  test('entryIndex 渲染成"第 N 条"（0 起 → 1 起展示）', () => {
    const text = errorToText(makeError('too_long', { message: 'title 超长', entryIndex: 2 }));
    assert.match(text, /第 3 条/);
  });

  test('field 渲染进结果行', () => {
    const text = errorToText(makeError('invalid_param', { message: '值非法', field: 'expiresAt' }));
    assert.match(text, /expiresAt：值非法/);
  });

  test('可以带标题行，且对残缺输入不抛错', () => {
    const withTitle = errorToText(makeError('conflict', { message: '与 #0011 冲突' }), { title: '[memory_write 未执行]' });
    assert.match(withTitle, /^\[memory_write 未执行\]\n做了什么：/);
    const tolerant = errorToText(/** @type {any} */ ({}));
    assert.match(tolerant, /做了什么：/);
    assert.match(tolerant, /下一步建议：/);
  });

  test('每个码都有默认的"做了什么"与"下一步"，不会出现空段', () => {
    for (const code of CODES) {
      const text = errorToText(makeError(code, {}));
      assert.match(text, new RegExp(`做了什么：\\S`), code);
      assert.match(text, new RegExp(`下一步建议：\\S`), code);
      assert.match(text, new RegExp(`错误码：${code}`), code);
    }
  });
});
