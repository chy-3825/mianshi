'use strict';

const { chunkText } = require('./documents');

const CONTEXT_NOTE =
  '【资料时效】以下是静态导入资料，仅供参考。方法名须以代码原文为准；测试数量、覆盖率等当前事实不能仅凭旧报告确认，没有实际运行结果就不要报具体当前数字。';
const TRUNCATED_NOTE = '[资料过长，已截断]';
const STOP_WORDS = new Set([
  '一下',
  '一些',
  '一个',
  '什么',
  '怎么',
  '如何',
  '介绍',
  '讲讲',
  '说说',
  '这个',
  '那个',
  '我们',
  '你们',
  '项目',
  '关于',
  '请问',
  'the',
  'and',
  'for',
  'what',
  'how',
  'with',
  'about',
]);

function tokenize(text) {
  const terms = new Set();
  for (const match of String(text || '').matchAll(
    /[\p{Script=Han}]+|[a-zA-Z][a-zA-Z0-9_.-]*|[0-9]+/gu,
  )) {
    const part = match[0];
    if (/^[\p{Script=Han}]+$/u.test(part)) {
      for (const size of [2, 3]) {
        for (let i = 0; i <= part.length - size; i++) {
          const term = part.slice(i, i + size);
          if (!STOP_WORDS.has(term)) terms.add(term);
        }
      }
    } else {
      const normalized = part.toLowerCase();
      if (normalized.length > 1 && !STOP_WORDS.has(normalized)) terms.add(normalized);
      for (const word of part.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_.\-\s]+/)) {
        const term = word.toLowerCase();
        if (term.length > 2 && !STOP_WORDS.has(term)) terms.add(term);
      }
    }
  }
  return terms;
}

// 项目路由和片段排序分开：路由只在可靠命中时选择项目，不能因为 README
// 恰好包含“项目”“技术”这类普通词就把通用理论题串到旧项目。
const ROUTE_COMMON_TERMS = new Set([
  '项目',
  '技术',
  '系统',
  '功能',
  '问题',
  '作用',
  '内容',
  '资料',
  '相关',
  '实现',
  '代码',
  '介绍',
  '哪些',
  '多少',
  '其中',
  '分别',
  '如何',
  '怎么',
  '什么',
  '使用',
  '里面',
  '可以',
  '这个',
  '一个',
  'you',
  'your',
  'project',
]);
const ROUTE_FILLER =
  /请问|能不能|可不可以|能否|可以|请|帮我|介绍|讲讲|说说|这个|那个|该|上述|项目|一下|哪些|什么|怎么|如何|分别|其中|里面|有关|相关|还有|以及|有没有|有多少|有什么|都是|的|是|有|呢|吗|啊|？|\?|，|,|。/gu;
const FOLLOWUP =
  /(?:这个|那个|该|上述|刚才|前面)(?:项目|游戏|功能|模块|系统)|(?:它|其)(?:的|是|有|如何|怎么)|刚刚提到|接着|继续/u;
const WORD_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
// 泛词不是禁词：仍参与覆盖率和片段排序，但不能单独证明某个项目相关。
// 用户显式配置的关键词始终走 matchStrong，不受这里的低权重影响。
const ROUTE_WEAK_TERMS = new Set([
  '普通',
  '对象',
  '数据',
  '存储',
  '文件',
  '权限',
  '执行',
  '实际',
  '用途',
  '适合',
  '表示',
  '应该',
  '需要',
  '主要',
  '方法',
  '服务',
  '游戏',
  'javascript',
  'java',
  'script',
  'typescript',
  'python',
]);

function routeTerms(text) {
  const cleaned = String(text || '')
    .replace(ROUTE_FILLER, ' ')
    // 常见名词边界拆开，避免“棋类游戏”的跨词 n-gram 压过“六种棋类”。
    .replace(/游戏|系统|功能|技术/gu, ' $& ');
  const terms = tokenize(cleaned);
  for (const term of terms) {
    if (ROUTE_COMMON_TERMS.has(term)) terms.delete(term);
  }
  return { cleaned: cleaned.trim(), terms };
}

