// RP-Hub「分段合成失败隔离」验证（无第三方依赖）
// 运行：node tests/tts-segment-retry.test.mjs
//
// 验证的性质（对应 docs/tts-segment-retry.md）：
//   1. 单段失败不再连坐：同一批里其它段的请求照常完成，已花掉的音频不丢。
//   2. 段内重试：可重试的失败（5xx / 超时 / 空音频）按 400ms、800ms 退避重试同一段。
//   3. 不可重试的失败（401 鉴权 / 402 余额 / 内容审核）只发一次，直接跳过。
//   4. 跳过而非整体失败：只要有段落成，就按可播内容继续读，缺口报成 ttsState.skipped + toast。
//   5. 只重跑 miss 的段：第二次点击同一条气泡时，命中段级缓存的段完全不发请求。
//   6. 全段失败仍然整条报错（这是真失败，不该伪装成「跳过」）。
//
// 打桩方式与 tests/tts-progress-player.test.mjs 一致：<audio>、objectURL、rAF、fetch 全换假实现，
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

// 失败注入点：按「段文本」给出要返回的错误状态码队列。队列空了就成功。
const failPlan = new Map();
const fetchedBodies = [];

const takeFailure = (text) => {
  const queue = failPlan.get(text);
  if (!queue || !queue.length) return 0;
  return queue.shift();
};

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  fetchedBodies.push(body);
  // assistant 消息承载待合成文本，用它定位「这是第几段」。
  const text = body.messages[1].content;
  const status = takeFailure(text);
  if (status) {
    return { ok: false, status, text: async () => '{}' };
  }
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

const waitFor = async (predicate, message, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  throw new Error(`等待超时：${message}`);
};

// 一条必然被切成多段的气泡。段数由被测切分器现算，不写死实现细节。
const LONG_TEXT = `${'甲'.repeat(700)}\n\n${'乙'.repeat(700)}`;
const SEGMENT_TEXTS = TTS.splitForPresetSpeech(TTS.stripForSpeech(LONG_TEXT));
const EXPECTED_SEGMENTS = SEGMENT_TEXTS.length;

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

const requestsFor = (text) => fetchedBodies.filter(body => body.messages[1].content === text).length;

const reset = () => {
  failPlan.clear();
  fetchedBodies.length = 0;
  createdAudios.length = 0;
};

// ────────────────────────────── 纯函数契约 ──────────────────────────────

test('[契约] 段级缓存键：段序号与段文本都进键，改动任一项都必须 miss', () => {
  const a = TTS.segmentKeyOf('bubble', 0, '第一段');
  assert.equal(a, TTS.segmentKeyOf('bubble', 0, '第一段'), '同样输入必须稳定');
  assert.notEqual(a, TTS.segmentKeyOf('bubble', 1, '第一段'), '段序号变了必须换键');
  assert.notEqual(a, TTS.segmentKeyOf('bubble', 0, '第二段'), '段文本变了必须换键');
  assert.notEqual(a, TTS.segmentKeyOf('bubble2', 0, '第一段'), '气泡变了必须换键');
  assert.equal(typeof a, 'string');
});

test('[契约] 可重试判定：限流/5xx/超时/空音频重试，鉴权/余额/审核不重试', () => {
  const mk = (message, name) => Object.assign(new Error(message), name ? { name } : {});
  // 值得再试一次
  assert.equal(TTS.isRetryableSpeechError(mk('语音合成请求过于频繁（限流 100 RPM / 10M TPM），请稍后重试')), true);
  assert.equal(TTS.isRetryableSpeechError(mk('语音合成接口返回 500')), true);
  assert.equal(TTS.isRetryableSpeechError(mk('语音合成接口返回 503')), true);
  assert.equal(TTS.isRetryableSpeechError(mk('语音合成超时，请稍后重试', 'TimeoutError')), true);
  assert.equal(TTS.isRetryableSpeechError(mk('语音合成接口未返回音频数据')), true);
  assert.equal(TTS.isRetryableSpeechError(mk('Failed to fetch')), true);
  // 再试也不会变好
  assert.equal(TTS.isRetryableSpeechError(mk('语音合成鉴权失败，请检查 MiMo 语音合成密钥')), false);
  assert.equal(TTS.isRetryableSpeechError(mk('语音合成账户余额或额度不足')), false);
  assert.equal(TTS.isRetryableSpeechError(mk('合成文本被内容审核拦截，请调整文本后重试')), false);
  assert.equal(TTS.isRetryableSpeechError(mk('语音合成请求格式错误（400）：请检查合成模型名')), false);
  // 中止永远不重试
  assert.equal(TTS.isRetryableSpeechError(mk('已取消朗读', 'AbortError')), false);
  assert.equal(TTS.isRetryableSpeechError(null), false);
});

