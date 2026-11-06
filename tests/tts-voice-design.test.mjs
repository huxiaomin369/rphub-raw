// RP-Hub「LLM 音色设计」验证（无第三方依赖）
// 运行：node tests/tts-voice-design.test.mjs
//
// 验证的性质（对应 docs/tts-voice-design.md，规范来源：MiMo 官方 SKILL「音色描述编写」）：
//   1. 音色描述是「嗓子的身份卡」：必写四项（身份锚点/声音质感/语速节奏/情绪底色）+ 可选两项（风格锚点/辨识度癖好）。
//   2. 官方硬约束全部落进 prompt：1-2 句白描、不写场景、不写动作、不用真实演员或 IP 名。
//   3. prompt 里带正例，且正例本身符合 1-2 句 + 身份锚点 —— 规则和它自己的样例不能互相打架。
//   4. delivery 只写表演（语速/气息/停顿/重音/情绪），音色词被明确列为禁止项。
//   5. composeVoiceInstruction：无 delivery 时指令与身份卡逐字相同（压住音色漂移的关键）。
//   6. 端到端：voicedesign 请求体 instruction=身份卡（+演绎），不带 voice，正文不加风格标签。
//   7. 端到端：同一角色跨段身份卡逐字一致，delivery 只是附加，不改写身份卡。
//   8. 回归：只有 preset 链路才给正文加音频标签（官方明确 voicedesign 不支持标签）。
//
// 打桩方式与 tests/tts-streaming-playback.test.mjs 一致：<audio>、objectURL、rAF、fetch 全换假实现，
// 然后真跑一遍 useSpeechSynthesis 的完整链路。只读 assets/，不修改任何被测文件。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(HERE, '..', 'assets', 'js', 'tts-service.js');

// ────────────────────────────── 假环境 ──────────────────────────────

const SEGMENT_SECONDS = 0.05;
const SAMPLE_RATE = 24000;
const BYTE_RATE = SAMPLE_RATE * 2;
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
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, BYTE_RATE, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  return bytes;
};

const WAV_BASE64 = Buffer.from(makeWavBytes()).toString('base64');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let current = null;
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

// 只收集合成请求：音色设计的 LLM 调用走注入的 requestChatCompletion，不经过 fetch。
const ttsBodies = [];

globalThis.fetch = async (url, init) => {
  ttsBodies.push(JSON.parse(init.body));
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { audio: { data: WAV_BASE64, format: 'wav' } } }]
    })
  };
};

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

// 一句话里出现这几个词，就是模型在 identity card 里混进了「这次要念什么」。
const SCENE_WORDS = ['场景感', '此刻', '这一段', '本段', '正在', '走在', '坐在', '站在'];

// ────────────────────────────── 规则层：对齐官方规范 ──────────────────────────────

test('[契约] 音色描述规则覆盖官方必写四项与两项可选', () => {
  const rules = TTS.VOICE_DESIGN_RULES;
  assert.equal(typeof rules, 'string');
  // 「音色描述是嗓子的身份卡」是官方规范的核心比喻，必须点明。
  assert.ok(rules.includes('身份卡'), '必须说明 voiceDesign 是嗓子的身份卡');

  const required = ['身份锚点', '年龄段', '声音质感', '共鸣位置', '语速节奏', '情绪底色'];
  for (const key of required) {
    assert.ok(rules.includes(key), `必写项缺失：${key}`);
  }
  const optional = ['风格或身份锚点', '辨识度小癖好'];
  for (const key of optional) {
    assert.ok(rules.includes(key), `推荐项缺失：${key}`);
  }
  // 官方那条最有指导性的细节：质感要用可感的动词或比喻，不要堆形容词。
  assert.ok(rules.includes('动词') || rules.includes('比喻'), '必须要求用动词/比喻写质感');
  assert.ok(rules.includes('空泛形容词') || rules.includes('不要堆'), '必须禁止堆形容词');
});

