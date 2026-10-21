'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_README_BYTES = 2 * 1024 * 1024;
const README_NAMES = ['README.md', 'README.markdown', 'README.txt', 'README'];

function firstHeading(text) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) return match[1].trim();
  }
  return '';
}

function readUtf8FileNoFollow(filePath) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(filePath, flags);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) throw new Error('项目 README 必须是普通文件。');
    if (stats.size > MAX_README_BYTES) throw new Error('项目 README 超过 2 MiB 大小限制。');

    // Read at most one byte past the limit so a concurrently growing file cannot
    // make this operation consume unbounded memory.
    const buffer = Buffer.alloc(MAX_README_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_README_BYTES) throw new Error('项目 README 超过 2 MiB 大小限制。');

    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new Error('项目 README 不是有效的 UTF-8 文本。');
    }
    if (!text.trim() || text.includes('\0')) {
      throw new Error('项目 README 为空或不是有效的纯文本。');
    }
    return text;
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error('项目 README 不能是软链接。');
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Read one README from a project's root directory. This function is synchronous
 * so callers can invoke it directly from a folder-selection IPC handler.
 */
function readProjectFolder(rootPath) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    throw new Error('请选择有效的项目文件夹。');
  }
  const resolvedRoot = path.resolve(rootPath);
  let rootStats;
  try {
    rootStats = fs.lstatSync(resolvedRoot);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('项目文件夹不存在。');
    throw error;
  }
  if (rootStats.isSymbolicLink()) throw new Error('项目文件夹不能是软链接。');
  if (!rootStats.isDirectory()) throw new Error('请选择项目文件夹，而不是文件。');

  const entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  let readmeEntry;
  let linkedReadme = false;
  for (const preferred of README_NAMES) {
    const matches = entries
      .filter((entry) => entry.name.toLowerCase() === preferred.toLowerCase())
      .sort((a, b) => {
        if (a.name === preferred) return -1;
        if (b.name === preferred) return 1;
        return a.name.localeCompare(b.name);
      });
    for (const entry of matches) {
      if (entry.isSymbolicLink()) {
        linkedReadme = true;
        continue;
      }
      if (entry.isFile()) {
        readmeEntry = entry;
        break;
      }
    }
    if (readmeEntry) break;
  }
  if (!readmeEntry) {
    if (linkedReadme) throw new Error('项目 README 不能是软链接。');
    throw new Error('项目根目录未找到 README.md、README.markdown、README.txt 或 README。');
  }

  const readmePath = path.join(resolvedRoot, readmeEntry.name);
  const text = readUtf8FileNoFollow(readmePath);
  const name = path.basename(resolvedRoot);
  const suggestedKeywords = [name, firstHeading(text)]
    .filter(Boolean)
    .filter(
      (keyword, index, keywords) =>
        keywords.findIndex((value) => value.toLowerCase() === keyword.toLowerCase()) === index,
    );

  return { rootPath: resolvedRoot, readmePath, name, text, suggestedKeywords };
}

module.exports = { readProjectFolder, MAX_README_BYTES };
