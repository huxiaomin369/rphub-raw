// RP-Hub「流式播放」验证（无第三方依赖）
// 运行：node tests/tts-streaming-playback.test.mjs
//
// 验证的性质（对应 docs/tts-streaming-playback.md）：
//   1. 第 0 段一就绪就出声，不等整条气泡全部合成完 —— 首字延迟只取决于第一段。
//   2. 出声那一刻时间轴还没成形：duration=0、seekable=false，拖动被拒绝。
//   3. 全段就绪后时间轴一次性拼好并解锁拖动（duration = 各段时长之和）。
//   4. 合成中途停止不会把播放循环挂在门闩上（drainSegmentGates 生效，无未捕获 rejection）。
//   5. 整条气泡缓存命中时时间轴当场就绪，不必再等任何合成。
//
// 打桩方式与 tests/tts-segment-retry.test.mjs 一致：<audio>、objectURL、rAF、fetch 全换假实现，
// 然后真跑一遍 useSpeechSynthesis 的完整链路。只读 assets/，不修改任何被测文件。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(HERE, '..', 'assets', 'js', 'tts-service.js');

// ────────────────────────────── 假环境 ──────────────────────────────

const SEGMENT_SECONDS = 0.2;
const BYTE_RATE = 24000 * 2;
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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// 诊断开关：DIAG=1 时打印每次请求与每次起播的相对时间，用来确认延迟注入是否真的命中。
const T0 = Date.now();
const diag = (...args) => { if (process.env.DIAG) console.log(`[diag +${Date.now() - T0}ms]`, ...args); };

// 每个用例都换一个 service 实例；FakeAudio 通过 current 采样当时的 ttsState。
let current = null;
const playSamples = [];
const createdAudios = [];
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
    setTimeout(() => {
      this.readyState = 1;
      if (typeof this.onloadedmetadata === 'function') this.onloadedmetadata();
    }, 0);
  }

  play() {
    if (this.paused) {
      this.paused = false;
      this.ended = false;
      // 采样「真正开始出声」这一刻的进度条状态：流式阶段应该是 duration=0、不可拖。
      playSamples.push({
        at: Date.now(),
        settledCount: settleStamps.size,
        duration: current ? current.service.ttsState.duration : -1,
        seekable: current ? current.service.ttsState.seekable : null,
        status: current ? current.service.ttsState.status : ''
      });
      diag(`play 起播，已合成 ${settleStamps.size}/${EXPECTED_SEGMENTS}`);
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
globalThis.URL.createObjectURL = () => `blob:fake/${++urlSeq}`;
globalThis.URL.revokeObjectURL = () => { };

// 每段请求的模拟耗时：默认 0。键是「第几个发出的请求」（0 起），
// 不用段文本做键 —— 请求正文会经过 applyStyleTag / 空白裁剪，
// 与切分结果只要差一个字符，延迟就会静默失效，测试变成假绿。
const delayByIndex = new Map();
const settleStamps = new Map();
const fetchedBodies = [];

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  fetchedBodies.push(body);
  const nth = fetchedBodies.length - 1;
  const delay = delayByIndex.get(nth) || 0;
  diag(`fetch #${nth} 收到一段，delay=${delay}`);
  if (delay) await sleep(delay);
  settleStamps.set(nth, Date.now());
  diag(`fetch #${nth} 返回，累计已合成 ${settleStamps.size}`);
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { audio: { data: WAV_BASE64, format: 'wav' } } }]
    })
  };
};

// 未捕获 rejection 是要命的：门闩没开、或 drain 漏了，都会在这里冒出来。
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

new Function(fs.readFileSync(SOURCE_PATH, 'utf8'))();
const TTS = globalThis.window.RPHubTts;
assert.ok(TTS, 'window.RPHubTts 不可用');

// ────────────────────────────── 迷你测试运行器 ──────────────────────────────

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const failures = [];
let passed = 0;

const waitFor = async (predicate, message, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  throw new Error(`等待超时：${message}`);
};

