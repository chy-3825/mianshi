#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { aggregateResults, distribution } = require('./benchmark-metrics');

const seconds = (value) => (Number.isFinite(value) ? (value / 1000).toFixed(3) : '—');
const percent = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—');
const tableText = (value) =>
  String(value ?? '')
    .replace(/\|/g, '｜')
    .replace(/\r?\n/g, ' ');
const csvText = (value) => {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};
const codeBlock = (value) => {
  const text = String(value || '（没有完整答案）');
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
};

function serviceStages(results) {
  const headers = [];
  const reasoningToContent = [];
  const reasoningTokens = [];
  let failedAttempts = 0;
  for (const result of results) {
    for (const answer of result.answers || []) {
      const timings = answer.modelTimings || [];
      failedAttempts += timings.filter(
        (event) => event.stage === 'complete' && event.outcome === 'error',
      ).length;
      let lastStart = -1;
      for (let index = 0; index < timings.length; index++)
        if (timings[index].stage === 'request-start') lastStart = index;
      if (lastStart < 0 || !answer.successful) continue;
      const attempt = timings.slice(lastStart);
      const header = attempt.find((event) => event.stage === 'response-headers');
      const reasoning = attempt.find((event) => event.stage === 'first-reasoning');
      const content = attempt.find((event) => event.stage === 'first-content');
      const complete = attempt.find(
        (event) => event.stage === 'complete' && event.outcome === 'success',
      );
      if (Number.isFinite(header?.elapsedMs)) headers.push(header.elapsedMs);
      if (
        Number.isFinite(reasoning?.elapsedMs) &&
        Number.isFinite(content?.elapsedMs) &&
        content.elapsedMs >= reasoning.elapsedMs
      )
        reasoningToContent.push(content.elapsedMs - reasoning.elapsedMs);
      if (Number.isFinite(complete?.reasoningTokens))
        reasoningTokens.push(complete.reasoningTokens);
    }
  }
  return {
    successfulAttemptToHeadersMs: distribution(headers),
    firstReasoningToContentMs: distribution(reasoningToContent),
    reasoningTokens: distribution(reasoningTokens),
    failedAttempts,
    note: '响应头前含连接、代理、排队与服务处理；推理片段到正文是客户端接收间隔，不等于纯模型计算时间。重试题仅用最后成功尝试计算阶段分布。',
  };
}

