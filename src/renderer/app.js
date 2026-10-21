'use strict';

const $ = (id) => document.getElementById(id);
const { isQuestion, isNearDuplicateQuestion, AutoQuestionBuffer } = window.QuestionDetection;

const state = {
  listening: false,
  settings: null,
  // 采集资源
  contexts: [],
  nodes: [],
  streams: [],
  dgMic: null,
  dgSys: null,
  // 转写
  interim: { interviewer: null, interviewee: null },
  lastFinalSpeaker: null,
  history: [], // 已敲定的对话（去重）：{ role, text }
  sessionStart: null,
  autoQuestion: '', // 上次自动识别并回填到问题框的问题（用户未改动时视作"留空"）
  autoTimer: null, // 自动作答的去抖定时器
  autoDeadlineAt: null, // 噪声只暂停计时；丢弃后恢复原截止时间
  autoBuffer: new AutoQuestionBuffer(),
  queuedAuto: null, // 生成期间到来的最新问题
  interviewerSpeaking: false,
  lastAutoQuestion: null,
  // 生成
  reqId: 0,
  generating: false,
  selfChecking: false,
  sysSelectionTouched: false,
  starting: false,
  stopPromise: null,
  editingProject: null,
};

// ---------------- 工具 ----------------
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

function logSession(event, fields = {}) {
  // Diagnostics must never block audio capture or answer generation.
  Promise.resolve(window.api.logSessionEvent?.({ event, ...fields })).catch(() => {});
}

function setStatus(text, kind) {
  $('statusText').textContent = text;
  const dot = $('statusDot');
  dot.classList.remove('live', 'error');
  if (kind) dot.classList.add(kind);
}

function charCount(s) {
  return [...(s || '')].length;
}

// ---------------- 转写显示 ----------------
const MIC_SVG =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';

function showEmptyState() {
  $('transcript').innerHTML =
    `<div class="transcript-empty"><div class="empty-mic">${MIC_SVG}</div>` +
    '<p>开始监听后，面试官和你的对话会显示在这里。</p></div>';
}

function clearEmptyState() {
  const e = $('transcript').querySelector('.transcript-empty');
  if (e) e.remove();
}