const LONG_TEXT = `${'甲'.repeat(700)}\n\n${'乙'.repeat(700)}`;
const SEGMENT_TEXTS = TTS.splitForPresetSpeech(TTS.stripForSpeech(LONG_TEXT));
const EXPECTED_SEGMENTS = SEGMENT_TEXTS.length;

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
  const messages = [{ id: 'm1', role: 'assistant', name: '角色', content: LONG_TEXT }];
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
  const instance = { service, messages, toasts };
  current = instance;
  return instance;
};

const reset = () => {
  delayByIndex.clear();
  settleStamps.clear();
  fetchedBodies.length = 0;
  playSamples.length = 0;
  createdAudios.length = 0;
};

const lastSettleAt = () => Math.max(...[...settleStamps.values()]);

// ────────────────────────────── 契约 ──────────────────────────────

test('[契约] 段级门闩：只认第一次 settle，重复 settle 不覆盖', async () => {
  assert.equal(typeof TTS.createSegmentGate, 'function', 'createSegmentGate 必须导出');
  const gate = TTS.createSegmentGate();
  assert.equal(gate.settled, false);

  let observed = null;
  gate.promise.then(value => { observed = value; });
  gate.settle({ blob: 'first', seconds: 1 });
  await gate.promise;
  assert.deepEqual(observed, { blob: 'first', seconds: 1 });
  assert.equal(gate.settled, true);

  // 第二次 settle 必须被忽略：否则失败的段可能被后来的结果"复活"。
  gate.settle({ blob: 'second', seconds: 2 });
  assert.deepEqual(gate.value, { blob: 'first', seconds: 1 });

  // null 也照样开门 —— 跳过的段不能把播放循环卡死。
  const skipped = TTS.createSegmentGate();
  skipped.settle(null);
  await skipped.promise;
  assert.equal(skipped.settled, true);
  assert.equal(skipped.value, null);
});

// ────────────────────────────── 流式主链路 ──────────────────────────────

test('第 0 段就绪即出声：不等最后一段合成完', async () => {
  reset();
  assert.ok(EXPECTED_SEGMENTS >= 3, `需要至少 3 段才能验证流式，实际 ${EXPECTED_SEGMENTS}`);
  // 让第 2、3、4 个发出的请求变慢：第 1 个（段 0）必须立刻返回，后面的段还在路上。
  delayByIndex.set(1, 300);
  delayByIndex.set(2, 500);
  delayByIndex.set(3, 700);

  const { service } = buildService();
  service.toggleSpeakMessage(0);

  await waitFor(() => playSamples.length > 0, '应该已经有一段的音频开始播', 5000);
  const first = playSamples[0];

  // 出声时还有段没合成完：这是"不再等全段"的本质证据，不依赖时间戳精度。
  assert.ok(first.settledCount < EXPECTED_SEGMENTS,
    `首段出声时只有 ${first.settledCount}/${EXPECTED_SEGMENTS} 段合成完，说明仍在等全段`);

  // 出声那一刻时间轴必须还没成形。
  assert.equal(first.duration, 0, '流式阶段 duration 应为 0（还没拼时间轴）');
  assert.equal(first.seekable, false, '流式阶段不能拖动');
  assert.equal(first.status, 'playing', '出声时状态应已切到 playing');

  // 等全段落地再比时间：首段出声必须早于「最后一段合成完成」。
  await waitFor(() => settleStamps.size >= EXPECTED_SEGMENTS, '所有段都应完成合成', 12000);
  assert.ok(first.at < lastSettleAt(),
    `首段出声（${first.at}）应早于最后一段合成完成（${lastSettleAt()}）`);

  await waitFor(() => service.ttsState.activeKey === '', '播完应复位', 12000);
  await waitFor(() => unhandled.length === 0, '不应有未捕获 rejection', 1000);
});

