import { describe, expect, it } from "vitest";
import {
  importMidi,
  MalformedMidiError,
  MidiImportError,
  UnsupportedFormatError,
  UnsupportedTimeBaseError,
} from "../src/index.js";
import {
  crossTrackTempoFile,
  format2File,
  noteAnomalyFile,
  smpteDivisionFile,
  TPQ,
  truncatedFile,
  zeroTempoFile,
} from "./fixtures.js";

describe("importMidi: supported files", () => {
  it("imports a format 1 file and exposes its structure", () => {
    const timeline = importMidi(crossTrackTempoFile());
    expect(timeline.format).toBe(1);
    expect(timeline.ticksPerQuarter).toBe(TPQ);
    expect(timeline.trackCount).toBe(2);
    expect(timeline.tracks[0]?.name).toBe("conductor");
    expect(timeline.diagnostics).toEqual([]);
  });

  it("imports a file without any tempo event using the default 120 BPM", () => {
    const timeline = importMidi(noteAnomalyFile());
    expect(timeline.tempoChanges).toEqual([]);
    expect(timeline.tempoMap.points).toHaveLength(1);
    expect(timeline.tempoMap.points[0]?.microsecondsPerQuarter).toBe(500_000);
  });
});

describe("importMidi: failure contract", () => {
  it("rejects garbage bytes", () => {
    const garbage = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
    expect(() => importMidi(garbage)).toThrow(MalformedMidiError);
  });

  it("rejects empty input", () => {
    expect(() => importMidi(new Uint8Array(0))).toThrow(MalformedMidiError);
  });

  it("rejects non-byte-array input", () => {
    // @ts-expect-error — runtime guard for callers without types
    expect(() => importMidi(null)).toThrow(MalformedMidiError);
  });

  it("rejects SMPTE-divided files instead of guessing a tempo", () => {
    expect(() => importMidi(smpteDivisionFile())).toThrow(UnsupportedTimeBaseError);
  });

  it("rejects format 2 files explicitly", () => {
    expect(() => importMidi(format2File())).toThrow(UnsupportedFormatError);
  });

  it("rejects truncated files whose tracks are missing", () => {
    expect(() => importMidi(truncatedFile())).toThrow(MalformedMidiError);
    expect(() => importMidi(truncatedFile())).toThrow(/truncated/);
  });

  it("rejects semantically corrupt tempo events", () => {
    expect(() => importMidi(zeroTempoFile())).toThrow(MalformedMidiError);
  });

  it("every failure is a MidiImportError", () => {
    const inputs = [
      new Uint8Array(0),
      smpteDivisionFile(),
      format2File(),
      truncatedFile(),
      zeroTempoFile(),
    ];
    for (const input of inputs) {
      expect(() => importMidi(input)).toThrow(MidiImportError);
    }
  });
});
