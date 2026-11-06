# 流式播放：第 0 段就绪即出声

实现位置：`assets/js/tts-service.js`（`createSegmentGate`、`speakMessage`、`onTick`、`measureBlobDurations`、`drainSegmentGates`）。
验证：`node tests/tts-streaming-playback.test.mjs`、`node tests/tts-progress-player.test.mjs`、`node tests/tts-progress.test.mjs`。

## 改之前的时序

```
buildSpeechPlan ──▶ Promise.all(全部段合成) ──▶ measureBlobDurations(全部段) ──▶ 播放第 1 段
                                                                                ▲
                                      首字只能等这条横线走完 ──────────────────┘
```

首字延迟 = `断句 + ceil(N/3) × 单段请求 + N × 测量`。12 段、每段 1.2 秒的气泡，第一条声音要等 5 秒以上；
而且**等的是最慢的那一段**，不是第一段——某段触发 429 退避时，整条气泡的出声一起被拖。

## 改之后的时序

```
buildSpeechPlan ──▶ worker×3 并行合成
                        │
                        ├─ 段0 settle ──▶ 播放段0  ─────────────┐
                        ├─ 段1 settle ──▶ 播放段1              │  播放按顺序 await 各自的 gate
                        ├─ 段2 settle ──▶ 播放段2              │
                        └─ 全部 settle ─▶ 拼时间轴 + 解锁拖动 ◀┘
```

首字延迟降到 **第一段的合成时间**。后面的段在播放第 0 段的同时继续合成，合成与播放真正并行。

## 三个机制

### 1. 段级门闩（`createSegmentGate`）

每段一个 gate，结构是 `{ promise, settled, value, settle(value) }`。

- `settle({ blob, seconds })` → 就绪，播放循环拿到音频。
- `settle(null)` → 这一段彻底失败，播放循环跳过它。
- **只认第一次 settle**。成功、失败、被 drain 三条路都汇到同一个 `settle`，重复调用不覆盖——否则一个失败的段可能被后来的结果"复活"，或者一个成功的段被误判成空。

播放循环按顺序 `await gates[playIndex].promise`，所以：

- 顺序有保证：第 0 段没出声，第 1 段不会抢跑。
- 阻塞有界：只等"我要的这一段"，不等整批。

`Map`/数组都不参与调度，`gates` 只是一个下标可寻址的 promise 数组。

### 2. 时间轴延后解锁

流式阶段 `activeTimeline` 还是 `null`，进度条靠两个值活着：

- `playedSeconds`：已播完的段的完整时长累加。
- `playbackBaseSeconds`：当前段的起点，`onTick` 用它 + `audio.currentTime` 算出实时位置。

全段 settle 后 `unlockTimeline(durations)` 一次性拼出 `starts / durations / total`，同时：

```js
ttsState.duration = activeTimeline.total;   // 进度条出现
ttsState.seekable = activeTimeline.total > 0;  // 拖动解锁
```

**为什么不在流式阶段给个估算值**：`seekSpeaking` 会把全局秒数换算成「第几段 + 段内偏移」，然后等那一段的 gate。
估算值一旦落在一个还没合成的段上，用户拖动 → 播放停下等合成 → 表现出来就是"卡住"。等齐了再放开，拖动永远落在已经存在音频的段上。

`unlockTimeline` 只在全段 settle 之后调用（`synthesisJob` 的 `.then` 里，且此时 `Promise.all(workers)` 已返回），所以解锁瞬间每个 gate 都已 settle，拖动不可能等待。

### 3. 停止时 drain 门闩（`drainSegmentGates`）

`stopSpeaking()` → `releaseAudio()` → `drainSegmentGates()`，把所有未 settle 的 gate 用 `null` 打开。

没有这一步，播放循环会挂在 `await gate.promise` 上，`token !== playbackToken` 的检查永远轮不到执行——一条僵尸协程会一直挂在内存里，直到下一次同一条气泡播放时才被覆盖。

drain 之后再 `settlePlayback(AbortError)`，播放中的段也被唤醒，`playBlobFrom` 的 await 不会悬挂。

## 失败与跳过在流式下的行为

| 情形 | 行为 |
|---|---|
| 第 k 段失败（非中止） | `gate[k].settle(null)`，播放到第 k 段时跳过，继续读第 k+1 段；`ttsState.skipped++`，`warning` toast |
| 全部段失败 | 播放循环空转完 → `await synthesisJob` → `synthesisError` 抛出 → 统一失败分支（`status='error'`） |
| 合成中途停止 | `playbackToken++` → drain → 循环醒来看到 token 变了直接 return，不发 toast、不报错 |
| 某段很慢 | 播放停在这一段的 gate 上等它；其它段已在后台合成完，不会重复请求 |

