// RP-Hub「气泡朗读进度条」纯函数独立验证
// 无第三方依赖。运行：node tests/tts-progress.test.mjs
//
// 打桩方式与 tests/tts-preset.test.mjs 一致：
//   globalThis.window = {}   →  assets/js/tts-service.js 是 IIFE，执行后把 API 挂到 window.RPHubTts
//   globalThis.Vue = { reactive: v => v, ref: v => ({ value: v }) }
// 只读，不修改 assets/ 下任何内容。
//
// 被验证的对象只有三个纯函数，它们撑起整条进度条：
//   parseWavDuration(bytes)              → 一段音频多少秒（直接读 WAV 头，不依赖媒体解码）
//   buildSpeechTimeline(durations)       → [时长…] → { starts, durations, total }（逐段音频拼成一条时间轴）
//   locateTimelinePosition(timeline, s)  → 全局秒数 → { index, offset }（拖动进度条时的落点换算）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(HERE, '..', 'assets', 'js', 'tts-service.js');

// ────────────────────────────── 加载被测文件 ──────────────────────────────

const loadService = () => {
  if (!fs.existsSync(SOURCE_PATH)) throw new Error(`未找到被测文件：${SOURCE_PATH}`);
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  globalThis.window = {};
  globalThis.Vue = { reactive: v => v, ref: v => ({ value: v }) };
  new Function(source)(); // IIFE：执行后 window.RPHubTts 可用
  const api = globalThis.window.RPHubTts;
  if (!api) throw new Error('执行 tts-service.js 后 window.RPHubTts 仍不可用');
  return { api, source };
};

const loaded = loadService();
const TTS = loaded.api;
const SOURCE = loaded.source;

// ────────────────────────────── 迷你测试运行器 ──────────────────────────────

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const failures = [];
let passed = 0;

const fmt = (value) => {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
};

const same = (actual, expected, message) => {
  assert.deepEqual(actual, expected, `${message}\n  期望：${fmt(expected)}\n  实测：${fmt(actual)}`);
};

const close = (actual, expected, message, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) < epsilon,
    `${message}\n  期望：${expected}\n  实测：${actual}（允许误差 ${epsilon}）`);
};