function routeFamilies(cleaned) {
  const families = new Map();
  const add = (source) => {
    const terms = tokenize(source);
    for (const term of terms) {
      if (ROUTE_COMMON_TERMS.has(term)) terms.delete(term);
    }
    if (terms.size) families.set(source.toLowerCase(), { source: source.toLowerCase(), terms });
  };
  for (const match of cleaned.matchAll(/[\p{Script=Han}]+|[a-zA-Z][a-zA-Z0-9_.-]*/gu)) {
    if (!/^[\p{Script=Han}]+$/u.test(match[0])) {
      // createGameClient / create / game / client 是同一原词族，不是四份证据。
      add(match[0]);
      continue;
    }
    let singles = '';
    const flush = () => {
      if (singles.length >= 2) add(singles);
      singles = '';
    };
    for (const { segment } of WORD_SEGMENTER.segment(match[0])) {
      if (segment.length === 1) singles += segment;
      else {
        flush();
        add(segment);
      }
    }
    flush();
  }
  return [...families.values()];
}

function compact(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function hasAlias(normalizedText, alias) {
  if (alias.length < 2) return false;
  let position = normalizedText.indexOf(alias);
  while (position !== -1) {
    if (!/^[a-z0-9]+$/.test(alias)) return true;
    const before = normalizedText[position - 1] || '';
    const after = normalizedText[position + alias.length] || '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    position = normalizedText.indexOf(alias, position + 1);
  }
  return false;
}

function buildProjectRouter(projects, previous = []) {
  const cached = new Map(previous.map((entry) => [entry.project.id, entry]));
  return projects.map((project) => {
    const aliases = [...new Set([project.name, ...project.keywords].map(compact))].filter(
      (alias) => alias.length >= 2,
    );
    const old = cached.get(project.id);
    return {
      project,
      aliases,
      terms: old && old.project.text === project.text ? old.terms : routeTerms(project.text).terms,
    };
  });
}

function relatedScore(entry, query) {
  const families = routeFamilies(query.cleaned);
  if (!families.length) return 0;
  const lexicalCoverage =
    [...query.terms].filter((term) => entry.terms.has(term)).length / query.terms.size;
  let total = 0;
  let matched = 0;
  let specificMatches = 0;
  let exactIdentifier = false;
  for (const family of families) {
    const matching = [...family.terms].filter((term) => entry.terms.has(term));
    const weak = ROUTE_WEAK_TERMS.has(family.source);
    const weight = weak ? 0.25 : 1;
    total += weight;
    if (!matching.length) continue;
    matched += weight;
    if (!weak) specificMatches++;
    if (!weak && /^[a-z][a-z0-9_.-]{5,}$/u.test(family.source) && entry.terms.has(family.source)) {
      exactIdentifier = true;
    }
  }
  const coverage = matched / total;
  // 简短、明确的类别词（如“棋类”）可以单独命中；较长问题至少需要两个
  // 独立原词族。跨“普通 / 对象”生成的“普通对”不能累加成额外证据。
  const shortSpecific = query.cleaned.length <= 4 && families.length === 1 && specificMatches === 1;
  const focusedCategory =
    specificMatches === 1 &&
    coverage >= 0.75 &&
    families.filter((family) => !ROUTE_WEAK_TERMS.has(family.source)).length === 1;
  if (!shortSpecific && !focusedCategory && specificMatches < 2 && !exactIdentifier) return 0;
  // 原来的片段覆盖门槛仍保留；词族去重不能反过来把少量泛匹配变成高覆盖。
  if (!shortSpecific && (coverage < 0.3 || lexicalCoverage < 0.3)) return 0;
  return matched + specificMatches * 0.5 + coverage;
}

function pickBest(scored, minimum = 0) {
  const ranked = scored
    .filter((entry) => entry.score > minimum)
    .sort((a, b) => b.score - a.score || a.position - b.position);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].score < ranked[1].score * 1.15) return null;
  return ranked[0].entry.project;
}

function matchStrong(router, text) {
  const normalizedText = compact(text);
  if (!normalizedText) return null;
  return pickBest(
    router.map((entry, position) => ({
      entry,
      position,
      score: Math.max(
        0,
        ...entry.aliases
          .filter((alias) => hasAlias(normalizedText, alias))
          .map((alias) => alias.length),
      ),
    })),
  );
}

function matchRelated(router, text) {
  const query = routeTerms(text);
  return pickBest(
    router.map((entry, position) => ({ entry, position, score: relatedScore(entry, query) })),
  );
}

