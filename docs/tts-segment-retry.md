# 分段合成的失败隔离与段级重跑

> 对应实现：[assets/js/tts-service.js](../assets/js/tts-service.js)
> 对应验证：[tests/tts-segment-retry.test.mjs](../tests/tts-segment-retry.test.mjs)（`node tests/tts-segment-retry.test.mjs`）

## 1. 修掉的问题

一条气泡会被切成 N 段（`MAX_SEGMENTS = 50`），每段一次 `chat/completions` 合成请求，并发上限
`SYNTHESIS_CONCURRENCY = 3`。修复前的编排是 fail-fast 的：

| 环节 | 修复前 | 后果 |
| --- | --- | --- |
| 并发编排 | `Promise.all` | 任一段 reject → 整个 Promise reject |
| 错误处理 | catch 里 `activeController.abort()` | 另外 2 个在飞的请求被取消，配额白烧 |
| 整条缓存 | `audioCache.set()` 在 `Promise.all` 之后 | 已合成的 N 段只存在于局部变量，失败即全丢 |
| 重试 | 无 | 一次 429 / 5xx / 网络抖动就判死刑 |
| 段级缓存 | 无 | 重试必须从第 1 段重跑 |

结论：**不是「一段失败丢弃所有请求」，但确实是「一段失败丢弃所有结果」**——段级失败会连坐整条气泡，
并且已花掉的配额不可回收。N 段时整条成功率是 `(1-p)^N`，p=1%、N=50 时约 61%。

## 2. 修复后的模型

三个独立性：**失败独立、重试独立、缓存独立**。

### 2.1 失败独立

每个工作协程只处理自己手里那一段：

```js
try {
    const blob = await synthesizeSegmentWithRetry({ segment, signal, token });
    blobs[item.position] = blob;
    rememberSegment(segKey, blob);
} catch (error) {
    if (error?.name === 'AbortError' || token !== playbackToken) return; // 真中止，交回控制权
    failures.push({ position, label, error });                           // 否则只记一笔，跳过
}
```

- 单段失败 → 记入 `failures`，**不 abort**、不影响同批其它段。
- 全部段失败 → 才 `throw`，走原来的整条失败分支（`status = 'error'`）。
- 用户中止 / 切换消息 → `AbortError` 立即上抛，链路立刻停（这是真中止，不是失败）。

### 2.2 段内重试

`synthesizeSegmentWithRetry`：最多 `SEGMENT_RETRY_ATTEMPTS = 3` 次，指数退避
`400ms → 800ms`（`SEGMENT_RETRY_BASE_DELAY_MS`）。退避等待 `waitForRetry` 挂在同一个 `signal` 上，
拖动进度条或停止朗读会立刻结束等待，不留后台定时器。

`isRetryableSpeechError` 决定值不值得再试：

| 可重试 | 不可重试 |
| --- | --- |
| 429 限流 | 401 鉴权失败 |
| 5xx | 402 余额不足 |
| `TimeoutError`（180s） | 400 请求格式错误 |
| 网络瞬断（`Failed to fetch` / ECONN / ETIMEDOUT / EAI_AGAIN） | 421 内容审核拦截 |
| 接口未返回音频数据 | `AbortError` |

把 401 重试三遍只是把同一个错误看三遍，所以不可重试的直接认输。

### 2.3 段级缓存：只重跑 miss 的段

两层缓存，键都从整条气泡的 `cacheKey` 派生：

