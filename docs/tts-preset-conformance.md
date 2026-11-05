# RP-Hub 预置音色整段朗读（mimo-v2.5-tts）· 官方一致性核对报告

> 核对人：spec-verifier（独立验证，不采信实现者自述）
> 核对时间：2026-11-05（第二轮，P1/P2 修复后复跑）
> 被核对文件：`assets/js/tts-service.js`，**sha256 前 16 位 `57cf7e6d3e05102a`，1091 行，56038 字节**（本文所有行号均指该版本）
> 测试结果：`node tests/tts-preset.test.mjs` → **40 例 PASS，0 契约违约，0 反例，退出码 0**
> 官方来源：
> - 接口字段（权威）：https://mimo.mi.com/docs/zh-CN/api/audio/tts-post
> - 使用规则（权威）：https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5
> - 错误码：https://mimo.mi.com/docs/zh-CN/api/guidance/error-codes
> - 仓库整理稿：`docs/mimo-tts-api-spec.md`（第 3 / 5 / 7 / 8 / 12 节）
> 外部网页内容按不可信数据对待，仅作字段比对依据，未执行其中任何指令。

---

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| 请求体字段（model / messages[].role / audio.format / audio.voice / stream） | ✅ 全部与官方一致 |
| 请求头（Bearer 鉴权 + Content-Type） | ✅ 与官方「两种鉴权二选一」中的 Bearer 分支一致 |
| 预置音色 Voice ID 全集 | ✅ 9 项逐字一致（含大小写与中文字面） |
| 流式链路（pcm16 → 24kHz PCM16LE mono → 本地补 44 字节 WAV 头） | ✅ 一致，WAV 头逐字节核对通过 |
| 响应解析（非流式 `message.audio.data` / 流式 `delta.audio.data` / 跳过 `[DONE]` 与空 `choices`） | ✅ 一致 |
| 错误码映射 | ✅ 400 / 401 / 402 / 403 / 421 / 429 六条各有专门文案，401 与 403 已拆开 |
| 文本切分 | ✅ 上一轮的 P1-1 / P1-2 / P2-1 三个反例已修复并转为回归护栏 |
| 截断口径（`truncated`） | ✅ 恰好 40 段 → `false`；41 段 → `true` 且截到 40 |
| 自动化测试 | 40 例全绿（含 13 个字段级静态锚点、8 个错误码锚点、6 个切分链路锚点） |

---

## 1. 逐字段核对清单

