# 小米 MiMo 语音合成（MiMo-V2.5-TTS 系列）API 技术规范

> 整理日期：2026-11-05
> 取证方式：抓取 mimo.mi.com 官方文档页面原文
> 标注约定：**`⚠️未确认`** = 官方文档未写明，属于推断或实测待验证

## 来源清单（取证 URL 与结果）

| # | URL | 状态 | 提供内容 |
| --- | --- | --- | --- |
| 1 | https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5 | ✅ 200 | 模型对比、调用规则、风格控制、标签表、预置音色表、voicedesign 写法与禁忌、Python 示例 |
| 2 | https://mimo.mi.com/docs/zh-CN/api/audio/tts-post | ✅ 200 | **权威接口规范**：请求地址、请求头、请求体字段、非流式/流式响应结构、curl 示例、响应示例 |
| 3 | https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call | ✅ 200 | BASE_URL 一览、鉴权方式、OpenAI/Anthropic 兼容协议、API Key 格式 |
| 4 | https://mimo.mi.com/docs/zh-CN/api/guidance/rate-limit | ✅ 200 | TTS 三模型 RPM/TPM 限流配额 |
| 5 | https://mimo.mi.com/docs/zh-CN/quick-start/summary/model | ✅ 200 | 模型能力矩阵、上下文窗口/最大输出、限流、选型指南 |
| 6 | https://mimo.mi.com/docs/zh-CN/api/guidance/error-codes | ✅ 200 | 400/401/402/403/404/421/429/500/503 错误码表 |
| 7 | https://mimo.mi.com/docs/zh-CN/api/guidance/model-hyperparameters | ✅ 200 | temperature / top_p 默认值与范围（**仅文本生成模型，未列 TTS**） |
| 8 | https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go | ✅ 200 | TTS 系列计费口径（限时免费） |
| 9 | https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/Speech-Recognition | ✅ 200 | ASR 对照页（音频格式/MIME 参考） |
| 10 | https://mimo.mi.com/docs/en/quick-start/usage-guide/audio/speech-synthesis-v2.5 | ❌ 空 | 英文版返回空壳，无内容 |
| 11 | https://mimo.mi.com/docs/zh-CN/api/audio/tts-post.md | ❌ 空 | 非 `.md` 端点，返回空壳 |
| 12 | 站内搜索 `mimo-v2.5-tts-voicedesign` 的 API 参考页 | ✅ 命中 | 即 #2（`/docs/zh-CN/api/audio/tts-post`） |

**未抓到的内容**：语音合成指南页「使用音频样本复刻音色进行语音合成（voiceclone）」章节正文（页面在 `optimize_text_preview` 流式注意事项处被截断）；API 参考页 curl 代码块中「音色设计 / 音色克隆」两个 tab 的完整代码（页面只渲染了默认「语音合成」tab）。相关字段语义已从 API 参考页的字段说明中取证，见下文第 3 节。

---

## 1. 接口地址与鉴权

### 1.1 请求地址

```bash
https://api.xiaomimimo.com/v1/chat/completions
```

> 来源：#2 API 参考页「请求地址」

### 1.2 Base URL（按计费方式区分）

| 使用方式 | 协议 | BASE_URL | API Key 格式 |
| --- | --- | --- | --- |
| 按量付费 API | OpenAI 兼容 | `https://api.xiaomimimo.com/v1` | `sk-xxxxx` |
| 按量付费 API | Anthropic 兼容 | `https://api.xiaomimimo.com/anthropic` | `sk-xxxxx` |
| 批量推理 | OpenAI 兼容 | `https://batch-api-cn.xiaomimimo.com/v1` | `sk-xxxxx` |
| Token Plan | OpenAI 兼容 | `https://token-plan-cn.xiaomimimo.com/v1` | 个人版 `tp-xxxxx` / 团队版 `ttp-xxxxx` |
| Token Plan | Anthropic 兼容 | `https://token-plan-cn.xiaomimimo.com/anthropic` | 同上 |

> 来源：#3 首次调用 API
> **TTS 走 Chat Completions 协议**，即使用 `{BASE_URL}/chat/completions`。
> ⚠️未确认：TTS 是否支持 Token Plan / 批量推理的 Base URL（官方未在 TTS 页面说明；Token Plan 与按量付费 Key **不可混用**，见 #6 错误码 401）。

### 1.3 请求头（两种鉴权二选一）

**API Key 鉴权：**

```json
api-key: $MIMO_API_KEY
Content-Type: application/json
```

**Bearer 鉴权：**

```json
Authorization: Bearer $MIMO_API_KEY
Content-Type: application/json
```

> 来源：#2 API 参考页「请求头」— 原文表述为「接口支持以下两种认证方式，请选择其中一种添加到请求头中：API Key 鉴权 / Bearer 鉴权」，两个 tab 共用同一段说明。
> ⚠️未确认：Bearer tab 下请求头字段的**逐字原文**（页面只渲染了 API Key tab 的 `api-key: $MIMO_API_KEY` 代码块）。Bearer 的写法由「Bearer 鉴权」标签名与 #6 错误码 401 中「或 `Authorization` 请求头格式错误」交叉推得。

### 1.4 最小必需请求头

| 请求头 | 必需 | 说明 |
| --- | --- | --- |
| `api-key` 或 `Authorization` | ✅ 必需 | 二者之一 |
| `Content-Type: application/json` | ✅ 必需 | 文档明确列出 |

---

## 2. 三个模型的差异