test('[契约] 官方硬约束全部落进 prompt，旧「场景感」措辞已清除', () => {
  const prompt = TTS.buildVoiceDirectorSystemPrompt('');
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length > 800, `prompt 太短，规则可能没拼进去（${prompt.length} 字）`);

  const must = [
    ['1-2 句', '长度必须收窄到官方口径的 1-2 句'],
    ['白描', '必须要求白描式'],
    ['不分段、不列条', '必须禁止分段与列条'],
    ['禁止写场景', '必须禁止写场景（官方硬约束）'],
    ['禁止写动作', '必须禁止写动作（官方硬约束）'],
    ['真实演员', '必须禁止使用真实演员/IP 角色名'],
    ['方言', '必须说明方言仅在明确需要时才写'],
    ['逐字相同', '同一说话人跨段必须逐字相同']
  ];
  for (const [needle, why] of must) {
    assert.ok(prompt.includes(needle), `${why}：prompt 里找不到「${needle}」`);
  }

  // 回归：上一版规则允许「可补充……场景感」，与官方「不写场景」直接冲突，必须已经删掉。
  assert.ok(!prompt.includes('场景感'), '「场景感」违反官方「不写场景」硬约束，必须清除');
  // 上一版允许 1-4 句，官方是 1-2 句；放宽回去等于放任音色漂移。
  assert.ok(!/1-4\s*句/.test(prompt), '长度上限必须收窄到 1-2 句，不得回到 1-4 句');
  // 旧版把音色描述里塞「年代」参照，官方未列此项且易与场景混淆。
  assert.ok(!prompt.includes('年代或口音参照'), '旧的「年代或口音参照」措辞应已被官方口径替换');
});

test('[契约] 正例 4 条以上，且每条都符合 1-2 句 + 身份锚点', () => {
  const rules = TTS.VOICE_DESIGN_RULES;
  const tail = rules.split('正例（')[1];
  assert.ok(tail, 'prompt 必须带正例（few-shot 比纯规则描述有效得多）');
  const examples = tail.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim());

  assert.ok(examples.length >= 4, `正例至少 4 条，实际 ${examples.length}`);

  for (const example of examples) {
    const label = `正例「${example.slice(0, 12)}…」`;
    // 身份锚点：年龄段 + 性别，必须出现在最前面。
    assert.match(example, /^(青年|中年|老年|少年|少女)/, `${label} 缺年龄段锚点`);
    assert.match(example, /[男女]性|男声|女声/, `${label} 缺性别锚点`);
    // 1-2 句：句号数量就是句子数量。
    const sentences = (example.match(/。/g) || []).length;
    assert.ok(sentences >= 1 && sentences <= 2, `${label} 应为 1-2 句，实际 ${sentences} 句`);
    // 不许出现后期/工程词，也不许在身份卡里写场景与动作。
    assert.ok(!/混响|回声|EQ|压缩|降噪|立体声/.test(example), `${label} 出现了后期处理词`);
    for (const word of SCENE_WORDS) {
      assert.ok(!example.includes(word), `${label} 出现了场景/段落词「${word}」`);
    }
  }

  // 风格锚点是被官方「强烈推荐」的，正例里必须有示范。
  const withStyle = examples.filter(item => item.includes('风格'));
  assert.ok(withStyle.length >= 2, `至少 2 条正例示范「风格/身份锚点」，实际 ${withStyle.length}`);
});

test('[契约] delivery 规则把音色词列为禁止项，并说明留空的价值', () => {
  const rules = TTS.DELIVERY_RULES;
  assert.equal(typeof rules, 'string');
  for (const key of ['语速', '气息', '停顿', '重音', '情绪起伏']) {
    assert.ok(rules.includes(key), `delivery 允许项缺失：${key}`);
  }
  const banned = ['年龄', '性别', '沙哑', '清亮', '共鸣位置', '音域', '口音', '方言'];
  for (const key of banned) {
    assert.ok(rules.includes(key), `delivery 禁止项缺失：${key}`);
  }
  assert.ok(rules.includes('留空'), '必须说明平淡段落留空，留空才能保证音色输入一致');
  // delivery 必须出现在 prompt 里，否则模型根本不知道有这个字段的用法。
  const prompt = TTS.buildVoiceDirectorSystemPrompt('');
  assert.ok(prompt.includes(TTS.DELIVERY_RULES), 'delivery 规则必须拼进 system prompt');
});

// ────────────────────────────── 契约：指令拼装 ──────────────────────────────

test('[契约] composeVoiceInstruction：无 delivery 时与身份卡逐字相同', () => {
  const card = '中年男性，声线低沉醇厚、胸腔共鸣重，吐字慢而字字顿挫，情绪克制。法庭陈词风格。';
  assert.equal(TTS.composeVoiceInstruction(card, ''), card);
  assert.equal(TTS.composeVoiceInstruction(card, '   '), card);
  assert.equal(TTS.composeVoiceInstruction(card, null), card);
  assert.equal(TTS.composeVoiceInstruction(card, undefined), card);
  // 逐字相同是压住音色漂移的核心：任何多余后缀都会让每段的 context 不再是同一串。
  assert.equal(TTS.composeVoiceInstruction(card, '').length, card.trim().length);
});