function setLive(on) {
  $('liveIndicator').classList.toggle('hidden', !on);
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function addDaySeparator() {
  const t = $('transcript');
  const sep = document.createElement('div');
  sep.className = 'day-sep';
  const clock = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  sep.textContent = `今天 · ${clock}`;
  t.appendChild(sep);
}

function avatarEl(role) {
  const a = document.createElement('div');
  a.className = role === 'interviewee' ? 'avatar you-av' : 'avatar';
  a.textContent = role === 'interviewee' ? '我' : '面';
  return a;
}

function metaEl(role, rightText) {
  const m = document.createElement('div');
  m.className = 'msg-meta';
  const who = `<span class="who">${role === 'interviewee' ? '我' : '面试官'}</span>`;
  const ts = `<span class="ts">${rightText}</span>`;
  m.innerHTML = role === 'interviewee' ? `${ts} ${who}` : `${who} ${ts}`;
  return m;
}

function appendFinalLine(role, text) {
  clearEmptyState();
  const t = $('transcript');
  const elapsed = formatElapsed(state.sessionStart ? Date.now() - state.sessionStart : 0);

  const msg = document.createElement('div');
  msg.className = `msg ${role === 'interviewee' ? 'you' : 'interviewer'}`;

  const main = document.createElement('div');
  main.className = 'msg-main';
  main.appendChild(metaEl(role, elapsed));

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  main.appendChild(bubble);

  if (role === 'interviewer' && isQuestion(text)) {
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.innerHTML =
      '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg> 检测到问题';
    main.appendChild(badge);
  }

  msg.appendChild(avatarEl(role));
  msg.appendChild(main);
  t.appendChild(msg);
  t.scrollTop = t.scrollHeight;
}

function updateInterim(role, text) {
  clearEmptyState();
  const t = $('transcript');
  let el = state.interim[role];
  if (!el) {
    el = document.createElement('div');
    el.className = `msg ${role === 'interviewee' ? 'you' : 'interviewer'} interim`;
    const main = document.createElement('div');
    main.className = 'msg-main';
    main.appendChild(metaEl(role, '实时'));
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    main.appendChild(bubble);
    el.appendChild(avatarEl(role));
    el.appendChild(main);
    t.appendChild(el);
    state.interim[role] = el;
  }
  el.querySelector('.bubble').textContent = text;
  t.scrollTop = t.scrollHeight;
}

function clearInterim(role) {
  const el = state.interim[role];
  if (el) {
    el.remove();
    state.interim[role] = null;
  }
}

function normalizeText(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim();
}

// 把已敲定的句子写入历史，并对双声道串音/ASR 重复做去重
function pushHistory(role, text) {
  const norm = normalizeText(text);
  if (!norm) return false;
  const recent = state.history.slice(-3);
  for (const h of recent) {
    const hn = normalizeText(h.text);
    if (hn === norm || hn.includes(norm) || norm.includes(hn)) {
      if (h.role !== role) {
        // 双声道串音时优先信任系统音源对面试官的归属；麦克风的
        // 近似重复不得把一条已确认的面试官问题改成 Candidate。
        if (role === 'interviewer') {
          h.role = role;
          h.text = text;
        }
        // A short subset or near-exact copy is likely speaker-channel echo.
        // If the candidate repeats the question and then starts answering,
        // the additional content must still cancel the pending auto answer.
        return (
          role === 'interviewee' &&
          h.role === 'interviewer' &&
          norm.length >= 6 &&
          (hn.includes(norm) || (norm.includes(hn) && hn.length / norm.length >= 0.85))
        );
      }
      // 近似重复：保留信息更全的那条
      if (norm.length > hn.length) {
        h.text = text;
      }
      return false;
    }
  }
  state.history.push({ role, text });
  if (state.history.length > 60) state.history.shift();
  return false;
}

// 取最近几轮对话（去重后）交给大模型提取问题
function buildRecentDialogue(maxItems = 12) {
  return state.history
    .slice(-maxItems)
    .map((h) => `${h.role === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${h.text}`)
    .join('\n');
}

// 把 "Control+A" 渲染成 ⌃Control / A 之类的按键 chip
function renderHotkeyHint(hotkey) {
  const sym = {
    control: '⌃ Control',
    command: '⌘',
    cmd: '⌘',
    commandorcontrol: '⌘/⌃',
    shift: '⇧ Shift',
    alt: '⌥ Option',
    option: '⌥ Option',
  };
  const chips = (hotkey || 'Control+A')
    .split('+')
    .map((t) => `<kbd>${sym[t.toLowerCase()] || t}</kbd>`)
    .join(' ');
  $('hotkeyHint').innerHTML = chips;
}

function cancelAutoTimer({ preserveDeadline = false } = {}) {
  clearTimeout(state.autoTimer);
  state.autoTimer = null;
  if (!preserveDeadline) state.autoDeadlineAt = null;
}

function noteInterviewerSpeechStart() {
  state.interviewerSpeaking = true;
  cancelAutoTimer({ preserveDeadline: true });
}

function noteInterviewerUtteranceEnd() {
  state.interviewerSpeaking = false;
  // A discarded breath/click must not restart the full merge window. When a
  // forced-duration chunk finally ends there may be no deadline yet.
  if (state.autoDeadlineAt === null) scheduleAuto('interviewer');
  else resumeAutoTimer();
}

function handleTranscript(
  role,
  { text, isFinal, utteranceEnd = true, speechActive = false, timing = null },
) {
  if (!isFinal) {
    if (role === 'interviewer') noteInterviewerSpeechStart();
    updateInterim(role, text);
    return;
  }
  clearInterim(role);
  logSession('transcript_final', {
    role,
    text,
    sttId: timing?.sttId,
    segmentId: timing?.segmentId,
    utteranceEnd,
    speechActive,
  });
  appendFinalLine(role, text);
  const microphoneEcho = pushHistory(role, text);
  state.lastFinalSpeaker = role;
  if (role === 'interviewer') {
    if (state.settings.autoAnswer && state.listening) state.autoBuffer.append(text, timing);
    // A local STT max-duration split is only a chunk boundary; the speaker
    // has not finished asking the question yet.
    if (!utteranceEnd) {
      cancelAutoTimer();
      return;
    }
    state.interviewerSpeaking = speechActive;
  } else {
    if (microphoneEcho) return;
    state.autoBuffer.clear();
    state.interviewerSpeaking = false;
    state.lastAutoQuestion = null;
  }
  scheduleAuto(role);
}

// ---------------- 自动作答（监测到问题就触发） ----------------
const AUTO_DELAY_MS = 1000; // STT 已等待 0.65 秒静音；额外覆盖复合问句中的短停顿
const AUTO_DEDUP_MS = 8000;

function scheduleAuto(role) {
  cancelAutoTimer();
  if (!state.settings.autoAnswer || !state.listening) {
    logSession('auto_decision', { reason: 'disabled_or_not_listening' });
    return;
  }
  if (role === 'interviewee') {
    logSession('auto_decision', { reason: 'candidate_spoke' });
    return; // 你开口了 → 取消待触发的自动作答
  }
  if (!state.autoBuffer.parts.length) return;
  state.autoDeadlineAt = Date.now() + AUTO_DELAY_MS;
  resumeAutoTimer();
}

function resumeAutoTimer() {
  cancelAutoTimer({ preserveDeadline: true });
  if (!state.settings.autoAnswer || !state.listening || !state.autoBuffer.parts.length) {
    state.autoDeadlineAt = null;
    return;
  }
  if (state.interviewerSpeaking || state.autoDeadlineAt === null) return;
  state.autoTimer = setTimeout(maybeAutoAnswer, Math.max(0, state.autoDeadlineAt - Date.now()));
}

function maybeAutoAnswer() {
  state.autoTimer = null;
  state.autoDeadlineAt = null;
  if (!state.settings.autoAnswer || !state.listening || state.interviewerSpeaking) {
    logSession('auto_decision', { reason: 'disabled_stopped_or_speaking' });
    return;
  }
  const current = state.autoBuffer.take();
  if (!current) {
    logSession('auto_decision', { reason: 'not_a_question' });
    tryDrainQueuedAuto();
    return;
  }
  const previous = state.lastAutoQuestion;
  if (
    previous &&
    Date.now() - previous.atMs < AUTO_DEDUP_MS &&
    isNearDuplicateQuestion(previous.question, current.question)
  ) {
    logSession('auto_decision', { reason: 'repeat_question', question: current.question });
    return;
  }
  if (state.queuedAuto && isNearDuplicateQuestion(state.queuedAuto.question, current.question)) {
    logSession('auto_decision', { reason: 'already_queued', question: current.question });
    return;
  }
  const payload = { ...current, transcript: buildRecentDialogue(15) };
  if (state.generating) {
    const replaced = !!state.queuedAuto;
    state.queuedAuto = payload;
    logSession('auto_decision', {
      reason: replaced ? 'replace_queued' : 'queue_while_generating',
      question: current.question,
    });
    toast(replaced ? '已用最新追问更新待答问题' : '新问题已排队，上一题完成后作答');
    return;
  }
  startAutoAnswer(payload);
}

function startAutoAnswer(payload) {
  const reqId = triggerGenerate({ ...payload, auto: true });
  if (!reqId) return;
  const atMs = Date.now();
  state.lastAutoQuestion = { question: payload.question, atMs };
  const timing = payload.timing;
  logSession('auto_trigger', {
    reqId,
    question: payload.question,
    sttId: timing?.sttId,
    segmentId: timing?.segmentId,
    asrToTriggerMs: timing?.asrFinalAtMs ? atMs - timing.asrFinalAtMs : null,
    vadToTriggerMs: timing?.vadFlushAtMs ? atMs - timing.vadFlushAtMs : null,
  });
  console.info(
    JSON.stringify({
      event: 'auto_trigger',
      reqId,
      atMs,
      sttId: timing?.sttId || null,
      segmentId: timing?.segmentId || null,
      asrToTriggerMs: timing?.asrFinalAtMs ? atMs - timing.asrFinalAtMs : null,
      vadToTriggerMs: timing?.vadFlushAtMs ? atMs - timing.vadFlushAtMs : null,
    }),
  );
}

function tryDrainQueuedAuto() {
  if (
    !state.queuedAuto ||
    !state.settings.autoAnswer ||
    !state.listening ||
    state.generating ||
    state.interviewerSpeaking ||
    state.autoTimer ||
    state.autoBuffer.parts.length
  )
    return;
  const pending = state.queuedAuto;
  state.queuedAuto = null;
  startAutoAnswer(pending);
}

// ---------------- 音频采集 ----------------
async function listInputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');

    const micSel = $('micSelect');
    const sysSel = $('sysSelect');
    const prevMic = micSel.value;
    const prevSys = sysSel.value;

    micSel.innerHTML = '';
    const noMic = document.createElement('option');
    noMic.value = '__none__';
    noMic.textContent = '不采集我的声音';
    micSel.appendChild(noMic);
    inputs.forEach((d, i) => {
      if (window.api.platform === 'linux' && /\bmonitor\b|回环/i.test(d.label)) return;
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `麦克风 ${i + 1}`;
      micSel.appendChild(opt);
    });
    if (prevMic && [...micSel.options].some((o) => o.value === prevMic)) micSel.value = prevMic;
    else if (micSel.options.length > 1) micSel.selectedIndex = 1;

    // 系统音源：保留 loopback 选项 + 追加可选输入设备（如 BlackHole）
    sysSel.innerHTML = '<option value="__loopback__">系统回环（Linux 可能不可用）</option>';
    inputs.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `输入设备 ${i + 1}`;
      sysSel.appendChild(opt);
    });
    if (prevSys) sysSel.value = prevSys;
    if (
      window.api.platform === 'linux' &&
      !state.sysSelectionTouched &&
      (!prevSys || prevSys === '__loopback__')
    ) {
      const monitor = inputs.find((d) => /\bmonitor\b|回环/i.test(d.label));
      if (monitor) sysSel.value = monitor.deviceId;
    }
  } catch (e) {
    console.error(e);
  }
}

