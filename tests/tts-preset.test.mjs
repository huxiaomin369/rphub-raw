// RP-Hub「预置音色整段朗读（mimo-v2.5-tts）」纯函数 + 静态一致性独立验证
// 无第三方依赖。运行：node tests/tts-preset.test.mjs
//
// 打桩方式：
//   globalThis.window = {}   →  assets/js/tts-service.js 是 IIFE，执行后把 API 挂到 window.RPHubTts
//   globalThis.Vue = { reactive: v => v, ref: v => ({ value: v }) }
// 只读，不修改 assets/ 下任何内容。
//
// 事实来源：官方文档 https://mimo.mi.com/docs/zh-CN/api/audio/tts-post 与
//           https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5
//           （仓库整理稿 docs/mimo-tts-api-spec.md）；字段级结论见 docs/tts-preset-conformance.md。
//
// 用例分两类：
//   [契约] 由官方文档 / 任务要求直接推出的硬契约，必须全绿。
//   [反例] 针对「实现声称要做、但当前没做到」的性质写的判定，失败即为待修问题（见 conformance 文档）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
  const stat = fs.statSync(SOURCE_PATH);
  const sha = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
  return { api, source, sha, mtime: stat.mtime.toISOString(), size: stat.size, lines: source.split('\n').length };
};

const loaded = loadService();
const TTS = loaded.api;
const SOURCE_LINES = loaded.source.split('\n');
const lineOf = (pattern) => {
  const index = SOURCE_LINES.findIndex(line => pattern.test(line));
  return index < 0 ? -1 : index + 1;
};

// ────────────────────────────── 迷你测试运行器 ──────────────────────────────

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const failures = [];
const skipped = [];
let passed = 0;

const runAll = async () => {
  console.log('='.repeat(80));
  console.log('RP-Hub 预置音色朗读（mimo-v2.5-tts）· 独立验证');
  console.log(`被测文件 : ${SOURCE_PATH}`);
  console.log(`sha256   : ${loaded.sha}（前 16 位）  ${loaded.size} 字节 / ${loaded.lines} 行`);
  console.log(`mtime    : ${loaded.mtime}`);
  console.log(`node     : ${process.version}`);
  console.log(`导出键   : ${Object.keys(TTS).join(', ')}`);
  console.log('='.repeat(80));
  for (const { name, fn } of cases) {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (error) {
      if (error && error.__missing) {
        skipped.push(name);
        console.log(`  SKIP  ${name}  ← ${error.message}`);
      } else {
        failures.push({ name, error });
        console.log(`  FAIL  ${name}`);
        console.log(`        ${String(error && error.message).split('\n')[0]}`);
      }
    }
  }
  console.log('-'.repeat(80));
  const counterExamples = failures.filter(item => item.name.startsWith('[反例]'));
  const contractFailures = failures.filter(item => !item.name.startsWith('[反例]'));
  console.log(`合计 ${cases.length}：PASS ${passed}，契约违约 ${contractFailures.length}，反例（实现待修）${counterExamples.length}，SKIP ${skipped.length}`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const { name, error } of failures) {
      console.log(`\n[FAIL] ${name}`);
      console.log(error && error.stack ? error.stack : String(error));
    }
  }
  if (skipped.length) {
    console.log('\n跳过明细（依赖的函数未导出）：');
    for (const name of skipped) console.log(`  - ${name}`);
  }
  process.exitCode = failures.length ? 1 : 0;
};

// ────────────────────────────── 工具函数 ──────────────────────────────

/** 取导出函数；缺失时抛 __missing，让用例走 SKIP 而不是 FAIL。 */
const fn = (name) => {
  const value = TTS[name];
  if (typeof value !== 'function') {
    const error = new Error(`window.RPHubTts.${name} 不是函数（当前导出：${Object.keys(TTS).join(', ')}）`);
    error.__missing = true;
    throw error;
  }
  return value;
};

const toBytes = async (value) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error(`无法从返回值取得字节：${Object.prototype.toString.call(value)}`);
};

/** 字符袋：去掉空白后按码位排序 —— 用于「不丢字 / 不凭空造字」的守恒断言。 */
const charBag = (text) => [...String(text)].filter(ch => !/\s/.test(ch)).sort().join('');

/** 去掉全部空白后的字符串：顺序敏感的守恒断言（不丢字 / 不增字 / 不重排）。 */
const noWs = (text) => String(text).replace(/\s+/g, '');

/**
 * 空白折叠为单空格并 trim。
 * 用于「词边界与词序不变」的断言：片段是彼此独立的 TTS 请求，切点处的空白允许被裁剪，
 * 因此不要求 `segments.join('') === source`（那会把合法的边界 trim 误判成丢字）。
 */
const squash = (text) => String(text).replace(/\s+/g, ' ').trim();