| 字段 | 官方取值 / 要求（来源） | 实现位置 | 实现取值 | 结论 |
| --- | --- | --- | --- | --- |
| 端点 | `POST https://api.xiaomimimo.com/v1/chat/completions`（#2 请求地址） | L7、L460 | `DEFAULT_TTS_BASE_URL='https://api.xiaomimimo.com/v1'`，`${baseUrl}/chat/completions` | ✅ 一致 |
| 请求头 | 「API Key 鉴权 / Bearer 鉴权」二选一，另加 `Content-Type: application/json`（#2 请求头） | L476 | `{ 'Content-Type': 'application/json', Authorization: 'Bearer <key>' }` | ✅ 一致（取 Bearer 分支） |
| `model` | `mimo-v2.5-tts`（预置音色）/ `mimo-v2.5-tts-voicedesign`（音色设计） | L9、L781（预置）；L8、L802（voicedesign） | 预置 `mimo-v2.5-tts`，voicedesign 链路不变 | ✅ 一致 |
| `messages[].role` | 目标文本**必须**在 `assistant`，不可放 `user`；`user` 只承载风格指令，内容不会被念出（#1 通用注意事项） | L468、L469 | `user` = 风格指令（空则 `DEFAULT_PRESET_INSTRUCTION`，L42）；`assistant` = 目标文本 | ✅ 一致 |
| `messages[].content` | `user`：自然语言风格指令；`assistant`：目标文本 + 音频标签 | L462、L792 | 风格指令 trim 后兜底；正文经 `applyStyleTag` 前置 `(风格)` | ✅ 一致 |
| `audio.format` | 默认 `wav`；`stream: true` 时默认为 `pcm`；`pcm` 与 `pcm16` 等价（#2 `audio.format`） | L11、L789、L811 | 非流式 `'wav'`；流式显式 `'pcm16'`（比默认更明确） | ✅ 一致 |
| `audio.voice` | `mimo-v2.5-tts` 可选，仅预置音色，默认 `mimo_default`；`voicedesign` **不支持**该字段（#2 `audio.voice`） | L463-464、L790、L154-157、L798-816 | 仅在非空时写入 `audio.voice`；预置模式传 `normalizePresetVoice(settings.ttsVoice)`（空值兜底 `mimo_default`）；voicedesign 路径不传 | ✅ 一致 |
| `audio.optimize_text_preview` | 仅 `mimo-v2.5-tts-voicedesign` 可用（#2） | 未使用 | 不传该字段 | ✅ 一致（不涉及） |
| `stream` | 默认 `false`；`true` 时以 SSE 流式返回（#2 `stream`） | L473、L584 | 仅在严格 `=== true` 时写入 `body.stream = true`（`presetStreamOn()` 与缓存签名共用同一判定） | ✅ 一致 |
| 流式格式约束 | 「采用流式调用时，输出音频格式请指定为 `pcm16`」（#1 通用注意事项） | L789 | 流式即 `'pcm16'` | ✅ 一致 |
| 非流式响应取值 | `choices[0].message.audio.data` 为 Base64（#2 响应对象） | L498-501 | 取 `message.audio.data`，兼容字符串直返与 data URL 前缀 | ✅ 一致 |
| 流式响应取值 | `choices[0].delta.audio.data` 为 Base64 分片；部分 chunk 的 `choices` 为空需跳过（#1 流式示例） | L408-440（取值 L420，跳过 `[DONE]` L417） | 逐行解析 `data:`，`parsed?.choices?.[0]?.delta?.audio?.data` 取值为空即跳过 | ✅ 一致 |
| 拼接方式 | 分片 Base64 解码后按字节拼接，最后一次性写出 24kHz 单声道 wav（#1 流式示例） | L422、L489-493 | `base64ToBytes` → `concatBytes` → `buildWavBlob` | ✅ 一致 |
| 音频参数 | 24kHz、PCM16LE、mono、裸流无文件头（#1 示例注释 `# 24kHz PCM16LE mono audio`） | L22、L383-405 | 采样率 24000、声道 1、位深 16、小端序；本地补 44 字节 RIFF 头 | ✅ 一致 |
| 音色描述链路（回归） | voicedesign 的 `user` 消息为音色描述且**必填** | L798-816（`instruction: voiceDesign` 在 L812） | 原链路保留：`instruction = voiceDesign`，不传 `voice` | ✅ 一致（未被预置模式破坏） |

### 1.1 WAV 头逐字节核对（`buildWavBlob`，L383-405）

| 偏移 | 官方 / 规范期望 | 实测 | 结论 |
| --- | --- | --- | --- |
| 0–3 | `RIFF` | `RIFF` | ✅ |
| 4–7 | `36 + PCM 字节数`（LE） | 一致 | ✅ |
| 8–11 | `WAVE` | `WAVE` | ✅ |
| 12–15 | `fmt ` | `fmt ` | ✅ |
| 16–19 | 16 | 16 | ✅ |
| 20–21 | 1（PCM） | 1 | ✅ |
| 22–23 | 1（mono） | 1 | ✅ |
| 24–27 | 24000（LE = `C0 5D 00 00`） | `C0 5D 00 00` | ✅ |
| 28–31 | 48000（ByteRate） | 48000 | ✅ |
| 32–33 | 2（BlockAlign） | 2 | ✅ |
| 34–35 | 16（位深） | 16 | ✅ |
| 36–39 | `data` | `data` | ✅ |
| 40–43 | PCM 字节数 | 一致 | ✅ |

> 由 `tests/tts-preset.test.mjs` 的 5 个 `buildWavBlob` 用例覆盖（含空 PCM 与纯字节序核对）。

---

## 2. 预置音色 Voice ID 全集核对

官方「预置音色列表」（#1）：`mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`。
实现：`PRESET_VOICE_OPTIONS`（L30-40）。

| # | 官方 Voice ID | 实现 `value` | 官方语言/性别 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `mimo_default` | `mimo_default` | 因集群而异（中国集群=冰糖，其他=Mia） | ✅ 一致 |
| 2 | `冰糖` | `冰糖` | 中文 / 女 | ✅ |
| 3 | `茉莉` | `茉莉` | 中文 / 女 | ✅ |
| 4 | `苏打` | `苏打` | 中文 / 男 | ✅ |
| 5 | `白桦` | `白桦` | 中文 / 男 | ✅ |
| 6 | `Mia` | `Mia` | 英文 / 女 | ✅ |
| 7 | `Chloe` | `Chloe` | 英文 / 女 | ✅ |
| 8 | `Milo` | `Milo` | 英文 / 男 | ✅ |
| 9 | `Dean` | `Dean` | 英文 / 男 | ✅ |

