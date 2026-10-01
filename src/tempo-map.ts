import { milliseconds, ticks, type Milliseconds, type Ticks } from "./units.js";

/** Tempo assumed before the first explicit `setTempo` event (120 BPM), per the SMF spec. */
export const DEFAULT_MICROSECONDS_PER_QUARTER = 500_000;

/** One segment of the tempo map: `microsecondsPerQuarter` applies from `tick` onward. */
export interface TempoPoint {
  readonly tick: Ticks;
  readonly timeMs: Milliseconds;
  readonly microsecondsPerQuarter: number;
}

/** A `setTempo` event located at an absolute tick, before the map is built. */
export interface TempoEventInput {
  readonly tick: number;
  readonly microsecondsPerQuarter: number;
  readonly track: number;
  readonly index: number;
}

/**
 * Bidirectional tick ↔ millisecond mapping built from the `setTempo` events
 * of <em>all</em> tracks merged together. Because every event in the file is
 * converted through this single map, events at the same tick always resolve
 * to the same millisecond position no matter which track they came from.
 */
export class TempoMap {
  readonly ticksPerQuarter: number;
  /** Segment starts, strictly increasing in both tick and time. The first point sits at tick 0. */
  readonly points: readonly TempoPoint[];

  private constructor(ticksPerQuarter: number, points: readonly TempoPoint[]) {
    this.ticksPerQuarter = ticksPerQuarter;
    this.points = points;
  }

  /**
   * Build a map from absolute-tick tempo events. Events are applied in
   * deterministic `(tick, track, index)` order; when several events share a
   * tick, the last one in that order governs the following segment.
   */
  static build(ticksPerQuarter: number, tempoEvents: readonly TempoEventInput[]): TempoMap {
    const sorted = [...tempoEvents].sort(
      (a, b) => a.tick - b.tick || a.track - b.track || a.index - b.index,
    );

    const points: TempoPoint[] = [
      { tick: ticks(0), timeMs: milliseconds(0), microsecondsPerQuarter: DEFAULT_MICROSECONDS_PER_QUARTER },
    ];
    let currentTick = 0;
    let currentMs = 0;
    let mpq = DEFAULT_MICROSECONDS_PER_QUARTER;

    for (const event of sorted) {
      if (event.tick > currentTick) {
        currentMs += ((event.tick - currentTick) * mpq) / (ticksPerQuarter * 1000);
        currentTick = event.tick;
      }
      mpq = event.microsecondsPerQuarter;
      const point: TempoPoint = {
        tick: ticks(event.tick),
        timeMs: milliseconds(currentMs),
        microsecondsPerQuarter: mpq,
      };
      const last = points[points.length - 1];
      if (last !== undefined && last.tick === point.tick) {
        points[points.length - 1] = point;
      } else {
        points.push(point);
      }
    }

    return new TempoMap(ticksPerQuarter, Object.freeze(points));
  }

  /** Millisecond position of a tick. Ticks beyond the last tempo change use the final tempo. */
  timeAtTick(tick: Ticks): Milliseconds {
    if (tick < 0) {
      throw new RangeError(`tick must be >= 0, got ${tick}`);
    }
    const point = this.pointAtTick(tick);
    const offsetMs = ((tick - point.tick) * point.microsecondsPerQuarter) / (this.ticksPerQuarter * 1000);
    return milliseconds(point.timeMs + offsetMs);
  }

  /**
   * Tick position of a millisecond time — the exact inverse of
   * {@link timeAtTick}. May be fractional when `time` falls between ticks.
   */
  tickAtTime(time: Milliseconds): Ticks {
    if (time < 0) {
      throw new RangeError(`time must be >= 0, got ${time}`);
    }
    const point = this.pointAtTime(time);
    const offsetTicks = ((time - point.timeMs) * this.ticksPerQuarter * 1000) / point.microsecondsPerQuarter;
    return ticks(point.tick + offsetTicks);
  }

  private pointAtTick(tick: number): TempoPoint {
    let lo = 0;
    let hi = this.points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.points[mid]!.tick <= tick) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return this.points[lo]!;
  }

  private pointAtTime(time: number): TempoPoint {
    let lo = 0;
    let hi = this.points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.points[mid]!.timeMs <= time) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return this.points[lo]!;
  }
}