function render(report) {
  const results = report.results || [];
  const expected =
    report.requestedCount || report.expectedCount || report.caseCount || report.totalCases || 100;
  const summary = aggregateResults(results, expected);
  const stages = serviceStages(results);
  summary.serviceStages = stages;
  const metrics = summary.latencyMs;
  const lines = [
    `# ${expected} 题中文合成语音：性能测试数据`,
    '',
    `已完成 ${results.length}/${expected} 题，结构检查通过 ${summary.structurePassed} 题，成功送达答案 ${summary.deliveredAnswers} 条，未触发截断或完整性提醒的答案 ${summary.successfulAnswers} 条。`,
    '',
    '本报告为自动汇总；结构检查不代表事实正确。语音为公开音色合成，实时 100 ms 分包；设备、IPC、DOM 使用测试适配器。每题独立会话，共用已预热 ASR worker，未覆盖真人口音、噪声、回声、真实声卡与连续追问。',
    '',
    '## 延迟（秒）',
    '',
    '分位数使用最近秩法，仅含唯一、未提前触发、成功、未截断且未触发完整性提醒的回答；失败和超时另列。语音结束为 VAD 估计，分包分辨率约 100 ms。',
    '',
    '| 阶段 | 有效样本 | 平均 | P50 | P90 | P95 | 最大 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const [name, field] of [
    ['VAD 估计末音 → 首字', 'speechEndToFirstVisible'],
    ['回答请求 → 首字', 'requestToFirstVisible'],
    ['VAD 估计末音 → 全文', 'speechEndToDone'],
    ['切段 → ASR 返回', 'vadToAsr'],
    ['ASR 返回 → 自动触发', 'asrToTrigger'],
    ['首字 → 全文', 'firstVisibleToDone'],
  ]) {
    const value = metrics[field];
    lines.push(
      `| ${name} | ${value.n} | ${seconds(value.mean)} | ${seconds(value.p50)} | ${seconds(value.p90)} | ${seconds(value.p95)} | ${seconds(value.max)} |`,
    );
  }
  lines.push(
    '',
    '## 识别与触发',
    '',
    `- 去标点/空白字符错误率：${percent(summary.characterError.surface.rate)}；有限数字单位归一化后：${percent(summary.characterError.canonical.rate)}。两者均按总编辑距离除以总参考字符加权。`,
    `- 关键概念全部匹配：${summary.conceptComplete}/${results.length}；匹配词包含明确声明的同义表达，不能替代逐题语义复核。`,
    `- 无转写 ${summary.noTranscript} 题；无触发 ${summary.noTrigger} 题；重复触发 ${summary.duplicateTrigger} 题；提前触发 ${summary.earlyTrigger} 题。`,
    `- 路由符合本题预设 ${summary.routePassed}/${results.length}；通用题即便与项目语义相近，也按预设不携带项目资料诊断，需人工判断这是否违背实际需求。`,
    `- 答案关键词代理通过 ${summary.answerProxyPassed}/${results.length}，不称作回答正确率。`,
    '',
    '## 回答服务与本机阶段',
    '',
    `- 服务失败 ${summary.serviceFailedCases} 题，首字超时 ${summary.firstContentTimeouts} 次，总时限超时 ${summary.overallTimeouts} 次，截断 ${summary.truncatedAnswers} 条。`,
    `- 疑似未说完提醒 ${summary.suspectedIncompleteAnswers} 条；这是窄规则诊断，不代表未告警的答案一定完整或正确。旧测试未记录此标志时不能补证答案完整。`,
    `- 逻辑回答请求 ${summary.totalLogicalRequests} 次，实际模型尝试 ${summary.modelAttempts} 次（包括重试）。`,
    `- ASR 推理 P50 / P95：${seconds(summary.inferenceMs.p50)} / ${seconds(summary.inferenceMs.p95)} 秒；排队 P95：${seconds(summary.queueMs.p95)} 秒；检索 P95：${seconds(summary.retrievalMs.p95)} 秒。`,
    `- 最后成功尝试到响应头 P50 / P95：${seconds(stages.successfulAttemptToHeadersMs.p50)} / ${seconds(stages.successfulAttemptToHeadersMs.p95)} 秒；首个推理片段到正文 P50 / P95：${seconds(stages.firstReasoningToContentMs.p50)} / ${seconds(stages.firstReasoningToContentMs.p95)} 秒。`,
    `- 失败尝试 ${stages.failedAttempts} 次；服务上报的推理 token P50 / P95：${stages.reasoningTokens.p50 ?? '—'} / ${stages.reasoningTokens.p95 ?? '—'}。${stages.note}`,
    '',
    '## 最慢的十题（只列成功完整答案）',
    '',
    '| 题号 | 问题 | 请求到首字（秒） | 估计末音到首字（秒） |',
    '| --- | --- | ---: | ---: |',
  );
  const slowest = results
    .filter(
      (result) =>
        result.answers?.length === 1 &&
        result.answers[0].successful &&
        !result.answers[0].truncated &&
        !result.answers[0].answerIncomplete,
    )
    .sort(
      (a, b) =>
        (b.answers[0].latencyMs.speechEndToFirstVisible || 0) -
        (a.answers[0].latencyMs.speechEndToFirstVisible || 0),
    )
    .slice(0, 10);
  for (const result of slowest)
    lines.push(
      `| ${result.id} | ${tableText(result.question)} | ${seconds(result.answers[0].latencyMs.requestToFirstVisible)} | ${seconds(result.answers[0].latencyMs.speechEndToFirstVisible)} |`,
    );
  lines.push(
    '',
    '## 逐题索引',
    '',
    '[完整转写和所有答案](answers.md) · [CSV 数据](results.csv)',
    '',
    '| 题号 | 类别 | 结构 | 关键概念 | 路由 | 答案关键词 | 首字（秒） |',
    '| --- | --- | --- | --- | --- | --- | ---: |',
  );
  const answers = [
    '# 全部问题、转写与模型原文',
    '',
    '模型答案未经人工修改。关键词检查只是代理，可能漏掉同义表达或放过事实错误。',
    '',
  ];
  const csv = [
    [
      'id',
      'category',
      'question',
      'transcript',
      'structurePassed',
      'conceptsMatched',
      'routePassed',
      'answerProxyPassed',
      'requestToFirstVisibleMs',
      'speechEndToFirstVisibleMs',
      'answer',
      'serviceErrorReasons',
    ]
      .map(csvText)
      .join(','),
  ];
  for (const result of results) {
    const first = result.answers?.[0];
    const concepts = result.concepts || result.conceptCheck;
    const proxy = result.answerProxy || result.answerProxyCheck;
    const route = result.answers?.length === 1 && first?.routingPassed;
    lines.push(
      `| ${result.id} | ${tableText(result.category)} | ${result.structurePassed ? '通过' : '失败'} | ${concepts?.allMatched ? '齐全' : '缺失'} | ${route ? '符合' : '不符'} | ${proxy?.passed ? '命中' : '未齐'} | ${seconds(first?.latencyMs?.speechEndToFirstVisible)} |`,
    );
    answers.push(
      `## ${result.id}：${result.question}`,
      '',
      `类别：${result.category}；结构：${result.structurePassed ? '通过' : '失败'}。`,
      '',
      '参考朗读文本：',
      '',
      codeBlock(result.sourceText || result.speechText || result.question),
      '',
      '实际完整转写：',
      '',
      codeBlock((result.transcripts || []).join(' ')),
      '',
      `缺失概念组：${JSON.stringify(concepts?.missing || [])}`,
      '',
      `服务错误：${JSON.stringify((result.events || []).filter((event) => event.event === 'answer_error').map(({ reason, errorName, errorCode }) => ({ reason, errorName, errorCode })))}`,
      '',
    );
    for (const answer of result.answers || [])
      answers.push(
        `回答请求 ${answer.reqId}；成功送达：${answer.successful}；疑似未说完：${answer.answerIncomplete === undefined ? '未记录' : answer.answerIncomplete}；首字：${seconds(answer.latencyMs?.speechEndToFirstVisible)} 秒；项目资料：${answer.contextChars} 字符。`,
        '',
        codeBlock(answer.answer),
        '',
      );
    if (!result.answers?.length) answers.push('（没有触发回答）', '');
    csv.push(
      [
        result.id,
        result.category,
        result.question,
        (result.transcripts || []).join(' '),
        result.structurePassed,
        concepts?.allMatched,
        route,
        proxy?.passed,
        first?.latencyMs?.requestToFirstVisible,
        first?.latencyMs?.speechEndToFirstVisible,
        (result.answers || []).map((answer) => answer.answer).join('\n\n'),
        (result.events || [])
          .filter((event) => event.event === 'answer_error')
          .map((event) => event.reason)
          .join(','),
      ]
        .map(csvText)
        .join(','),
    );
  }
  return {
    summary,
    markdown: lines.join('\n') + '\n',
    answers: answers.join('\n') + '\n',
    csv: '\uFEFF' + csv.join('\n') + '\n',
  };
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw new Error('用法：node scripts/report-benchmark.js <结果.json> <新报告目录>');
  const report = JSON.parse(fs.readFileSync(input, 'utf8'));
  const rendered = render(report);
  const directory = path.resolve(output);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [filename, content] of [
    ['summary.md', rendered.markdown],
    ['answers.md', rendered.answers],
    ['results.csv', rendered.csv],
    ['summary.json', JSON.stringify(rendered.summary, null, 2)],
  ])
    fs.writeFileSync(path.join(directory, filename), content, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      event: 'benchmark_report',
      completed: report.results?.length || 0,
      output: directory,
    }),
  );
}

module.exports = { render, serviceStages };
if (require.main === module) main();
