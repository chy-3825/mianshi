'use strict';

// Diagnostics, not an automatic factual-accuracy judge. Raw text is always
// retained alongside edit-distance and explicitly declared concept groups.
function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function chineseInteger(value) {
  const digits = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  let total = 0;
  let current = 0;
  for (const char of value) {
    if (char === '十' || char === '百') {
      total += (current || 1) * (char === '十' ? 10 : 100);
      current = 0;
    } else if (Object.hasOwn(digits, char)) current = digits[char];
    else return value;
  }
  return String(total + current);
}

function canonicalText(value) {
  // Only declared number + unit forms. Never turn 一致性/二分查找 into digits.
  return normalizeText(
    String(value || '').replace(
      /([零〇一二两三四五六七八九十百]+)(?=\s*(?:毫秒|秒|分钟|个|种|次|人|条|项|份))/g,
      (_, number) => chineseInteger(number),
    ),
  );
}

function editDistance(reference, hypothesis) {
  const a = Array.from(reference);
  const b = Array.from(hypothesis);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function characterError(reference, hypothesis) {
  const ref = String(reference || '');
  const hyp = String(hypothesis || '');
  const length = Array.from(ref).length;
  const edits = editDistance(ref, hyp);
  return { edits, referenceChars: length, rate: length ? edits / length : null };
}

function transcriptionMetrics(reference, hypothesis) {
  return {
    // Literal CER includes punctuation, which is not spoken; report separately.
    literal: characterError(reference, hypothesis),
    surface: characterError(normalizeText(reference), normalizeText(hypothesis)),
    canonical: characterError(canonicalText(reference), canonicalText(hypothesis)),
  };
}

function conceptCoverage(text, groups = []) {
  const normalized = canonicalText(text);
  const hits = groups.map((group) =>
    (Array.isArray(group) ? group : [group]).some((alias) => {
      const value = canonicalText(alias);
      return value.length > 0 && normalized.includes(value);
    }),
  );
  return {
    expected: hits.length,
    matched: hits.filter(Boolean).length,
    allMatched: hits.every(Boolean),
    missing: groups.filter((_group, i) => !hits[i]),
  };
}

function answerProxies(text, checks = {}) {
  const positive = conceptCoverage(text, checks.mustMention || []);
  const normalized = canonicalText(text);
  const forbidden = (checks.mustNotMention || []).filter((term) =>
    normalized.includes(canonicalText(term)),
  );
  return { ...positive, forbidden, passed: positive.allMatched && forbidden.length === 0 };
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0 };
  const quantile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return {
    n: sorted.length,
    min: sorted[0],
    mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: quantile(0.5),
    p90: quantile(0.9),
    p95: quantile(0.95),
    max: sorted.at(-1),
  };
}

function aggregateResults(results, expectedCount) {
  const answers = results.flatMap((result) => result.answers || []);
  const successful = answers.filter(
    (answer) => answer.successful && !answer.truncated && !answer.answerIncomplete,
  );
  const uniqueSuccessful = results
    .filter(
      (result) =>
        result.requestCount === 1 &&
        !result.earlyTrigger &&
        result.answers?.[0]?.successful &&
        !result.answers[0].truncated &&
        !result.answers[0].answerIncomplete,
    )
    .map((result) => result.answers[0]);
  const rate = (key) => {
    const entries = results.map((result) => result.transcriptionMetrics?.[key]).filter(Boolean);
    const edits = entries.reduce((sum, entry) => sum + entry.edits, 0);
    const referenceChars = entries.reduce((sum, entry) => sum + entry.referenceChars, 0);
    return { edits, referenceChars, rate: referenceChars ? edits / referenceChars : null };
  };
  const count = (predicate) => results.filter(predicate).length;
  const answerErrorEvents = results
    .flatMap((result) => result.events || [])
    .filter((entry) => entry.event === 'answer_error');
  return {
    expectedCount,
    completedCases: results.length,
    structurePassed: count((result) => result.structurePassed),
    noTrigger: count((result) => result.triggerCount === 0),
    duplicateTrigger: count((result) => result.triggerCount > 1),
    earlyTrigger: count((result) => result.earlyTrigger),
    noTranscript: count((result) => !result.transcripts?.join('').trim()),
    conceptComplete: count((result) => result.concepts?.allMatched),
    routePassed: count((result) => result.answers?.length === 1 && result.answers[0].routingPassed),
    answerProxyPassed: count(
      (result) =>
        result.answerProxy?.passed && result.answers?.length === 1 && result.answers[0].successful,
    ),
    serviceFailedCases: count((result) => result.answerErrorCount > 0),
    firstContentTimeouts: answerErrorEvents.filter(
      (entry) => entry.reason === 'first_content_timeout',
    ).length,
    overallTimeouts: answerErrorEvents.filter((entry) => entry.reason === 'overall_timeout').length,
    truncatedAnswers: answers.filter((answer) => answer.truncated).length,
    suspectedIncompleteAnswers: answers.filter((answer) => answer.answerIncomplete).length,
    deliveredAnswers: answers.filter((answer) => answer.successful).length,
    totalLogicalRequests: answers.length,
    modelAttempts: results.reduce(
      (sum, result) =>
        sum +
        (result.events || []).filter(
          (entry) => entry.event === 'answer_timing' && entry.stage === 'request-start',
        ).length,
      0,
    ),
    successfulAnswers: successful.length,
    characterError: {
      literal: rate('literal'),
      surface: rate('surface'),
      canonical: rate('canonical'),
    },
    latencyMs: Object.fromEntries(
      [
        'speechEndToFirstVisible',
        'requestToFirstVisible',
        'speechEndToDone',
        'vadToAsr',
        'asrToTrigger',
        'firstVisibleToDone',
      ].map((field) => [
        field,
        distribution(uniqueSuccessful.map((answer) => answer.latencyMs?.[field])),
      ]),
    ),
    queueMs: distribution(
      results.flatMap((result) => result.asr || []).map((entry) => entry.queueMs),
    ),
    inferenceMs: distribution(
      results.flatMap((result) => result.asr || []).map((entry) => entry.inferenceMs),
    ),
    retrievalMs: distribution(answers.map((answer) => answer.retrievalMs)),
    note: '延迟分位数仅含唯一、非提前、成功且未截断的回答；另列失败与超时。CER按总编辑距离/总参考字符加权。概念及答案关键词是诊断代理，不是专业正确率。',
  };
}

module.exports = {
  normalizeText,
  canonicalText,
  editDistance,
  transcriptionMetrics,
  conceptCoverage,
  answerProxies,
  distribution,
  aggregateResults,
};