| 项目 | `mimo-v2.5-tts` | `mimo-v2.5-tts-voicedesign` | `mimo-v2.5-tts-voiceclone` |
| --- | --- | --- | --- |
| 功能 | 使用预置精品音色进行语音合成 | 通过文本描述定制音色 | 基于音频样本复刻任意音色 |
| 音色来源 | 预置音色列表 | 文本描述自动生成，无需预置或音频样本 | 音频样本精准复刻 |
| `audio.voice` 是否支持 | ✅ 可选，仅支持预置音色，默认 `mimo_default` | ❌ **不支持该字段** | ✅ **必填**，仅支持传入音频样本的 base64 编码 |
| `audio.voice` 取值范围 | `mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean` | — | mp3 / wav 音频样本的 base64 字符串 |
| `user` 消息 | 可选（传入指令调整语气与风格，或作为对话历史） | ✅ **必填**（音色设计描述文本） | 可选 |
| `assistant` 消息 | ✅ 必需（承载合成目标文本） | 必需；但 `optimize_text_preview: true` 时可省略 | ✅ 必需 |
| 唱歌模式 | ✅ 支持（须在 assistant 文本最开头加 `(唱歌)`） | ❌ 不支持 | ❌ 不支持 |
| 流式支持 | ✅ 已上线低延迟流式，可实时返回 | ⚠️ **低延迟流式暂未上线**；当前降级为兼容模式，**仅在所有推理完成后以流式格式返回一次结果** | ⚠️未确认（官方页面未说明） |
| 上下文窗口 / 最大输出 | 8K / 8K | 8K / 8K | 8K / 8K |
| RPM / TPM | 100 / 10M | 100 / 10M | 100 / 10M |

> 来源：#1 指南页「支持的模型列表」「通用注意事项」「使用预置音色进行语音合成」「使用文本设计音色」；#2 API 参考页 `audio.voice` 字段说明；#5 模型列表页；#4 速率限制页

### 2.1 messages 角色要求（核心规则）

| 角色 | 放什么 | 必需性 | 是否会被合成成语音 |
| --- | --- | --- | --- |
| `role: "user"` | 自然语言风格/语气指令；voicedesign 时为**音色设计描述**；也可以是对话历史 | `mimo-v2.5-tts` 可选；`voicedesign` **必填**；`voiceclone` 可选 | ❌ **不会**（原文：消息内容不会出现在合成的语音中） |
| `role: "assistant"` | **语音合成的目标文本**（要念出来的那句话），以及音频标签控制内容 | 必需（`voicedesign` + `optimize_text_preview: true` 时可省略） | ✅ 会 |

> 原文强调：「语音合成的目标文本需填写在 `role` 为 `assistant` 的消息中，**不可放在 `user` 角色的消息内**。」

---

## 3. 请求体完整字段表

**Endpoint**：`POST https://api.xiaomimimo.com/v1/chat/completions`

| 字段 | 类型 | 必填 | 取值 / 说明 | 默认值 |
| --- | --- | --- | --- | --- |
| `model` | string | ✅ 必填 | `mimo-v2.5-tts`、`mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone` | — |
| `messages` | array | ✅ 必填 | 对话消息列表 | — |
| `messages[].role` | string | ✅ 必填 | `user` / `assistant` | — |
| `messages[].content` | string | ✅ 必填 | `user`：风格指令或音色描述；`assistant`：合成目标文本 + 标签 | — |
| `audio` | object | 文档未标必填（要出音频则实际必需） | 音频输出参数 | — |
| `audio.format` | string | 否 | `wav`、`mp3`、`pcm`、`pcm16`。**传入 `pcm` 或 `pcm16` 均表示使用 pcm16 格式** | `wav`；若 `stream: true` 则为 `pcm` |
| `audio.voice` | string | 视模型而定 | 预置音色的音色 ID **或** 音频样本的 base64 编码。三模型差异见第 2 节表 | `mimo_default`（仅 `mimo-v2.5-tts`） |
| `audio.optimize_text_preview` | boolean | 否 | 是否开启目标音频播报文本智能优化。`true` 时对传入目标文本智能润色；未传目标文本则自动生成适配播报场景的文本。**仅支持 `mimo-v2.5-tts-voicedesign`** | `false` |
| `stream` | boolean | 否 | `true` 时以 SSE（server-sent events）形式流式传输 | `false` |

> 来源：#2 API 参考页「请求体」逐字段说明

### 3.1 其他可能字段

| 字段 | 状态 | 说明 |
| --- | --- | --- |
| `temperature` / `top_p` | ⚠️未确认 | 官方「模型超参」页**只列了 `mimo-v2.6-flash` / `mimo-v2.6-pro` / `mimo-v2.6-pro-ultraspeed`** 的默认值与范围（默认 1.0 / 0.95），**未列任何 TTS 模型**。TTS 是否接受该参数未知。 |
| `max_completion_tokens` / `stop` / `frequency_penalty` / `presence_penalty` | ⚠️未确认 | 首次调用 API 页的文本生成示例中出现，TTS 页面未提及。 |
| `tool_calls` | 观测到 | 非流式响应示例中 `choices[0].message` 含 `"tool_calls": null`，属响应字段而非请求字段。 |
| `asr_options` | 不适用 | 属 ASR 模型（`mimo-v2.5-asr`）专用参数。 |

---

## 4. 响应体结构

