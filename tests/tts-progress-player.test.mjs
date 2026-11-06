// RP-Hub「气泡朗读进度条」播放链路集成验证（无第三方依赖）
// 运行：node tests/tts-progress-player.test.mjs
//
// 这里不用真浏览器，而是把 <audio>、URL.createObjectURL、requestAnimationFrame、fetch 全换成
// 可控的假实现，然后真正跑一遍 useSpeechSynthesis 的完整链路：
//   合成（假 fetch 返回 wav） → 量时长 → 拼时间轴 → 逐段播放 → 拖动跳转 → 暂停/继续 → 播完复位
// 断言点就是用户在界面上能感知的东西：总时长、当前位置在推进、拖动落在正确的段与段内偏移、暂停后不推进。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(HERE, '..', 'assets', 'js', 'tts-service.js');

// ────────────────────────────── 假环境 ──────────────────────────────

const SEGMENT_SECONDS = 0.2;          // 每段音频的时长
const BYTE_RATE = 24000 * 2;          // 24kHz / 16bit / 单声道
const segmentBytes = Math.round(BYTE_RATE * SEGMENT_SECONDS);

const makeWavBytes = () => {
  const dataSize = segmentBytes;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, BYTE_RATE, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  return bytes;
};

const WAV_BASE64 = Buffer.from(makeWavBytes()).toString('base64');

const createdAudios = [];
const urlToBlob = new Map();
let urlSeq = 0;

class FakeAudio {
  constructor(url) {
    this.url = url;
    this.duration = SEGMENT_SECONDS;
    this.currentTime = 0;
    this.paused = true;
    this.ended = false;
    this.readyState = 0;
    this.playbackRate = 1;
    this.onloadedmetadata = null;
    this.onplay = null;
    this.onended = null;
    this.onerror = null;
    this._timer = null;
    createdAudios.push(this);
    // 真实 <audio> 的元数据是异步到位的，这里用 setTimeout(0) 复现同样的时序。
    setTimeout(() => {
      this.readyState = 1;
      if (typeof this.onloadedmetadata === 'function') this.onloadedmetadata();
    }, 0);
  }

  play() {
    if (this.paused) {
      this.paused = false;
      this.ended = false;
      if (typeof this.onplay === 'function') this.onplay();
      this._startClock();
    }
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this._stopClock();
  }

  _stopClock() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _startClock() {
    this._stopClock();
    this._timer = setInterval(() => {
      if (this.paused) return;
      this.currentTime = Math.min(this.duration, this.currentTime + 0.02);
      if (this.currentTime >= this.duration) {
        this.ended = true;
        this.paused = true;
        this._stopClock();
        if (typeof this.onended === 'function') this.onended();
      }
    }, 10);
  }

  removeAttribute() {
    this.paused = true;
    this._stopClock();
  }

  load() { }
}

globalThis.window = {};
globalThis.Vue = { reactive: v => v, ref: v => ({ value: v }) };
globalThis.Audio = FakeAudio;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.URL.createObjectURL = (blob) => {
  const url = `blob:fake/${++urlSeq}`;
  urlToBlob.set(url, blob);
  return url;
};
globalThis.URL.revokeObjectURL = (url) => { urlToBlob.delete(url); };

const fetchedBodies = [];
globalThis.fetch = async (url, init) => {
  fetchedBodies.push(JSON.parse(init.body));
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { audio: { data: WAV_BASE64, format: 'wav' } } }]
    })
  };
};

new Function(fs.readFileSync(SOURCE_PATH, 'utf8'))();
const TTS = globalThis.window.RPHubTts;
assert.ok(TTS, 'window.RPHubTts 不可用');

// ────────────────────────────── 迷你测试运行器 ──────────────────────────────

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const failures = [];
let passed = 0;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const waitFor = async (predicate, message, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  throw new Error(`等待超时：${message}`);
};