const tokensOf = (text) => String(text).split(/\s+/).filter(Boolean);
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isBlank = (text) => String(text).trim() === '';
const u16 = (bytes, o) => bytes[o] | (bytes[o + 1] << 8);
const u32 = (bytes, o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
const ascii = (bytes, o, n) => String.fromCharCode(...bytes.slice(o, o + n));

const assertStyleApplied = (result, text, style) => {
  assert.equal(typeof result, 'string', 'applyStyleTag 必须返回字符串');
  assert.ok(result.endsWith(text), `结果应以正文结尾：${JSON.stringify(result)}`);
  const prefix = result.slice(0, result.length - text.length);
  assert.match(prefix, new RegExp(`^[（(]${escapeRe(style)}[）)]$`),
    `前缀应为单层括号包住的风格名，实际为 ${JSON.stringify(prefix)}`);
};

/** 断言一组片段满足通用守恒：非空、不超上限、首尾无空白、非空白字符与原文逐字一致。 */
const assertChunksSane = (segments, source, limit, label) => {
  assert.ok(segments.length > 0, `${label}：没有产出任何片段`);
  assert.ok(segments.every(segment => !isBlank(segment)), `${label}：存在空白片段`);
  assert.ok(segments.every(segment => segment === segment.trim()), `${label}：片段首尾残留空白`);
  assert.ok(segments.every(segment => segment.length <= limit), `${label}：存在超过上限（${limit}）的片段`);
  assert.equal(noWs(segments.join('')), noWs(source),
    `${label}：拼接后与原文的非空白字符不一致（丢字 / 增字 / 重排）`);
};

// ────────────────────────────── 0. 导出面与常量 ──────────────────────────────

test('[契约] 导出面：预置朗读所需的 5 个纯函数均已挂到 window.RPHubTts', () => {
  for (const name of ['splitForPresetSpeech', 'normalizeStyleTag', 'applyStyleTag', 'buildWavBlob', 'base64ToBytes']) {
    assert.equal(typeof TTS[name], 'function',
      `window.RPHubTts.${name} 缺失（当前导出：${Object.keys(TTS).join(', ')}）`);
  }
});

test('[契约] 导出面：voicedesign 既有链路未被移除（回归护栏）', () => {
  for (const name of ['stripForSpeech', 'normalizeVoicePlan', 'extractJsonObject', 'useSpeechSynthesis',
    'buildVoiceDirectorSystemPrompt', 'buildVoiceDirectorUserPrompt']) {
    assert.equal(typeof TTS[name], 'function', `window.RPHubTts.${name} 缺失，voicedesign 链路被破坏`);
  }
  assert.equal(TTS.DEFAULT_TTS_MODEL, 'mimo-v2.5-tts-voicedesign', 'voicedesign 默认模型被改动');
  assert.equal(TTS.DEFAULT_TTS_FORMAT, 'wav', 'voicedesign 默认格式被改动');
});

test('[契约] 常量：预置模型 / 默认音色 / PCM 采样率 / 切块上限与官方文档一致', () => {
  assert.equal(TTS.DEFAULT_TTS_PRESET_MODEL, 'mimo-v2.5-tts', '预置朗读模型必须是 mimo-v2.5-tts');
  assert.equal(TTS.DEFAULT_TTS_PRESET_VOICE, 'mimo_default', '预置音色默认值必须是官方默认 mimo_default');
  assert.equal(TTS.TTS_PCM_SAMPLE_RATE, 24000, '流式 PCM 采样率必须是官方 24kHz');
  assert.equal(TTS.MAX_PRESET_CHUNK_LENGTH, 600, '切块上限常量被改动');
  assert.equal(TTS.TTS_MODE_PRESET, 'preset');
  assert.equal(TTS.TTS_MODE_VOICEDESIGN, 'voicedesign');
});

test('[契约] 预置音色 Voice ID 全集与官方「预置音色列表」逐项一致（9 个）', () => {
  const official = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
  const options = TTS.PRESET_VOICE_OPTIONS;
  assert.ok(Array.isArray(options), 'PRESET_VOICE_OPTIONS 必须是数组');
  assert.deepEqual(options.map(option => option.value), official,
    '预置音色 ID 集合/顺序与官方文档不一致（多出、缺失或拼写不同）');
  assert.ok(options.every(option => typeof option.label === 'string' && option.label.length > 0), '音色选项缺少 label');
});

test('[契约] normalizePresetVoice / normalizeTtsMode：空值回落到默认，非法模式回落 voicedesign', () => {
  const normalizeVoice = fn('normalizePresetVoice');
  const normalizeMode = fn('normalizeTtsMode');
  assert.equal(normalizeVoice(''), 'mimo_default');
  assert.equal(normalizeVoice('   '), 'mimo_default');
  assert.equal(normalizeVoice(null), 'mimo_default');
  assert.equal(normalizeVoice(' 冰糖 '), '冰糖');
  assert.equal(normalizeMode('preset'), 'preset');
  assert.equal(normalizeMode('PRESET'), 'voicedesign', '大小写不敏感不该被当成 preset（当前实现只认精确值）');
  assert.equal(normalizeMode(''), 'voicedesign');
  assert.equal(normalizeMode(undefined), 'voicedesign');
});

// 段数/单段长度上限不写死数字：一律从导出常量取值。
// 历史教训：7507899 把 MAX_SEGMENTS 40→50、MAX_SEGMENT_LENGTH 140→200，只改了实现，
// 这里仍按 40 断言，套件从此常红（恰好 40 段那条反而还是绿的，更具迷惑性）。
test('[契约] normalizeVoicePlan：truncated 与 MAX_SEGMENTS 截断口径一致（恰好 N → false，N+1 → true）', () => {
  const normalize = fn('normalizeVoicePlan');
  const cap = TTS.MAX_SEGMENTS;
  assert.ok(Number.isInteger(cap) && cap > 0, `MAX_SEGMENTS 必须是正整数，实测 ${cap}`);
  const payload = (count) => ({
    sceneTone: '平静',
    speakers: [{ id: 'narrator', label: '旁白', voiceDesign: '沉稳中性旁白，语速平缓。' }],
    segments: Array.from({ length: count }, (_, i) => ({ speaker: 'narrator', text: `第${i + 1}句旁白。` }))
  });
  const at5 = normalize(payload(5), '兜底文本');
  assert.equal(at5.segments.length, 5);
  assert.equal(at5.truncated, false, '未超上限不应标记 truncated');
  assert.equal(at5.sceneTone, '平静');
  const atCap = normalize(payload(cap), '兜底文本');
  assert.equal(atCap.segments.length, cap);
  assert.equal(atCap.truncated, false, `恰好 ${cap} 段不应被判为截断（否则会误报「只朗读前 ${cap} 段」）`);
  const overCap = normalize(payload(cap + 1), '兜底文本');
  assert.equal(overCap.segments.length, cap, `超过 ${cap} 段必须截断到 ${cap}`);
  assert.equal(overCap.truncated, true, `${cap + 1} 段必须标记 truncated`);
});

test('[契约] normalizeVoicePlan：单段文本按 MAX_SEGMENT_LENGTH × 4 裁剪（常量驱动）', () => {
  const normalize = fn('normalizeVoicePlan');
  const cap = TTS.MAX_SEGMENT_LENGTH;
  assert.ok(Number.isInteger(cap) && cap > 0, `MAX_SEGMENT_LENGTH 必须是正整数，实测 ${cap}`);
  const limit = cap * 4;
  const longText = '甲'.repeat(limit + 200);
  const result = normalize({
    sceneTone: '',
    speakers: [{ id: 'narrator', label: '旁白', voiceDesign: '沉稳中性旁白。' }],
    segments: [{ speaker: 'narrator', text: longText }]
  }, '');
  assert.equal(result.segments.length, 1);
  const text = result.segments[0].text;
  // truncate() 截断时会补一个省略号，因此上限是 limit(+1)。
  assert.ok(text.length <= limit + 1, `单段文本应裁到 ${limit} 以内（含省略号），实测 ${text.length}`);
  assert.ok(text.endsWith('…'), '超长单段应带省略号，说明确实走了裁剪分支');
  // 未超限的段落必须逐字保留，不能被顺手裁掉。
  const short = normalize({
    sceneTone: '',
    speakers: [{ id: 'narrator', label: '旁白', voiceDesign: '沉稳中性旁白。' }],
    segments: [{ speaker: 'narrator', text: '短句。' }]
  }, '');
  assert.equal(short.segments[0].text, '短句。');
});

// ────────────────────────────── 1. splitForPresetSpeech ──────────────────────────────
test('[契约] splitForPresetSpeech：空值 / 纯空白返回空数组', () => {
  const split = fn('splitForPresetSpeech');
  assert.deepEqual(split(''), []);
  assert.deepEqual(split('   \n\t '), []);
  assert.deepEqual(split(' \r\n\r\n\t\u3000  '), [], 'CRLF + 全角空格的纯空白输入应返回空数组');
  assert.deepEqual(split(null), []);
  assert.deepEqual(split(undefined), []);
});

test('[契约] splitForPresetSpeech：短于上限时原样单段返回', () => {
  const split = fn('splitForPresetSpeech');
  const text = '你好，世界。今天天气不错。';
  assert.deepEqual(split(text), [text]);
});

test('[契约] splitForPresetSpeech：无标点超长串按上限硬切，不丢字符、恰好上限不切', () => {
  const split = fn('splitForPresetSpeech');
  const cap = TTS.MAX_PRESET_CHUNK_LENGTH;
  const probe = split('あ'.repeat(20000));
  assert.ok(probe.length > 1, `20000 字无标点长串未被切分（片段数 ${probe.length}）`);
  assert.equal(Math.max(...probe.map(segment => segment.length)), cap,
    `实测最大片段长度不等于常量上限 ${cap}`);
  assertChunksSane(probe, 'あ'.repeat(20000), cap, '无标点超长串');
  assert.ok(probe.length <= Math.ceil(20000 / cap) + 2, `片段数 ${probe.length} 异常膨胀`);
  assert.deepEqual(split('あ'.repeat(cap)), ['あ'.repeat(cap)], `长度恰好等于上限（${cap}）时被多切`);
  const over = split('あ'.repeat(cap + 1));
  assert.deepEqual(over.map(segment => segment.length), [cap, 1], `上限 +1 的切分长度不符合预期：${over.length} 段`);
  assert.equal(charBag(over.join('')), charBag('あ'.repeat(cap + 1)), '上限 +1 切分丢字');
});

test('[契约] splitForPresetSpeech：自定义上限生效，并受 40 的下限保护', () => {
  const split = fn('splitForPresetSpeech');
  const text = 'あ'.repeat(1000);
  const at100 = split(text, 100);
  assertChunksSane(at100, text, 100, 'maxLength=100');
  const at10 = split(text, 10);
  assert.ok(at10.every(segment => segment.length <= 40), 'maxLength 低于 40 时未按 40 下限收敛');
});

test('[契约] splitForPresetSpeech：超长多段文本 —— 每段不超上限、拼接守恒、无空段', () => {
  const split = fn('splitForPresetSpeech');
  const paragraph = '夜色沉下来，风把窗棂吹得轻响，桌上的灯芯晃了一下，又稳稳地亮着。她把手里的信纸折了三次，塞进袖口，谁也没看见。';
  const source = Array.from({ length: 40 }, (_, i) => `第${i + 1}段：${paragraph}`).join('\n\n');
  const segments = split(source);
  assert.ok(segments.length > 1, '超长多段文本没有被切分');
  assertChunksSane(segments, source, TTS.MAX_PRESET_CHUNK_LENGTH, '超长多段');
});

test('[契约] splitForPresetSpeech：CRLF 与连续空行输入不丢字、不超限（附 \\r 残留观察）', () => {
  const split = fn('splitForPresetSpeech');
  const cap = TTS.MAX_PRESET_CHUNK_LENGTH;
  const para = '夜色沉下来，风把窗棂吹得轻响。';
  const cases = [
    ['CRLF 空行分隔（短）', [para, para, para].join('\r\n\r\n')],
    ['CRLF 逐行（超长）', Array.from({ length: 30 }, () => para.repeat(6)).join('\r\n')],
    ['CRLF 英文（超长）', Array.from({ length: 30 }, () => 'The night was long and the wind kept knocking at the window frame.').join('\r\n')],
    ['连续空行 \\n\\n\\n\\n（短）', [para, para, para].join('\n\n\n\n')],
    ['连续空行 \\n\\n\\n\\n（超长）', Array.from({ length: 30 }, () => para.repeat(6)).join('\n\n\n\n')],
    ['裸 \\r 分隔', [para, para].join('\r')]
  ];
  const notes = [];
  for (const [label, source] of cases) {
    const segments = split(source);
    assertChunksSane(segments, source, cap, label);
    if (segments.some(segment => segment.includes('\r'))) {
      notes.push(`${label} 片段内残留 \\r`);
    }
  }
  // 观察项（不判失败）：CRLF 的 \r\n\r\n 不被 /\n{2,}/ 命中，分段退化为逐行；
  // 且短文本会原样保留 \r。真实链路里 stripForSpeech 已把 CRLF 归一化为 LF，故实际不可达。
  console.log(`        观察：${notes.length ? notes.join('；') : '无 \\r 残留'}`);
});

test('[契约] splitForPresetSpeech：无任何空白的超长串回退为按上限硬切（不丢字）', () => {
  const split = fn('splitForPresetSpeech');
  const source = 'a'.repeat(1500);
  const segments = split(source);
  assert.deepEqual(segments.map(segment => segment.length), [600, 600, 300],
    '找不到空白断点时应严格按上限硬切');
  assert.equal(segments.join(''), source, '无空白硬切分支丢字');
});

test('[契约] splitForPresetSpeech：英文超长文本不丢字、不重排（非空白字符逐字守恒）', () => {
  const split = fn('splitForPresetSpeech');
  const source = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const segments = split(source);
  assert.ok(segments.length > 1, '超长英文文本没有被切分');
  assertChunksSane(segments, source, TTS.MAX_PRESET_CHUNK_LENGTH, '英文长串');
  assert.equal(squash(segments.join(' ')), squash(source), '空白折叠后无法还原原文（词序 / 词边界发生变化）');
});

test('[契约] splitForPresetSpeech：英文多段（\\n\\n）合并不粘连、词序列守恒', () => {
  const split = fn('splitForPresetSpeech');
  const paragraph = 'The night was long and the wind kept knocking at the window frame.';
  const source = Array.from({ length: 12 }, () => paragraph).join('\n\n');
  const segments = split(source);
  assert.ok(segments.length > 1, '超长英文多段没有被切分');
  assertChunksSane(segments, source, TTS.MAX_PRESET_CHUNK_LENGTH, '英文多段');
  assert.deepEqual(tokensOf(segments.join(' ')), tokensOf(source), '英文段落合并后词序列发生变化（粘连或切词）');
});

test('[契约] splitForPresetSpeech：! / ? 是断句点，超长英文不会在词中被硬切', () => {
  const split = fn('splitForPresetSpeech');
  const source = 'Watch out now! '.repeat(60).trim();
  const segments = split(source);
  assert.ok(segments.length > 1, '超长英文（! 断句）没有被切分');
  assertChunksSane(segments, source, TTS.MAX_PRESET_CHUNK_LENGTH, '英文 ! 断句');
  assert.ok(segments.every(segment => /[!?。！？]$/.test(segment)),
    '存在不以断句标点结尾的片段，说明 ! / ? 没有真正参与断句');
});

test('[契约] splitForPresetSpeech：同一片段内相邻英文句之间保留空白（P2-1 回归）', () => {
  const split = fn('splitForPresetSpeech');
  const source = 'Watch out now! '.repeat(60).trim();
  const segments = split(source);
  // 段内不得出现「标点后直接跟字母」——那正是修前 "that?Are" 式的粘连。
  const glued = segments.filter(segment => /[!?.,;:][A-Za-z0-9]/.test(segment));
  assert.deepEqual(glued, [], `片段内出现标点与单词粘连：${JSON.stringify(glued.slice(0, 2))}`);
  assert.deepEqual(tokensOf(segments.join(' ')), tokensOf(source), '合并后词序列发生变化');
  // 观察项（不判失败）：切点处会裁剪一个边界空白（片段是彼此独立的 TTS 请求，不影响朗读）。
  const lost = source.length - segments.join('').length;
  console.log(`        观察：切点空白裁剪 ${lost} 个字符（${segments.length - 1} 个切点）`);
});

test('[契约] splitForPresetSpeech：英文长串在词边界断开，不切断单词（P1-1 回归）', () => {
  const split = fn('splitForPresetSpeech');
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
  const source = words.join(' ');
  const segments = split(source);
  // 用单个空格拼接后必须还原出原文的词序列：在词中间硬切会让词数变多。
  assert.deepEqual(tokensOf(segments.join(' ')), words, '英文片段在单词内部被切断');
  // 边界实证：每个片段的首尾都应是完整单词
  for (const segment of segments) {
    assert.match(segment, /^word\d+/, `片段未从单词开头开始：${JSON.stringify(segment.slice(0, 12))}`);
    assert.match(segment, /word\d+$/, `片段未在单词结尾结束：${JSON.stringify(segment.slice(-12))}`);
  }
});

test('[契约] splitForPresetSpeech：英文句号 . 是断句点，带 . 的长文不切词（P1-2 回归）', () => {
  const split = fn('splitForPresetSpeech');
  const sentence = 'She folded the letter three times and tucked it into her sleeve, and nobody saw a thing. ';
  const source = sentence.repeat(40).trim();
  const segments = split(source);
  assert.deepEqual(tokensOf(segments.join(' ')), tokensOf(source),
    '英文句号未参与断句，长文被硬切、词被切开');
  assert.ok(segments.every(segment => /[.!?。！？]$/.test(segment)),
    '存在不以句末标点结尾的片段，说明句号没有真正参与断句');
  assertChunksSane(segments, source, TTS.MAX_PRESET_CHUNK_LENGTH, '英文 . 断句');
});

// ────────────────────────────── 2. normalizeStyleTag / applyStyleTag ──────────────────────────────

test('[契约] normalizeStyleTag：半角 / 全角 / 方括号一律剥离为标签内容', () => {
  const normalize = fn('normalizeStyleTag');
  assert.equal(normalize('温柔'), '温柔');
  assert.equal(normalize('（温柔）'), '温柔');
  assert.equal(normalize('(温柔)'), '温柔');
  assert.equal(normalize('[温柔]'), '温柔');
  assert.equal(normalize('【温柔】'), '温柔');
  assert.equal(normalize(' 温柔 '), '温柔');
  assert.equal(normalize(' （温柔） '), '温柔');
});

test('[契约] normalizeStyleTag：空值与只有括号时返回空串', () => {
  const normalize = fn('normalizeStyleTag');
  for (const input of ['', '   ', null, undefined, '（）', '()', '[]', '【】']) {
    assert.equal(normalize(input), '', `输入 ${JSON.stringify(input)} 应归一化为空串`);
  }
});

test('[契约] normalizeStyleTag：同一括号内的多风格保留原分隔（只剥一层括号）', () => {
  const normalize = fn('normalizeStyleTag');
  assert.equal(normalize('(温柔 磁性)'), '温柔 磁性');
  assert.equal(normalize('（温柔 磁性）'), '温柔 磁性');
  assert.equal(normalize('[东北话 俏皮]'), '东北话 俏皮');
});

test('[契约] applyStyleTag：空风格不加任何括号，正文原样返回', () => {
  const apply = fn('applyStyleTag');
  const text = '你好，世界。';
  for (const style of ['', '   ', null, undefined, '（）', '()', '[]']) {
    assert.equal(apply(text, style), text, `风格 ${JSON.stringify(style)} 时不应改变正文`);
  }
  assert.equal(apply('', '温柔'), '', '空正文时不应只返回一个孤立标签');
});

test('[契约] applyStyleTag：风格名归一化后以单层括号前缀写在正文之前', () => {
  const apply = fn('applyStyleTag');
  const text = '你好，世界。';
  assertStyleApplied(apply(text, '温柔'), text, '温柔');
  assertStyleApplied(apply(text, '（温柔）'), text, '温柔');
  assertStyleApplied(apply(text, '(温柔)'), text, '温柔');
  assertStyleApplied(apply(text, '[温柔]'), text, '温柔');
  assertStyleApplied(apply(text, '温柔 '), text, '温柔');
});

test('[契约] applyStyleTag：标签紧贴正文开头，与官方 (风格)待合成内容 语法一致', () => {
  const apply = fn('applyStyleTag');
  const result = apply('夜已经深了，城市还在呼吸。', '磁性');
  assert.equal(result, '(磁性)夜已经深了，城市还在呼吸。');
  assert.equal(result[0], '(', '风格标签必须紧贴正文最开头，且为半角括号');
});

// ────────────────────────────── 3. buildWavBlob ──────────────────────────────

test('[契约] buildWavBlob：返回 Blob 且 MIME 为 wav，大小 = 44 + PCM', async () => {
  const build = fn('buildWavBlob');
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const blob = build(pcm);
  assert.ok(blob && typeof blob.size === 'number', 'buildWavBlob 未返回 Blob');
  assert.equal(blob.size, 44 + pcm.length, `Blob 大小应为 44 + PCM 字节数，实际 ${blob.size}`);
  assert.equal(typeof blob.type, 'string', 'Blob 缺少 type');
  assert.match(blob.type, /wav|audio/i, `MIME 类型异常：${blob.type}`);
});

test('[契约] buildWavBlob：44 字节 RIFF 头字段逐项正确（24kHz / mono / 16bit / LE）', async () => {
  const build = fn('buildWavBlob');
  const pcm = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 7) & 0xff));
  const bytes = await toBytes(build(pcm));
  assert.equal(bytes.length, 44 + pcm.length, '总长度应为 44 + PCM');
  assert.equal(ascii(bytes, 0, 4), 'RIFF', 'ChunkID 应为 RIFF');
  assert.equal(ascii(bytes, 8, 4), 'WAVE', 'Format 应为 WAVE');
  assert.equal(ascii(bytes, 12, 4), 'fmt ', 'Subchunk1ID 应为 "fmt "');
  assert.equal(ascii(bytes, 36, 4), 'data', 'Subchunk2ID 应为 data');
  assert.equal(u32(bytes, 4), 36 + pcm.length, 'RIFF size 字段应等于 36 + PCM 字节数');
  assert.equal(u32(bytes, 16), 16, 'fmt 块大小应为 16（PCM）');
  assert.equal(u16(bytes, 20), 1, 'AudioFormat 应为 1（PCM）');
  assert.equal(u16(bytes, 22), 1, '声道数应为 1（mono）');
  assert.equal(u32(bytes, 24), 24000, '采样率应为 24000');
  assert.equal(u32(bytes, 28), 48000, 'ByteRate 应为 采样率 × 声道 × 位深/8 = 48000');
  assert.equal(u16(bytes, 32), 2, 'BlockAlign 应为 2');
  assert.equal(u16(bytes, 34), 16, '位深应为 16');
  assert.equal(u32(bytes, 40), pcm.length, 'data 长度字段应等于 PCM 字节数');
});

