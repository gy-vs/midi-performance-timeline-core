import { ms, type Milliseconds, type Tick, tickUnchecked } from "./units.js";

/** Microseconds per quarter note at the standard default 120 BPM. */
export const DEFAULT_MICROSECONDS_PER_BEAT = 500_000;
const MICROSECONDS_PER_MILLISECOND = 1000;
/**
 * Tempo maps are piecewise linear with integer tick endpoints; floating
 * point error at those endpoints is always far below this threshold.
 */
const EPSILON = 1e-9;

/** One tempo-change point on the global tempo map. */
export interface TempoBoundary {
  /** Absolute tick at which the tempo takes effect (events *at* this tick use it). */
  readonly tick: Tick;
  /** Time at which the tempo takes effect. */
  readonly time: Milliseconds;
  /** Tempo value in microseconds per quarter note (SMF meta setTempo value). */
  readonly microsecondsPerBeat: number;
  /** 0-based index of the track that supplied this tempo event. */
  readonly trackIndex: number;
  /** Index within the source track's raw event array (deterministic ordering). */
  readonly eventIndex: number;
}

interface Segment {
  /** First tick mapped by this segment (inclusive). */
  readonly startTick: number;
  /** Time of {@link Segment.startTick} in milliseconds. */
  readonly startTime: number;
  /** Milliseconds per PPQ tick inside this segment. */
  readonly msPerTick: number;
}

/**
 * Global piecewise tempo map.
 *
 * Tempo events are gathered from *every* track and merged into one map, so a
 * tempo change living on a conductor track correctly affects notes on all
 * other tracks. When several setTempo events share a tick they are ordered by
 * (track index, event index) and the last one wins — the same total order
 * used for performance events.
 */
export class TempoMap {
  readonly ticksPerBeat: number;
  /** All effective tempo boundaries, sorted by tick (first one at tick 0). */
  readonly boundaries: readonly TempoBoundary[];
  private readonly segments: readonly Segment[];
  /** Time of the last tick covered by the parsed data, for clamping. */
  readonly endTime: Milliseconds;
  readonly endTick: Tick;

  constructor(
    ticksPerBeat: number,
    tempoEvents: ReadonlyArray<{
      tick: Tick;
      microsecondsPerBeat: number;
      trackIndex: number;
      eventIndex: number;
    }>,
    maxTick: Tick
  ) {
    this.ticksPerBeat = ticksPerBeat;

    // Physical occurrence order: tick, then source track, then in-track order.
    const ordered = [...tempoEvents].sort((a, b) => {
      if (a.tick !== b.tick) return a.tick - b.tick;
      if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex;
      return a.eventIndex - b.eventIndex;
    });

    // Seed with the standard default tempo; a setTempo at tick 0 replaces it.
    const boundaries: TempoBoundary[] = [
      {
        tick: tickUnchecked(0),
        time: ms(0),
        microsecondsPerBeat: DEFAULT_MICROSECONDS_PER_BEAT,
        trackIndex: 0,
        eventIndex: -1,
      },
    ];
    const segments: Segment[] = [
      {
        startTick: 0,
        startTime: 0,
        msPerTick:
          DEFAULT_MICROSECONDS_PER_BEAT /
          ticksPerBeat /
          MICROSECONDS_PER_MILLISECOND,
      },
    ];

    // Running segment: tempo currently in force, ending at the next event tick.
    let segStartTick = 0;
    let segStartTime = 0;
    let segMsPerTick =
      DEFAULT_MICROSECONDS_PER_BEAT /
      ticksPerBeat /
      MICROSECONDS_PER_MILLISECOND;

    for (const ev of ordered) {
      const time =
        segStartTime + (ev.tick - segStartTick) * segMsPerTick;
      const nextMsPerTick =
        ev.microsecondsPerBeat / ticksPerBeat / MICROSECONDS_PER_MILLISECOND;

      const lastIndex = boundaries.length - 1;
      if (boundaries[lastIndex]!.tick === ev.tick) {
        // Same-tick tempo: later (track, event) wins.
        boundaries[lastIndex] = {
          tick: ev.tick,
          time: ms(time),
          microsecondsPerBeat: ev.microsecondsPerBeat,
          trackIndex: ev.trackIndex,
          eventIndex: ev.eventIndex,
        };
        segments[lastIndex] = { startTick: ev.tick, startTime: time, msPerTick: nextMsPerTick };
      } else {
        boundaries.push({
          tick: ev.tick,
          time: ms(time),
          microsecondsPerBeat: ev.microsecondsPerBeat,
          trackIndex: ev.trackIndex,
          eventIndex: ev.eventIndex,
        });
        segments.push({ startTick: ev.tick, startTime: time, msPerTick: nextMsPerTick });
      }

      segStartTick = ev.tick;
      segStartTime = time;
      segMsPerTick = nextMsPerTick;
    }

    this.boundaries = boundaries;
    this.segments = segments;
    this.endTick = maxTick;
    this.endTime = ms(
      snap(segStartTime + (maxTick - segStartTick) * segMsPerTick)
    );
  }

  /** Segment whose tempo governs the given absolute tick. */
  private segmentAtTick(tick: number): Segment {
    const segs = this.segments;
    // Invariant: segs[0].startTick === 0; segments sorted by startTick.
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid]!.startTick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return segs[lo]!;
  }

  /** Segment whose tempo governs the given time (last boundary at/before it). */
  private segmentAtTime(time: number): Segment {
    const segs = this.segments;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid]!.startTime <= time) lo = mid;
      else hi = mid - 1;
    }
    return segs[lo]!;
  }

  /**
   * Absolute milliseconds for an absolute tick. Exact for every integer tick
   * (each segment is a linear map; values within epsilon of an integer are
   * snapped so round-tripping across a tempo change stays exact).
   */
  tickToTime(tick: Tick): Milliseconds {
    const seg = this.segmentAtTick(tick);
    const raw = seg.startTime + (tick - seg.startTick) * seg.msPerTick;
    return ms(snap(raw));
  }

  /**
   * Absolute tick whose time is at or immediately before `time`.
   *
   * Returns the greatest integer tick t with tickToTime(t) <= time, clamped
   * to [0, endTick]. This is the deterministic transport position for
   * seeking: an event at a strictly later tick has not started yet.
   */
  timeToTick(time: Milliseconds): Tick {
    if (time <= 0) return tickUnchecked(0);
    if (time >= this.endTime) return tickUnchecked(this.endTick);

    const seg = this.segmentAtTime(time);
    const fracTick = seg.startTick + (time - seg.startTime) / seg.msPerTick;
    let result = Math.floor(fracTick + EPSILON);
    const snapped = snap(fracTick);
    if (Number.isInteger(snapped)) result = snapped;
    if (result < seg.startTick) result = seg.startTick;
    return tickUnchecked(Math.min(result, this.endTick));
  }
}

function snap(value: number): number {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < EPSILON) return rounded;
  return value;
}