### 4.1 非流式响应（`object: "chat.completion"`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 响应唯一标识符 |
| `choices` | array | 生成的回复选项列表 |
| `choices[].finish_reason` | string | `stop`（自然结束或触发停止序列）/ `length`（超出最大生成长度）/ `content_filter`（内容被过滤拦截） |
| `choices[].index` | integer | 选项索引 |
| `choices[].message` | object | 模型生成的对话补全消息 |
| `choices[].message.content` | string | 消息内容（TTS 场景下实测/示例中为空字符串 `""`） |
| `choices[].message.role` | string | 消息作者角色（`assistant`） |
| `choices[].message.audio` | object | 音频响应数据 |
| `choices[].message.audio.id` | string | 音频响应唯一标识符 |
| **`choices[].message.audio.data`** | **string** | **✅ 是的，Base64 编码音频**，格式为请求中指定的格式 |
| `choices[].message.audio.expires_at` | number \| null | 音频过期 Unix 时间戳（秒）。**当前仅为 `null`** |
| `choices[].message.audio.transcript` | string \| null | 音频文字记录。**当前仅为 `null`** |
| `choices[].message.final_text_preview` | string | 智能优化润色后的最终播报文本。**仅当 `optimize_text_preview: true` 时返回** |
| `created` | integer | 创建时间 Unix 时间戳（秒） |
| `model` | string | 用于生成结果的模型 |
| `object` | string | 固定 `chat.completion` |
| `usage` | object \| null | 用量信息 |
| `usage.completion_tokens` | integer | 输出消耗 token |
| `usage.prompt_tokens` | integer | 提示词 token 数 |
| `usage.total_tokens` | integer | 总 token 数 |
| `usage.completion_tokens_details.reasoning_tokens` | integer | **固定为 `0`** |
| `usage.prompt_tokens_details.cached_tokens` | integer | 命中缓存的 token 数 |

**官方非流式响应示例（原文）：**

```json
{
    "id": "6ebed286b58546f6b87fa7fa9d0e806b",
    "choices": [
        {
            "finish_reason": "stop",
            "index": 0,
            "message": {
                "content": "",
                "role": "assistant",
                "audio": {
                    "id": "979a91904f9a4143928d9e1f54837b4f",
                    "data": "base64Data",
                    "expires_at": null,
                    "transcript": null
                },
                "tool_calls": null
            }
        }
    ],
    "created": 1776954802,
    "model": "mimo-v2.5-tts",
    "object": "chat.completion",
    "usage": {
        "completion_tokens": 97,
        "prompt_tokens": 213,
        "total_tokens": 310,
        "completion_tokens_details": { "reasoning_tokens": 0 },
        "prompt_tokens_details": { "cached_tokens": 109 }
    }
}
```

> **注意**：非流式响应中**没有** `audio.format` 顶层字段 —— 音频格式由请求参数决定，不随响应回传。文档也未定义 `audio.sample_rate` 等字段。

### 4.2 流式响应（`object: "chat.completion.chunk"`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 每个数据块**使用相同的 ID** |
| `created` | integer | 每个数据块**使用相同的时间戳** |
| `model` | string | 用于生成结果的模型 |
| `object` | string | 固定 `chat.completion.chunk` |
| `choices` | array | 回复选项列表 |
| `choices[].index` | integer | 选项索引 |
| `choices[].finish_reason` | string \| null | 同非流式三值；中间分片为 `null` |
| `choices[].delta` | object | 流式增量 |
| `choices[].delta.content` | string | 数据块消息内容 |
| `choices[].delta.role` | string | 消息作者角色 |
| `choices[].delta.audio` | object \| null | 音频响应数据 |
| **`choices[].delta.audio.data`** | **string** | **Base64 编码音频分片** |
| `choices[].delta.audio.id` | string | 音频响应唯一标识符 |
| `choices[].delta.audio.expires_at` | number \| null | 当前仅为 `null` |
| `choices[].delta.audio.transcript` | string \| null | 当前仅为 `null` |
| `choices[].delta.final_text_preview` | string | 仅当 `optimize_text_preview: true` 时返回 |
| `usage` | object \| null | 用量信息，结构同非流式 |

> 官方 Python 流式示例中通过 `chunk.choices[0].delta.audio` 取值，并断言其为 dict，再取 `audio["data"]`。

---

## 5. 音频格式与流式拼接

### 5.1 支持的格式

| `audio.format` 取值 | 说明 |
| --- | --- |
| `wav` | 默认值。**流式调用时不作为默认** |
| `mp3` | 支持 |
| `pcm` | **等价于 pcm16**（原文：「传入 `pcm` 或 `pcm16`，均表示指定使用 `pcm16` 格式」） |
| `pcm16` | 推荐用于流式调用，便于拼接 |

### 5.2 音频参数（流式）

| 参数 | 值 | 依据 |
| --- | --- | --- |
| 采样率 | **24000 Hz（24kHz）** | 官方 Python 流式示例注释 `# 24kHz PCM16LE mono audio`，且保存时 `samplerate=24000` |
| 位深 | **16 bit** | 示例用 `dtype=np.int16` 解析 |
| 字节序 | **Little Endian（LE）** | 示例注释明确 `PCM16LE` |
| 声道数 | **单声道（mono）** | 示例注释明确 `mono` |
| 编码 | 裸 PCM（无文件头） | 示例直接 `np.frombuffer` 解析后写入 wav |

### 5.3 流式拼接方法（官方推荐流程）

