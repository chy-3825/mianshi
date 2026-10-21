'use strict';
/* global module */

// The same small, deterministic question detector is used by the renderer and
// the main process. It deliberately does not rewrite ASR text or call a model.
const QuestionDetection = (() => {
  const ENGLISH_QUESTION =
    /^(?:what|why|how|when|where|who|which|can you|could you|tell me|walk me|describe|explain|do you|have you|would you)\b/i;
  const CHINESE_QUESTION_WORD =
    /为什么|怎么|怎样|如何|什么|哪(?:个|些|种|里|儿)|谁|多少|多久|是否|能否|有没有|是不是|能不能|会不会|可不可以|要不要/;
  const CHINESE_REQUEST =
    /(?:^|[，,。；;])\s*(?:(?:请(?:你|您|你们)?|你(?:们)?(?:能|可以)?|您(?:能|可以)?|能|可以)\s*)?(?:简单|具体|详细)?\s*(?:介绍(?:一下)?|说说|讲讲|谈谈|解释(?:一下)?|描述(?:一下)?|分享(?:一下)?|举(?:个例子|出|例)|分析(?:一下)?|聊聊)/;

  function isQuestion(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    return (
      /[?？]/.test(value) ||
      ENGLISH_QUESTION.test(value) ||
      CHINESE_QUESTION_WORD.test(value) ||
      CHINESE_REQUEST.test(value) ||
      /[吗么呢][。.!！]*$/.test(value)
    );
  }

  // Segments here are only from the current interviewer turn. The caller
  // clears the buffer after each decision, so an older question cannot make
  // a later non-question look actionable.
  function selectCurrentQuestion(segments) {
    const texts = (Array.isArray(segments) ? segments : [segments])
      .map((item) =>
        String(typeof item === 'object' && item !== null ? item.text || '' : item || '').trim(),
      )
      .filter(Boolean);
    const current = texts.join(' ').replace(/\s+/g, ' ').trim();
    return isQuestion(current) ? current : '';
  }

  function isNearDuplicateQuestion(previous, current) {
    const clean = (value) =>
      String(value || '')
        .toLowerCase()
        .replace(/[\s\p{P}]/gu, '');
    const a = clean(previous);
    const b = clean(current);
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    if (shorter >= 8 && shorter / longer >= 0.72 && (a.includes(b) || b.includes(a))) return true;
    if (shorter < 12 || shorter / longer < 0.75) return false;
    const counts = new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const gram = a.slice(i, i + 2);
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
    let overlap = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const gram = b.slice(i, i + 2);
      const count = counts.get(gram) || 0;
      if (count > 0) {
        overlap++;
        counts.set(gram, count - 1);
      }
    }
    return (2 * overlap) / (a.length + b.length - 2) >= 0.82;
  }

  class AutoQuestionBuffer {
    constructor() {
      this.parts = [];
      this.latestTiming = null;
    }

    append(text, timing = null) {
      const value = String(text || '').trim();
      if (!value) return;
      this.parts.push(value);
      if (this.parts.length > 4) this.parts.shift();
      this.latestTiming = timing;
    }

    take() {
      const result = {
        question: selectCurrentQuestion(this.parts),
        timing: this.latestTiming,
      };
      this.clear();
      return result.question ? result : null;
    }

    clear() {
      this.parts = [];
      this.latestTiming = null;
    }
  }

  return { isQuestion, isNearDuplicateQuestion, selectCurrentQuestion, AutoQuestionBuffer };
})();

if (typeof window !== 'undefined') window.QuestionDetection = QuestionDetection;
if (typeof module !== 'undefined') module.exports = QuestionDetection;