// 一条足够长、必然被切成多块的气泡：预置音色模式按 600 字上限切块，
// 这里用 1400 字（无句号，走硬切）确保至少 3 块，段落数由同一个切分器现算，避免测试写死实现细节。
const LONG_TEXT = `${'甲'.repeat(700)}\n\n${'乙'.repeat(700)}`;
const EXPECTED_SEGMENTS = TTS.splitForPresetSpeech(TTS.stripForSpeech(LONG_TEXT)).length;

const buildMessages = () => ([
  { id: 'm1', role: 'assistant', name: '角色', content: LONG_TEXT }
]);

const buildSettings = () => ({
  ttsEnabled: true,
  ttsMode: 'preset',
  ttsApiUrl: 'https://api.example.com/v1',
  ttsApiKey: 'test-key',
  ttsPresetModel: 'mimo-v2.5-tts',
  ttsVoice: 'mimo_default',
  ttsPresetStyle: '',
  ttsPresetInstruction: '',
  ttsPresetStream: false,
  ttsModel: 'mimo-v2.5-tts-voicedesign',
  ttsDesignModel: '',
  ttsDesignApiUrl: '',
  ttsDesignApiKey: '',
  ttsContextRange: 0,
  ttsCustomInstruction: '',
  ttsPlaybackRate: 1,
  ttsCacheEnabled: true,
  model: 'test-model',
  apiUrl: 'https://api.example.com/v1',
  apiKey: 'test-key'
});

const buildService = () => {
  const messages = buildMessages();
  const toasts = [];
  const service = TTS.useSpeechSynthesis({
    settings: buildSettings(),
    showToast: (text, type) => toasts.push({ text, type }),
    requestChatCompletion: () => { throw new Error('预置音色模式不应调用 LLM'); },
    buildApiEndpoint: (base, endpoint) => `${String(base).replace(/\/+$/, '')}/${endpoint}`,
    getChatHistory: () => messages,
    getCurrentCharacter: () => ({ name: '角色' }),
    getUser: () => ({ name: '用户' }),
    resolveMessageText: content => content
  });
  return { service, messages, toasts };
};

// ────────────────────────────── 用例 ──────────────────────────────

test('[集成] 合成后总时长 = 各段时长之和，进度条有刻度', async () => {
  createdAudios.length = 0;
  assert.ok(EXPECTED_SEGMENTS >= 3, `夹具必须切成多段，实测 ${EXPECTED_SEGMENTS} 段`);
  const { service } = buildService();
  const running = service.speakMessage(0);
  await waitFor(() => service.ttsState.duration > 0, '总时长就绪');
  const total = service.ttsState.duration;
  const expected = SEGMENT_SECONDS * EXPECTED_SEGMENTS;
  assert.ok(Math.abs(total - expected) < 1e-6, `总时长应为 ${expected}，实测 ${total}`);
  assert.equal(service.ttsState.total, EXPECTED_SEGMENTS, '段数应等于切块数');
  assert.equal(service.ttsState.seekable, true, '有刻度即应可拖动');
  assert.equal(service.ttsState.status, 'playing', '应进入播放态');
  service.stopSpeaking();
  await running.catch(() => { });
});

test('[集成] 播放中当前位置持续推进，且不超过总时长', async () => {
  createdAudios.length = 0;
  const { service } = buildService();
  const running = service.speakMessage(0);
  await waitFor(() => service.ttsState.duration > 0, '总时长就绪');
  const first = service.ttsState.currentTime;
  await waitFor(() => service.ttsState.currentTime > first, '位置推进');
  assert.ok(service.ttsState.currentTime <= service.ttsState.duration + 1e-6,
    `位置 ${service.ttsState.currentTime} 不应超过总时长 ${service.ttsState.duration}`);
  service.stopSpeaking();
  await running.catch(() => { });
});