1. 请求时设 `"audio": {"format": "pcm16"}` 且 `"stream": true`。
2. 逐 chunk 取 `choices[0].delta.audio`；注意部分 chunk 的 `choices` 为空，需跳过。
3. 对每个分片的 `audio["data"]` 做 `base64.b64decode` 得到 PCM 字节。
4. 按 `np.int16` 解析并追加到累积缓冲区（`np.frombuffer(pcm_bytes, dtype=np.int16)`）。
5. 全部收集完后一次性写为 24kHz 单声道 wav（`sf.write(path, data, samplerate=24000)`）。

> **关键点**：格式必须指定为 `pcm16`，因为 wav/mp3 是带容器头的格式，分片无法直接首尾拼接；PCM 是裸流，可直接字节级拼接。

---

## 6. 音色设计（voicedesign）最佳实践

> 来源：#1 指南页「如何写好音色描述（voice design prompt）」

### 6.1 user 消息 = 音色设计描述

使用 `mimo-v2.5-tts-voicedesign` 时，**`user` 消息中的文本就是音色设计描述**。描述越具体、越生动，生成的音色越贴近预期。

### 6.2 关键维度（不必面面俱到）

| 维度 | 示例（官方原文） |
| --- | --- |
| **性别与年龄** | "young woman in her mid-20s"、"五十多岁的中年男性" |
| **音色/质感** | "deep and gravelly"、"丝滑醇厚、带着磁性" |
| **情绪/语气** | "warm and confident"、"温柔但带着一丝疲惫" |
| **语速/节奏** | "slow and deliberate"、"语速极快，像连珠炮" |

**可选加分维度：**

- **角色/人设**：narrator, podcast host, 评书先生, 深夜电台DJ
- **说话风格**：casual and colloquial, 一本正经地, 压低嗓音像在密谋
- **场景描写**：narrating a nature documentary, 在给投资人路演
- **年代参照**：1940s film noir, 八十年代译制片配音

### 6.3 两种写法范式

**简洁描述型**（关键词或一句话）：

```text
Heavy Russian accent, gruff middle-aged male, blunt and matter-of-fact.
```

**专业描述型**（场景/人设/多维度立体刻画）：

```text
Young female, extreme close-up with a binaural, ear-to-ear ASMR feel. Audible breathing, subtle swallowing, and soft natural lip sounds. She speaks very slowly, creating a deeply relaxing and immersive experience.
```

```text
一位年迈的老先生，说带北方口音的普通话，语速缓慢而沉稳，嗓音略带沙哑和沧桑感，仿佛一位饱经风霜的老爷爷在讲故事，充满岁月的智慧。
```

### 6.4 注意事项（官方明确的禁忌）

| 条目 | 要求 |
| --- | --- |
| **长度** | **1-4 句即可**，不需要写长文。核心特征描述清楚比堆砌维度更重要 |
| **避免冲突** | 不要同时要求矛盾特征（如"稚嫩的童声 + CEO气场"） |
| **避免音质效果词** | **不要写混响、回声、EQ、压缩等后期处理相关描述** |
| **避免模糊词** | 不要用"普通的""正常的""外国的"等缺乏具体指向的描述 |
| **中英文均可** | 模型同时支持中英文音色描述，选择最能精确表达的语言 |
| **合成文本要贴合音色** | `assistant` 消息中的合成文本应与音色描述匹配（如"温柔治愈系女声"配晚安独白，而非激烈体育解说）。建议用 LLM 按音色描述自动生成适配文本；Studio 页面有「生成文本」按钮 |

### 6.5 `optimize_text_preview` 用法

- `optimize_text_preview: true` 时：对传入目标文本做智能润色；**若未传入目标文本，则自动生成适配播报场景的目标文本**，再将处理完成的最终文本送入模型合成。
- 此时**可省略 `assistant` 消息**。
- 润色后的最终文本会在响应的 `final_text_preview` 字段返回。
- **仅支持 `mimo-v2.5-tts-voicedesign` 模型。**

---

## 7. 风格控制：两种机制

> 来源：#1 指南页「风格控制」。**两种方式的内容在 messages 中的放置位置不同。**

| 机制 | 放置位置 |
| --- | --- |
| **自然语言控制** | `role: user` 的 `content` |
| **音频标签控制** | `role: assistant` 的 `content` |

### 7.1 自然语言控制（user 消息）

一条自然语言指令即可生效。官方示例：

```text
用轻快上扬的语调向领导报喜，语速稍快，带着查到成绩后压抑不住的激动与小骄傲，声音明亮有活力。
```

```text
看着刚解决的难题成果忍不住得意忘形地惊呼，声音高亢明亮，语速偏快，语气中带着满满的自信与难以置信。
```

```text
用明亮活泼的青少年嗓音，带着恶作剧得逞后的得意与戏谑，语速偏快且咬字轻巧，在强调赌注时语气微微上扬。
```

**能力边界（官方声称）：**

- **多风格切换**：同一段语音内完成 *播报 → 低语 → 嘶吼* 转场，过渡自然
- **多情绪混合**：支持"压抑的愤怒"、"带着哽咽的笑意"、"温柔但疲惫"、"狂躁中的温柔"等复合情绪
- **多粒度控制**：段落级（整体基调）→ 句子级（节奏）→ 词级（重音）→ 字粒度（某个字的哽咽、拖音、气音）

#### 导演模式（更精细的三段式写法）

像给演员写剧本一样，从**角色、场景、指导**三个维度刻画：