test('[契约] buildWavBlob：PCM 数据原样写入，无填充与重排', async () => {
  const build = fn('buildWavBlob');
  const pcm = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0x12, 0x34]);
  const bytes = await toBytes(build(pcm));
  assert.deepEqual(Array.from(bytes.slice(44)), Array.from(pcm), 'data 区与输入 PCM 不一致');
});

test('[契约] buildWavBlob：空 PCM 也是合法的 44 字节空 WAV', async () => {
  const build = fn('buildWavBlob');
  const bytes = await toBytes(build(new Uint8Array(0)));
  assert.equal(bytes.length, 44, '空 PCM 应得到 44 字节头');
  assert.equal(u32(bytes, 4), 36, '空 PCM 的 RIFF size 应为 36');
  assert.equal(u32(bytes, 40), 0, '空 PCM 的 data 长度字段应为 0');
  assert.equal(ascii(bytes, 36, 4), 'data');
});

test('[契约] buildWavBlob：字节序为 Little Endian（采样率字段逐字节核对）', async () => {
  const build = fn('buildWavBlob');
  const bytes = await toBytes(build(new Uint8Array([0, 0])));
  // 24000 = 0x00005DC0 → LE: C0 5D 00 00
  assert.deepEqual(Array.from(bytes.slice(24, 28)), [0xc0, 0x5d, 0x00, 0x00], '采样率字段不是小端序');
});