test('流式阶段拖动被拒绝，全段就绪后时间轴一次性解锁', async () => {
  reset();
  delayByIndex.set(0, 0);
  delayByIndex.set(1, 400);
  delayByIndex.set(2, 600);
  delayByIndex.set(3, 800);

  const { service } = buildService();
  service.toggleSpeakMessage(0);

  await waitFor(() => playSamples.length > 0, '首段应已开播', 5000);
  // 此刻时间轴还没解锁：拖动必须原样失败，不能把播放位置改到一个还不存在的段上。
  assert.equal(service.ttsState.seekable, false);
  assert.equal(service.seekSpeaking(0.5), false, '未解锁时 seekSpeaking 应返回 false');

  // 全段就绪 → 时长 = 段数 × 每段秒数。
  await waitFor(() => service.ttsState.seekable === true, '全段就绪后应解锁拖动', 12000);
  const expected = EXPECTED_SEGMENTS * SEGMENT_SECONDS;
  assert.ok(Math.abs(service.ttsState.duration - expected) < 0.05,
    `总时长应约为 ${expected}，实际 ${service.ttsState.duration}`);
  assert.equal(service.ttsState.seekable, true);

  await waitFor(() => service.ttsState.activeKey === '', '播完应复位', 12000);
});

test('合成中途停止：门闩被 drain，播放循环退出且无未捕获 rejection', async () => {
  reset();
  // 全部压慢，保证停止时播放循环还挂在 `await gate.promise` 上。
  for (let i = 0; i < EXPECTED_SEGMENTS; i++) delayByIndex.set(i, 400);

  const { service } = buildService();
  service.toggleSpeakMessage(0);
  await sleep(80);
  assert.equal(service.ttsState.activeKey, 'm1', '应该已经进入朗读态');
  assert.equal(playSamples.length, 0, '此时还没有任何一段就绪');

  service.toggleSpeakMessage(0);
  assert.equal(service.ttsState.activeKey, '', '停止后应立刻复位');
  // 再等一会：如果门闩没被 drain，播放循环会一直挂着，后续状态或 rejection 会冒出来。
  await sleep(600);
  assert.equal(service.ttsState.activeKey, '', '停止后不应被残余协程改回朗读态');
  assert.equal(unhandled.length, 0, `停止后不应有未捕获 rejection，实际 ${unhandled.length}`);
});

test('整条缓存命中：时间轴当场就绪，不再等任何合成', async () => {
  reset();
  const { service } = buildService();
  service.toggleSpeakMessage(0);
  await waitFor(() => service.ttsState.activeKey === '', '第一遍应播完', 12000);
  const requestsAfterFirst = fetchedBodies.length;

  // 第二遍：整条气泡缓存命中，应该一个请求都不发、时间轴立刻可用。
  service.toggleSpeakMessage(0);
  const startedAt = Date.now();
  await waitFor(() => service.ttsState.duration > 0, '缓存命中后时长应立即可用', 3000);
  assert.equal(fetchedBodies.length, requestsAfterFirst, '缓存命中不应再发合成请求');
  assert.equal(service.ttsState.fromCache, true);
  assert.ok(Math.abs(service.ttsState.duration - EXPECTED_SEGMENTS * SEGMENT_SECONDS) < 0.05,
    `缓存命中总时长应完整，实际 ${service.ttsState.duration}`);
  assert.ok(Date.now() - startedAt < 1000, '缓存命中不应有可感知的等待');
  await waitFor(() => service.ttsState.activeKey === '', '第二遍应播完', 12000);
});

// ────────────────────────────── 执行 ──────────────────────────────

for (const item of cases) {
  try {
    await item.fn();
    passed += 1;
    console.log(`PASS  ${item.name}`);
  } catch (error) {
    failures.push({ name: item.name, error });
    console.error(`FAIL  ${item.name}`);
    console.error(`      ${error?.message}`);
    if (error?.stack) console.error(error.stack.split('\n').slice(1, 6).join('\n'));
  }
}

if (unhandled.length) {
  failures.push({ name: '[全局] 未捕获 rejection', error: new Error(String(unhandled[0]?.stack || unhandled[0])) });
  console.error('FAIL  存在未捕获的 promise rejection');
}

console.log(`\n合计 ${cases.length} 个用例：PASS ${passed}，FAIL ${failures.length}`);
if (failures.length) {
  console.error(`\n失败清单：`);
  for (const failure of failures) console.error(` - ${failure.name}: ${failure.error?.message}`);
  process.exit(1);
}
console.log('全部通过');