| 维度 | 写法要求 |
| --- | --- |
| **【角色】** | 写清人物的身份、性格底色、外形气质与说话习惯 |
| **【场景】** | 交代此刻发生了什么、和谁说话、情绪处在什么位置。越具体越好——时间、地点、事件、对方反应都可以写进来 |
| **【指导】** | 像导演给演员下达演绎要领：语速、气息、停顿、重音、共鸣位置、音色质感、情绪起伏。可以写得细腻 |

官方导演模式示例（原文）：

```text
角色：百年门阀岑家的现任大当家。自出生便被过继给祖庙的守门老人抚养，被塑造成一尊完美无瑕、绝情断欲的家族图腾。常年深居简出，对人有着极强的阶级疏离感。

场景：在祠堂的阴影里，看着那个不顾一切冲破保安防线来找她、企图带她私奔的男人。她要用最冷硬的阶级壁垒，绞杀对方，也绞杀自己刚刚萌芽、却足以燎原的感情。

指导：
冰冷、慵懒却极具威压的低音御姐。发声通道非常松弛，没有任何剑拔弩张，却有着让人骨里生寒的压迫感。

- 语速与顿挫：极慢，每个字都像是在舌尖滚过才吐出来，带着上位者漫不经心的傲慢。句与句之间留下极长的、令人不安的空白。
- 气声与实声：大部分时间，她的声音没有明显的声调起伏，实音重且硬，像是一条平缓却冰冷的暗河。但一定要在某些尾音处（如"真心"），加入极其轻微的气音收束，透出一丝连她自己都没察觉到的疲惫与渴望。
- 咬字肌理：文白杂糅的用词带着旧时代的痕迹，唇齿音发得极轻但极清晰（如"冲撞""廉价"），显得既清雅又锋利，刀刀见血。
```

### 7.2 音频标签控制（assistant 消息）

**语法规则：**

| 规则 | 细节 |
| --- | --- |
| 整体风格标签位置 | 目标文本**开头**，格式 `(风格)` |
| 多风格同时设置 | 多个风格名放**同一对括号内**，**分隔符不限**。格式：`(风格1 风格2)待合成内容` |
| 支持的括号格式 | 半角 `()`、全角 `（）`、方括号 `[]` |
| 细粒度音频标签 | 在文本**任意位置**插入 `[音频标签]` |
| 唱歌模式 | **必须在目标文本最开头**加 `(唱歌)`，格式 `(唱歌)歌词`。歌词建议中文。等效取值：`唱歌`、`sing`、`singing` |

#### 风格标签表（`(风格)` 前缀用）

| 风格类型 | 风格示例 |
| --- | --- |
| 基础情绪 | 开心 / 悲伤 / 愤怒 / 恐惧 / 惊讶 / 兴奋 / 委屈 / 平静 / 冷漠 |
| 复合情绪 | 怅然 / 欣慰 / 无奈 / 愧疚 / 释然 / 嫉妒 / 厌倦 / 忐忑 / 动情 |
| 整体语调 | 温柔 / 高冷 / 活泼 / 严肃 / 慵懒 / 俏皮 / 深沉 / 干练 / 凌厉 |
| 音色定位 | 磁性 / 醇厚 / 清亮 / 空灵 / 稚嫩 / 苍老 / 甜美 / 沙哑 / 醇雅 |
| 人设腔调 | 夹子音 / 御姐音 / 正太音 / 大叔音 / 台湾腔 |
| 方言 | 东北话 / 四川话 / 河南话 / 粤语 |
| 角色扮演 | 孙悟空 / 林黛玉 |
| 唱歌 | 唱歌 |

> 官方说明：「以下是一些**推荐**风格，同时也**支持使用未在列表中的自定义风格**。」

**风格标签样例：**

```text
(怅然)这么多年过去了，再走过那条街，心里一下子空了一块。
(慵懒)再让我睡五分钟……就五分钟，真的，最后一次。
(磁性)夜已经深了，城市还在呼吸。我是今晚陪你的人，欢迎收听《午夜电台》。
(东北话)哎呀妈呀，这天儿也忒冷了吧！你说这风，嗖嗖的，跟刀子似的，割脸啊！
(粤语)呢个真係好正啊！食过一次就唔会忘记！
(唱歌)原谅我这一生不羁放纵爱自由，也会怕有一天会跌倒，Oh no。背弃了理想，谁人都可以，哪会怕有一天只你共我。
```

#### 音频标签表（`[音频标签]` 插入用）

| 风格类型 | 风格示例 |
| --- | --- |
| 语速与节奏 | 吸气 / 深呼吸 / 叹气 / 长叹一口气 / 喘息 / 屏息 |
| 情绪状态 | 紧张 / 害怕 / 激动 / 疲惫 / 委屈 / 撒娇 / 心虚 / 震惊 / 不耐烦 |
| 语音特征 | 颤抖 / 声音颤抖 / 变调 / 破音 / 鼻音 / 气声 / 沙哑 |
| 哭笑表达 | 笑 / 轻笑 / 大笑 / 冷笑 / 抽泣 / 呜咽 / 哽咽 / 嚎啕大哭 |

**音频标签样例（注意官方示例中实际用圆括号内嵌描述，如 `（紧张，深呼吸）`）：**

