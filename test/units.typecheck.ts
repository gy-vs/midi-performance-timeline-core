/**
 * Compile-time contract for the branded unit types. This file is type-checked
 * by `tsc` (it is part of the tsconfig `include` set) but is not a test
 * suite — every `@ts-expect-error` line fails the build if the unit brands
 * ever become interchangeable.
 */
import { milliseconds, ticks } from "../src/index.js";
import type { MidiTimeline, Milliseconds, Ticks } from "../src/index.js";

const tickPosition = ticks(480);
const timePosition = milliseconds(250);

// @ts-expect-error — milliseconds are not assignable to ticks
const badTicks: Ticks = timePosition;

// @ts-expect-error — ticks are not assignable to milliseconds
const badMs: Milliseconds = tickPosition;

// @ts-expect-error — a plain number is not a tick position
const plainTicks: Ticks = 480;

// @ts-expect-error — a plain number is not a millisecond position
const plainMs: Milliseconds = 250;

// @ts-expect-error — arithmetic on a branded value yields a plain number
const derived: Ticks = tickPosition + 10;

declare const timeline: MidiTimeline;

// @ts-expect-error — timeAtTick takes Ticks, not Milliseconds
timeline.timeAtTick(timePosition);

// @ts-expect-error — tickAtTime takes Milliseconds, not Ticks
timeline.tickAtTime(tickPosition);

// @ts-expect-error — activeNotesAt takes Milliseconds, not a plain number
timeline.activeNotesAt(500);

// @ts-expect-error — slice bounds must be branded millisecond values
timeline.slice(0, 1000);

// Sanity: the intended usages do type-check.
timeline.timeAtTick(tickPosition);
timeline.tickAtTime(timePosition);
timeline.activeNotesAt(timePosition);
timeline.slice(timePosition, milliseconds(500));

export const okTicks: Ticks = tickPosition;
export const okMs: Milliseconds = timePosition;