async function getMicStream(deviceId) {
  const audio = deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true;
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(typeof audio === 'object' ? audio : {}),
      echoCancellation: false,
      noiseSuppression: true,
    },
  });
}

async function handleSystemCaptureError(e, sysVal) {
  if (sysVal === '__loopback__') {
    const status = await window.api.getScreenPermission();
    if (status !== 'granted') {
      toast('采集系统声音需要屏幕与系统音频录制权限。即将打开系统设置；授权本应用后请重启。', true);
      setStatus('请授权系统音频录制并重启', 'error');
      window.api.openScreenSettings();
      return;
    }
  }
  toast('无法采集面试官声音：' + e.message + '；将仅使用麦克风', true);
}

async function getSystemStream(value) {
  if (value === '__loopback__') {
    // 通过主进程的 displayMediaRequestHandler 抓取系统声音
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    // 丢弃视频轨，只保留音频
    stream.getVideoTracks().forEach((t) => t.stop());
    return stream;
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: value },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
}

async function wireStream(stream, dg) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, 'pcm-worklet');
  // 静音接到 destination，确保 worklet 持续处理且不产生回声
  const silent = ctx.createGain();
  silent.gain.value = 0;

  worklet.port.onmessage = (e) => dg.send(e.data);

  source.connect(worklet);
  worklet.connect(silent);
  silent.connect(ctx.destination);

  state.contexts.push(ctx);
  state.nodes.push(source, worklet, silent);
  // dg 期望的采样率以实际 AudioContext 为准
  dg.sampleRate = ctx.sampleRate;
}

function setListeningUI(on) {
  const btn = $('toggleBtn');
  btn.classList.toggle('primary', !on);
  btn.classList.toggle('danger', on);
  btn.querySelector('.label').textContent = on ? '停止监听' : '开始监听';
  const icon = on
    ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  btn.querySelector('svg').outerHTML = icon;
}

async function startListening() {
  if (state.stopPromise) await state.stopPromise;
  if (state.starting || state.listening) return;
  if (state.selfChecking) {
    toast('自检进行中，请完成后再开始监听', true);
    return;
  }
  const local = (state.settings.sttProvider || 'local') === 'local';
  if (!local && !state.settings.deepgramApiKey) {
    toast('请先在设置中填写 Deepgram API Key', true);
    openSettings();
    return;
  }

  state.starting = true;
  $('toggleBtn').disabled = true;
  setStatus('正在初始化…');
  try {
    if (local) {
      setStatus('正在加载本地中文模型…');
      await window.api.warmLocalStt();
    }
    await window.api.ensureMicPermission();

    // Linux 授权麦克风后设备名称才可能出现，此时优先自动选择 Monitor 输入。
    await listInputDevices();
    const micVal = $('micSelect').value;
    const micStream = micVal && micVal !== '__none__' ? await getMicStream(micVal) : null;
    let sysStream = null;
    const sysVal = $('sysSelect').value;
    try {
      // Loopback 需要屏幕录制权限：已明确拒绝时直接引导，不触发 getDisplayMedia（避免一串报错）。
      if (sysVal === '__loopback__' && (await window.api.getScreenPermission()) === 'denied') {
        await handleSystemCaptureError(new Error('Screen Recording permission denied'), sysVal);
      } else {
        sysStream = await getSystemStream(sysVal);
      }
    } catch (e) {
      console.error('system audio capture failed:', e);
      await handleSystemCaptureError(e, sysVal);
    }
    if (sysStream && sysStream.getAudioTracks().length === 0) {
      sysStream.getTracks().forEach((t) => t.stop());
      sysStream = null;
      toast('所选系统音源没有音轨；Linux 请改选扬声器 Monitor 输入', true);
    }

    const lang = state.settings.sttLanguage || 'zh';

    const SttClient = local ? window.LocalSttLive : window.DeepgramLive;
    if (!micStream && !sysStream)
      throw new Error('没有可用音频输入。请在系统声音中选择 Monitor，或接入麦克风。');

    if (micStream) {
      state.dgMic = new SttClient({
        ...(local ? {} : { apiKey: state.settings.deepgramApiKey }),
        role: 'interviewee',
        language: lang,
        onTranscript: (r) => handleTranscript('interviewee', r),
        onState: (s, info) => onDgState('mic', s, info),
      });
      await wireStream(micStream, state.dgMic);
      state.streams.push(micStream);
      state.dgMic.connect();
    }

    if (sysStream) {
      state.dgSys = new SttClient({
        ...(local ? {} : { apiKey: state.settings.deepgramApiKey }),
        role: 'interviewer',
        language: lang,
        onTranscript: (r) => handleTranscript('interviewer', r),
        onSpeechStart: noteInterviewerSpeechStart,
        onUtteranceEnd: noteInterviewerUtteranceEnd,
        onState: (s, info) => onDgState('sys', s, info),
      });
      await wireStream(sysStream, state.dgSys);
      state.streams.push(sysStream);
      state.dgSys.connect();
    }

    state.listening = true;
    state.sessionStart = Date.now();
    state.lastAutoQuestion = null;
    state.autoBuffer.clear();
    state.queuedAuto = null;
    state.interviewerSpeaking = false;
    clearEmptyState();
    if (!$('transcript').querySelector('.day-sep')) addDaySeparator();
    setLive(true);
    setListeningUI(true);
    setStatus('监听中', 'live');
    logSession('session_start', {
      micEnabled: !!micStream,
      systemEnabled: !!sysStream,
      auto: !!state.settings.autoAnswer,
      channelCount: sysStream?.getAudioTracks()[0]?.getSettings().channelCount,
      sampleRate: sysStream?.getAudioTracks()[0]?.getSettings().sampleRate,
      asrSampleRate: state.dgSys?.sampleRate,
      echoCancellation: sysStream?.getAudioTracks()[0]?.getSettings().echoCancellation,
      noiseSuppression: sysStream?.getAudioTracks()[0]?.getSettings().noiseSuppression,
      autoGainControl: sysStream?.getAudioTracks()[0]?.getSettings().autoGainControl,
    });
    // 拿到权限后刷新设备名称
    listInputDevices();
  } catch (e) {
    console.error(e);
    await stopListening();
    setStatus('启动失败', 'error');
    toast('启动失败：' + e.message, true);
  } finally {
    state.starting = false;
    $('toggleBtn').disabled = false;
  }
}