// ────────────────────────────── 4. base64ToBytes ──────────────────────────────

test('[契约] base64ToBytes：纯 base64 解码正确且返回 Uint8Array', () => {
  const decode = fn('base64ToBytes');
  const bytes = decode('AAECAw==');
  assert.ok(bytes instanceof Uint8Array, '应返回 Uint8Array');
  assert.deepEqual(Array.from(bytes), [0, 1, 2, 3]);
});

test('[契约] base64ToBytes：带 data URL 前缀时剥离前缀后解码', () => {
  const decode = fn('base64ToBytes');
  for (const input of ['data:audio/wav;base64,AAECAw==', 'data:audio/mpeg;base64,AAECAw==', 'data:;base64,AAECAw==']) {
    assert.deepEqual(Array.from(decode(input)), [0, 1, 2, 3], `前缀剥离失败：${input}`);
  }
});

test('[契约] base64ToBytes：含换行与空格的 base64 可解码', () => {
  const decode = fn('base64ToBytes');
  assert.deepEqual(Array.from(decode('AAEC\nAw==')), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(decode('AAEC Aw==')), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(decode('  AAECAw==  \n')), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(decode('data:audio/wav;base64,\nAAEC\nAw==\n')), [0, 1, 2, 3]);
});

test('[契约] base64ToBytes：空值返回空字节数组', () => {
  const decode = fn('base64ToBytes');
  for (const input of ['', '   ', null, undefined]) {
    const bytes = decode(input);
    assert.ok(bytes instanceof Uint8Array, `应返回 Uint8Array：${String(input)}`);
    assert.equal(bytes.length, 0, `空值应返回 0 字节：${String(input)}`);
  }
});

