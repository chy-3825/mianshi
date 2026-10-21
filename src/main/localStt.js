'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { performance } = require('perf_hooks');
const { buildAsrContext, limitContext } = require('./stt-context');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function packagedRuntime() {
  // `require('electron')` returns a string in plain Node tests.
  const electron = require('electron');
  return Boolean(electron && electron.app && electron.app.isPackaged);
}

function userSttDir(env = process.env) {
  const dataHome =
    env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'interview-copilot', 'stt-venv');
}

function resolvePython(settings = {}, runtime = {}) {
  if (settings.localSttPython && settings.localSttPython.trim()) {
    return settings.localSttPython.trim();
  }
  const isPackaged = runtime.isPackaged ?? packagedRuntime();
  const venvDir = isPackaged
    ? userSttDir(runtime.env)
    : path.join(runtime.projectRoot || PROJECT_ROOT, '.venv-stt');
  return path.join(venvDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

function resolveWorkerScript(runtime = {}) {
  const isPackaged = runtime.isPackaged ?? packagedRuntime();
  const baseDir = isPackaged
    ? runtime.resourcesPath || process.resourcesPath
    : runtime.projectRoot || PROJECT_ROOT;
  return path.join(baseDir, 'local_stt', 'server.py');
}

class LocalStt {
  constructor(options = {}) {
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.signature = '';
    this.readyPromise = null;
    this.warmPromise = null;
    this.queue = [];
    this.activeTask = null;
    this.drainingChild = null;
    this.options = options;
  }

  request(command, payload = {}) {
    const child = this.child;
    if (!child) return Promise.reject(new Error('本地语音服务未启动'));
    const id = `stt_${++this.seq}`;
    const defaultTimeoutMs =
      command === 'init' ? 10 * 60 * 1000 : command === 'warm' ? 120 * 1000 : 45 * 1000;
    const configuredTimeoutMs =
      command === 'init'
        ? this.options.initTimeoutMs
        : command === 'warm'
          ? this.options.warmTimeoutMs
          : this.options.transcribeTimeoutMs;
    const timeoutMs = configuredTimeoutMs > 0 ? configuredTimeoutMs : defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pending.get(id) !== pending || this.child !== child) return;
          this.failChild(child, new Error(`本地语音服务 ${command} 请求超时（${timeoutMs} 毫秒）`));
          child.kill();
        }, timeoutMs),
      };
      this.pending.set(id, pending);
      try {
        child.stdin.write(JSON.stringify({ id, command, ...payload }) + '\n', (error) => {
          if (error && this.pending.get(id) === pending) {
            this.failChild(child, new Error(`向本地语音服务发送请求失败：${error.message}`));
            child.kill();
          }
        });
      } catch (error) {
        this.failChild(child, new Error(`向本地语音服务发送请求失败：${error.message}`));
        child.kill();
      }
    });
  }

  async ensure(settings = {}) {
    const engine = settings.localSttEngine || 'qwen3-asr';
    const defaultModels = {
      'qwen3-asr': 'Qwen/Qwen3-ASR-0.6B-hf',
      sensevoice: 'iic/SenseVoiceSmall',
      'faster-whisper': 'large-v3-turbo',
      whisper: 'large-v3-turbo',
    };
    const model = settings.localSttModel || defaultModels[engine] || defaultModels['qwen3-asr'];
    const python = resolvePython(settings, this.options.runtime);
    const script = this.options.scriptPath || resolveWorkerScript(this.options.runtime);
    const signature = `${python}|${script}|${engine}|${model}`;
    if (this.child && this.signature === signature) return this.readyPromise;

    this.stop();
    const child = (this.options.spawn || spawn)(python, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.signature = signature;
    let stderr = '';

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (_e) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending || this.child !== child) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.error || '本地转写失败'));
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.stdin.on('error', (error) => {
      this.failChild(child, new Error(`本地语音服务输入流失败：${error.message}`));
      child.kill();
    });
    child.stdout.on('error', (error) => {
      this.failChild(child, new Error(`本地语音服务输出流失败：${error.message}`));
      child.kill();
    });
    child.stderr.on('error', (error) => {
      this.failChild(child, new Error(`本地语音服务错误流失败：${error.message}`));
      child.kill();
    });
    child.once('error', (error) => {
      this.failChild(child, new Error(`无法启动本地语音服务：${error.message}`));
    });
    child.once('exit', (code, signal) => {
      const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
      this.failChild(
        child,
        new Error(`本地语音服务已退出（${reason}）${stderr ? `：${stderr}` : ''}`),
      );
    });

    const readyPromise = this.request('init', { engine, model, device: 'cuda' })
      .then(() => undefined)
      .catch((error) => {
        if (this.child === child) this.stop();
        throw error;
      });
    this.readyPromise = readyPromise;
    return readyPromise;
  }

  warm(settings = {}) {
    const ready = this.ensure(settings);
    const child = this.child;
    if (this.warmPromise) {
      // ensure() is async, so consume its derived rejection as well as the shared warm promise.
      ready.catch(() => {});
      return this.warmPromise;
    }
    const warmPromise = ready
      .then(async () => {
        if (!child || this.child !== child) throw new Error('本地语音服务已停止');
        const result = await this.request('warm');
        return { warmMs: Math.max(0, Number(result.warmMs) || 0) };
      })
      .catch((error) => {
        if (child && this.child === child) {
          this.failChild(child, error);
          child.kill();
        }
        throw error;
      });
    this.warmPromise = warmPromise;
    return warmPromise;
  }

  transcribe(settings, pcm, sampleRate, language, options = {}) {
    const enqueuedAt = performance.now();
    const ready = this.warm(settings);
    const child = this.child;
    const configuredLimit = this.options.maxQueueSize;
    const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 8;
    if (this.queue.length >= limit) {
      ready.catch(() => {});
      return Promise.reject(new Error(`本地语音识别队列已满（最多等待 ${limit} 段），请稍后重试`));
    }
    const role = ['interviewer', 'interviewee'].includes(options.role) ? options.role : 'unknown';
    const eligible =
      settings.localSttContextEnabled !== false &&
      ['qwen3-asr', 'qwen'].includes(settings.localSttEngine || 'qwen3-asr') &&
      ['zh', 'zh-CN'].includes(language);
    const context = eligible
      ? options.context === undefined
        ? buildAsrContext(settings).prompt
        : limitContext(options.context)
      : '';
    const promise = new Promise((resolve, reject) => {
      this.queue.push({
        resolve,
        reject,
        payload: { pcm: Buffer.from(pcm).toString('base64'), sampleRate, language, context },
        role,
        onTiming: options.onTiming,
        enqueuedAt,
      });
    });
    this.drainQueue(child, ready);
    return promise;
  }

  async drainQueue(child, ready) {
    if (this.drainingChild === child && child) return;
    this.drainingChild = child;
    try {
      await ready;
      while (this.child === child && this.queue.length) {
        const preferredIndex = this.queue.findIndex((task) => task.role === 'interviewer');
        const [task] = this.queue.splice(preferredIndex < 0 ? 0 : preferredIndex, 1);
        this.activeTask = task;
        const startedAt = performance.now();
        try {
          const result = await this.request('transcribe', task.payload);
          const finishedAt = performance.now();
          if (typeof task.onTiming === 'function') {
            try {
              const hintMetadata = {};
              for (const field of ['hintApplied', 'hintFallback'])
                if (typeof result[field] === 'boolean') hintMetadata[field] = result[field];
              for (const field of ['hintChars', 'hintTermCount'])
                if (Number.isInteger(result[field]) && result[field] >= 0 && result[field] <= 128)
                  hintMetadata[field] = result[field];
              if (['echo', 'empty', 'context_error'].includes(result.hintFallbackReason))
                hintMetadata.hintFallbackReason = result.hintFallbackReason;
              task.onTiming({
                role: task.role,
                queueMs: Math.max(0, startedAt - task.enqueuedAt),
                inferenceMs:
                  Number.isFinite(result.inferenceMs) && result.inferenceMs >= 0
                    ? result.inferenceMs
                    : Math.max(0, finishedAt - startedAt),
                elapsedMs: Math.max(0, finishedAt - task.enqueuedAt),
                ...hintMetadata,
              });
            } catch (_error) {
              // Diagnostics must not turn a successful transcription into an error.
            }
          }
          task.resolve(result.text || '');
        } catch (error) {
          task.reject(error);
        } finally {
          if (this.activeTask === task) this.activeTask = null;
        }
      }
    } catch (error) {
      // Initialization can fail before spawn has produced a child process.
      if (this.child === child) this.rejectQueue(error);
    } finally {
      if (this.drainingChild === child) this.drainingChild = null;
    }
  }

  rejectQueue(error) {
    if (this.activeTask) this.activeTask.reject(error);
    this.activeTask = null;
    for (const task of this.queue) task.reject(error);
    this.queue = [];
  }

  failChild(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.signature = '';
    this.readyPromise = null;
    this.warmPromise = null;
    this.drainingChild = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.rejectQueue(error);
  }

  stop() {
    const child = this.child;
    if (!child) {
      this.warmPromise = null;
      this.rejectQueue(new Error('本地语音服务已停止'));
      return;
    }
    this.failChild(child, new Error('本地语音服务已停止'));
    child.kill();
  }
}

module.exports = new LocalStt();
module.exports.LocalStt = LocalStt;
module.exports.resolvePython = resolvePython;
module.exports.resolveWorkerScript = resolveWorkerScript;
module.exports.userSttDir = userSttDir;