test('[契约] composeVoiceInstruction：有 delivery 时显式隔离且不改音色底色', () => {
  const card = '青年女性，气息偏浅、贴在鼻腔上方，语速快而连贯带明显气口，情绪松软微甜。';
  const act = '语速极慢，句尾气息发虚，重音落在「终于」。';
  const merged = TTS.composeVoiceInstruction(card, act);

  assert.ok(merged.startsWith(card), '身份卡必须完整出现在最前面，顺序不能颠倒');
  assert.ok(merged.includes('\n'), '身份卡与演绎提示必须换行隔开，不能连成一串');
  assert.ok(merged.includes(TTS.VOICE_DELIVERY_PREFIX), '必须有显式前缀把两段隔开');
  assert.ok(merged.includes(act), '演绎提示必须原样保留');
  assert.ok(merged.endsWith(act), '演绎提示必须在最后');
  // 前缀里要写明「只改表演、不改音色」，这是防止模型把演绎指令读成音色描述的关键一句。
  assert.ok(TTS.VOICE_DELIVERY_PREFIX.includes('不改'), '前缀必须声明不改音色底色');
  assert.ok(TTS.VOICE_DELIVERY_PREFIX.includes('音色'), '前缀必须点明「音色」二字');
});

test('[契约] composeVoiceInstruction：空白与空串边界', () => {
  assert.equal(TTS.composeVoiceInstruction(null, null), '');
  assert.equal(TTS.composeVoiceInstruction('', ''), '');
  // 只有演绎、没有身份卡时不该拼出一个悬空前缀之外的怪串。
  const onlyAct = TTS.composeVoiceInstruction('', '语速加快');
  assert.ok(onlyAct.includes('语速加快'));
  assert.ok(!onlyAct.startsWith('\n'), '不能以换行开头');
  // 两端空白都要裁掉，否则同一张卡会因缩进差异变成不同的 instruction。
  assert.equal(
    TTS.composeVoiceInstruction('  卡  ', '  演  '),
    `卡\n${TTS.VOICE_DELIVERY_PREFIX}演`
  );
});

test('[契约] prompt 版本号形如 card-vN，且已随本次规则重写递增', () => {
  const version = TTS.VOICE_DESIGN_PROMPT_VERSION;
  assert.equal(typeof version, 'string', 'VOICE_DESIGN_PROMPT_VERSION 必须导出');
  assert.match(version, /^card-v\d+$/, `版本号应形如 card-v2，实际「${version}」`);
  // 版本号是 voicedesign 缓存签名的一部分：规则改了却不递增，旧音频会继续命中，
  // 用户会以为「prompt 改了但音色一点没变」。这里只能锁格式与下限，是否递增仍需人工确认。
  assert.ok(Number(version.replace('card-v', '')) >= 2,
    '1-4 句 → 1-2 句 + 禁场景这次改动必须已递增版本号');
});

// ────────────────────────────── 端到端 ──────────────────────────────
const NARRATOR_CARD = '中年男性，声线沉稳中性、胸腔共鸣为主，吐字清晰工整，语速平稳，情绪克制。播音员风格。';
const LIN_CARD = '青年女性，气息偏浅、贴在鼻腔上方，语速快而连贯带明显气口，情绪松软微甜。偶尔把尾音拖长半拍。';

const SEGMENT_SPEC = [
  { speaker: 'narrator', text: '雨停了，巷子里的灯一盏接一盏亮起来。', delivery: '' },
  { speaker: 'lin', text: '你终于来了。', delivery: '语速极慢，句尾气息发虚，重音落在「终于」。' },
  { speaker: 'lin', text: '伞给你，别淋着。', delivery: '' },
  { speaker: 'narrator', text: '她没有回头，只把手里的伞收了起来。', delivery: '' },
  { speaker: 'lin', text: '明天还来吗？', delivery: '句尾拖长，气息收得很轻。' }
];

const PLAN_JSON = JSON.stringify({
  sceneTone: '深夜的克制与暗流',
  speakers: [
    { id: 'narrator', label: '旁白', voiceDesign: NARRATOR_CARD },
    { id: 'lin', label: '林', voiceDesign: LIN_CARD }
  ],
  segments: SEGMENT_SPEC
});