test('[契约] base64ToBytes：0x00–0xFF 全字节往返一致（含 data URL 形态）', () => {
  const decode = fn('base64ToBytes');
  const raw = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
  const b64 = Buffer.from(raw).toString('base64');
  assert.deepEqual(Array.from(decode(b64)), Array.from(raw));
  assert.deepEqual(Array.from(decode(`data:audio/wav;base64,${b64}`)), Array.from(raw));
});

// ────────────────────────────── 5. 链路形状 ──────────────────────────────

test('[契约] WAV 头 + base64 分片可拼装出合法 wav（流式链路形状）', async () => {
  const decode = fn('base64ToBytes');
  const build = fn('buildWavBlob');
  const concat = fn('concatBytes');
  const pcm = new Uint8Array(Array.from({ length: 4800 }, (_, i) => i & 0xff)); // 0.1s @24k mono16
  const b64 = Buffer.from(pcm).toString('base64');
  const rebuilt = await toBytes(build(concat([decode(b64), decode('')])));
  assert.equal(rebuilt.length, 44 + pcm.length);
  assert.equal(ascii(rebuilt, 0, 4), 'RIFF');
  assert.equal(ascii(rebuilt, 36, 4), 'data');
  assert.equal(u32(rebuilt, 40), pcm.length);
  assert.deepEqual(Array.from(rebuilt.slice(44, 48)), [0, 1, 2, 3]);
});