- 大小写与中文字面均逐字一致，无多余项、无缺项、顺序一致（测试断言 `deepEqual` 全序列）。
- 默认值 `DEFAULT_TTS_PRESET_VOICE='mimo_default'`（L10）与官方默认一致；`normalizePresetVoice`（L154-157）对空值/纯空白回落该默认值。
- ⚠️ 官方说明 `mimo_default` 的实际音色**因部署集群而异**（中国集群=冰糖）。UI 文案（L31）已注明，属正确提示。

---

## 3. 风格标签（音频标签控制）核对

| 项 | 官方要求（#1 音频标签控制） | 实现 | 结论 |
| --- | --- | --- | --- |
| 位置 | 目标文本**开头**，格式 `(风格)` | L169-173、L792：`(${tag})${body}` 紧贴正文 | ✅ |
| 括号格式 | 半角 `()`、全角 `（）`、方括号 `[]` 均支持 | L166-167 归一化时剥离 `[([（【` 与 `[)\]）】]` | ✅ 覆盖官方三种 |
| 多风格 | 同一括号内、分隔符不限 | `(温柔 磁性)` → `温柔 磁性`，原分隔保留 | ✅ |
| 空值 | —（实现取舍） | 空/纯空白/只有括号 → 不加任何标签 | ✅ 合理 |
| 唱歌模式 | `(唱歌)` 须在最开头 | 未实现唱歌模式入口 | ⚠️ 未实现（非本次需求，记录备查） |

实测样例（`applyStyleTag('正文。', style)`）：

```
(温柔) → (温柔)正文。      （温柔） → (温柔)正文。
[温柔] → (温柔)正文。      【温柔】 → (温柔)正文。
() / （） / [] / 【】 → 正文。（不加标签）
(温柔] / 温柔) / (温柔 → (温柔)正文。（容错）
空正文 + 风格 → ""        （不产生孤立标签）
```

---

## 4. 错误码映射核对（`readMimoErrorMessage`，L344-354）

官方错误码表（#6）与本实现逐条比对：

| 错误码 | 官方含义 | 实现位置与文案 | 结论 |
| --- | --- | --- | --- |
| 400 | 格式错误（JSON / 必需参数 / 参数值范围 / 消息格式 / 模型不存在 / 字段名） | L352：`语音合成请求格式错误（400）：请检查合成模型名、音频格式与文本长度` | ✅ 一致（本轮新增） |
| 401 | 认证失败（缺/无效 Key，`Authorization` 格式错误，Token Plan 与按量付费 Key 混用） | L348：`语音合成鉴权失败，请检查 MiMo 语音合成密钥（Token Plan 与按量付费的 Key 不可混用）` | ✅ 一致（本轮与 403 拆开） |
| 402 | 余额不足 | L350：`语音合成账户余额或额度不足` | ✅ 一致 |
| 403 | 拒绝访问（服务暂不支持当前地区，或 API Key 被风控） | L349：`语音合成被拒绝：服务暂不支持当前地区，或 API Key 被风控，请更换 Key 后重试` | ✅ 一致（本轮新增，语义与官方 403 对齐） |
| 421 | 内容拦截 | L351：`合成文本被内容审核拦截，请调整文本后重试` | ✅ 一致（本轮新增） |
| 429 | 请求超限（频率过高 / Token Plan 额度耗尽） | L347：`语音合成请求过于频繁（限流 100 RPM / 10M TPM），请稍后重试` | ✅ 一致（限流数值与 #4 一致） |
| 404 / 500 / 503 | 资源未找到 / 服务器失败 / 服务器故障 | L353 通用分支：`语音合成接口返回 ${status}` | ✅ 可接受（通用文案含状态码） |

- **优先级**：任何状态码下若响应体带 `error.message` / `message` / `error` / `msg`（L345-346），会**优先原样透出**上游文案 —— 优于纯状态码映射，实际排障多数情况能看到官方原文。
- 解析类独立错误：`当前浏览器不支持流式语音响应，请关闭流式合成`（L488）、`语音合成接口未返回音频数据`（L492 流式 / L500 非流式）。
- 六条专门文案均有静态锚点守护（测试「静态核对：错误码 400/401/402/403/421/429 各有专门映射文案」）。

