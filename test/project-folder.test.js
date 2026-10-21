'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readProjectFolder, MAX_README_BYTES } = require('../src/main/projectFolder');

function tempProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-folder-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('readProjectFolder reads the root README and suggests the folder name and title', (t) => {
  const root = tempProject(t);
  fs.writeFileSync(path.join(root, 'README.md'), '# Demo App\n\nA game collection.\n');
  fs.writeFileSync(path.join(root, 'README.txt'), 'Lower priority');
  const result = readProjectFolder(root);
  assert.equal(result.rootPath, root);
  assert.equal(result.readmePath, path.join(root, 'README.md'));
  assert.equal(result.name, path.basename(root));
  assert.equal(result.text, '# Demo App\n\nA game collection.\n');
  assert.deepEqual(result.suggestedKeywords, [path.basename(root), 'Demo App']);
});

test('readProjectFolder accepts case-insensitive README names without searching subfolders', (t) => {
  const root = tempProject(t);
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'README.md'), 'Nested only');
  assert.throws(() => readProjectFolder(root), /项目根目录未找到 README/);
  fs.writeFileSync(path.join(root, 'ReadMe.MARKDOWN'), '# 项目标题\n内容');
  assert.equal(readProjectFolder(root).text, '# 项目标题\n内容');
});

test('readProjectFolder rejects a missing or empty README', (t) => {
  const root = tempProject(t);
  assert.throws(() => readProjectFolder(root), /项目根目录未找到 README/);
  fs.writeFileSync(path.join(root, 'README.md'), '  \n\t');
  assert.throws(() => readProjectFolder(root), /为空/);
});

test('readProjectFolder does not follow README or project-folder symlinks', (t) => {
  const root = tempProject(t);
  const target = path.join(root, 'outside.txt');
  fs.writeFileSync(target, 'Secret');
  fs.symlinkSync(target, path.join(root, 'README.md'));
  assert.throws(() => readProjectFolder(root), /软链接/);

  const linkedRoot = `${root}-link`;
  fs.symlinkSync(root, linkedRoot, 'dir');
  t.after(() => fs.rmSync(linkedRoot, { force: true }));
  assert.throws(() => readProjectFolder(linkedRoot), /软链接/);
});

test('readProjectFolder rejects a README larger than 2 MiB', (t) => {
  const root = tempProject(t);
  fs.writeFileSync(path.join(root, 'README.md'), Buffer.alloc(MAX_README_BYTES + 1, 'x'));
  assert.throws(() => readProjectFolder(root), /超过 2 MiB/);
});

test('readProjectFolder rejects invalid UTF-8', (t) => {
  const root = tempProject(t);
  fs.writeFileSync(path.join(root, 'README.md'), Buffer.from([0xc3, 0x28]));
  assert.throws(() => readProjectFolder(root), /UTF-8/);
});