const buildSettings = (overrides = {}) => ({
  ttsEnabled: true,
  ttsMode: 'voicedesign',
  ttsApiUrl: 'https://api.example.com/v1',
  ttsApiKey: 'tts-key',
  ttsModel: 'mimo-v2.5-tts-voicedesign',
  ttsDesignModel: '',
  ttsDesignApiUrl: '',
  ttsDesignApiKey: '',
  ttsContextRange: 0,
  ttsCustomInstruction: '',
  ttsPlaybackRate: 1,
  ttsCacheEnabled: true,
  ttsPresetModel: 'mimo-v2.5-tts',
  ttsVoice: 'mimo_default',
  ttsPresetStyle: '',
  ttsPresetInstruction: '',
  ttsPresetStream: false,
  model: 'design-llm',
  apiUrl: 'https://api.example.com/v1',
  apiKey: 'llm-key',
  ...overrides
});

const buildService = (overrides = {}) => {
  const text = SEGMENT_SPEC.map(item => item.text).join('\n');
  const messages = [{ id: 'm1', role: 'assistant', name: '角色', content: text }];
  const toasts = [];
  const designCalls = [];
  const service = TTS.useSpeechSynthesis({
    settings: buildSettings(overrides),
    showToast: (text2, type) => toasts.push({ text: text2, type }),
    requestChatCompletion: (payload) => {
      designCalls.push(payload);
      return { content: PLAN_JSON, reasoning: '', finishReason: 'stop' };
    },
    buildApiEndpoint: (base, endpoint) => `${String(base).replace(/\/+$/, '')}/${endpoint}`,
    getChatHistory: () => messages,
    getCurrentCharacter: () => ({ name: '角色' }),
    getUser: () => ({ name: '用户' }),
    resolveMessageText: content => content
  });
  const instance = { service, messages, toasts, designCalls };
  current = instance;
  return instance;
};

const reset = () => { ttsBodies.length = 0; };

const instructionByText = () => {
  const map = new Map();
  for (const body of ttsBodies) {
    const act = body?.messages?.[1]?.content;
    const instruction = body?.messages?.[0]?.content;
    if (typeof act === 'string' && typeof instruction === 'string') map.set(act, instruction);
  }
  return map;
};

const seekRequest = (text) => {
  const key = TTS.stripForSpeech(text);
  const body = ttsBodies.find(item => item?.messages?.[1]?.content === key);
  assert.ok(body, `找不到段「${text}」的合成请求，实际收到 ${ttsBodies.length} 个`);
  return body;
};