```text
（紧张，深呼吸）呼……冷静，冷静。不就是一个面试吗……（语速加快，碎碎念）自我介绍已经背了五十遍了，应该没问题的。加油，你可以的……（小声）哎呀，领带歪没歪？
（极其疲惫，有气无力）师傅……到地方了叫我一声……（长叹一口气）我先眯一会儿，这班加得我魂儿都要散了。
如果我当时……（沉默片刻）哪怕再坚持一秒钟，结果是不是就不一样了？（苦笑）呵，没如果了。
（寒冷导致的急促呼吸）呼——呼——这、这大兴安岭的雪……（咳嗽）简直能把人骨头冻透了……别、别停下，走，快走。
（提高音量喊话）大姐！这鱼新鲜着呢！早上刚捞上来的！哎！那个谁，别乱翻，压坏了你赔啊？！
```

> ⚠️未确认：官方在**表头与说明**中写 `[音频标签]`（方括号），但**全部样例**都用 `（…）`（全角圆括号）书写插入式标签。两者是否严格等价、方括号是否为推荐写法，文档未做明确说明。

### 7.3 预置音色列表（仅 `mimo-v2.5-tts`）

| 音色名 | Voice ID | 语言 | 性别 |
| --- | --- | --- | --- |
| MiMo-默认 | `mimo_default` | 因部署集群而异，中国集群默认为 `冰糖`，其他集群默认为 `Mia` | — |
| 冰糖 | `冰糖` | 中文 | 女性 |
| 茉莉 | `茉莉` | 中文 | 女性 |
| 苏打 | `苏打` | 中文 | 男性 |
| 白桦 | `白桦` | 中文 | 男性 |
| Mia | `Mia` | 英文 | 女性 |
| Chloe | `Chloe` | 英文 | 女性 |
| Milo | `Milo` | 英文 | 男性 |
| Dean | `Dean` | 英文 | 男性 |

---

## 8. 错误码、限流与计费

### 8.1 错误码

| 错误码 | 错误原因 | 解决方法 |
| --- | --- | --- |
| 400 - 格式错误 | 请求体格式错误 | 检查 JSON 格式；检查必需参数；检查参数值范围；检查消息格式；检查模型是否存在；检查字段名；检查多模态文件格式/大小/可公开访问；多轮对话思考模式下需完整回传 `reasoning_content` |
| 401 - 认证失败 | 缺少或无效的 API Key，或 `Authorization` 请求头格式错误；**混用了 Token Plan 和按量付费 API 的 API Key** | 检查 API Key 及请求头格式；检查 Token Plan 是否使用了专属 Base URL 和 API Key |
| 402 - 余额不足 | 账户余额不足 | 检查余额并及时充值 |
| 403 - 拒绝访问 | 服务暂不支持当前地区，或 API Key 被风控 | 新建 API Key，并注意输入内容安全 |
| 404 - 资源未找到 | 接口或模型不支持图像输入能力 | 确认模型/接口是否支持多模态图像输入 |
| 421 - 内容拦截 | 内容审核拦截 | 避免输入不安全或敏感内容 |
| 429 - 请求超限 | 请求过于频繁，或 Token Plan 额度耗尽 | 实现指数退避和重试逻辑，或降低请求频率；升级套餐或切按量付费 |
| 500 - 服务器失败 | 服务器内部故障 | 稍后重试或联系官方 |
| 503 - 服务器故障 | 服务器负载过高 | 稍后重试 |

### 8.2 限流（Rate Limit）

| 模型 ID | RPM | TPM |
| --- | --- | --- |
| `mimo-v2.5-tts` | 100 | 10M |
| `mimo-v2.5-tts-voiceclone` | 100 | 10M |
| `mimo-v2.5-tts-voicedesign` | 100 | 10M |

**口径说明：**

- **RPM（Requests Per Minute）**：每分钟最多发起的请求数。计算范围为**调用同一模型时，单个账号下所有 API Key 的请求总数之和**。
- **TPM（Tokens Per Minute）**：每分钟最多交互的 Token 数。计算范围同上。
- 平台对每个账号设有**模型并发上限**，服务器负载较高时可能出现响应延迟或 `429` 报错。建议合理规划请求频率，在高并发场景下实现**请求重试与退避策略**。

> ⚠️未确认：**具体的并发上限数值**官方未给出（只说「设有模型并发上限」）。

### 8.3 计费口径

| 模型 | 计费 |
| --- | --- |
| `mimo-v2.5-tts` | **限时免费** |
| `mimo-v2.5-tts-voiceclone` | **限时免费** |
| `mimo-v2.5-tts-voicedesign` | **限时免费** |

- 计费单位（通用说明）：国内为「元 / 百万 tokens」；海外为「美元 / 百万 tokens」。
- 缓存命中：前缀内容命中 Prompt Cache 时按命中缓存价格计费；缓存写入限时免费。
- ASR 系列按**输入音频时长**计费（精确到秒，折算成小时）——**TTS 不是按时长计费**。
- ⚠️未确认：TTS 限时免费结束后的**正式定价**（官方未公布）。响应中的 `usage` 字段照常返回 token 用量，可据此观测。

---

## 9. 可直接复制运行的 curl 示例

> 通用前置：`export MIMO_API_KEY=sk-xxxxx`（Windows PowerShell：`$env:MIMO_API_KEY="sk-xxxxx"`）

### 9.1 示例一：voicedesign 非流式（文本描述设计音色）

`user` 消息 = 音色设计描述；`assistant` 消息 = 合成目标文本。`audio.voice` 不支持，须省略。

