'use strict';

const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const prompt = require('./prompt');

const execFileAsync = promisify(execFile);

async function probeGpu() {
  const { stdout } = await execFileAsync(
    'nvidia-smi',
    ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
    { timeout: 4000 },
  );
  const first = stdout.trim().split('\n')[0] || '';
  const match = /^(.*),\s*(\d+)\s*$/.exec(first);
  if (!match) throw new Error('无法解析显卡信息');
  return { name: match[1].trim(), memoryMiB: Number(match[2]) };
}

function toPcm16(pcm) {
  if (!Array.isArray(pcm) || pcm.length < 8000 || pcm.length > 160000) {
    throw new Error('录音长度应为 0.5–10 秒');
  }
  const samples = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const value = Number(pcm[i]);
    if (!Number.isFinite(value)) throw new Error('录音数据无效');
    samples[i] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
  }
  return new Uint8Array(samples.buffer);
}

function summarize(checks) {
  if (checks.some((item) => item.status === 'fail')) return 'fail';
  if (checks.some((item) => item.status === 'warning')) return 'warning';
  return 'pass';
}

async function runSelfCheck({
  settings,
  localStt,
  resolveProvider,
  generateWithFallback,
  pcm,
  sampleRate = 16000,
  audio,
  asrContext,
  gpuProbe = probeGpu,
}) {
  const checks = [];
  const add = (id, label, status, detail, metrics) => {
    checks.push({ id, label, status, detail, ...(metrics ? { metrics } : {}) });
  };
  const startedAt = new Date().toISOString();
  const ramGiB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  add(
    'system',
    '系统环境',
    process.platform === 'linux' ? 'pass' : 'warning',
    process.platform === 'linux'
      ? '当前为 Linux 首发平台'
      : '此版本优先验证 Linux，其他系统尚未完成交付测试',
    { platform: process.platform, arch: process.arch, ramGiB },
  );

  if (audio && typeof audio === 'object') {
    const micDeviceCount = Number(audio.micDeviceCount);
    const micFound = Number.isInteger(micDeviceCount) && micDeviceCount > 0;
    const permissionDenied = audio.micPermissionState === 'denied';
    add(
      'microphone',
      '麦克风通道',
      permissionDenied ? 'fail' : pcm !== undefined ? 'pass' : 'warning',
      permissionDenied
        ? '麦克风权限被拒绝'
        : !micFound
          ? '未发现麦克风输入设备；可能尚未授权，请尝试录音自检'
          : pcm !== undefined
            ? '已取得测试录音；请结合转写结果确认音质'
            : '已找到麦克风，尚未录音验证',
      Number.isInteger(micDeviceCount) ? { deviceCount: micDeviceCount } : undefined,
    );
    const interviewerSource = audio.interviewerSource;
    add(
      'interviewer-audio',
      '面试官音频通道',
      interviewerSource === 'none' ? 'fail' : 'warning',
      interviewerSource === 'loopback'
        ? process.platform === 'linux'
          ? 'Linux 下系统回环通常不可用；请优先选择 PulseAudio/PipeWire Monitor 或虚拟输入设备并实测'
          : '已选择系统声音；是否真正采到面试官声音仍需实时测试'
        : interviewerSource === 'input'
          ? '已选择输入设备；请播放音频确认设备路由正确'
          : '未选择面试官音频来源',
    );
  } else {
    add('microphone', '麦克风通道', 'skipped', '尚未检查音频设备');
    add('interviewer-audio', '面试官音频通道', 'skipped', '尚未检查音频设备');
  }

  const local = (settings.sttProvider || 'local') === 'local';
  try {
    const gpu = await gpuProbe();
    add('gpu', '显卡', 'pass', '已检测到 NVIDIA 显卡；实际语音性能以本机测试结果为准', {
      name: gpu.name,
      memoryMiB: gpu.memoryMiB,
    });
  } catch (_error) {
    add(
      'gpu',
      '显卡',
      local ? 'fail' : 'warning',
      local
        ? '未检测到可用的 NVIDIA CUDA 环境；当前本地语音实现需要 CUDA'
        : '未检测到 NVIDIA 显卡；云端转写不依赖本地显卡',
    );
  }

  if (local) {
    const start = performance.now();
    try {
      if (typeof localStt.warm === 'function') await localStt.warm(settings);
      else await localStt.ensure(settings);
      add('stt', '本地语音模型', 'pass', '模型已准备就绪（后台预热后可更快开始识别）', {
        loadMs: Math.round(performance.now() - start),
      });
      if (pcm !== undefined) {
        if (sampleRate !== 16000) throw new Error('目前只支持 16 kHz 自检录音');
        const pcm16 = toPcm16(pcm);
        const inferenceStart = performance.now();
        let sampleTiming;
        const text = await localStt.transcribe(settings, pcm16, sampleRate, 'zh', {
          context: asrContext,
          onTiming: (timing) => {
            sampleTiming = timing;
          },
        });
        const elapsedMs = Math.round(performance.now() - inferenceStart);
        const inferenceMs = Math.round(sampleTiming?.inferenceMs ?? elapsedMs);
        add(
          'stt-sample',
          '中文录音转写',
          text.trim() ? 'pass' : 'warning',
          text.trim()
            ? '已识别到语音；报告不保存或显示转写原文'
            : '未识别到文字，请检查麦克风或重新录音',
          {
            durationMs: Math.round((pcm.length / sampleRate) * 1000),
            inferenceMs,
            elapsedMs,
            ...(sampleTiming ? { queueMs: Math.round(sampleTiming.queueMs) } : {}),
            ...(typeof sampleTiming?.hintApplied === 'boolean'
              ? { hintApplied: sampleTiming.hintApplied, hintFallback: sampleTiming.hintFallback }
              : {}),
            chars: [...text].length,
          },
        );
      } else {
        add('stt-sample', '中文录音转写', 'skipped', '点击“录音自检”可测真实语音转写耗时');
      }
    } catch (error) {
      const missing = error.code === 'ENOENT' || /ENOENT|not found/i.test(error.message);
      add(
        'stt',
        '本地语音模型',
        'fail',
        missing
          ? '未找到本地语音运行环境，请先完成 Linux 语音依赖安装'
          : '本地语音模型启动或推理失败，请查看应用日志',
        { elapsedMs: Math.round(performance.now() - start) },
      );
    }
  } else {
    add(
      'stt',
      '云端语音服务',
      settings.deepgramApiKey ? 'warning' : 'fail',
      settings.deepgramApiKey
        ? '已配置 Deepgram Key；此项尚未执行真实音频连接测试'
        : '尚未配置 Deepgram Key',
    );
  }

  const provider = resolveProvider(settings);
  if (provider.needsKey && !provider.apiKey) {
    add('answer', '回答模型', 'fail', `尚未配置 ${provider.label} 的 API Key`);
  } else if (provider.id === 'custom' && (!provider.baseURL || !provider.models[0])) {
    add('answer', '回答模型', 'fail', '尚未填写自定义接口地址或模型 ID');
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const start = performance.now();
    let firstContentMs = null;
    try {
      const testPrompt = prompt.buildPrompt({
        question: '一加一等于几？请只回答数字。',
        transcript: '',
        context: '',
        answerLanguage: 'zh',
        maxChars: 80,
      });
      const result = await generateWithFallback({
        streamFn: provider.streamFn,
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        models: provider.models,
        ...(provider.type === 'gemini' ? { thinkingBudget: 0 } : {}),
        ...testPrompt,
        maxOutputTokens: 512,
        signal: controller.signal,
        onChunk: (delta) => {
          if (delta && firstContentMs === null)
            firstContentMs = Math.round(performance.now() - start);
        },
      });
      const completeMs = Math.round(performance.now() - start);
      const produced = !!result.text.trim();
      const slow = firstContentMs !== null && firstContentMs > 10000;
      add(
        'answer',
        '回答模型',
        !produced ? 'fail' : slow ? 'warning' : 'pass',
        !produced
          ? '服务已连接，但没有返回答案'
          : slow
            ? '回答可用，但首字超过 10 秒'
            : '已成功生成测试回答',
        { model: result.model, firstContentMs, completeMs },
      );
    } catch (_error) {
      add('answer', '回答模型', 'fail', '连接或生成失败；请检查模型、Key、网络与服务地址', {
        elapsedMs: Math.round(performance.now() - start),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return { startedAt, finishedAt: new Date().toISOString(), summary: summarize(checks), checks };
}

module.exports = { runSelfCheck, toPcm16, summarize, probeGpu };
