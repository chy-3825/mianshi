'use strict';

// OpenAI 兼容的 Chat Completions 客户端（SSE 流式）。
// 用于 DeepSeek / OpenAI / Ollama 等：只需提供不同的 baseURL（+可选 apiKey）。
const { GenError } = require('./llm');
const { performance } = require('node:perf_hooks');

const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';

// 只识别答案正文和思考片段是否存在；不保存或输出思考内容。
function parseSSEDelta(payload) {
  if (!payload || payload === '[DONE]') return { content: '', hasReasoning: false };
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch (_e) {
    return { content: '', hasReasoning: false };
  }
  const delta = obj?.choices?.[0]?.delta;
  const usage = {};
  for (const [field, value] of Object.entries({
    promptTokens: obj?.usage?.prompt_tokens,
    completionTokens: obj?.usage?.completion_tokens,
    reasoningTokens: obj?.usage?.completion_tokens_details?.reasoning_tokens,
    totalTokens: obj?.usage?.total_tokens,
    cachedPromptTokens:
      obj?.usage?.prompt_cache_hit_tokens ?? obj?.usage?.prompt_tokens_details?.cached_tokens,
  })) {
    if (Number.isSafeInteger(value) && value >= 0) usage[field] = value;
  }
  const finishReason = obj?.choices?.[0]?.finish_reason;
  return {
    content: typeof delta?.content === 'string' ? delta.content : '',
    hasReasoning:
      typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0,
    usage,
    finishReason: ['stop', 'length', 'content_filter', 'tool_calls'].includes(finishReason)
      ? finishReason
      : undefined,
  };
}

// 保持原有的纯文本提取接口，供调用方和单测使用。
function deltaFromSSEData(payload) {
  return parseSSEDelta(payload).content;
}

async function generateAnswerStream({
  apiKey,
  baseURL,
  model,
  systemInstruction,
  userText,
  maxOutputTokens = 2048,
  temperature = 0.6,
  thinking,
  signal,
  onStart,
  onChunk,
  onTiming,
}) {
  const startedAt = performance.now();
  let responseStatus = null;
  let reasoningFragments = 0;
  let contentFragments = 0;
  let outcome = 'error';
  let usage = {};
  let finishReason;
  // 可选观测回调只接收阶段、耗时和计数，不接收 URL、密钥或提示词。
  // 观测失败不应中断面试作答。
  const mark = (stage, extra = {}) => {
    if (typeof onTiming !== 'function') return;
    try {
      onTiming({ stage, elapsedMs: Math.max(0, performance.now() - startedAt), ...extra });
    } catch (_e) {
      /* ignore observer errors */
    }
  };
  mark('request-start');

  try {
    const endpoint = baseURL || DEFAULT_ENDPOINT;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

    const body = {
      model,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userText },
      ],
      stream: true,
      max_tokens: maxOutputTokens,
      temperature,
    };
    // 第三方兼容接口支持程度不同；仅调用方明确指定时发送。
    if (thinking !== undefined) body.thinking = thinking;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    responseStatus = res.status;
    mark('response-headers', { status: responseStatus });

    if (!res.ok || !res.body) {
      let txt = '';
      try {
        txt = await res.text();
      } catch (_e) {
        /* ignore */
      }
      throw new GenError(res.status, `生成失败 (${res.status}): ${txt.slice(0, 400)}`);
    }

    if (onStart) onStart();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    const flushLine = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const delta = parseSSEDelta(t.slice(5).trim());
      if (delta.usage) usage = { ...usage, ...delta.usage };
      if (delta.finishReason) finishReason = delta.finishReason;
      if (delta.hasReasoning) {
        reasoningFragments += 1;
        if (reasoningFragments === 1) mark('first-reasoning');
      }
      if (delta.content) {
        contentFragments += 1;
        if (contentFragments === 1) mark('first-content');
        full += delta.content;
        if (onChunk) onChunk(delta.content);
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        flushLine(line);
      }
    }
    if (buffer) flushLine(buffer);

    outcome = 'success';
    return full;
  } catch (e) {
    outcome = e.name === 'AbortError' ? 'aborted' : 'error';
    throw e;
  } finally {
    mark('complete', {
      outcome,
      status: responseStatus,
      reasoningFragments,
      contentFragments,
      ...usage,
      ...(finishReason ? { finishReason } : {}),
    });
  }
}

module.exports = { generateAnswerStream, deltaFromSSEData };