function transcriptLines(transcript) {
  return String(transcript || '')
    .split('\n')
    .map((line) =>
      line.replace(/^\s*(?:Interviewer|Candidate|面试官|候选人|我)\s*[:：]\s*/iu, '').trim(),
    )
    .filter(Boolean);
}

function recentProjectMention(router, transcript) {
  const lines = transcriptLines(transcript).slice(-6);
  for (let i = lines.length - 1; i >= 0; i--) {
    const project = matchStrong(router, lines[i]);
    if (project) return project;
  }
  return null;
}

function selectProject(router, { question = '', transcript = '' } = {}) {
  if (!router.length) return null;
  const current = String(question || '').trim();
  if (current) {
    const direct = matchStrong(router, current);
    if (direct) return direct;
    // “这个项目”先解析指代，不能因另一个 README 更像当前话题而切换项目。
    if (FOLLOWUP.test(current)) {
      const previous = recentProjectMention(router, transcript);
      if (previous) return previous;
    }
    // 独立问题仍可按 README 内容匹配，不能无条件继承上一个项目。
    return matchRelated(router, current);
  }
  const lastLine = transcriptLines(transcript).at(-1) || '';
  return matchStrong(router, lastLine) || matchRelated(router, lastLine);
}

// Markdown 标题只在代码围栏外生效；表格和列表尽量作为完整段落保留。
// 超长段落仍有界切分，避免 PDF/纯文本整篇只有一个段落时索引过大。
function documentSections(text) {
  const sections = [];
  let headings = [];
  let lines = [];
  let fence = null;
  const flush = () => {
    const body = lines.join('\n').trim();
    if (body) sections.push({ heading: headings.join(' / '), title: headings.at(-1) || '', body });
    lines = [];
  };
  for (const line of String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      lines.push(line);
      continue;
    }
    const heading = !fence && line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) {
      lines.push(line);
      continue;
    }
    flush();
    headings = headings.slice(0, heading[1].length - 1);
    headings.push(heading[2]);
  }
  flush();
  return sections;
}