test('[契约] concatBytes：按顺序拼接、总长正确、空列表得 0 字节', () => {
  const concat = fn('concatBytes');
  const merged = concat([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3, 4, 5])]);
  assert.deepEqual(Array.from(merged), [1, 2, 3, 4, 5]);
  assert.equal(concat([]).length, 0);
});

// ────────────────────────────── 6. 源码静态一致性核对 ──────────────────────────────

test('[契约] 静态核对：预置合成请求字段（model / format / voice / stream / messages / 请求头）', () => {
  const checks = [
    ['预置模型常量', /const DEFAULT_TTS_PRESET_MODEL = 'mimo-v2\.5-tts';/],
    ['流式必须 pcm16', /format: stream \? 'pcm16' : DEFAULT_TTS_FORMAT/],
    ['非流式走 wav', /const DEFAULT_TTS_FORMAT = 'wav';/],
    ['voice 仅在非空时写入 audio', /if \(voice\) audio\.voice = voice;/],
    ['目标文本放在 assistant 消息', /\{ role: 'assistant', content: text \}/],
    ['风格指令放在 user 消息', /\{ role: 'user', content: userInstruction \|\| DEFAULT_PRESET_INSTRUCTION \}/],
    ['Bearer 鉴权请求头', /Authorization: `Bearer \$\{apiKey\}`/],
    ['Content-Type: application/json', /'Content-Type': 'application\/json'/],
    ['stream 为真时才写入请求体', /if \(stream\) body\.stream = true;/],
    ['流式分片只取 delta.audio.data', /parsed\?\.choices\?\.\[0\]\?\.delta\?\.audio\?\.data/],
    ['非流式只取 message.audio.data', /payload\?\.choices\?\.\[0\]\?\.message\?\.audio/],
    ['SSE 结束标记 [DONE] 被跳过', /payload === '\[DONE\]'/],
    ['预置路径每块都加风格标签', /text: applyStyleTag\(text, presetStyleTagOf\(\)\)/]
  ];
  const missing = [];
  const found = [];
  for (const [label, pattern] of checks) {
    const line = lineOf(pattern);
    if (line < 0) missing.push(label);
    else found.push(`${label}=L${line}`);
  }
  console.log(`        静态命中：${found.join('，')}`);
  assert.deepEqual(missing, [], `源码中缺少以下一致性锚点：${missing.join('、')}`);
});