function onDgState(which, s, info) {
  if (s === 'error') {
    setStatus('转写出错', 'error');
    if (info) toast(`语音识别（${which === 'mic' ? '麦克风' : '面试官声音'}）：${info}`, true);
  }
}

async function stopListening() {
  if (state.stopPromise) return state.stopPromise;
  state.stopPromise = (async () => {
    if (state.listening) logSession('session_stop');
    state.listening = false;
    $('toggleBtn').disabled = true;
    cancelAutoTimer();
    state.autoBuffer.clear();
    state.queuedAuto = null;
    state.interviewerSpeaking = false;

    // Stop new PCM first, then let already queued ASR return the last phrase.
    state.nodes.forEach((n) => {
      try {
        n.disconnect();
      } catch (_e) {}
    });
    state.nodes = [];
    state.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    state.streams = [];

    const clients = [state.dgMic, state.dgSys].filter(Boolean);
    await Promise.allSettled(
      clients.map((client) => {
        try {
          return Promise.resolve(client.close());
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    );
    state.dgMic = null;
    state.dgSys = null;

    for (const c of state.contexts) {
      try {
        await c.close();
      } catch (_e) {}
    }
    state.contexts = [];
    clearInterim('interviewer');
    clearInterim('interviewee');
    setLive(false);
    setListeningUI(false);
    setStatus('待机');
  })();
  try {
    await state.stopPromise;
  } finally {
    state.stopPromise = null;
    if (!state.starting) $('toggleBtn').disabled = false;
  }
}

// ---------------- 生成答案 ----------------
function triggerGenerate(options = {}) {
  if (!options.auto) state.queuedAuto = null;
  let manual = options.auto ? options.question : $('questionBox').value.trim();
  // 框里若只是上次自动识别的问题（用户没改），仍按"自动从最近对话提取"处理
  if (!options.auto && manual && manual === state.autoQuestion) manual = '';
  // 作答上下文：最近 15 轮对话历史（问题检测在主进程里只取其末尾几轮）
  const transcript = options.transcript || buildRecentDialogue(15);
  if (!manual && !transcript) {
    toast('暂无可回答的问题，请开始监听或输入问题', true);
    $('questionBox').focus();
    return null;
  }
  if (options.auto) {
    $('questionBox').value = manual;
    state.autoQuestion = manual;
  }
  state.reqId += 1;
  logSession('answer_request', {
    reqId: state.reqId,
    question: manual,
    auto: !!options.auto,
    source: options.auto ? 'interviewer' : 'manual',
  });
  state.generating = true;
  const ans = $('answer');
  ans.textContent = '';
  ans.classList.add('generating');
  updateCounter('');
  $('generateBtn').disabled = true;
  $('cancelBtn').disabled = false;
  if (!manual) {
    const turns = transcript.split('\n').length;
    toast(`正在从最近 ${turns} 轮对话中提取问题…`);
  }
  // 自动模式已确定当前问题；手动空问题框继续交给主进程提取。
  window.api.generateAnswer({ reqId: state.reqId, question: manual, transcript });
  return state.reqId;
}

function endGenerate() {
  state.generating = false;
  $('answer').classList.remove('generating');
  $('generateBtn').disabled = false;
  $('cancelBtn').disabled = true;
  tryDrainQueuedAuto();
}

function updateCounter(text) {
  const n = charCount(text);
  const max = state.settings ? state.settings.maxChars || 500 : 500;
  const el = $('charCounter');
  el.textContent = `${n} / ${max} 字`;
  el.classList.toggle('over', n > max);
}

// ---------------- 资料 ----------------
async function refreshDocs(list) {
  const docs = list || (await window.api.listDocuments());
  const ul = $('docList');
  ul.innerHTML = '';
  if (!docs || docs.length === 0) {
    const li = document.createElement('li');
    li.className = 'docs-empty';
    li.textContent = '暂无资料。可上传简历、岗位描述或项目笔记，回答时会优先参考相关内容。';
    ul.appendChild(li);
    return;
  }
  docs.forEach((d) => {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.className = 'doc-name';
    left.textContent = d.name;
    const meta = document.createElement('span');
    meta.className = 'doc-meta';
    meta.textContent = `${d.chars.toLocaleString()} 字`;
    left.appendChild(meta);
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '移除';
    rm.onclick = async () => {
      try {
        await refreshDocs(await window.api.removeDocument(d.id));
      } catch (e) {
        toast('移除资料失败：' + e.message, true);
      }
    };
    li.appendChild(left);
    li.appendChild(rm);
    ul.appendChild(li);
  });
}

function parseProjectKeywords(text) {
  const seen = new Set();
  return String(text || '')
    .split(/[,，、;；\n]+/)
    .map((keyword) => keyword.trim())
    .filter((keyword) => {
      const key = keyword.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function openProjectKeywords(project) {
  state.editingProject = project.id;
  $('projectKeywordName').textContent = project.name;
  $('projectKeywordInput').value = (project.keywords || []).join('，') || project.name;
  $('projectKeywordsModal').classList.remove('hidden');
  $('projectKeywordInput').focus();
}

function closeProjectKeywords() {
  state.editingProject = null;
  $('projectKeywordsModal').classList.add('hidden');
}

async function saveProjectKeywords() {
  if (!state.editingProject) return;
  const keywords = parseProjectKeywords($('projectKeywordInput').value);
  if (!keywords.length) {
    toast('请至少填写一个项目关键词', true);
    return;
  }
  const button = $('saveProjectKeywords');
  button.disabled = true;
  try {
    await refreshProjects(
      await window.api.setProjectKeywords({ projectId: state.editingProject, keywords }),
    );
    closeProjectKeywords();
    toast('项目关键词已保存');
  } catch (error) {
    toast('保存项目关键词失败：' + error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function removeProject(project) {
  if (!window.confirm(`确定移除“${project.name}”项目知识库？`)) return;
  try {
    await refreshProjects(await window.api.removeProject(project.id));
    toast(`已移除项目：${project.name}`);
  } catch (error) {
    toast('移除项目失败：' + error.message, true);
  }
}

async function refreshProjects(list) {
  const projects = Array.isArray(list) ? list : await window.api.listProjects();
  const ul = $('projectList');
  ul.innerHTML = '';
  if (!projects.length) {
    const li = document.createElement('li');
    li.className = 'docs-empty';
    li.textContent = '暂无项目。点击“导入项目”选择含 README 的文件夹。';
    ul.appendChild(li);
    return projects;
  }
  projects.forEach((project) => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'project-info';
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = project.name;
    const detail = document.createElement('span');
    detail.className = 'project-detail';
    const chars = Number.isFinite(project.chars) ? `${project.chars.toLocaleString()} 字` : '';
    detail.textContent = [project.readmeName || 'README', chars].filter(Boolean).join(' · ');
    const keywords = document.createElement('span');
    keywords.className = 'project-detail';
    keywords.textContent = `关键词：${(project.keywords || []).join('、') || '未设置'}`;
    info.append(name, detail, keywords);
    const actions = document.createElement('div');
    actions.className = 'project-row-actions';
    const edit = document.createElement('button');
    edit.className = 'rm edit-project';
    edit.type = 'button';
    edit.textContent = '编辑';
    edit.setAttribute('aria-label', `编辑 ${project.name} 的关键词`);
    edit.onclick = () => openProjectKeywords(project);
    const remove = document.createElement('button');
    remove.className = 'rm';
    remove.type = 'button';
    remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除 ${project.name} 项目`);
    remove.onclick = () => removeProject(project);
    actions.append(edit, remove);
    li.append(info, actions);
    ul.appendChild(li);
  });
  return projects;
}

async function importProjectFolder() {
  const button = $('importProjectBtn');
  button.disabled = true;
  try {
    const result = await window.api.pickProjectFolder();
    if (!result || result.canceled) return;
    if (result.error) throw new Error(result.error);
    await refreshProjects(result.projects);
    if (result.project) {
      openProjectKeywords(result.project);
      toast(`已导入 ${result.project.name} 的 README，请设置关键词`);
    } else {
      toast('项目 README 已导入');
    }
  } catch (error) {
    toast('导入项目失败：' + error.message, true);
  } finally {
    button.disabled = false;
  }
}

// ---------------- 首次配置与部署自检 ----------------
function showSetupFields() {
  const provider = $('setupProvider').value;
  document.querySelectorAll('[data-setup-provider]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.setupProvider !== provider);
  });
  $('setupDeepgramFields').classList.toggle('hidden', $('setupSttProvider').value !== 'deepgram');
}

function openSetup() {
  const s = state.settings;
  $('setupSttProvider').value = s.sttProvider || 'local';
  $('setupProvider').value = providerConfigured(s) ? s.provider : 'custom';
  $('setupDeepgramKey').value = s.deepgramApiKey || '';
  // 新安装时不预填特定云服务商；已有自定义配置则保留。
  const hasCustom = !!s.customApiKey || !!s.onboardingComplete;
  $('setupCustomURL').value = hasCustom ? s.customBaseURL || '' : '';
  $('setupCustomModel').value = hasCustom ? s.customModel || '' : '';
  $('setupCustomKey').value = s.customApiKey || '';
  $('setupOllamaURL').value = s.ollamaBaseURL || 'http://localhost:11434/v1/chat/completions';
  $('setupOllamaModel').value = s.provider === 'ollama' ? s.ollamaModel || '' : '';
  $('setupDeepseekKey').value = s.deepseekApiKey || '';
  $('setupGeminiKey').value = s.geminiApiKey || '';
  $('setupOpenaiKey').value = s.openaiApiKey || '';
  showSetupFields();
  $('setupModal').classList.remove('hidden');
}

function providerConfigured(s) {
  switch (s.provider) {
    case 'ollama':
      return !!(s.ollamaBaseURL && s.ollamaModel);
    case 'custom':
      return !!(s.customBaseURL && s.customModel && s.customApiKey);
    case 'deepseek':
      return !!s.deepseekApiKey;
    case 'gemini':
      return !!s.geminiApiKey;
    case 'openai':
      return !!s.openaiApiKey;
    default:
      return false;
  }
}

function validatedEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_e) {
    return false;
  }
}

async function finishSetup() {
  const sttProvider = $('setupSttProvider').value;
  const provider = $('setupProvider').value;
  const partial = { sttProvider, provider, sttLanguage: 'zh', onboardingComplete: true };
  if (sttProvider === 'deepgram') {
    partial.deepgramApiKey = $('setupDeepgramKey').value.trim();
    if (!partial.deepgramApiKey) {
      toast('选择 Deepgram 时需要填写它的 API Key', true);
      $('setupDeepgramKey').focus();
      return;
    }
  }
  if (provider === 'custom') {
    partial.customBaseURL = $('setupCustomURL').value.trim();
    partial.customModel = $('setupCustomModel').value.trim();
    partial.customApiKey = $('setupCustomKey').value.trim();
    if (!validatedEndpoint(partial.customBaseURL) || !partial.customModel) {
      toast('请填写有效的兼容接口地址和模型名称', true);
      $('setupCustomURL').focus();
      return;
    }
    if (!partial.customApiKey) {
      toast('自定义兼容接口需要 API Key；无 Key 的本地服务请选 Ollama', true);
      $('setupCustomKey').focus();
      return;
    }
  } else if (provider === 'ollama') {
    partial.ollamaBaseURL = $('setupOllamaURL').value.trim();
    partial.ollamaModel = $('setupOllamaModel').value.trim();
    if (!validatedEndpoint(partial.ollamaBaseURL) || !partial.ollamaModel) {
      toast('请填写 Ollama 接口地址和已安装的模型名称', true);
      $('setupOllamaModel').focus();
      return;
    }
  } else {
    const field = {
      deepseek: ['deepseekApiKey', 'setupDeepseekKey'],
      gemini: ['geminiApiKey', 'setupGeminiKey'],
      openai: ['openaiApiKey', 'setupOpenaiKey'],
    }[provider];
    if (!field) {
      toast('请选择回答模型服务', true);
      return;
    }
    partial[field[0]] = $(field[1]).value.trim();
    if (!partial[field[0]]) {
      toast('请填写所选回答服务的 API Key', true);
      $(field[1]).focus();
      return;
    }
  }
  try {
    state.settings = await window.api.saveSettings(partial);
    $('langSelect').value = state.settings.sttLanguage;
    $('setupModal').classList.add('hidden');
    toast('配置已保存，正在运行部署自检');
    await runSelfCheck();
  } catch (e) {
    toast('保存配置失败：' + e.message, true);
  }
}

async function selfCheckAudioInfo() {
  let micDeviceCount = 0;
  let micPermissionState = 'unknown';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    micDeviceCount = devices.filter((d) => d.kind === 'audioinput').length;
  } catch (_e) {}
  try {
    const permission = await navigator.permissions.query({ name: 'microphone' });
    if (['granted', 'prompt', 'denied'].includes(permission.state)) {
      micPermissionState = permission.state;
    }
  } catch (_e) {}
  const source = $('sysSelect').value;
  return {
    micDeviceCount,
    interviewerSource: source === '__loopback__' ? 'loopback' : source ? 'input' : 'none',
    micPermissionState,
  };
}

async function recordSelfCheckMic() {
  let stream = null;
  let context = null;
  const samples = [];
  try {
    await window.api.ensureMicPermission();
    stream = await getMicStream($('micSelect').value);
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule('pcm-worklet.js');
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, 'pcm-worklet');
    const silent = context.createGain();
    silent.gain.value = 0;
    worklet.port.onmessage = (e) => {
      const chunk = new Int16Array(e.data);
      for (const value of chunk) samples.push(value / 32768);
    };
    source.connect(worklet);
    worklet.connect(silent);
    silent.connect(context.destination);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    source.disconnect();
    worklet.disconnect();
    silent.disconnect();
    const actualRate = context.sampleRate;
    if (actualRate === 16000) return samples;
    const ratio = actualRate / 16000;
    const resampled = [];
    for (let i = 0; i < samples.length / ratio; i++) {
      const position = i * ratio;
      const left = Math.floor(position);
      const fraction = position - left;
      resampled.push(samples[left] * (1 - fraction) + (samples[left + 1] || 0) * fraction);
    }
    return resampled;
  } finally {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    if (context) await context.close();
  }
}

function renderSelfCheck(report) {
  const checks = Array.isArray(report && report.checks) ? report.checks : [];
  const summary = ['pass', 'warning', 'fail'].includes(report && report.summary)
    ? report.summary
    : 'warning';
  const summaryText = {
    pass: '自检通过：可以开始使用',
    warning: '部分检查需要留意：请查看下方详情',
    fail: '自检未通过：请先处理失败项',
  }[summary];
  const summaryEl = $('selfCheckSummary');
  summaryEl.className = 'check-summary ' + summary;
  summaryEl.textContent = summaryText;
  const list = $('selfCheckReport');
  list.replaceChildren();
  const icons = { pass: '✓', warning: '!', fail: '×', skipped: '–' };
  const safeMetrics = {
    ramGiB: ['系统内存', ' GiB'],
    memoryMiB: ['显存', ' MiB'],
    deviceCount: ['设备数', ''],
    durationMs: ['音频时长', ' ms'],
    loadMs: ['模型加载', ' ms'],
    inferenceMs: ['语音推理', ' ms'],
    queueMs: ['语音排队', ' ms'],
    chars: ['识别字数', ' 字'],
    firstContentMs: ['首字', ' ms'],
    completeMs: ['完整回答', ' ms'],
    elapsedMs: ['等待', ' ms'],
  };
  for (const check of checks) {
    const status = ['pass', 'warning', 'fail', 'skipped'].includes(check.status)
      ? check.status
      : 'warning';
    const item = document.createElement('div');
    item.className = 'check-item ' + status;
    const icon = document.createElement('span');
    icon.className = 'check-icon';
    icon.textContent = icons[status];
    const copy = document.createElement('div');
    copy.className = 'check-copy';
    const title = document.createElement('strong');
    title.textContent = String(check.label || check.id || '检查项').slice(0, 80);
    const detail = document.createElement('p');
    detail.textContent = String(check.detail || '').slice(0, 400);
    copy.append(title, detail);
    if (check.metrics && typeof check.metrics === 'object') {
      const metrics = document.createElement('div');
      metrics.className = 'check-metrics';
      for (const [key, value] of Object.entries(check.metrics)) {
        if (!safeMetrics[key] || typeof value !== 'number' || !Number.isFinite(value)) continue;
        const metric = document.createElement('span');
        const [label, unit] = safeMetrics[key];
        const amount = key === 'ramGiB' ? value.toFixed(1) : Math.round(value);
        metric.textContent = `${label}：${amount}${unit}`;
        metrics.appendChild(metric);
      }
      if (metrics.childNodes.length) copy.appendChild(metrics);
    }
    item.append(icon, copy);
    list.appendChild(item);
  }
}

async function runSelfCheck(withMic = false) {
  if (state.selfChecking) return;
  if (state.listening) {
    toast('请先停止监听，再运行自检，避免占用音频设备', true);
    return;
  }
  state.selfChecking = true;
  $('selfCheckModal').classList.remove('hidden');
  $('selfCheckSummary').className = 'check-summary';
  $('selfCheckSummary').textContent = withMic
    ? '正在采集 3 秒麦克风声音，请说一句中文…'
    : '正在检查环境、语音模型与回答服务…';
  $('selfCheckReport').replaceChildren();
  $('runGeneralCheck').disabled = true;
  $('runMicCheck').disabled = true;
  $('selfCheckBtn').disabled = true;
  try {
    const options = {};
    if (withMic) {
      options.pcm = await recordSelfCheckMic();
      options.sampleRate = 16000;
      if (options.pcm.length < 16000)
        throw new Error('麦克风没有采集到足够的声音，请检查设备和权限');
      await listInputDevices();
    }
    options.audio = await selfCheckAudioInfo();
    renderSelfCheck(await window.api.runSelfCheck(options));
  } catch (e) {
    $('selfCheckSummary').className = 'check-summary fail';
    $('selfCheckSummary').textContent = '自检未完成：' + e.message;
  } finally {
    state.selfChecking = false;
    $('runGeneralCheck').disabled = false;
    $('runMicCheck').disabled = false;
    $('selfCheckBtn').disabled = false;
  }
}

// ---------------- 设置弹窗 ----------------
function showSettingsFields() {
  const provider = $('setProvider').value;
  const stt = $('setSttProvider').value;
  document.querySelectorAll('[data-setting-provider]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.settingProvider !== provider);
  });
  document.querySelectorAll('[data-setting-stt]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.settingStt !== stt);
  });
  $('localSttContextFields').classList.toggle(
    'hidden',
    stt !== 'local' || $('setLocalSttEngine').value !== 'qwen3-asr',
  );
  $('setLocalSttContextTerms').disabled = !$('setLocalSttContextEnabled').checked;
}
const LOCAL_STT_DEFAULT_MODELS = {
  'qwen3-asr': 'Qwen/Qwen3-ASR-0.6B-hf',
  sensevoice: 'iic/SenseVoiceSmall',
  'faster-whisper': 'large-v3-turbo',
};

function openSettings() {
  const s = state.settings;
  $('setSttProvider').value = s.sttProvider || 'local';
  $('setLocalSttEngine').value = s.localSttEngine || 'qwen3-asr';
  $('setLocalSttModel').value =
    s.localSttModel || LOCAL_STT_DEFAULT_MODELS[$('setLocalSttEngine').value];
  $('setLocalSttContextEnabled').checked = s.localSttContextEnabled !== false;
  $('setLocalSttContextTerms').value = s.localSttContextTerms || '';
  $('setDeepgram').value = s.deepgramApiKey || '';
  $('setProvider').value = s.provider || 'custom';
  $('setDeepseek').value = s.deepseekApiKey || '';
  $('setDeepseekModel').value = s.deepseekModel || 'deepseek-chat';
  $('setGemini').value = s.geminiApiKey || '';
  $('setModel').value = s.genModel || 'gemini-2.5-flash';
  $('setOpenai').value = s.openaiApiKey || '';
  $('setOpenaiModel').value = s.openaiModel || 'gpt-4o-mini';
  $('setCustomURL').value = s.customBaseURL || '';
  $('setCustomModel').value = s.customModel || '';
  $('setCustomKey').value = s.customApiKey || '';
  $('setOllamaURL').value = s.ollamaBaseURL || 'http://localhost:11434/v1/chat/completions';
  $('setOllamaModel').value = s.ollamaModel || 'llama3.1';
  $('setSttLang').value = s.sttLanguage || 'zh';
  $('setAnswerLang').value = s.answerLanguage || 'auto';
  $('setMaxChars').value = s.maxChars || 500;
  $('setHotkey').value = s.hotkey || 'Control+A';
  $('setProfile').value = s.interviewProfile || '';
  $('setJD').value = s.jobDescription || '';
  $('setDiagnosticLogging').checked = s.diagnosticLogging !== false;
  showSettingsFields();
  $('settingsModal').classList.remove('hidden');
}

async function saveSettings() {
  const partial = {
    sttProvider: $('setSttProvider').value,
    localSttEngine: $('setLocalSttEngine').value,
    localSttModel:
      $('setLocalSttModel').value.trim() || LOCAL_STT_DEFAULT_MODELS[$('setLocalSttEngine').value],
    localSttContextEnabled: $('setLocalSttContextEnabled').checked,
    localSttContextTerms: $('setLocalSttContextTerms').value.trim().slice(0, 500),
    deepgramApiKey: $('setDeepgram').value.trim(),
    provider: $('setProvider').value,
    deepseekApiKey: $('setDeepseek').value.trim(),
    deepseekModel: $('setDeepseekModel').value.trim() || 'deepseek-chat',
    geminiApiKey: $('setGemini').value.trim(),
    genModel: $('setModel').value.trim() || 'gemini-2.5-flash',
    openaiApiKey: $('setOpenai').value.trim(),
    openaiModel: $('setOpenaiModel').value.trim() || 'gpt-4o-mini',
    customBaseURL: $('setCustomURL').value.trim(),
    customModel: $('setCustomModel').value.trim(),
    customApiKey: $('setCustomKey').value.trim(),
    ollamaBaseURL: $('setOllamaURL').value.trim() || 'http://localhost:11434/v1/chat/completions',
    ollamaModel: $('setOllamaModel').value.trim() || 'llama3.1',
    sttLanguage: $('setSttLang').value,
    answerLanguage: $('setAnswerLang').value,
    maxChars: parseInt($('setMaxChars').value, 10) || 500,
    hotkey: $('setHotkey').value.trim() || 'Control+A',
    interviewProfile: $('setProfile').value,
    jobDescription: $('setJD').value,
    diagnosticLogging: $('setDiagnosticLogging').checked,
    onboardingComplete: true,
  };
  try {
    state.settings = await window.api.saveSettings(partial);
    renderHotkeyHint(state.settings.hotkey);
    $('langSelect').value = state.settings.sttLanguage || 'zh';
    $('settingsModal').classList.add('hidden');
    updateCounter($('answer').textContent);
    toast('设置已保存');
  } catch (e) {
    toast('保存设置失败：' + e.message, true);
  }
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  $('toggleBtn').onclick = () => (state.listening ? stopListening() : startListening());
  $('sysSelect').onchange = () => {
    state.sysSelectionTouched = true;
  };
  $('setupBtn').onclick = openSetup;
  $('closeSetup').onclick = () => $('setupModal').classList.add('hidden');
  $('setupProvider').onchange = showSetupFields;
  $('setupSttProvider').onchange = showSetupFields;
  $('finishSetup').onclick = finishSetup;
  $('setupAdvanced').onclick = () => {
    $('setupModal').classList.add('hidden');
    openSettings();
  };
  $('selfCheckBtn').onclick = () => runSelfCheck();
  $('runGeneralCheck').onclick = () => runSelfCheck();
  $('runMicCheck').onclick = () => runSelfCheck(true);
  $('closeSelfCheck').onclick = () => $('selfCheckModal').classList.add('hidden');
  $('settingsBtn').onclick = openSettings;
  $('closeSettings').onclick = () => $('settingsModal').classList.add('hidden');
  $('saveSettings').onclick = saveSettings;
  $('clearSessionLog').onclick = async () => {
    if (!window.confirm('确定清空本机诊断日志？此操作无法撤销。')) return;
    try {
      await window.api.clearSessionLog();
      toast('诊断日志已清空');
    } catch (error) {
      toast('清空诊断日志失败：' + error.message, true);
    }
  };
  $('setProvider').onchange = showSettingsFields;
  $('setSttProvider').onchange = showSettingsFields;
  $('setLocalSttContextEnabled').onchange = showSettingsFields;
  $('setLocalSttEngine').onchange = () => {
    const modelInput = $('setLocalSttModel');
    if (
      !modelInput.value.trim() ||
      Object.values(LOCAL_STT_DEFAULT_MODELS).includes(modelInput.value.trim())
    ) {
      modelInput.value = LOCAL_STT_DEFAULT_MODELS[$('setLocalSttEngine').value];
    }
    showSettingsFields();
  };

  // 上传 / 清空 目标岗位 JD（保存时随设置一起持久化）
  $('uploadJD').onclick = async () => {
    const r = await window.api.pickJD();
    if (!r) return;
    if (r.error) {
      toast('岗位描述解析失败：' + r.error, true);
      return;
    }
    $('setJD').value = r.text || '';
    toast(`已加载岗位描述：${r.name}（${charCount(r.text)} 字），点击“保存”后生效。`);
  };
  $('clearJD').onclick = () => {
    $('setJD').value = '';
  };

  $('generateBtn').onclick = triggerGenerate;
  $('cancelBtn').onclick = () => {
    window.api.cancelGenerate();
    logSession('auto_decision', { reason: 'answer_cancelled', reqId: state.reqId });
    endGenerate();
  };

  $('clearTranscript').onclick = () => {
    cancelAutoTimer();
    state.autoBuffer.clear();
    state.queuedAuto = null;
    state.interviewerSpeaking = false;
    state.interim = { interviewer: null, interviewee: null };
    state.lastFinalSpeaker = null;
    state.lastAutoQuestion = null;
    state.history = [];
    if (state.listening) {
      $('transcript').innerHTML = '';
      addDaySeparator();
    } else {
      showEmptyState();
    }
  };

  $('uploadBtn').onclick = async () => {
    try {
      const res = await window.api.pickDocuments();
      if (res.errors && res.errors.length)
        toast('部分文件解析失败：' + res.errors.join('；'), true);
      await refreshDocs(res.docs);
    } catch (e) {
      toast('上传资料失败：' + e.message, true);
    }
  };
  $('importProjectBtn').onclick = importProjectFolder;
  $('closeProjectKeywords').onclick = closeProjectKeywords;
  $('saveProjectKeywords').onclick = saveProjectKeywords;
  $('clearDocsBtn').onclick = async () => {
    try {
      await refreshDocs(await window.api.clearDocuments());
    } catch (e) {
      toast('清空资料失败：' + e.message, true);
    }
  };

  $('pasteBtn').onclick = () => $('pasteModal').classList.remove('hidden');
  $('closePaste').onclick = () => $('pasteModal').classList.add('hidden');
  $('savePaste').onclick = async () => {
    const name = $('pasteName').value.trim() || '粘贴的文本';
    const text = $('pasteText').value;
    if (!text.trim()) {
      toast('内容不能为空', true);
      return;
    }
    try {
      const docs = await window.api.addTextDocument({ name, text });
      $('pasteName').value = '';
      $('pasteText').value = '';
      $('pasteModal').classList.add('hidden');
      await refreshDocs(docs);
      toast('已加入知识库');
    } catch (e) {
      toast('保存资料失败：' + e.message, true);
    }
  };

  // 转写语言切换：持久化；若正在监听则自动重连以立即生效
  $('langSelect').onchange = async (e) => {
    const lang = e.target.value;
    try {
      state.settings = await window.api.saveSettings({ sttLanguage: lang });
      $('setSttLang').value = lang;
      const label = e.target.selectedOptions[0].textContent;
      if (state.listening) {
        toast(`转写语言已改为${label}，正在重新连接…`);
        await stopListening();
        await startListening();
      } else {
        toast(`转写语言已设为${label}`);
      }
    } catch (error) {
      e.target.value = state.settings.sttLanguage || 'zh';
      toast('保存转写语言失败：' + error.message, true);
    }
  };

  // 设备变化
  navigator.mediaDevices.addEventListener('devicechange', listInputDevices);

  // 用户手动编辑问题框 → 不再视作自动识别值
  $('questionBox').addEventListener('input', () => {
    state.autoQuestion = '';
  });

  // 自动作答开关
  $('autoAnswer').onchange = async (e) => {
    try {
      state.settings = await window.api.saveSettings({ autoAnswer: e.target.checked });
      if (!e.target.checked) {
        cancelAutoTimer();
        state.autoBuffer.clear();
        state.queuedAuto = null;
      }
      logSession('auto_decision', {
        reason: e.target.checked ? 'enabled_by_user' : 'disabled_by_user',
      });
      toast(e.target.checked ? '已开启自动作答：面试官问完后将自动生成回答' : '已关闭自动作答');
    } catch (error) {
      e.target.checked = !!state.settings.autoAnswer;
      toast('保存自动作答设置失败：' + error.message, true);
    }
  };

  // 全局热键
  window.api.onHotkeyGenerate(() => triggerGenerate());

  // 生成事件流
  window.api.onAnswerTiming(({ reqId, stage, elapsedMs }) => {
    if (reqId !== state.reqId || stage !== 'first-content') return;
    console.info(JSON.stringify({ event: 'answer_first_content', reqId, elapsedMs }));
  });
  window.api.onAnswerStart(({ reqId, model, primary }) => {
    if (reqId !== state.reqId) return;
    logSession('answer_start', { reqId, model, primary });
    $('answer').textContent = '';
    updateCounter('');
    if (model && primary && model !== primary) {
      toast(`${primary} 暂不可用，已切换至 ${model} 作答`);
    }
  });
  // 识别到的问题：回填到「Current Question」框供查看/编辑
  window.api.onAnswerQuestion(({ reqId, question }) => {
    if (reqId !== state.reqId || !question) return;
    logSession('answer_question', { reqId, question });
    const box = $('questionBox');
    box.value = question; // 程序化赋值不会触发 input 事件
    state.autoQuestion = question;
  });
  window.api.onAnswerChunk(({ reqId, delta }) => {
    if (reqId !== state.reqId) return;
    const ans = $('answer');
    ans.textContent += delta;
    updateCounter(ans.textContent);
    ans.scrollTop = ans.scrollHeight;
  });
  window.api.onAnswerDone(({ reqId, aborted, warning }) => {
    if (reqId !== state.reqId) return;
    if (aborted) logSession('auto_decision', { reason: 'answer_aborted', reqId });
    endGenerate();
    if (!aborted && typeof warning === 'string' && warning) toast(warning, true);
  });
  window.api.onAnswerError(({ reqId, message }) => {
    if (reqId && reqId !== state.reqId) return;
    endGenerate();
    toast(message, true);
  });
}

// ---------------- 启动 ----------------
async function init() {
  try {
    state.settings = await window.api.getSettings();
  } catch (e) {
    showEmptyState();
    setStatus('设置读取失败', 'error');
    toast('无法读取设置：' + e.message, true);
    return;
  }
  renderHotkeyHint(state.settings.hotkey || 'Control+A');
  $('autoAnswer').checked = !!state.settings.autoAnswer;
  $('langSelect').value = state.settings.sttLanguage || 'zh';
  showEmptyState();
  updateCounter('');
  bindEvents();
  await listInputDevices();
  try {
    await refreshDocs();
  } catch (e) {
    toast('读取知识库失败：' + e.message, true);
  }
  try {
    await refreshProjects();
  } catch (e) {
    toast('读取项目知识库失败：' + e.message, true);
  }
  const needsSttKey = state.settings.sttProvider === 'deepgram' && !state.settings.deepgramApiKey;
  if (needsSttKey || !providerConfigured(state.settings)) {
    setStatus('请完成首次配置');
    openSetup();
  } else if (!state.settings.onboardingComplete) {
    // 升级用户已有可用配置：不强制重新输入密钥，但首次进入仍进行部署自检。
    runSelfCheck();
  }
}

window.addEventListener('DOMContentLoaded', init);