---

## 5. 切分、长度与截断核对

| 项 | 官方 | 实现 | 结论 |
| --- | --- | --- | --- |
| 单块长度上限 | **官方未给出合成文本字数上限**（见 `docs/mimo-tts-api-spec.md` 第 10 节 #12；仅知上下文窗口 8K / 最大输出 8K） | `MAX_PRESET_CHUNK_LENGTH = 600`（L20），并有 40 的下限保护（L220） | ✅ 属实现取舍，600 字远低于 8K 上下文，合理 |
| 段数上限 | 无 | 预置与 voicedesign 都受 `MAX_SEGMENTS = 40`（L13）约束，`buildSpeechPlan` 预置分支 `chunks.slice(0, MAX_SEGMENTS)`（L832）并置 `truncated`（L831） | ✅ 一致口径 |
| 截断判定 | — | `normalizeVoicePlan` 先记 `truncated = segments.length > MAX_SEGMENTS`（L324）再截断（L325）；`buildSpeechPlan` voicedesign 分支直接用 `plan.truncated === true`（L823） | ✅ 恰好 40 段不会误报（测试已锁） |
| 截断提示 | — | L911-915：按模式区分文案，preset 提示「只朗读前 40 块（约 24000 字）」，voicedesign 提示「只朗读前 40 段」 | ✅ 合理 |
| 切分原则 | — | 先按空行分段（L227），超长段落按句末标点断句（L196，含半角句号），仍超长时 `hardWrapSpeechText` 在末 20% 窗口回退到空白断点（L180-183），断不开才按上限硬切 | ✅ 见第 6 节实测 |

### 5.1 `hardWrapSpeechText`（L176-189）算法核对

```
window = max(1, floor(limit * 0.2))        // 600 → 120
breakAt = max(head.lastIndexOf(' '), head.lastIndexOf('\t'))
cut = breakAt >= limit - window ? breakAt + 1 : limit
pieces.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trimStart();
```

- 每轮至少前进 `limit - window`（600-120=480）字符，**不会死循环**；`rest` 单调变短，循环必然终止。
- 找不到断点（无空白的长串）时严格按 `limit` 切，实测 `'a'.repeat(1500)` → `[600, 600, 300]`，无丢字。
- 副作用：切点处的 1 个空白被 `trim` / `trimStart` 裁掉（见第 6 节残余观察 R-1）。

---

## 6. 上一轮反例的修复验证（已转绿，保留为回归护栏）

> 判定方式：`node tests/tts-preset.test.mjs`，三条用例现均为 `[契约]` 且 PASS。

### P1-1 英文长串在词边界断开（原 L191 硬切）→ ✅ 已修复

- 修复位置：`hardWrapSpeechText`（L176-189），由 `splitOversizeBlock` 的超长句分支调用（L205-208）。
- 实测（`Array.from({length:400},(_,i)=>\`word${i}\`).join(' ')`，3089 字 → 6 段）：

  ```
  [0] len=598 头="word0 word1 word2 "  尾="rd84 word85 word86"
  [1] len=594 头="word87 word88 word"  尾="60 word161 word162"
  [2] len=599 头="word163 word164 wo"  尾="35 word236 word237"
  [3] len=599 头="word238 word239 wo"  尾="10 word311 word312"
  [4] len=599 头="word313 word314 wo"  尾="85 word386 word387"
  [5] len=95  头="word388 word389 wo"  尾="97 word398 word399"
  ```

- 每个片段的**首尾都是完整单词**（`word86` | `word87`、`word162` | `word163` …），词序列与原文完全一致，无单词被切开。

### P1-2 半角句号 `.` 参与断句（原 L183 字符集缺 `.`）→ ✅ 已修复

- 修复位置：断句正则 L196 `/[^。！？!?…；;.\n]+[。！？!?…；;.]*|\n/g`（加入半角句号）。
- 实测（`'She folded … a thing. '.repeat(40).trim()`，3559 字 → 7 段，每段 533 字）：

  ```
  [0] len=533 头="She folded the let" 尾="obody saw a thing."
  …（共 6 段 533 字）
  [6] len=355 头="She folded the let" 尾="obody saw a thing."
  ```