test('[契约] 静态核对：错误码 400/401/402/403/421/429 各有专门映射文案', () => {
  const checks = [
    ['429 限流', /if \(status === 429\) return '语音合成请求过于频繁/],
    ['401 鉴权（单独，不再与 403 合并）', /if \(status === 401\) return '语音合成鉴权失败/],
    ['403 地区/风控（单独）', /if \(status === 403\) return '语音合成被拒绝/],
    ['402 余额不足', /if \(status === 402\) return '语音合成账户余额或额度不足/],
    ['421 内容审核拦截', /if \(status === 421\) return '合成文本被内容审核拦截/],
    ['400 请求格式错误', /if \(status === 400\) return '语音合成请求格式错误/],
    ['上游 error.message 优先透出', /const detail = payload\?\.error\?\.message \|\| payload\?\.message/],
    ['兜底通用文案', /return `语音合成接口返回 \$\{status\}`/]
  ];
  const missing = [];
  const found = [];
  for (const [label, pattern] of checks) {
    const line = lineOf(pattern);
    if (line < 0) missing.push(label);
    else found.push(`${label}=L${line}`);
  }
  console.log(`        错误码锚点：${found.join('，')}`);
  assert.deepEqual(missing, [], `错误码映射缺少锚点：${missing.join('、')}`);
});

test('[契约] 静态核对：切分链路已含词边界回退与半角句号断句', () => {
  const checks = [
    ['硬切回退到空白/制表符断点', /const breakAt = Math\.max\(head\.lastIndexOf\(' '\), head\.lastIndexOf\('\\t'\)\);/],
    ['回退窗口为 limit 的 20%', /const window = Math\.max\(1, Math\.floor\(limit \* 0\.2\)\);/],
    ['断不开才按 limit 硬切', /const cut = breakAt >= limit - window \? breakAt \+ 1 : limit;/],
    ['断句字符集含半角句号', /；;\.\\n\]\+\[。！？!\?…；;\.\]\*/],
    ['合并相邻句时保留原文空白', /buffer \+= sentence;/],
    ['旧的 joinSpeechPieces 已移除', /^(?!.*joinSpeechPieces).*$/]
  ];
  const missing = [];
  const found = [];
  for (const [label, pattern] of checks) {
    if (label === '旧的 joinSpeechPieces 已移除') {
      const stillThere = lineOf(/const joinSpeechPieces/);
      if (stillThere >= 0) missing.push(`${label}（仍在 L${stillThere}）`);
      else found.push(`${label}=已移除`);
      continue;
    }
    const line = lineOf(pattern);
    if (line < 0) missing.push(label);
    else found.push(`${label}=L${line}`);
  }
  console.log(`        切分锚点：${found.join('，')}`);
  assert.deepEqual(missing, [], `切分链路缺少锚点：${missing.join('、')}`);
});

// ────────────────────────────── 运行 ──────────────────────────────

await runAll();
