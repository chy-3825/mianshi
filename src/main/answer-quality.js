'use strict';

// A narrow end-of-answer warning, not a correctness score or a reason to
// generate more text. Missing final punctuation alone is perfectly valid.
function checkAnswerCompleteness(text) {
  if (typeof text !== 'string' || !text.trim()) return { suspected: false, reason: null };

  const prose = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      ) {
        fence = null;
        prose.push(' CODE ');
      }
      continue;
    }
    if (!fence) prose.push(line);
  }
  if (fence) return { suspected: true, reason: 'unclosed_code_fence' };

  const plain = prose
    .join('\n')
    .normalize('NFKC')
    .replace(/(`+)[^`\n]*?\1/g, ' CODE ')
    .replace(/https?:\/\/\S+/g, ' URL ')
    // Half-open mathematical intervals are intentionally not bracket errors.
    .replace(
      /[[(]\s*[-+]?(?:\d+(?:\.\d+)?|[a-z]\w*|∞)\s*[,，]\s*[-+]?(?:\d+(?:\.\d+)?|[a-z]\w*|∞)\s*[\])]/giu,
      ' VALUE ',
    )
    // Quoted bracket characters are symbols, not parenthetical clauses.
    .replace(/['"“‘]\s*[()[\]{}]\s*['"”’]/g, ' SYMBOL ');
  const brackets = [];
  const opening = new Set(['(', '[', '{']);
  const closing = { ')': '(', ']': '[', '}': '{' };
  for (const character of plain) {
    if (opening.has(character)) brackets.push(character);
    else if (closing[character] && brackets.at(-1) === closing[character]) brackets.pop();
  }
  if (brackets.length) return { suspected: true, reason: 'unclosed_bracket' };

  const tail = plain
    .trim()
    .replace(/[*_~]+$/g, '')
    .trim();
  if (!tail) return { suspected: false, reason: null };
  if (/[:：]$/.test(tail)) return { suspected: true, reason: 'trailing_colon' };
  const sentenceTail = tail.replace(/[。.！!]+$/g, '').trim();
  if (
    /(?:例如|比如|包括|因为|由于|分别是|如下)$/.test(sentenceTail) ||
    /以[^。！？!?\n]{1,64}(?<![行作认成])为$/.test(sentenceTail)
  )
    return { suspected: true, reason: 'dangling_clause' };
  // Upper-case AND/OR may be the named logical operators in a valid list.
  if (
    /\b(?:and|or|because|including|such as|for example|consists of|as follows)$/i.test(
      sentenceTail,
    ) &&
    !/\b(?:AND|OR)$/.test(sentenceTail)
  )
    return { suspected: true, reason: 'dangling_connector' };
  return { suspected: false, reason: null };
}

module.exports = { checkAnswerCompleteness };