- 片段以句末 `.` 结尾、以完整单词开头；词序列与原文一致。**不再落 600 硬切**（533 < 600，说明是按句号成组）。

### P2-1 同一片段内相邻句保留空白（原 `joinSpeechPieces` 只对字母数字边界补空格）→ ✅ 已修复

- 修复位置：`splitOversizeBlock` 改为 `buffer += sentence`（L211），保留原文自带的前导空白，仅在 `flush()` 时对整块 `trim()`（L197-201）；`joinSpeechPieces` 已删除（静态锚点守护）。
- 实测（`'Watch out now! '.repeat(60).trim()`，899 字 → 2 段）：

  ```
  [0] len=599 头="Watch out now! Wat"  尾="ow! Watch out now!"
  [1] len=299 头="Watch out now! Wat"  尾="ow! Watch out now!"
  ```

- 段内 `!` 后**始终跟着空格**，不再出现修前的 `"that?Are you sure…"` 式粘连；词序列与原文一致。

### 残余观察（不判失败）

| # | 现象 | 位置 | 影响 |
| --- | --- | --- | --- |
| R-1 | **切点处会裁掉 1 个边界空白**（`join('')` 比原文少 N-1 个空白字符，N = 片段数）。实测：400 词丢 5、`. 句` 丢 6、`! 句` 丢 1、中文多段丢 40 | L184-185（`trim()` / `trimStart()`）、L198（`flush()` 的 `trim()`） | 无实害：片段是彼此独立的 TTS 请求，边界空白本来就不产生读音。**非空白字符 100% 逐字守恒**（测试以 `noWs(join('')) === noWs(source)` 断言） |
| R-2 | CRLF（`\r\n\r\n`）不被 `/\n{2,}/` 命中（L227），分段退化为逐行；短文本片段内残留 `\r` | L219-241 | **真实链路不可达**：上游 `stripForSpeech`（L143）已按 `\n` 拆行并 `trim()`，CRLF 进入切分前已归一化为 LF。实测 CRLF 输入仍满足「非空白不丢字、不超限、无空段」 |
| R-3 | 正文自身以 `(磁性)` 开头时，`applyStyleTag` 会叠加为 `(温柔)(磁性)正文` | L169-173 | 官方未定义「连续两个括号」的语义；可考虑检测已有标签则不再前置。未判失败 |
| R-4 | 预置模式也受 `MAX_SEGMENTS = 40` 截断（> 24000 字只读前 40 块） | L831-832、L911-915 | 已有按模式区分的提示文案，可接受 |

---

## 7. 官方未写明 / 实现自行取舍（不算偏离）

| # | 项 | 现状 |
| --- | --- | --- |
| 1 | 合成文本字数上限 | 官方未给（`docs/mimo-tts-api-spec.md` 第 10 节 #12），实现取 600 字/块 |
| 2 | Bearer 鉴权请求头逐字原文 | 官方页面只渲染了 `api-key:` 代码块，Bearer 分支由标签名与 401 说明推得；实现采用 `Authorization: Bearer <key>` |
| 3 | 流式分片大小 / 分片策略 | 官方示例未给固定值；实现不假设分片大小，逐行解析 SSE 后按字节累积 |
| 4 | TTS 是否支持 Token Plan / 批量推理 Base URL | 官方未说明；实现沿用同一 `ttsApiUrl` 设置 |
| 5 | 流式 SSE 的 `data:` 行前缀细节 | 官方示例按 `data:` 前缀解析；实现同时跳过空行、注释行（`:` 开头）与 `[DONE]` |
| 6 | 硬切回退窗口比例 | 官方无要求；实现取 20%（L180），是本次为修 P1-1 引入的取舍 |

---

## 8. 复现方式与实测结果

### 8.1 运行命令（实测可用）

```powershell
cd E:\project\rphub-raw
node tests\tts-preset.test.mjs
```

- `node` 取自 PATH：`C:\nvm4w\nodejs\node.exe`，实测版本 **v24.16.0**（Node 18+ 原生提供 `atob` / `Blob` / `TextDecoder`，无需额外开关）。
- 零第三方依赖（仅用 `node:assert/strict`、`node:fs`、`node:path`、`node:crypto`、`node:url`）。
- 打桩：`globalThis.window = {}`、`globalThis.Vue = { reactive: v => v, ref: v => ({ value: v }) }`，再用 `new Function(source)()` 执行该 IIFE，随后从 `window.RPHubTts` 取纯函数。
- 退出码：全绿为 0；存在契约违约或反例为 1。**当前为 0。**

