'use strict';

// 跨 Provider 的通用层：错误类型 + 重试/兜底逻辑。
// 具体的流式实现由各 Provider 的 generateAnswerStream 提供（gemini.js / openaiCompat.js）。

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const { setTimeout: sleep } = require('node:timers/promises');
const TRANSIENT_NETWORK = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

// Node fetch wraps socket failures in TypeError.cause. Do not retry arbitrary
// TypeErrors, invalid URLs, certificate failures or errors after stream start.
function networkErrorCode(error) {
  for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
    if (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code))
      return error.code;
  }
  return undefined;
}

class GenError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GenError';
    this.status = status;
  }
}

/**
 * 按 models 顺序尝试；临时性 HTTP/连接错误先重试，仍失败切下一个；
 * 一旦开始输出(onStart 已触发)就不再切换。
 * @param {function} opts.streamFn  provider 的 generateAnswerStream
 * @returns {Promise<{model:string, text:string}>}
 */
async function generateWithFallback({ streamFn, models, retries = 1, onStart, ...rest }) {
  let started = false;
  let lastErr = null;

  for (const model of models) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        rest.signal?.throwIfAborted();
        const text = await streamFn({
          ...rest,
          model,
          onStart: () => {
            started = true;
            if (onStart) onStart(model);
          },
        });
        return { model, text };
      } catch (e) {
        lastErr = e;
        if (started) throw e;
        if (e.name === 'AbortError' || rest.signal?.aborted) throw e;
        const transient = TRANSIENT.has(e.status) || TRANSIENT_NETWORK.has(networkErrorCode(e));
        if (transient && attempt < retries) {
          await sleep(400 * (attempt + 1), undefined, { signal: rest.signal });
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error('生成失败：所有模型均不可用');
}

module.exports = { GenError, TRANSIENT, generateWithFallback, networkErrorCode };
