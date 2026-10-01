# MIDI timing core

TypeScript 的 MIDI 演奏时间轴内核：从标准 MIDI 文件（SMF）字节构建一条**跨轨道、速度感知**的演奏时间线，提供 ticks ↔ 毫秒双向定位、按真实时间排序的演奏事件、以及播放器中途定位所需的活跃音符状态恢复。

内核本身**不含** GUI、音频合成或设备连接；二进制 MIDI 解析由成熟库 [`midi-file`](https://www.npmjs.com/package/midi-file) 负责，本项目实现的是跨轨道的时间语义。

## 解决的问题

SMF 的每个轨道用相对 tick（delta time）记录事件，速度变更事件可以出现在任意轨道（例如只有 tempo 的"指挥轨"）。把每个轨道乘一个固定每拍毫秒数再拼接，会在速度变化后逐渐漂移。本内核：

- 汇总**所有轨道**的 `setTempo`，建立一条全局分段线性 tempo map；
- 速度事件改变的是**其后 tick** 的映射；同 tick 的所有演奏事件（无论来自哪条轨道）得到**同一个毫秒时间**；
- 音符按 SMF 通道模型配对：`noteOff` 关闭同一 **channel + pitch** 上最近一个尚未结束的 `noteOn`（LIFO），不同通道/音高绝不合并，即使分布在不同轨道；
- 事件总顺序确定：`(tick, trackIndex, sourceEventIndex)`，同一 tick 上的事件带有组内 `order`；
- 所有查询都是纯函数：时间轴不持有可变播放位置，重复查询同一时间结果相同且不改变内部状态。

## 时间基准契约（失败必须显式报告）

`parseTimeline` / `loadTimeline` 是**全有或全无**的：任何契约违例都抛出带机器可读 `reason` 的 `MidiFormatError`，不会返回一半有效的时间轴。

| reason                     | 触发条件                                             |
| -------------------------- | ---------------------------------------------------- |
| `invalidFile`              | 字节不是合法 SMF、轨道数与表头不符、输入不是字节容器、文件不可读 |
| `unsupportedTimeDivision`  | 表头使用 SMPTE/每秒帧数（非 PPQ）时间基准            |
| `invalidTimeDivision`      | PPQ 基准存在但不是正整数（例如 division word 为 0）  |
| `unsupportedFormat`        | SMF format 2（互不相关的轨道，无法形成统一时间线）   |
| `invalidTempo`             | setTempo 的 us/beat 超出 24 位合法范围               |
| `unmatchedNoteOff`         | noteOff 前面没有同通道同音高的 noteOn                |
| `unterminatedNote`         | 文件结束时仍有 noteOn 未收到 noteOff                 |

永远不会把未知时间基准悄悄当成默认速度。没有显式 tempo 事件时，才按 SMF 规范使用 120 BPM（500 000 µs/beat）。

## 单位

tick 与毫秒使用**品牌类型（branded types）**区分：

```ts
import { ticks, ms, type Tick, type Milliseconds } from "midi-timing-core";

const t: Tick = ticks(480);        // 非负整数，构造时校验
const when: Milliseconds = ms(500);
// tl.tickToTime(when)            // 编译错误：毫秒不能当 tick
```

## 用法

```ts
import {
  loadTimeline,      // 直接从文件路径
  parseTimeline,     // 或从 Uint8Array / ArrayBuffer / 类数组字节
  ticks,
  ms,
} from "midi-timing-core";

const tl = loadTimeline("score.mid");

tl.ticksPerBeat;                 // 480
tl.duration;                     // Milliseconds
tl.durationTick;                // Tick
tl.events;                       // 按真实时间排序的 noteOn/noteOff/tempo
tl.notes;                        // 跨轨道配对后的音符

// 双向定位（跨越速度变化）
const time = tl.tickToTime(ticks(720));
const tick = tl.timeToTick(ms(600));   // floor：该时间点已经到达的 tick

// 中途定位：此刻已开始但未结束的音符（start <= t < end）
const active = tl.activeNotesAt(ms(3200));
for (const n of active) {
  // n.channel / n.noteNumber / n.velocity（原始起音力度）
  // n.startedAtTime / n.endsAtTime —— 用来恢复持续发声状态
}

// 裁取播放片段：起点之前已经在响的音符在 sustained 中给出，
// 而不是只看到片段起点之后的 noteOn
const clip = tl.clip(ms(3000), ms(5000));
clip.sustained;       // 跨越起点的音符（preStarted）
clip.notes;           // 与 [start,end) 相交的音符，带 clipStart/End 边界
```

`clip.notes` 中：

- `preStarted: true` 表示音符在片段起点之前已起音，播放器应把它当作**应持续发声**的状态恢复，而不是等待已经过去的 noteOn；
- `clipStartTime/clipEndTime` 是音符在片段内的有效边界（原始 `startTime/endTime` 同时保留）。

## 语义细节

- **tick→时间**：分段线性，在每个整数 tick 上精确（端点做了 1e-9 ms 量级的浮点吸附）。
- **时间→tick**：返回满足 `tickToTime(t) <= time` 的最大整数 tick（区间语义），超出范围时钳制到 `[0, durationTick]`。
- 音符/活跃区间为半开：`end` 时刻音符已释放。
- velocity 为 0 的 `noteOn`（SMF 常见写法）由解析库归一为 `noteOff`。
- 不影响时间语义的元事件（拍号、调号、文本、SysEx 等）不出现在 `events` 中，但它们的 delta time 仍参与 tick 累加。
- 支持 format 0 与 format 1。

## 开发

```bash
npm install
npm run typecheck   # tsc 严格模式
npm test            # node:test（测试用例也用 midi-file 合成 SMF 字节）
npm run build       # 输出到 dist/（CommonJS + .d.ts）
```

测试覆盖：速度事件位于无音符的独立轨道、多通道同音高不合并、跨速度变化的双向定位、中途活跃音符、片段裁取与前置持续音、重复查询的无状态性，以及全部失败契约（SMPTE、format 2、坏字节、未配对音符等）。
