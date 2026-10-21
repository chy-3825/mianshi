'use strict';

// Keep this a small vocabulary, not a document or a generated answer. Large
// context lists made Qwen repeat the list in the 100-question experiment.
const MAX_PROMPT_CHARS = 128;
const MAX_TERMS = 20;
const PREFIX = '技术面试词汇：';
const BASE_TERMS = Object.freeze([
  '浅拷贝',
  '宏任务',
  '竞态',
  '背压',
  '事务',
  '脏读',
  '幻读',
  'B+树',
  'SIGTERM',
  'systemd',
  'CER',
  'WER',
  'P95',
  '事务隔离级别',
  '雅可比',
  '请求会话',
  'iframe',
  '军棋',
]);

const key = (term) => term.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

function cleanTerm(value) {
  if (typeof value !== 'string') return '';
  const term = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!term || [...term].length > 24 || !/^[\p{L}\p{N}+#._ /-]+$/u.test(term)) return '';
  return term;
}

function limitContext(value) {
  return typeof value === 'string' ? [...value].slice(0, MAX_PROMPT_CHARS).join('') : '';
}

function buildAsrContext(settings = {}, projects = []) {
  const engine = settings.localSttEngine || 'qwen3-asr';
  if (
    settings.localSttContextEnabled === false ||
    !['qwen3-asr', 'qwen'].includes(engine) ||
    (settings.sttLanguage && !['zh', 'zh-CN'].includes(settings.sttLanguage))
  )
    return { prompt: '', termCount: 0 };

  const projectNames = [];
  const projectKeywords = [];
  for (const project of (Array.isArray(projects) ? projects : []).slice(0, 3)) {
    if (!project || typeof project !== 'object') continue;
    const keywords = Array.isArray(project.keywords) ? project.keywords.slice(0, 8) : [];
    const name = cleanTerm(project.name);
    // Prefer a declared spoken alias (Demo App) over its joined spelling
    // (demoapp), while counting both as just one vocabulary item.
    const spokenAlias = keywords.find(
      (word) => typeof word === 'string' && /\s/.test(word) && name && key(word) === key(name),
    );
    if (name) projectNames.push(spokenAlias || name);
    projectKeywords.push(...keywords);
  }
  const extra =
    typeof settings.localSttContextTerms === 'string'
      ? settings.localSttContextTerms.slice(0, 500).split(/[,，、;；\r\n]+/)
      : [];
  const terms = [];
  const seen = new Set();
  const uniqueKeywords = [];
  const keywordSeen = new Set(projectNames.map(key));
  for (const candidate of projectKeywords) {
    const term = cleanTerm(candidate);
    if (!term || keywordSeen.has(key(term))) continue;
    keywordSeen.add(key(term));
    uniqueKeywords.push(term);
    if (uniqueKeywords.length >= 3) break;
  }
  for (const candidate of [...projectNames, ...uniqueKeywords, ...extra, ...BASE_TERMS]) {
    const term = cleanTerm(candidate);
    if (!term || seen.has(key(term))) continue;
    const next = PREFIX + [...terms, term].join('、') + '。';
    if ([...next].length > MAX_PROMPT_CHARS) continue;
    terms.push(term);
    seen.add(key(term));
    if (terms.length >= MAX_TERMS) break;
  }
  return { prompt: terms.length ? PREFIX + terms.join('、') + '。' : '', termCount: terms.length };
}

module.exports = { buildAsrContext, limitContext, MAX_PROMPT_CHARS, MAX_TERMS, BASE_TERMS };