function sectionChunks(body) {
  const blocks = [];
  let lines = [];
  let fence = null;
  const flush = () => {
    const block = lines.join('\n').trim();
    if (block) blocks.push(block);
    lines = [];
  };
  for (const line of body.split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    if (!line.trim() && !fence) flush();
    else lines.push(line);
  }
  flush();
  const chunks = [];
  let current = '';
  for (const block of blocks) {
    if (block.length > 2200) {
      if (current) chunks.push(current);
      current = '';
      chunks.push(...splitLongBlock(block));
    } else if (current && current.length + block.length + 2 > 480) {
      chunks.push(current);
      current = block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLongBlock(block) {
  const lines = block.split('\n');
  if (lines.length === 1) return chunkText(block, 1400, 0);
  const table = /^\s*\|/u.test(lines[0]) && /^\s*\|[\s:|-]+\|\s*$/u.test(lines[1]);
  const prefix = table ? lines.splice(0, 2).join('\n') : '';
  const chunks = [];
  let current = prefix;
  for (const line of lines) {
    if (current.length > prefix.length && current.length + line.length + 1 > 1400) {
      chunks.push(current);
      current = prefix;
    }
    if (line.length > 2200) {
      if (current.length > prefix.length) chunks.push(current);
      chunks.push(...chunkText(line, 1400, 0));
      current = prefix;
    } else {
      current += `${current ? '\n' : ''}${line}`;
    }
  }
  if (current.length > prefix.length) chunks.push(current);
  return chunks;
}

function enumerationTerms(text) {
  const terms = new Set();
  // “六种棋类（甲、乙、丙）”“支持的协议包括 A、B”是直接的清单证据。
  // 仅识别带分隔符的枚举，避免把普通括号说明也当成分类依据。
  for (const match of text.matchAll(
    /([\p{Script=Han}a-zA-Z0-9_.\- ]{2,40})(?:[（(]([^）)\n]{3,300})[）)]|(?:包括|包含|分别为|分别是|：|:)\s*([^\n。；]{3,300}))/gu,
  )) {
    if (!/[、，,；;]/u.test(match[2] || match[3])) continue;
    for (const term of routeTerms(match[1]).terms) terms.add(term);
  }
  return terms;
}

function buildIndex(docs) {
  const chunks = [];
  const fullChunks = [];
  const frequencies = new Map();
  for (const [docIndex, doc] of docs.entries()) {
    const name = String(doc.name || '未命名资料')
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    if (String(doc.text || '').trim()) {
      fullChunks.push({ name, docIndex, partIndex: 0, text: String(doc.text).trim() });
    }
    let partIndex = 0;
    for (const [sectionIndex, section] of documentSections(doc.text).entries()) {
      const titleTerms = routeTerms(section.title).terms;
      for (const text of sectionChunks(section.body)) {
        const terms = routeTerms(text).terms;
        for (const term of new Set([...terms, ...titleTerms])) {
          frequencies.set(term, (frequencies.get(term) || 0) + 1);
        }
        chunks.push({
          name,
          docIndex,
          partIndex: partIndex++,
          sectionIndex,
          heading: section.heading,
          text,
          terms,
          titleTerms,
          enumerationTerms: enumerationTerms(text),
        });
      }
    }
  }
  return { chunks, fullChunks, frequencies };
}

function rankChunks(index, question, enumeration = false) {
  const queryTerms = routeTerms(String(question || '').slice(-1200)).terms;
  const technical =
    /文件|目录|模块|接口|方法|函数|代码|启动|命令|依赖|开发|架构|实现|协议|参数|事件|组件/iu.test(
      question,
    );
  const count = index.chunks.length;
  return index.chunks
    .map((chunk) => {
      let score = 0;
      let matched = 0;
      let bestTerm = '';
      let bestWeight = 0;
      for (const term of queryTerms) {
        if (!chunk.terms.has(term) && !chunk.titleTerms.has(term)) continue;
        matched++;
        const frequency = index.frequencies.get(term) || 0;
        const rarity = Math.log1p((count - frequency + 0.5) / (frequency + 0.5));
        const weight = (rarity + 0.15) * (term.length > 2 ? 1.2 : 1);
        score += weight;
        if (chunk.terms.has(term) && weight > bestWeight) {
          bestWeight = weight;
          bestTerm = term;
        }
        if (chunk.titleTerms.has(term)) score += weight * 0.7;
        if (enumeration && chunk.enumerationTerms?.has(term)) score += weight * 2;
      }
      if (queryTerms.size) score *= 1 + Math.min(0.35, matched / queryTerms.size);
      // 清单问题优先取完整表格/列表的证据，而非碰巧提到相同名词的开发说明。
      if (enumeration && /(?:^|\n)\s*\|.+\|/u.test(chunk.text)) score *= 1.8;
      if (enumeration && !technical && /```|~~~/u.test(chunk.text)) score *= 0.25;
      return { ...chunk, score, bestTerm };
    })
    .sort((a, b) => b.score - a.score || a.partIndex - b.partIndex || a.docIndex - b.docIndex);
}

function excerpt(chunk, room) {
  if (chunk.text.length <= room) return chunk.text;
  const budget = Math.max(1, room - 2);
  const matchAt = chunk.bestTerm ? chunk.text.toLowerCase().indexOf(chunk.bestTerm) : -1;
  const start =
    matchAt < 0
      ? 0
      : Math.min(Math.max(0, matchAt - Math.floor(budget / 3)), chunk.text.length - budget);
  const end = start + budget;
  return `${start > 0 ? '…' : ''}${chunk.text.slice(start, end)}${end < chunk.text.length ? '…' : ''}`;
}

const OVERVIEW =
  /自我介绍|介绍.{0,24}(?:自己|项目)|(?:项目|个人)(?:概况|概述|背景|介绍|经历)|简历|技术栈|整体架构|总结|tell me about|resume|experience/iu;
const ENUMERATION = /多少|哪些|清单|列出|全部|所有|分类|分别|list|how many/iu;
const COUNTED_METHODS =
  /哪[一二三四五六七八九十\d]+(?:个|种|项)?(?:主要|核心|关键)?(?:方法|接口)|(?:方法|接口).{0,12}(?:清单|列出)/iu;
const GRAPHICS_DOMAIN = /绘图|渲染|画布|图形|画笔|canvas|webgl|three\.js|gpu|2d|3d/iu;

function queryFacets(query) {
  return String(query || '')
    .split(/[?？!！;；。\n、]+|以及|同时|另外|并且/u)
    .flatMap((part) => {
      // 只拆独立的协调连词，不拆“调和”“和棋”等完整词。
      const separators = [...WORD_SEGMENTER.segment(part)]
        .filter(({ segment }) => /^(?:和|及|与)$/u.test(segment))
        .map(({ index }) => index);
      const facets = [];
      let start = 0;
      for (const position of separators) {
        if (part.slice(start, position).trim().length < 2) continue;
        if (part.slice(position + 1).trim().length < 2) continue;
        facets.push(part.slice(start, position));
        start = position + 1;
      }
      facets.push(part.slice(start));
      return facets;
    })
    .filter((part) => part.trim());
}

function retrievalQuery(question, transcript, aliases) {
  let query = String(question || transcriptLines(transcript).at(-1) || '').slice(-1200);
  for (const alias of aliases || []) {
    const pattern = String(alias)
      .trim()
      .split(/\s+/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s*');
    if (pattern) query = query.replace(new RegExp(pattern, 'giu'), ' ');
  }
  return query;
}

function overviewChunks(index) {
  const docs = new Set();
  return [...index.chunks]
    .sort((a, b) => {
      const overviewScore = (chunk) =>
        (/简介|概述|背景|经验|技能|经历|教育|架构|summary|experience/iu.test(chunk.heading)
          ? 2
          : 0) + (chunk.partIndex === 0 ? 1 : 0);
      return (
        overviewScore(b) - overviewScore(a) || a.partIndex - b.partIndex || a.docIndex - b.docIndex
      );
    })
    .filter((chunk) => {
      if (docs.has(chunk.docIndex)) return false;
      docs.add(chunk.docIndex);
      return true;
    });
}

function retrieveChunks(
  index,
  query,
  overview,
  { projectName = '', implicitProject = false } = {},
) {
  const enumeration = ENUMERATION.test(query);
  const facets = queryFacets(query);
  const ranked = rankChunks(index, query, enumeration);
  const selected = [];
  const seen = new Set();
  const add = (chunk) => {
    const id = `${chunk.docIndex}:${chunk.partIndex}`;
    if (seen.has(id)) return;
    selected.push(chunk);
    seen.add(id);
  };
  if (overview && /技术栈|整体架构/iu.test(query)) overviewChunks(index).forEach(add);
  if (
    projectName &&
    /会话|游戏绘画/u.test(query) &&
    COUNTED_METHODS.test(query) &&
    !GRAPHICS_DOMAIN.test(query)
  ) {
    // 数量型会话接口清单优先保留原文签名，不依赖“需要”“方法”等泛词的总分。
    // 这里只补候选证据，不将语音中的“绘画”静默改成“会话”。
    const candidate = ranked.find((chunk) => {
      const methods = new Set(
        [...chunk.text.matchAll(/`([a-zA-Z_$][\w.$]*)\s*\(/gu)].map((match) => match[1]),
      );
      return (
        methods.size >= 3 &&
        /(?:会话|接口|实例|适配).{0,50}(?:提供|实现|包含|支持|具备)|(?:提供|实现).{0,50}(?:方法|接口)/u.test(
          chunk.text,
        )
      );
    });
    if (candidate) {
      add({
        ...candidate,
        inferenceNote:
          /绘画/u.test(query) && /会话/u.test(candidate.text)
            ? '【候选证据】当前转写提到“绘画”；以下是 README 的会话接口候选，并不代表已确认原问。若确实问绘图，不能把会话方法当作绘图接口。'
            : '',
      });
    }
  }
  // 每个子问题先保留至多两块可靠证据，避免总表或概览挤掉具体清单。
  for (const facet of facets) {
    const facetEnumeration = ENUMERATION.test(facet);
    const matches = rankChunks(index, facet, facetEnumeration);
    const minimum = Math.max(0.4, (matches[0]?.score || 0) * 0.5);
    for (const chunk of matches.slice(0, facetEnumeration ? 2 : 1)) {
      if (chunk.score >= minimum) add(chunk);
    }
  }
  const threshold = Math.max(0.4, (ranked[0]?.score || 0) * 0.25);
  for (const chunk of ranked) {
    if (chunk.score >= threshold) add(chunk);
  }
  if (overview && !selected.length) overviewChunks(index).forEach(add);
  const smallRelated = implicitProject && !enumeration && !overview;
  return {
    chunks: selected,
    maxChunks: smallRelated ? 2 : enumeration || facets.length > 1 ? 6 : 4,
    targetChars: smallRelated ? 1800 : enumeration || facets.length > 1 ? 6000 : 4400,
  };
}