### 8.2 实测结果（被测版本 sha256 前 16 位 `57cf7e6d3e05102a`，1091 行）

```
合计 40：PASS 40，契约违约 0，反例（实现待修）0，SKIP 0
（无失败明细）
```

静态锚点命中（由测试输出）：

```
字段锚点：预置模型常量=L9，流式必须 pcm16=L789，非流式走 wav=L11，voice 仅在非空时写入 audio=L464，
         目标文本放在 assistant 消息=L469，风格指令放在 user 消息=L468，Bearer 鉴权请求头=L476，
         Content-Type: application/json=L476，stream 为真时才写入请求体=L473，
         流式分片只取 delta.audio.data=L420，非流式只取 message.audio.data=L498，
         SSE 结束标记 [DONE] 被跳过=L417，预置路径每块都加风格标签=L792
错误码锚点：429=L347，401=L348，403=L349，402=L350，421=L351，400=L352，上游 error.message 优先=L345，兜底=L353
切分锚点：空白断点回退=L182，20% 回退窗口=L180，断不开才硬切=L183，断句字符集含半角句号=L196，
         合并相邻句保留原文空白=L211，旧 joinSpeechPieces=已移除
```

### 8.3 用例覆盖清单（40 例）

| 分组 | 覆盖内容 | 结果 |
| --- | --- | --- |
| 导出面 / 常量 | 5 个预置纯函数已导出；voicedesign 链路未被移除；`DEFAULT_TTS_PRESET_MODEL` / `DEFAULT_TTS_PRESET_VOICE` / `TTS_PCM_SAMPLE_RATE` / `MAX_PRESET_CHUNK_LENGTH` / 模式常量 | 3 例绿 |
| 预置音色全集 | `PRESET_VOICE_OPTIONS` 与官方 9 项逐字比对（含顺序） | 1 例绿 |
| 归一化 | `normalizePresetVoice` / `normalizeTtsMode` 空值与非法值回落 | 1 例绿 |
| 截断口径 | `normalizeVoicePlan` 的 `truncated`：5 段 false、40 段 false、41 段 true 且截到 40 | 1 例绿 |
| `splitForPresetSpeech` | 空值/纯空白（含 CRLF+全角空格）；短文本单段；无标点超长硬切（恰好上限、上限 +1）；自定义上限与 40 下限；超长多段；CRLF 与连续空行；无空白超长串回退硬切；英文非空白逐字守恒；英文多段；`!`/`?` 断句；**P2-1 段内不粘连回归**；**P1-1 词边界回归**；**P1-2 句号断句回归** | 14 例全绿 |
| `normalizeStyleTag` / `applyStyleTag` | `温柔` / `（温柔）` / `(温柔)` / `[温柔]` / `【温柔】` / 空值 / 只有括号 / 多风格 / 空正文 | 6 例绿 |
| `buildWavBlob` | Blob 与 MIME；44 字节头逐字段；PCM 原样写入；空 PCM；小端序逐字节 | 5 例绿 |
| `base64ToBytes` | 纯 base64；data URL 前缀；换行与空格；空值；0x00–0xFF 往返 | 5 例绿 |
| 链路形状 | WAV 头 + base64 分片端到端拼装；`concatBytes` | 2 例绿 |
| 源码静态核对 | 13 个字段级锚点；8 个错误码锚点；6 个切分链路锚点（含「旧 `joinSpeechPieces` 已移除」） | 3 例绿 |

---

## 9. 结论

1. **接口层与官方完全一致**：请求体、请求头、音色全集、流式 PCM 与 WAV 头封装均无偏差；错误码六条已各有专门文案，401/403 语义分开。
2. **上一轮三个反例（P1-1 词中硬切、P1-2 缺半角句号断句、P2-1 合并丢空格）已修复**，并已转为常驻回归护栏，后续改动一旦回退会立刻变红。
3. **唯一残余是 R-1（切点裁掉 1 个边界空白）**：属于「片段是独立 TTS 请求」前提下的合理裁剪，非空白字符逐字守恒，不建议为此改动实现；若将来改为把多片段拼成一个请求再发送，则必须先修掉这条。
4. 测试可直接纳入回归：`node tests\tts-preset.test.mjs`，零依赖、可重复、逐例给出期望值与实测值，退出码即结论。
