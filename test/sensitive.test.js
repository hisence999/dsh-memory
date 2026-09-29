/**
 * `sensitive` 的验收测试（设计 §7.6、§14.52）。
 *
 * 重点：正反例都要有——`Authorization: Bearer abc123` 必须命中，
 * `如何配置 TOKEN 刷新流程` 必须不命中；命中结果**绝不包含原文**。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES, CATEGORY_LABEL, SENSITIVE_HINT, describeHits, scanEntryTexts, scanSensitive } from '../src/sensitive.js';

describe('scanSensitive：必须命中', () => {
  test('Authorization: Bearer abc123 → 凭据（设计 §14.52 的正例）', () => {
    const result = scanSensitive('Authorization: Bearer abc123');
    assert.equal(result.hit, true);
    assert.equal(result.category, 'credential');
  });

  test('键值形凭据（英/中、冒号/等号）都命中', () => {
    for (const text of [
      'api_key = "sk-abcdefghijklmnop"',
      'access_token: aaaaaaaaaaaaaaaa',
      '数据库口令：s3cr3t-pass-9',
      '密码：123456',
      '私钥：not-a-real-key-0001',
      'COOKIE=sessionid1234',
    ]) {
      assert.equal(scanSensitive(text).hit, true, text);
    }
  });

  test('典型密钥字面量与 PEM 私钥命中', () => {
    assert.equal(scanSensitive('key = sk-abcdefghijklmnopqrstuvwx').category, 'credential');
    assert.equal(scanSensitive('ghp_abcdefghijklmnopqrstuvwxyz01').category, 'credential');
    assert.equal(scanSensitive('-----BEGIN RSA PRIVATE KEY-----').category, 'credential');
  });

  test('含账号口令的 URL → 连接串；纯 URL 不算', () => {
    assert.equal(scanSensitive('postgres://root:hunter2@db.local:5432/app').category, 'connection');
    assert.equal(scanSensitive('https://example.com/path/segment').hit, false);
    assert.equal(scanSensitive('mongodb://admin:pw12345@127.0.0.1:27017').category, 'connection');
  });

  test('身份类：身份证号 / 完整手机号 / 银行卡号', () => {
    assert.equal(scanSensitive('身份证 11010519491231002X').category, 'identity');
    assert.equal(scanSensitive('手机号 13800138000').category, 'identity');
    assert.equal(scanSensitive('卡号 6222021234567890123').category, 'identity');
  });
});

describe('scanSensitive：必须不命中', () => {
  test('"如何配置 TOKEN 刷新流程" → 不命中（设计 §14.52 的反例）', () => {
    assert.deepEqual(scanSensitive('如何配置 TOKEN 刷新流程'), { hit: false });
  });

  test('中文说明性文字（有键名但没有具体值）不命中', () => {
    for (const text of [
      '令牌：请向管理员索取',
      '把 TOKEN 放入请求头，不要写进记忆',
      '端口 3080、版本 1.2.3、路径 src/tools/write.js',
      '有效期到 2026-09-21，权重 42',
      '不要提交 .env 或含密钥的文件',
    ]) {
      assert.equal(scanSensitive(text).hit, false, text);
    }
  });

  test('边界：空值与非法入参不抛错', () => {
    assert.equal(scanSensitive('').hit, false);
    assert.equal(scanSensitive(undefined).hit, false);
    assert.equal(scanSensitive(null).hit, false);
    assert.equal(scanSensitive(12345).hit, false);
  });
});

describe('scanEntryTexts：位置与类别（不回显原文）', () => {
  test('逐字段返回中文位置与类别', () => {
    const hits = scanEntryTexts({
      title: 'Authorization: Bearer abc123',
      detail: '连接串：postgres://root:hunter2@db.local/app',
      tags: ['ok'],
      aliases: ['11010519491231002X'],
    });
    assert.deepEqual(hits, [
      { field: '标题', category: 'credential' },
      { field: '详细', category: 'connection' },
      { field: '别名', category: 'identity' },
    ]);
  });

  test('标签命中；同一字段同一类别只报一次；命中清单里没有原文', () => {
    const hits = scanEntryTexts({ title: '', detail: '', tags: ['密码：123456', '密码：654321'], aliases: [] });
    assert.deepEqual(hits, [{ field: '标签', category: 'credential' }]);
    assert.ok(!JSON.stringify(hits).includes('123456'));
  });

  test('干净文本返回空清单', () => {
    assert.deepEqual(scanEntryTexts({ title: '如何配置 TOKEN 刷新流程', detail: '只讲流程', tags: ['token'], aliases: [] }), []);
  });
});

describe('分类标签与提示文本', () => {
  test('三档类别齐全，且有中文展示名', () => {
    assert.deepEqual([...CATEGORIES], ['credential', 'connection', 'identity']);
    assert.equal(CATEGORY_LABEL.credential, '凭据');
    assert.equal(CATEGORY_LABEL.connection, '连接串');
    assert.equal(CATEGORY_LABEL.identity, '身份');
  });

  test('误伤提示是设计原文口径', () => {
    assert.match(SENSITIVE_HINT, /如何配置 TOKEN 刷新流程/);
    assert.match(SENSITIVE_HINT, /改写为不含具体值/);
  });

  test('describeHits 给出"位置（中文类别 英文码）"', () => {
    assert.equal(describeHits([{ field: '标题', category: 'credential' }]), '标题（凭据 credential）');
  });
});