function contextHeader(chunk) {
  return `\n\n【来源：${chunk.name}，片段 ${chunk.partIndex + 1}】\n${chunk.heading ? `【章节：${chunk.heading}】\n` : ''}${chunk.inferenceNote ? `${chunk.inferenceNote}\n` : ''}`;
}

function preferCompleteProject(index, query, projectName, limit) {
  if (!projectName || index.fullChunks?.length !== 1) return false;
  // 完整 README 是保守的宽清单特例。协调连词拆分只用于取证，不能令普通
  // 句子或“资料未记载就不要推测”的限制条件意外升级为整篇上传。
  const facets = query.split(/[?？!！;；\n]+|以及|同时|另外|并且/u).filter((part) => part.trim());
  if (facets.length < 3 || facets.filter((facet) => ENUMERATION.test(facet)).length < 2)
    return false;
  const [document] = index.fullChunks;
  // Broad lists need evidence from several sections. For a small README,
  // keeping it intact avoids losing relationships between the lists. Never
  // exceed the configured hard cap or expand ordinary uploaded documents.
  const required = CONTEXT_NOTE.length + contextHeader(document).length + document.text.length;
  return document.text.length <= 12000 && required + `\n${TRUNCATED_NOTE}`.length <= limit;
}

function buildKnowledgeContext(
  index,
  {
    maxChars = 60000,
    question = '',
    transcript = '',
    queryAliases = [],
    mode = 'auto',
    projectName = '',
  } = {},
) {
  if (!index.chunks.length) return '';
  const limit = Number.isFinite(Number(maxChars))
    ? Math.max(0, Math.floor(Number(maxChars)))
    : 60000;
  if (limit === 0) return '';
  if (limit <= CONTEXT_NOTE.length) return CONTEXT_NOTE.slice(0, limit);

  const query = retrievalQuery(question, transcript, queryAliases);
  const current = String(question || transcriptLines(transcript).at(-1) || '');
  const explicitProject = [projectName, ...queryAliases].some((alias) =>
    hasAlias(compact(current), compact(alias)),
  );
  const full =
    mode === 'full' ||
    (!question && !transcript) ||
    (mode === 'auto' && preferCompleteProject(index, query, projectName, limit));
  const selection = full
    ? { chunks: index.fullChunks || index.chunks, maxChunks: Infinity, targetChars: limit }
    : retrieveChunks(
        index,
        query,
        OVERVIEW.test(String(question || query)) ||
          (!!projectName &&
            (ENUMERATION.test(query) ||
              /介绍|概述|概况|背景|讲讲|说说/u.test(question) ||
              !routeTerms(query).terms.size)),
        {
          projectName,
          implicitProject: !!projectName && !explicitProject && !FOLLOWUP.test(current),
        },
      );
  const ranked = selection.chunks;
  if (!ranked.length) {
    if (!projectName) return '';
    return `${CONTEXT_NOTE}\n【检索结果：项目 ${projectName}】README 未找到与当前问题直接相关的片段；不得将推测当作这个项目已经实现的事实。`.slice(
      0,
      limit,
    );
  }
  const budget = Math.min(limit, selection.targetChars);
  const reserve = `\n${TRUNCATED_NOTE}`.length;
  let result = CONTEXT_NOTE;
  let included = 0;
  let clipped = false;
  for (const chunk of ranked) {
    if (included >= selection.maxChunks) break;
    const header = contextHeader(chunk);
    const room = budget - reserve - result.length - header.length;
    if (room < 20) break;
    if (chunk.text.length <= room) {
      result += header + chunk.text;
      included++;
    } else if (included === 0 || full || budget === limit) {
      result += header + excerpt(chunk, room);
      included++;
      clipped = true;
      break;
    }
  }
  // 只在字符上限确实切断证据时标注截断；未选中的无关片段无需装满预算。
  if (clipped || (full && included < ranked.length)) result += `\n${TRUNCATED_NOTE}`;
  return result.slice(0, limit);
}

module.exports = { buildIndex, buildKnowledgeContext, buildProjectRouter, selectProject };