```js
segmentKeyOf(cacheKey, position, text) = `${cacheKey}::#${position}::${text.length}::${text.slice(0, 48)}`
```

- `segmentCache`：段音频（`Blob`），上限 `MAX_SEGMENT_CACHE_ENTRIES = 120`，命中即刷新热度（LRU）。
- `planCache`：分镜计划，上限 `MAX_PLAN_CACHE_ENTRIES = 8`。**这一层是必需的**——voicedesign 模式下
  LLM 每次切分的断句可能不同，一旦断句变了，段级键会整片 miss，重试就得重付整条气泡的钱。
  锁住计划，段级缓存才有意义。

合成前先查段级缓存，命中就完全不发请求：

```js
const segKey = segmentKeyOf(cacheKey, item.position, item.segment.text);
const cachedBlob = cacheOn ? recallSegment(segKey) : null;
if (cachedBlob) { blobs[item.position] = cachedBlob; continue; }  // 零请求
```

**整条气泡缓存（`audioCache`）只在整条都成功时写入。** 带缺口的 entry 一旦写进去，下次点击会直接
命中它，失败的那几段就永远等不到重试——这是修复前那套结构里最隐蔽的一环。

于是「再次点击小喇叭」的实际行为是：

```
第 1 次点击：4 段 → 段 2 失败（3 次尝试）→ 段 2 跳过，段 1/3/4 入段级缓存，整条不入 audioCache
第 2 次点击：planCache 命中同一份计划 → 段 1/3/4 段级缓存命中（0 请求）→ 只给段 2 发 1 次请求
```

配额消耗与「失败段数」成正比，而不是与「气泡段数」成正比。

### 2.4 播放让缺口透明

失败段在 `blobs` 里是 `null`：

- `measureBlobDurations` 对 `null` 记 0 时长，时间轴不塌（`buildSpeechTimeline` 本就按 0 处理）。
- `locateTimelinePosition` 天然跳过零时长段，拖动不会停在空段上。
- 播放循环 `if (!blobs[playIndex]) { playIndex += 1; continue; }` 跳过缺口。
- `ttsState.skipped` 记跳过的段数，并弹一条 `warning` toast（4s）说明缺口与「再点只重试失败片段」。

## 3. 边界与取舍

| 情形 | 行为 |
| --- | --- |
| 一条气泡只有 1 段且失败 | `failures.length === plan.segments.length` → 整条报错，不伪装成「跳过」 |
| `ttsCacheEnabled = false` | 段级缓存与计划缓存都绕过，每段都真发请求（保留原语义） |
| 正文被编辑 | `cacheKey` 变（含正文长度与前 64 字）→ 段级缓存整片 miss，不会串音 |
| 段文本变化但气泡键不变 | 不可能：段文本指纹进段级键，改了必然换键 |
| 长会话反复朗读 | `segmentCache` 上限 120 段、`planCache` 上限 8 份计划，超出按最久未用淘汰 |
| 拖动 / 停止 / 切消息 | `AbortError` 上抛、退避等待被打断、`finally` 归还 `activeController` |

内存口径：段级缓存存的是 WAV `Blob`（24kHz PCM16 单声道 ≈ 48KB/s），120 段的量级与原先
`MAX_CACHE_ENTRIES = 24` 条整气泡缓存持平，必要时调小 `MAX_SEGMENT_CACHE_ENTRIES` 即可。

## 4. 导出的契约（供测试取用）

```js
SYNTHESIS_CONCURRENCY        // 3
SEGMENT_RETRY_ATTEMPTS       // 3
SEGMENT_RETRY_BASE_DELAY_MS  // 400
MAX_SEGMENT_CACHE_ENTRIES    // 120
MAX_PLAN_CACHE_ENTRIES       // 8
segmentKeyOf(cacheKey, position, text)   // → 段级缓存键
isRetryableSpeechError(error)            // → boolean
waitForRetry(ms, signal)                 // → Promise，可被 abort 打断
```

## 5. 验证覆盖

`node tests/tts-segment-retry.test.mjs`：

1. 段级缓存键的稳定性与区分度（段序号 / 段文本 / 气泡任何一个变了都必须 miss）。
2. 可重试判定的正反例（含 `AbortError` 永不重试）。
3. `waitForRetry` 可被 abort 打断。
4. 单段 5xx 两次后恢复：只对失败段重试，整条照读，不报跳过。
5. 单段永久失败：跳过该段、其余照读、`skipped` + `warning` toast、播放数 = 段数 - 1。
6. 401 只发一次请求，直接跳过。
7. 第二次点击只重跑 miss 的段（命中段零请求，播放数补齐为满）。
8. 全段失败仍整条报错。
9. 换正文后段级缓存整片 miss，不串味。