**为什么全段失败不能边播边报**：播放可能在第 0 段就发现是 `null`，但那时其它段还在飞，结论未定。所以失败判定放在 `synthesisJob` 里，播放循环先走完（全 null 就是一行 `ttsState.done`），再统一抛。

## 时长测量的位置

段合成完立刻在**同一个 worker 里** `await measureBlobDuration(blob)`，结果随 gate 一起交给播放循环：

- WAV 头解析是本地内存操作（`parseWavDuration` 读 byteRate/dataSize），不是网络往返，几十 KB 的段基本是微秒级。
- 放在 worker 里意味着 N 段并行测量，而不是串行。
- 时长同时用于 `durations[position]`（时间轴）和 `playedSeconds`（进度基准），两处同源，不会漂移。

段级缓存存 `{ blob, seconds }` 而不是裸 blob：命中时连测量都省掉。`measureBlobDurations`（整条缓存路径）也改成 `Promise.all` 并行，不再串行叠加。

## 状态字段一览

| 字段 | 流式阶段 | 全段就绪后 |
|---|---|---|
| `ttsState.status` | 第 0 段出声即 `'playing'` | `'playing'` |
| `ttsState.stage` | `正在朗读 k/N`（合成进度文案让位） | 同上 |
| `ttsState.duration` | `0` | 各段时长之和 |
| `ttsState.seekable` | `false` | `true` |
| `ttsState.currentTime` | `playedSeconds + 段内偏移`，持续走动 | 同一口径，拖动后按 `starts[index] + offset` |
| `ttsState.done` | 随播放推进 | 同上 |

`reportProgress`（合成进度）里有一道闸：`if (ttsState.status !== 'synthesizing') return;`。
播放一旦开跑，`stage` 就归播放循环，两条流水线不会抢同一行文案。

## 边界

- **整条缓存命中**：`audioCache` 里的 `{ blobs, durations }` 直接铺成一批已 settle 的 gate，`unlockTimeline` 立刻生效——没有合成、没有等待，进度条当场可用。
- **段级缓存命中 + 部分 miss**：命中的段立即 settle，miss 的段照常请求。播放从第 0 段起连续进行，只在 miss 段的位置上等一次。
- **拖动落点在已播段**：`pendingSeek` 在段结束时被读取，`playedSeconds` 重置为 `activeTimeline.starts[index]`，再从 `offset` 续播。
- **播放中暂停**：`togglePauseSpeaking` 只掐当前 `<audio>`，播放循环仍挂在同一个 `playBlobFrom` 上，继续时原地接上——与流式改造前一致。
- **`ttsCacheEnabled === false`**：不走 `planCache`/`segmentCache`，但门闩和流式播放照旧生效（二者是播放侧机制，与缓存无关）。
- **测量失败（返回 0）**：该段在时间轴上占 0 秒，`locateTimelinePosition` 会跳过它，拖动不会落在一个零长度段上。

## 测试覆盖

`tests/tts-streaming-playback.test.mjs`（5 个用例，全部通过）：

1. `[契约]` 门闩只认第一次 settle，`null` 也开门。
2. 第 0 段就绪即出声：把第 2 个及之后的请求压到 300/500/700ms，断言首段 `play()` 时**只有 1/4 段合成完**，且出声时刻早于最后一段的完成时刻。
3. 出声那一刻 `duration === 0`、`seekable === false`、`status === 'playing'`；流式阶段 `seekSpeaking(0.5) === false`；全段就绪后 `duration ≈ N × 段时长`、`seekable === true`。
4. 合成中途 stop：门闩被 drain，`activeKey` 立即清空，600ms 后仍为空，且无未捕获 rejection。
5. 整条缓存命中：零请求、时长立即可用、秒级以内开播。

延迟注入按「第几个请求」而不是段文本做键：请求正文会经过 `applyStyleTag` 与空白裁剪，用文本当键只要差一个字符就会静默失效，测试会变成假绿。

实测时序（`DIAG=1` 打印的相对时间）：`+7ms` 首段出声（当时 1/4 段完成），`+310ms` 第 2 段，`+509ms` 第 3 段，`+709ms` 全段完成 —— 播放与合成真正交错。

回归护栏：`tts-segment-retry`（9 例）、`tts-progress`（17 例）、`tts-progress-player`（6 例）、`tts-preset`（41 项）全绿。