test('[契约] 退避等待可以被 abort 打断，不会在后台空转', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = TTS.waitForRetry(5000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
  assert.ok(Date.now() - started < 1000, 'abort 后应立即结束等待');
});

// ────────────────────────────── 集成：失败隔离 ──────────────────────────────

test('[集成] 单段 5xx 两次后恢复：按段重试，整条照常读完，不报跳过', async () => {
  reset();
  assert.ok(EXPECTED_SEGMENTS >= 3, `夹具必须切成多段，实测 ${EXPECTED_SEGMENTS} 段`);
  const target = SEGMENT_TEXTS[1];
  failPlan.set(target, [500, 500]);
  const { service, toasts } = buildService();

  const running = service.speakMessage(0);
  await waitFor(() => service.ttsState.duration > 0, '总时长就绪');

  // 该段共尝试 3 次（失败 2 次 + 成功 1 次），其它段各 1 次。
  assert.equal(requestsFor(target), 3, '失败段应被重试到成功为止');
  assert.equal(fetchedBodies.length, EXPECTED_SEGMENTS + 2, '重试只应多发失败段的请求');
  const total = service.ttsState.duration;
  assert.ok(Math.abs(total - SEGMENT_SECONDS * EXPECTED_SEGMENTS) < 1e-6,
    `全部段都应播放：期望 ${SEGMENT_SECONDS * EXPECTED_SEGMENTS}，实测 ${total}`);
  assert.ok(!toasts.some(item => /已跳过/.test(item.text)), '没有段被跳过的场合不应提示跳过');

  service.stopSpeaking();
  await running.catch(() => { });
});

test('[集成] 单段永久失败：跳过这一段，其余段照读，并报出缺口', async () => {
  reset();
  const target = SEGMENT_TEXTS[1];
  failPlan.set(target, [500, 500, 500]);
  const { service, toasts } = buildService();

  const running = service.speakMessage(0);
  await waitFor(() => toasts.some(item => /已跳过/.test(item.text)), '应提示跳过', 12000);

  // 其余段全部完成，只有目标段的音频缺口。
  assert.equal(service.ttsState.total, EXPECTED_SEGMENTS, '段总数不应因跳过而缩水');
  assert.equal(requestsFor(target), 3, '重试 3 次后放弃');
  const skipToast = toasts.find(item => /已跳过/.test(item.text));
  assert.ok(skipToast, '应有跳过提示');
  assert.equal(skipToast.type, 'warning', '跳过属于警告，不是错误');

  await waitFor(() => service.ttsState.activeKey === '', '播完应复位', 12000);
  // 播放过的音频数 = 总段数 - 跳过段数（null 段被播放循环跳过）。
  assert.equal(createdAudios.length, EXPECTED_SEGMENTS - 1, '应少播放一段');
  assert.equal(service.ttsState.status, 'idle', '部分失败不应把整条气泡判成错误');
  await running.catch(() => { });
});

test('[集成] 不可重试的 401：只发一次请求，直接跳过该段', async () => {
  reset();
  const target = SEGMENT_TEXTS[0];
  failPlan.set(target, [401]);
  const { service, toasts } = buildService();

  const running = service.speakMessage(0);
  await waitFor(() => toasts.some(item => /已跳过/.test(item.text)), '应提示跳过', 12000);

  assert.equal(requestsFor(target), 1, '鉴权失败重试也不会变好，只能发一次');
  await waitFor(() => service.ttsState.activeKey === '', '播完应复位', 12000);
  await running.catch(() => { });
});

