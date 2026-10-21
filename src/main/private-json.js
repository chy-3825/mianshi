'use strict';

// settings.json 和 knowledge.json 都含有用户隐私。只在应用自己的 userData
// 目录内读写，并用同目录临时文件 + rename 避免崩溃时留下半份 JSON。
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

function storageError(action, error) {
  const code = error && /^[A-Z0-9_]+$/.test(error.code || '') ? `（${error.code}）` : '';
  return new Error(`${action}失败${code}，请检查应用数据目录及文件权限。`);
}

function ensurePrivateDirectory(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('应用数据目录不是普通目录');
  }
  // 迁移旧安装留下的过宽目录权限；chmod 不受进程 umask 影响。
  fs.chmodSync(dir, 0o700);
  return dir;
}

function openExistingPrivateFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('应用数据文件不是普通文件');
  }

  // Linux/macOS 下 O_NOFOLLOW 防止检查文件与打开文件之间被替换为链接。
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, flags);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('应用数据文件不是普通文件');
    fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readPrivateFile(filePath) {
  ensurePrivateDirectory(filePath);
  const fd = openExistingPrivateFile(filePath);
  if (fd === null) return null;
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function writePrivateJson(filePath, value) {
  const dir = ensurePrivateDirectory(filePath);
  const existingFd = openExistingPrivateFile(filePath);
  if (existingFd !== null) fs.closeSync(existingFd);

  const temporaryPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let fd = null;
  let renamed = false;
  try {
    fd = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryPath, filePath);
    renamed = true;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_error) {
        // 保留最初的写入错误。
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (_error) {
        // 临时文件可能根本没有创建；保留最初的写入错误。
      }
    }
  }
}

module.exports = { readPrivateFile, writePrivateJson, storageError };