test('[集成] 拖动进度条：跳到正确的段与段内偏移，且不重新合成', async () => {
  createdAudios.length = 0;
  fetchedBodies.length = 0;
  const { service } = buildService();
  const running = service.speakMessage(0);
  await waitFor(() => service.ttsState.duration > 0, '总时长就绪');
  const requestsBefore = fetchedBodies.length;
  const audiosBefore = createdAudios.length;

  // 目标：第 2 段（全局 0.2s 起）再往后 0.05s → 全局 0.25s
  const accepted = service.seekSpeaking(0.25);
  assert.equal(accepted, true, 'seekSpeaking 应接受该落点');
  await waitFor(() => createdAudios.length > audiosBefore, '跳转后应新起一段音频');
  const current = createdAudios[createdAudios.length - 1];
  assert.ok(Math.abs(current.currentTime - 0.05) < 0.06,
    `第 2 段应从段内 0.05s 起播，实测 ${current.currentTime}`);
  await waitFor(() => service.ttsState.currentTime >= 0.24, '位置应落在拖动点附近');
  assert.equal(fetchedBodies.length, requestsBefore, '拖动不应重新请求合成');
  service.stopSpeaking();
  await running.catch(() => { });
});

test('[集成] 暂停后位置停住，继续后重新推进', async () => {
  createdAudios.length = 0;
  const { service } = buildService();
  const running = service.speakMessage(0);
  await waitFor(() => service.ttsState.currentTime > 0, '开始播放');

  service.togglePauseSpeaking();
  assert.equal(service.ttsState.paused, true, '应标记为已暂停');
  const frozen = service.ttsState.currentTime;
  await sleep(120);
  assert.equal(service.ttsState.currentTime, frozen, '暂停期间位置不应变化');

  service.togglePauseSpeaking();
  assert.equal(service.ttsState.paused, false, '应取消暂停');
  await waitFor(() => service.ttsState.currentTime > frozen, '继续后位置应推进');
  service.stopSpeaking();
  await running.catch(() => { });
});

test('[集成] 播完自动复位：清掉时长与位置，进度条随之消失', async () => {
  createdAudios.length = 0;
  const { service } = buildService();
  await service.speakMessage(0);
  assert.equal(service.ttsState.activeKey, '', '播完应清掉 activeKey');
  assert.equal(service.ttsState.duration, 0, '播完应清掉总时长');
  assert.equal(service.ttsState.currentTime, 0, '播完应清掉位置');
  assert.equal(service.ttsState.seekable, false, '播完应关闭可拖动');
  assert.equal(service.ttsState.paused, false, '播完不应残留暂停态');
});

test('[集成] 停止朗读：立刻复位，且不再有进度上报', async () => {
  createdAudios.length = 0;
  const { service } = buildService();
  const running = service.speakMessage(0);
  await waitFor(() => service.ttsState.currentTime > 0, '开始播放');
  service.stopSpeaking();
  await running.catch(() => { });
  assert.equal(service.ttsState.activeKey, '');
  assert.equal(service.ttsState.duration, 0);
  const after = service.ttsState.currentTime;
  await sleep(120);
  assert.equal(service.ttsState.currentTime, after, '停止后不应继续上报位置');
});

// ────────────────────────────── 执行 ──────────────────────────────

const runAll = async () => {
  console.log('='.repeat(80));
  console.log('RP-Hub 气泡朗读进度条 · 播放链路集成验证');
  console.log('='.repeat(80));
  for (const item of cases) {
    try {
      await item.fn();
      passed++;
      console.log(`PASS  ${item.name}`);
    } catch (error) {
      failures.push({ name: item.name, error });
      console.log(`FAIL  ${item.name}`);
      console.log(`      ${String(error.message).replace(/\n/g, '\n      ')}`);
    }
  }
  console.log('-'.repeat(80));
  console.log(`合计 ${cases.length} 例：PASS ${passed}，FAIL ${failures.length}`);
  if (failures.length) {
    for (const item of failures) console.log(`  - ${item.name}`);
    process.exitCode = 1;
  } else {
    console.log('结论：进度条播放链路（测量 → 播放 → 拖动 → 暂停 → 复位）全部符合预期，退出码 0');
  }
};

runAll();
