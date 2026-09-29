/**
 * 跨进程写锁：`wx` 创建锁文件即获得锁，轮询等待，陈旧锁接管。
 *
 * 设计依据：§2.1（同一项目两个会话共享 `memory/`，靠跨进程写锁保证一致）、
 * §12（一致性）、设计 §12.1（多文件操作必须先拿到锁）；手册 §8.2（`wx` 幂等建文件）。
 *
 * 语义要点：
 *  1. 只有 `wx`（独占创建）成功才算拿到锁——**创建锁文件这个动作本身是原子的**，
 *     因此不需要额外的协商协议；
 *  2. 拿不到就轮询到 `timeoutMs` 超时，返回 `{ ok:false, reason:'locked' }`；
 *  3. 锁文件 mtime 超过 `staleMs` 视为陈旧锁（持锁进程已被杀），接管并记
 *     `stale-lock-taken` 告警（§4 码表）；
 *  4. `release()` 只删**自己创建的**那把锁：删之前比对内容令牌，锁已被别人接管时
 *     不动手，避免把别人的锁删掉。
 *
 * 只依赖 `node:` 内置模块；除编程错误外不抛异常。
 */

import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/** 默认锁等待上限（毫秒），与 `config.js` 的 `lockTimeoutMs` 默认值一致。 */
const DEFAULT_TIMEOUT_MS = 5000;

/** 默认陈旧锁判定阈值（毫秒），与 `config.js` 的 `staleLockMs` 默认值一致。 */
const DEFAULT_STALE_MS = 60_000;

/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 50;

/**
 * @typedef {object} Warning
 * @property {string} code
 * @property {string} message
 * @property {string} [filePath]
 */

/**
 * @typedef {object} LockHandle
 * @property {true} ok
 * @property {() => Promise<void>} release 释放锁；幂等，且**只删自己创建的锁**
 * @property {Warning[]} warnings 本次拿锁过程中产生的告警（如接管陈旧锁）
 */

/**
 * @typedef {object} LockFailure
 * @property {false} ok
 * @property {'locked'|'io_error'} reason `locked` = 等待超时/已中止；`io_error` = 环境失败
 * @property {string} [error]
 * @property {Warning[]} warnings
 */

/**
 * 获取跨进程锁。
 *
 * @param {string} lockPath 锁文件绝对路径（惯例 `<memoryDir>/.state/lock`）
 * @param {{ timeoutMs?: number, staleMs?: number, signal?: AbortSignal, warn?: (warning: Warning) => void }} [opts]
 *        `warn` 用于把接管陈旧锁这件事立刻交给调用方记日志（同时也会出现在返回值的 `warnings` 里）
 * @returns {Promise<LockHandle|LockFailure>}
 */
export async function acquireLock(lockPath, opts = {}) {
  const timeoutMs = positiveOr(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  const staleMs = positiveOr(opts.staleMs, DEFAULT_STALE_MS);
  const signal = opts.signal;
  const warn = opts.warn;

  /** 本次锁的持有凭据：写进锁文件，`release()` 靠它确认"这把锁还是我的"。 */
  const token = `${JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    nonce: randomBytes(4).toString('hex'),
  })}\n`;

  /** @type {Warning[]} */
  const warnings = [];
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // 入口处已中止：既没拿到锁也没在等待，归类为环境类失败。
    if (isAborted(signal)) return failure('io_error', '等待跨进程锁已中止（AbortSignal）', warnings);

    try {
      await writeFile(lockPath, token, { encoding: 'utf8', flag: 'wx' });
      return { ok: true, release: makeRelease(lockPath, token), warnings };
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) {
        return failure('io_error', `创建锁文件失败：${describeError(error)}`, warnings);
      }
    }

    // 锁被占用：先看是不是陈旧锁（持锁进程已被杀 → 不能一直等下去）。
    const state = await lockState(lockPath);
    if (state.exists && staleMs > 0 && Date.now() - state.mtimeMs > staleMs) {
      try {
        await unlink(lockPath);
        const warning = staleWarning(lockPath, staleMs);
        warnings.push(warning);
        warn?.(warning);
        continue; // 立刻重试独占创建，不再等待一个轮询间隔。
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) {
          return failure('io_error', `清理陈旧锁失败：${describeError(error)}`, warnings);
        }
        continue; // 锁正好被别人删了：直接重试。
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return failure('locked', `等待跨进程锁超时（${timeoutMs}ms，锁文件：${lockPath}）`, warnings);
    }
    await sleep(Math.min(POLL_INTERVAL_MS, remaining), signal);
  }
}

/**
 * 生成 `release()`。用内容令牌确认锁仍归自己所有，再删除。
 *
 * 释放是"尽力而为"：失败不抛异常（否则会把调用方的收尾逻辑炸掉），
 * 删不掉时锁会留给后续的陈旧锁接管路径处理。
 *
 * @param {string} lockPath
 * @param {string} token
 * @returns {() => Promise<void>}
 */
function makeRelease(lockPath, token) {
  return async () => {
    try {
      const current = await readFile(lockPath, 'utf8');
      if (current !== token) return; // 锁已被接管/替换，不是我的，不动。
      await unlink(lockPath);
    } catch {
      // ENOENT（已释放）或读失败：都当作"无需再动"。
    }
  };
}

/**
 * 读取锁文件现状。
 *
 * @param {string} lockPath
 * @returns {Promise<{ exists: true, mtimeMs: number } | { exists: false }>}
 */
async function lockState(lockPath) {
  try {
    const info = await stat(lockPath);
    return { exists: true, mtimeMs: info.mtimeMs };
  } catch {
    return { exists: false };
  }
}

/**
 * 等待，可被 `signal` 提前唤醒（唤醒后由调用方在循环顶部判定中止）。
 *
 * 监听器在完成时移除，避免长轮询在同一个 signal 上堆积监听器。
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    /** @type {boolean} */
    let done = false;
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    if (signal !== undefined) {
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
    }
  });
}

/**
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {Warning}
 */
function staleWarning(lockPath, staleMs) {
  return {
    code: 'stale-lock-taken',
    message: `发现陈旧锁（锁文件修改时间已超过 ${staleMs}ms，持锁进程疑似已被杀），已接管：${lockPath}`,
    filePath: lockPath,
  };
}

/**
 * @param {'locked'|'io_error'} reason
 * @param {string} error
 * @param {Warning[]} warnings
 * @returns {LockFailure}
 */
function failure(reason, error, warnings) {
  return { ok: false, reason, error, warnings };
}

/**
 * 有限非负数则沿用，否则回退默认值（配置非法不抛错，手册 §8.1）。
 *
 * @param {number|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveOr(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/**
 * @param {AbortSignal} [signal]
 * @returns {boolean}
 */
function isAborted(signal) {
  return signal !== undefined && signal.aborted;
}

/**
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
function isErrorCode(error, code) {
  if (typeof error !== 'object' || error === null) return false;
  return /** @type {{ code?: unknown }} */ (error).code === code;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