const runAll = () => {
  console.log('='.repeat(80));
  console.log('RP-Hub 气泡朗读进度条 · 时间轴纯函数验证');
  console.log('='.repeat(80));

  for (const item of cases) {
    try {
      item.fn();
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
    console.log('失败清单：');
    for (const item of failures) console.log(`  - ${item.name}`);
    process.exitCode = 1;
  } else {
    console.log('结论：进度条时间轴链路自洽，退出码 0');
  }
};

// ────────────────────────────── 用例：导出面 ──────────────────────────────

test('[契约] 导出面：进度条所需的 3 个纯函数已挂到 window.RPHubTts', () => {
  for (const name of ['parseWavDuration', 'buildSpeechTimeline', 'locateTimelinePosition']) {
    assert.equal(typeof TTS[name], 'function', `window.RPHubTts.${name} 缺失`);
  }
});

// ────────────────────────────── 用例：WAV 时长 ──────────────────────────────

// 24kHz / 16bit / 单声道 → byteRate = 48000，所以 N 秒就是 48000 * N 字节 PCM。
// 造一段「官方口径」的 WAV：与 buildWavBlob 的头部字段逐项一致，便于同步解析、不依赖 Blob 异步读取。
const makeWav = (seconds, asBuffer = false) => {
  const dataSize = Math.round(48000 * seconds);
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
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  return asBuffer ? bytes.buffer : bytes;
};

test('[契约] parseWavDuration：1.0 秒 PCM 回读为 1.0 秒', () => {
  // 先确认 buildWavBlob 确实按 44 字节头 + 裸 PCM 拼装，头部口径与 parseWavDuration 的假设一致。
  const blob = TTS.buildWavBlob(new Uint8Array(48000), 24000);
  assert.equal(blob.size, 44 + 48000, 'WAV 头必须是 44 字节');
  close(TTS.parseWavDuration(makeWav(1)), 1, '1.0 秒应解析为 1.0');
});

test('[契约] parseWavDuration：0.5 秒 / 2 秒都能按 byteRate 换算', () => {
  close(TTS.parseWavDuration(makeWav(0.5)), 0.5, '0.5 秒');
  close(TTS.parseWavDuration(makeWav(2)), 2, '2 秒');
});

test('[契约] parseWavDuration：非 WAV / 太短 / 空数组一律返回 0，不抛异常', () => {
  assert.equal(TTS.parseWavDuration(new Uint8Array(0)), 0, '空数组应为 0');
  assert.equal(TTS.parseWavDuration(new Uint8Array(10)), 0, '不足 44 字节应为 0');
  const junk = new Uint8Array(64).fill(7);
  assert.equal(TTS.parseWavDuration(junk), 0, '非 RIFF 头应为 0');
  assert.equal(TTS.parseWavDuration(null), 0, 'null 应为 0');
  assert.equal(TTS.parseWavDuration(undefined), 0, 'undefined 应为 0');
});

test('[契约] parseWavDuration：接受 ArrayBuffer 与 Uint8Array 两种入参', () => {
  close(TTS.parseWavDuration(makeWav(1)), 1, 'Uint8Array 入参');
  close(TTS.parseWavDuration(makeWav(1, true)), 1, 'ArrayBuffer 入参');
});

// ────────────────────────────── 用例：时间轴 ──────────────────────────────

test('[契约] buildSpeechTimeline：starts 是各段全局起点，total 是累加总时长', () => {
  const timeline = TTS.buildSpeechTimeline([1, 2, 3]);
  same(timeline.starts, [0, 1, 3], 'starts 错');
  same(timeline.durations, [1, 2, 3], 'durations 错');
  close(timeline.total, 6, 'total 错');
});

test('[契约] buildSpeechTimeline：非法时长归零，不污染后面的起点', () => {
  const timeline = TTS.buildSpeechTimeline([2, -1, 'x', null, 1.5, NaN]);
  same(timeline.durations, [2, 0, 0, 0, 1.5, 0], 'durations 归一化错');
  same(timeline.starts, [0, 2, 2, 2, 2, 3.5], 'starts 错');
  close(timeline.total, 3.5, 'total 错');
});

test('[契约] buildSpeechTimeline：空输入与非数组输入返回空轴（进度条据此隐藏）', () => {
  for (const input of [[], null, undefined, 'nope', 42]) {
    const timeline = TTS.buildSpeechTimeline(input);
    assert.equal(timeline.starts.length, 0, `${fmt(input)} 应得到空 starts`);
    assert.equal(timeline.total, 0, `${fmt(input)} 应得到 0 总时长`);
  }
});

// ────────────────────────────── 用例：拖动落点 ──────────────────────────────

const TL = TTS.buildSpeechTimeline([1, 2, 3]); // starts [0,1,3]，total 6

test('[契约] locateTimelinePosition：段内落点给出正确的段号与段内偏移', () => {
  same(TTS.locateTimelinePosition(TL, 0), { index: 0, offset: 0 }, '0 秒');
  same(TTS.locateTimelinePosition(TL, 0.5), { index: 0, offset: 0.5 }, '0.5 秒');
  same(TTS.locateTimelinePosition(TL, 2.5), { index: 1, offset: 1.5 }, '2.5 秒');
  same(TTS.locateTimelinePosition(TL, 4.25), { index: 2, offset: 1.25 }, '4.25 秒');
});

test('[契约] locateTimelinePosition：段边界归属下一段，段内偏移为 0', () => {
  same(TTS.locateTimelinePosition(TL, 1), { index: 1, offset: 0 }, '1 秒是第 2 段起点');
  same(TTS.locateTimelinePosition(TL, 3), { index: 2, offset: 0 }, '3 秒是第 3 段起点');
});

test('[契约] locateTimelinePosition：越界钳到两端，NaN 回落到开头', () => {
  same(TTS.locateTimelinePosition(TL, 99), { index: 2, offset: 3 }, '超长钳到末尾');
  same(TTS.locateTimelinePosition(TL, -5), { index: 0, offset: 0 }, '负数钳到开头');
  same(TTS.locateTimelinePosition(TL, NaN), { index: 0, offset: 0 }, 'NaN 落到开头');
  same(TTS.locateTimelinePosition(TL, undefined), { index: 0, offset: 0 }, 'undefined 落到开头');
});

test('[契约] locateTimelinePosition：零时长段不会被选中（拖动不会原地重启空段）', () => {
  const withEmpty = TTS.buildSpeechTimeline([0, 1]);
  same(TTS.locateTimelinePosition(withEmpty, 0), { index: 1, offset: 0 }, '0 秒应跳到有声音的第 2 段');
  same(TTS.locateTimelinePosition(withEmpty, 0.4), { index: 1, offset: 0.4 }, '段内落点');
});

test('[契约] locateTimelinePosition：空轴/无时长时返回安全值，不抛异常', () => {
  same(TTS.locateTimelinePosition(null, 3), { index: 0, offset: 0 }, 'null 轴');
  same(TTS.locateTimelinePosition(TTS.buildSpeechTimeline([]), 3), { index: 0, offset: 0 }, '空轴');
  // 全零时长轴 total = 0，进度条据此隐藏；此时任何落点都退回开头，不会算出一个越界段号。
  same(TTS.locateTimelinePosition(TTS.buildSpeechTimeline([0, 0]), 3), { index: 0, offset: 0 }, '全零时长轴');
});

// ────────────────────────────── 用例：实现接线（静态一致性） ──────────────────────────────

test('[契约] 播放链路：拖动走 pendingSeek，段内落点交给 playBlobFrom 的 offset', () => {
  assert.ok(/let pendingSeek = null;/.test(SOURCE), '缺少 pendingSeek 声明');
  assert.ok(/const seekSpeaking = \(seconds\) =>/.test(SOURCE), '缺少 seekSpeaking');
  assert.ok(/await playBlobFrom\(url, token, playOffset\);/.test(SOURCE), '播放循环没有把段内偏移传下去');
  assert.ok(/if \(pendingSeek\) \{/.test(SOURCE), '播放循环没有消费 pendingSeek');
});

test('[回归] 播放游标不能叫 index：speakMessage 的参数就是消息下标，同名声明会推进 TDZ', () => {
  // 历史故障：在 speakMessage 的 try 块里写 `let index = 0`，会遮蔽函数参数 index，
  // 导致前面的 buildSpeechPlan({ index }) 抛 "Cannot access 'index' before initialization"，整条朗读全挂。
  const start = SOURCE.indexOf('const speakMessage = async (index) => {');
  const end = SOURCE.indexOf('const toggleSpeakMessage = (index) => {');
  assert.ok(start > 0 && end > start, '定位不到 speakMessage 函数体');
  const body = SOURCE.slice(start, end);
  assert.ok(!/let index\s*=/.test(body), 'speakMessage 内不得再声明名为 index 的局部变量');
  assert.ok(/let playIndex = 0;/.test(body), '播放游标应使用 playIndex');
  assert.ok(/let playOffset = 0;/.test(body), '段内偏移应使用 playOffset');
});

test('[契约] 状态复位：停读时把时长/位置/暂停一起清掉，避免残留进度条', () => {
  const resetBlock = SOURCE.slice(SOURCE.indexOf('const resetTtsState = () => {'));
  const head = resetBlock.slice(0, resetBlock.indexOf('};'));
  for (const field of ['ttsState.duration = 0;', 'ttsState.currentTime = 0;', 'ttsState.paused = false;', 'ttsState.seekable = false;']) {
    assert.ok(head.includes(field), `resetTtsState 缺少 ${field}`);
  }
});

test('[契约] 进度上报：按帧回报，暂停/结束后停止排下一帧', () => {
  assert.ok(/const onTick = \(\) => \{/.test(SOURCE), '缺少 onTick');
  assert.ok(/if \(!audio\.paused && !audio\.ended\) scheduleTick\(\);/.test(SOURCE), 'onTick 没有在暂停/结束时停下');
  assert.ok(/audio\.onplay = \(\) => scheduleTick\(\);/.test(SOURCE), '起播没有开始回报进度');
});

runAll();