```bash
curl --location --request POST 'https://api.xiaomimimo.com/v1/chat/completions' \
--header "api-key: $MIMO_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw '{
    "model": "mimo-v2.5-tts-voicedesign",
    "messages": [
        {
            "role": "user",
            "content": "五十多岁的中年男性，丝滑醇厚、带着磁性，语速缓慢而沉稳，像一位深居简出的评书先生。"
        },
        {
            "role": "assistant",
            "content": "(磁性)夜已经深了，城市还在呼吸。我是今晚陪你的人，欢迎收听《午夜电台》。"
        }
    ],
    "audio": {
        "format": "wav"
    }
}'
```

**输出**：响应 JSON 中 `choices[0].message.audio.data` 为 Base64 wav，解码即得音频文件：

```bash
# 提取并解码（需 jq）
curl --location --request POST 'https://api.xiaomimimo.com/v1/chat/completions' \
--header "api-key: $MIMO_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw '{"model":"mimo-v2.5-tts-voicedesign","messages":[{"role":"user","content":"五十多岁的中年男性，丝滑醇厚、带着磁性，语速缓慢而沉稳。"},{"role":"assistant","content":"(磁性)夜已经深了，城市还在呼吸。"}],"audio":{"format":"wav"}}' \
| jq -r '.choices[0].message.audio.data' | base64 -d > voice_design.wav
```

### 9.2 示例二：voicedesign + `optimize_text_preview`（省略 assistant，自动生成播报文本）

```bash
curl --location --request POST 'https://api.xiaomimimo.com/v1/chat/completions' \
--header "api-key: $MIMO_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw '{
    "model": "mimo-v2.5-tts-voicedesign",
    "messages": [
        {
            "role": "user",
            "content": "Give me a young male tone."
        },
        {
            "role": "assistant",
            "content": "Yes, I had a sandwich."
        }
    ],
    "audio": {
        "format": "wav",
        "optimize_text_preview": true
    }
}'
```

> 官方 Python 示例的等价请求。`optimize_text_preview: true` 时可省略 `assistant` 消息，润色后的最终文本从 `choices[0].message.final_text_preview` 读取。

### 9.3 示例三：预置音色非流式（`mimo-v2.5-tts` + `voice`）

**此段为官方 API 参考页 curl 原文（voice synthesis tab）：**

```bash
curl --location --request POST 'https://api.xiaomimimo.com/v1/chat/completions' \
--header "api-key: $MIMO_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw '{
    "model": "mimo-v2.5-tts",
    "messages": [
        {
            "role": "user",
            "content": "Bright, bouncy, slightly sing-song tone — like you are bursting with good news you can barely hold in. Fast pace, rising pitch at the end."
        },
        {
            "role": "assistant",
            "content": "Hey boss — guess what, guess what? I just got the results back and I actually passed! Not just passed, I got a distinction! I know, I know — you told me I was cutting it close, but hey, here we are. Drinks are on me tonight, okay?"
        }
    ],
    "audio": {
        "format": "wav",
        "voice": "mimo_default"
    }
}'
```

**中文预置音色变体（可复制运行）：**

```bash
curl --location --request POST 'https://api.xiaomimimo.com/v1/chat/completions' \
--header "api-key: $MIMO_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw '{
    "model": "mimo-v2.5-tts",
    "messages": [
        {
            "role": "user",
            "content": "用轻快上扬的语调向领导报喜，语速稍快，带着查到成绩后压抑不住的激动与小骄傲，声音明亮有活力。"
        },
        {
            "role": "assistant",
            "content": "老板！你猜怎么着？我成绩出来了，我过了！不光是过了，还是优秀！"
        }
    ],
    "audio": {
        "format": "wav",
        "voice": "冰糖"
    }
}'
```

### 9.4 示例四：流式（`mimo-v2.5-tts` + `pcm16`）

流式必须用 `pcm16`，分片 Base64 解码后按 24kHz PCM16LE mono 字节拼接。

```bash
curl --location --request POST 'https://api.xiaomimimo.com/v1/chat/completions' \
--header "api-key: $MIMO_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw '{
    "model": "mimo-v2.5-tts",
    "messages": [
        {
            "role": "user",
            "content": "用轻快上扬的语调向领导报喜，语速稍快，声音明亮有活力。"
        },
        {
            "role": "assistant",
            "content": "老板！你猜怎么着？我成绩出来了，我过了！"
        }
    ],
    "audio": {
        "format": "pcm16",
        "voice": "冰糖"
    },
    "stream": true
}'
```

**流式分片解码 + 拼接为 wav（Python，官方逻辑的 curl 等价后处理）：**

```python
import base64, json, subprocess, sys
import numpy as np
import soundfile as sf

# 逐行读取 SSE 流：每个 data: {...} 行是一个 chunk
chunks = []
proc = subprocess.Popen(
    ["curl", "-sN", "--location", "--request", "POST",
     "https://api.xiaomimimo.com/v1/chat/completions",
     "--header", "api-key: " + __import__("os").environ["MIMO_API_KEY"],
     "--header", "Content-Type: application/json",
     "--data-raw", json.dumps({
         "model": "mimo-v2.5-tts",
         "messages": [
             {"role": "user", "content": "用轻快上扬的语调向领导报喜，语速稍快。"},
             {"role": "assistant", "content": "老板！你猜怎么着？我过了！"},
         ],
         "audio": {"format": "pcm16", "voice": "冰糖"},
         "stream": True,
     })],
    stdout=subprocess.PIPE, text=True,
)

pcm = np.array([], dtype=np.float32)
for line in proc.stdout:
    line = line.strip()
    if not line.startswith("data:"):
        continue
    payload = line[5:].strip()
    if payload == "[DONE]":
        break
    obj = json.loads(payload)
    if not obj.get("choices"):
        continue
    audio = obj["choices"][0].get("delta", {}).get("audio")
    if audio is not None:
        b = base64.b64decode(audio["data"])
        pcm = np.concatenate((pcm, np.frombuffer(b, dtype=np.int16).astype(np.float32) / 32768.0))

sf.write("output.wav", pcm, samplerate=24000)   # 24kHz PCM16LE mono
print("saved output.wav")
```