test('[端到端] voicedesign 请求体：instruction=身份卡（+演绎），不带 voice，正文不加标签', async () => {
  reset();
  const { service, designCalls } = buildService();
  service.toggleSpeakMessage(0);
  await waitFor(() => ttsBodies.length >= SEGMENT_SPEC.length, '每一段都应发出合成请求', 10000);
  await waitFor(() => service.ttsState.activeKey === '', '应播完并复位', 10000);

  // 音色设计只调一次 LLM，且 system prompt 带上了官方规则。
  assert.equal(designCalls.length, 1, `音色设计应只调用一次 LLM，实际 ${designCalls.length}`);
  const system = designCalls[0]?.messages?.[0]?.content || '';
  assert.equal(system, TTS.buildVoiceDirectorSystemPrompt(''), 'system prompt 必须由 buildVoiceDirectorSystemPrompt 生成');
  assert.ok(system.includes('身份卡'), 'system prompt 缺音色卡规则');

  for (const spec of SEGMENT_SPEC) {
    const body = seekRequest(spec.text);
    assert.equal(body.model, 'mimo-v2.5-tts-voicedesign');
    // voicedesign 的音色完全来自 instruction，一旦带上 voice 就会变成另一条链路。
    assert.equal(body.audio?.voice, undefined, 'voicedesign 请求不得携带 audio.voice');
    assert.equal(body.audio?.format, 'wav');
    assert.equal(body.messages.length, 2, '合成请求固定两条消息：instruction + 正文');

    const want = spec.speaker === 'narrator' ? NARRATOR_CARD : LIN_CARD;
    const expected = TTS.composeVoiceInstruction(want, spec.delivery);
    assert.equal(body.messages[0].content, expected,
      `段「${spec.text}」的 instruction 必须是 composeVoiceInstruction(身份卡, delivery)`);

    // 正文必须是原文本身：voicedesign 不支持音频标签，任何 `(风格)` 前缀都会被念出来。
    assert.equal(body.messages[1].content, TTS.stripForSpeech(spec.text));
    assert.ok(!/^[（(]/.test(body.messages[1].content), 'voicedesign 正文不得以括号标签开头');
  }

  assert.equal(unhandled.length, 0, `不应有未捕获 rejection，实际 ${unhandled.length}`);
});

test('[端到端] 同一角色跨段身份卡逐字一致，delivery 只做附加', async () => {
  reset();
  const { service } = buildService();
  service.toggleSpeakMessage(0);
  await waitFor(() => ttsBodies.length >= SEGMENT_SPEC.length, '每一段都应发出合成请求', 10000);
  await waitFor(() => service.ttsState.activeKey === '', '应播完并复位', 10000);

  const linSegments = SEGMENT_SPEC.filter(item => item.speaker === 'lin');
  const narrSegments = SEGMENT_SPEC.filter(item => item.speaker === 'narrator');

  // 「第一行 = 身份卡」是拼装契约：无论有没有 delivery，第一行都必须完全相同。
  const firstLineOf = (spec) => seekRequest(spec.text).messages[0].content.split('\n')[0];

  for (const group of [{ label: '林', items: linSegments, card: LIN_CARD },
  { label: '旁白', items: narrSegments, card: NARRATOR_CARD }]) {
    const lines = group.items.map(firstLineOf);
    for (const line of lines) {
      assert.equal(line, group.card, `${group.label} 的身份卡必须在所有段落里逐字一致`);
    }
    assert.equal(new Set(lines).size, 1, `${group.label} 出现了 ${new Set(lines).size} 种身份卡，音色会漂`);
  }

  // 有 delivery 的段：身份卡没被改写，只是多了一行演绎。
  const withDelivery = linSegments.find(item => item.delivery);
  const merged = seekRequest(withDelivery.text).messages[0].content;
  assert.ok(merged.startsWith(LIN_CARD), '演绎段的第一行仍必须是原样身份卡');
  assert.ok(merged.includes(withDelivery.delivery), '演绎提示不能丢');

  // 没有 delivery 的段：instruction 就是身份卡本身，不多一个字符。
  const plain = linSegments.filter(item => !item.delivery);
  assert.ok(plain.length >= 1, '用例需要至少一段「无 delivery」才能验证逐字一致');
  for (const spec of plain) {
    assert.equal(seekRequest(spec.text).messages[0].content, LIN_CARD,
      `无 delivery 的段「${spec.text}」instruction 必须与身份卡逐字相同`);
  }
});

test('[回归] 只有 preset 链路才给正文加音频标签', async () => {
  reset();
  // preset 模式下 requestChatCompletion 不应被调用：一旦被调用说明链路串了。
  const { service, designCalls } = buildService({
    ttsMode: 'preset',
    ttsPresetStyle: '温柔',
    ttsPresetInstruction: ''
  });
  service.toggleSpeakMessage(0);
  await waitFor(() => ttsBodies.length >= 1, 'preset 也应发出合成请求', 10000);
  await waitFor(() => service.ttsState.activeKey === '', '应播完并复位', 10000);

  assert.equal(designCalls.length, 0, 'preset 模式不得调用音色设计 LLM');
  const body = ttsBodies[0];
  assert.equal(body.model, 'mimo-v2.5-tts');
  assert.equal(body.audio?.voice, 'mimo_default', 'preset 必须显式带预置音色');
  assert.ok(body.messages[1].content.startsWith('(温柔)'),
    `preset 正文应以 (风格) 标签开头，实际「${body.messages[1].content.slice(0, 20)}」`);
  // preset 的 instruction 是风格指令，不是音色身份卡。
  assert.equal(body.messages[0].content, '自然地朗读这段文本，吐字清晰，语速适中，只读原文，不要增删内容。');
});

test('[端到端] voicedesign 第二次朗读：整条缓存命中，0 次新请求、0 次 LLM 调用', async () => {
  reset();
  const { service, designCalls } = buildService();
  service.toggleSpeakMessage(0);
  await waitFor(() => service.ttsState.activeKey === '', '第一遍应播完', 10000);
  const requestsAfterFirst = ttsBodies.length;
  const designAfterFirst = designCalls.length;
  assert.ok(requestsAfterFirst >= SEGMENT_SPEC.length,
    `第一遍应有 ${SEGMENT_SPEC.length} 个合成请求，实际 ${requestsAfterFirst}`);
  assert.equal(designAfterFirst, 1, '第一遍应只调一次音色设计 LLM');

  reset();
  service.toggleSpeakMessage(0);
  await waitFor(() => service.ttsState.fromCache === true, '第二遍应命中整条缓存', 5000);
  assert.equal(ttsBodies.length, 0, '命中的段不该再发合成请求');
  assert.equal(designCalls.length, designAfterFirst, '命中的计划不该再调 LLM');
  // 缓存签名稳定才可能命中；签名里若混进每次都会变的值，这里会立刻红。
  await waitFor(() => service.ttsState.activeKey === '', '第二遍也应播完', 10000);
  assert.equal(unhandled.length, 0, `不应有未捕获 rejection，实际 ${unhandled.length}`);
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