test('[集成] 再次点击：命中段级缓存的段完全不发请求，只重跑 miss 的段', async () => {
  reset();
  const target = SEGMENT_TEXTS[1];
  const others = SEGMENT_TEXTS.filter(text => text !== target);
  // 第一次点：3 次尝试全失败，这一段被跳过。
  failPlan.set(target, [500, 500, 500]);
  const { service, toasts } = buildService();

  const first = service.speakMessage(0);
  await waitFor(() => service.ttsState.activeKey === '', '第一条播完复位', 15000);
  await first.catch(() => { });
  assert.ok(toasts.some(item => /已跳过/.test(item.text)), '第一次应有跳过提示');

  const firstRun = fetchedBodies.length;
  assert.equal(firstRun, EXPECTED_SEGMENTS + 2, `首轮请求数 = 段数 + 失败段重试 2 次，实测 ${firstRun}`);
  assert.equal(requestsFor(target), 3);

  // 第二次点：同一条气泡。段级缓存应在，只有那段要重新合成。
  fetchedBodies.length = 0;
  createdAudios.length = 0;
  const second = service.speakMessage(0);
  // 段总数要在播放期间取样：播完 resetTtsState() 会把 total 归零。
  await waitFor(() => service.ttsState.duration > 0, '第二条总时长就绪', 15000);
  assert.equal(service.ttsState.total, EXPECTED_SEGMENTS, '补齐后段总数应为满');
  await waitFor(() => service.ttsState.activeKey === '', '第二条播完复位', 15000);
  await second.catch(() => { });

  assert.equal(fetchedBodies.length, 1, `只应重跑失败的那一段，实测发了 ${fetchedBodies.length} 次请求`);
  assert.equal(requestsFor(target), 1, '重跑的必须是之前失败的那段');
  for (const text of others) {
    assert.equal(requestsFor(text), 0, '已成功的段不应再发请求');
  }
  // 这一次全部段落都有音频，播放数应为满。
  assert.equal(createdAudios.length, EXPECTED_SEGMENTS, '补齐后应完整播放');
});

test('[集成] 全段失败：整条气泡报错，不伪装成「跳过」', async () => {
  reset();
  for (const text of SEGMENT_TEXTS) failPlan.set(text, [500, 500, 500]);
  const { service } = buildService();

  await service.speakMessage(0);
  assert.equal(service.ttsState.status, 'error', '一段都没合成出来就是真失败');
  assert.ok(/500|语音合成/.test(service.ttsState.error || ''), `错误信息应保留原始失败：${service.ttsState.error}`);
});

test('[集成] 段级缓存不串味：换一条正文后旧段落必须重新合成', async () => {
  reset();
  const { service, messages } = buildService();
  const first = service.speakMessage(0);
  await waitFor(() => service.ttsState.activeKey === '', '第一条播完复位', 15000);
  await first.catch(() => { });

  fetchedBodies.length = 0;
  // 只改第 1 段文本的开头，其余段落保持原样也无所谓：缓存键按气泡区分，必须整片 miss。
  messages[0].content = `【改】${messages[0].content}`;
  const second = service.speakMessage(0);
  await waitFor(() => service.ttsState.activeKey === '', '第二条播完复位', 15000);
  await second.catch(() => { });

  assert.ok(fetchedBodies.length > 0, '换了正文必须重新合成，不能命中旧段级缓存');
});

// ────────────────────────────── 执行 ──────────────────────────────

const runAll = async () => {
  console.log('='.repeat(80));
  console.log('RP-Hub 分段合成失败隔离 · 验证（段内重试 / 跳过 / 只重跑 miss 的段）');
  console.log(`被测文件 : ${SOURCE_PATH}`);
  console.log(`段数     : ${EXPECTED_SEGMENTS}（由 splitForPresetSpeech 现算）`);
  console.log(`重试策略 : ${TTS.SEGMENT_RETRY_ATTEMPTS} 次，退避基数 ${TTS.SEGMENT_RETRY_BASE_DELAY_MS}ms`);
  console.log('='.repeat(80));
  for (const item of cases) {
    try {
      await item.fn();
      passed++;
      console.log(`PASS  ${item.name}`);
    } catch (error) {
      failures.push({ name: item.name, error });
      console.log(`FAIL  ${item.name}`);
      console.log(`      ${String(error && error.message).replace(/\n/g, '\n      ')}`);
    }
  }
  console.log('-'.repeat(80));
  console.log(`合计 ${cases.length} 例：PASS ${passed}，FAIL ${failures.length}`);
  if (failures.length) {
    for (const item of failures) console.log(`  - ${item.name}`);
    process.exitCode = 1;
  } else {
    console.log('结论：单段失败不再连坐整条气泡，重试只花在失败段上，重播只重跑 miss 的段。退出码 0');
  }
};

runAll();