### 9.5 示例五：voiceclone 非流式（音频样本 base64 复刻音色）

`audio.voice` **必填**，值为音频样本的 base64 编码（仅支持 `mp3` 和 `wav`）。

```bash
# 1) 准备 base64 音频样本（wav 或 mp3）
SAMPLE_B64=$(base64 -w 0 ./sample.wav)

# 2) 调用
curl --location --request POST 'https://api.xiaomimimo.com/v1/chat/completions' \
--header "api-key: $MIMO_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw "{
    \"model\": \"mimo-v2.5-tts-voiceclone\",
    \"messages\": [
        {
            \"role\": \"user\",
            \"content\": \"温柔但带着一丝疲惫，语速缓慢。\"
        },
        {
            \"role\": \"assistant\",
            \"content\": \"(温柔)今天辛苦了，早点休息吧。\"
        }
    ],
    \"audio\": {
        \"format\": \"wav\",
        \"voice\": \"$SAMPLE_B64\"
    }
}"
```

> ⚠️未确认：`audio.voice` 中音频样本是否需要 `data:audio/wav;base64,` **Data URL 前缀**。API 参考页原文为「仅支持传入音频样本的 base64 编码」，未提 Data URL。对照 ASR 接口的 `input_audio.data` 明确要求 Data URL 格式（`data:{MIME_TYPE};base64,...`），TTS 的 `voice` 字段**未**做此要求，故上例用**纯 base64**。若报 400，可尝试加 `data:audio/wav;base64,` 前缀。
> ⚠️未确认：音频样本的**时长上下限、大小上限**。官方指南页该章节正文未抓到；媒体稿提及「数秒参考音频」「如 30 秒语音」（非官方文档口径，仅作参考）。

---

## 10. 未确认项汇总（`⚠️未确认`）

| # | 未确认项 | 现状 |
| --- | --- | --- |
| 1 | Bearer 鉴权请求头的**逐字原文** | 只确认「支持 Bearer 鉴权」及错误码 401 提及 `Authorization` 请求头格式；Bearer tab 代码块未渲染 |
| 2 | TTS 是否支持 Token Plan / 批量推理 Base URL | 官方 TTS 页面未说明；Token Plan 与按量付费 Key 不可混用 |
| 3 | `temperature` / `top_p` 是否对 TTS 生效 | 「模型超参」页只列 3 个文本生成模型，未列 TTS |
| 4 | `mimo-v2.5-tts-voiceclone` 是否支持流式 | 指南页未说明该模型的流式状态（voicedesign 明确「暂未上线」） |
| 5 | 账号级**并发上限具体数值** | 原文只说「设有模型并发上限」，无数字 |
| 6 | TTS 限时免费结束后的**正式定价** | 未公布 |
| 7 | `[音频标签]` 方括号 vs `（…）` 全角圆括号 是否严格等价 | 说明写方括号，全部样例用全角圆括号 |
| 8 | `audio.voice`（voiceclone）是否需 Data URL 前缀 | 文档只说「base64 编码」，未提 Data URL |
| 9 | voiceclone 音频样本的时长/大小限制 | 该章节正文未抓到；媒体稿提「数秒」「30 秒」，非官方文档口径 |
| 10 | 流式 SSE 的**分片大小 / 分片策略** | 官方 Python 示例只打印「Received audio chunk of size N bytes」，未给固定值 |
| 11 | 是否有 `sample_rate` / `channels` 等音频参数可配置 | 请求体字段表无此字段；24kHz/mono 为输出固有能力 |
| 12 | 合成目标文本的**字数/长度上限** | 只知上下文窗口 8K、最大输出 8K，未给文本字数上限 |

## 11. 抓取失败记录

| URL | 结果 |
| --- | --- |
| `https://mimo.mi.com/docs/en/quick-start/usage-guide/audio/speech-synthesis-v2.5` | HTTP 200 但正文为空（仅返回页面标题壳） |
| `https://mimo.mi.com/docs/zh-CN/api/audio/tts-post.md` | HTTP 200 但正文为空（非 `.md` 端点） |
| 语音合成指南页 voiceclone 章节正文 | 页面在 voicedesign 流式注意事项处截断，未渲染到 voiceclone 章节 |
| API 参考页「音色设计 / 音色克隆」curl tab | 页面只渲染默认 tab 的代码块，另两个 tab 内容未出现在 HTML 中 |
| `https://www.zhihu.com/question/2085660488310809029` | HTTP 403（与本文档无关，仅搜索噪声） |
| `https://mi-mo-tts-studio.vercel.app/about` | 连接被拒（第三方站点，非官方） |

---

*本文档由官方文档原文取证整理，字段定义以 [#2 API 参考页](https://mimo.mi.com/docs/zh-CN/api/audio/tts-post) 为权威来源，使用规则以 [#1 指南页](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5) 为权威来源。*
