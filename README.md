# MIDI timing core

A TypeScript kernel that turns a Standard MIDI File into an immutable,
tempo-aware performance timeline — with cross-track time semantics, active-note
queries for mid-playback seeking, and clip slicing. No GUI, no audio synthesis,
no device I/O.

Binary SMF parsing is delegated to the mature [`midi-file`](https://www.npmjs.com/package/midi-file)
library. This package implements what sits on top: merging tempo events from
**all** tracks into one tempo map, resolving every event to both ticks and
milliseconds, pairing note-ons with note-offs, and answering time-based queries.

## Why a shared tempo map

Tempo (`setTempo`) events may live on a different track than the notes. Each
track's delta ticks are accumulated independently into absolute ticks, and only
then is every event converted through the single merged tempo map. Two
consequences fall out of that design:

- Events at the same tick resolve to the same millisecond position no matter
  which track they came from.
- Tick ↔ millisecond conversion stays exactly invertible across tempo changes.

## Install & build

```sh
npm install
npm run build      # emit dist/
npm test           # vitest
npm run typecheck  # tsc, includes compile-time unit-brand checks
```

## Usage

```ts
import { importMidi, milliseconds, ticks } from "midi-timing-core";

const timeline = importMidi(bytes); // bytes: Uint8Array of the .mid file

timeline.notes;                     // all paired notes, (startTick, track, order) sorted
timeline.events;                    // all channel events, (tick, track, index) sorted
timeline.tempoChanges;              // explicit setTempo events with resolved positions
timeline.tracks[1].name;            // per-track views, file order preserved

// Bidirectional positioning across tempo changes
timeline.timeAtTick(ticks(960));        // Ticks -> Milliseconds
timeline.tickAtTime(milliseconds(750)); // Milliseconds -> Ticks (exact inverse)

// Seek support: notes already sounding at a position
timeline.activeNotesAt(milliseconds(600));

// Cut a playback clip; activeAtStart carries the notes to resume with
const clip = timeline.slice(milliseconds(300), milliseconds(700));
clip.activeAtStart; // sounding at the cut point (may have started earlier)
clip.notes;         // every note overlapping [300, 700)
clip.events;        // channel events positioned inside [300, 700)
```

All queries are pure: they never mutate the timeline, and re-querying the same
position returns equal results.

## Contract

**Units.** `Ticks` and `Milliseconds` are branded `number` types. Mixing them
(or passing a plain number) is a compile-time error, not a runtime surprise.
`tickAtTime` may return fractional ticks when a time falls between two ticks.

**Note semantics.** A note sounds for `startMs <= t < endMs`. Pairing is scoped
per `(track, channel, pitch)`: same-pitch notes on different channels or tracks
never merge. A note-on with velocity 0 is a note-off. Anomalies are handled
deterministically and reported in `timeline.diagnostics`:

| kind                   | handling                                               |
| ---------------------- | ------------------------------------------------------ |
| `overlapping-note-on`  | previous note on the same key is closed at that tick   |
| `unmatched-note-off`   | ignored                                                |
| `unterminated-note`    | closed at the end of its track                         |

**Import failures are atomic.** `importMidi` either returns a complete
timeline or throws a `MidiImportError` subclass — never a partial result:

- `MalformedMidiError` — unparseable bytes, truncated tracks, corrupt events
  (e.g. a `setTempo` of 0 µs/quarter).
- `UnsupportedTimeBaseError` — SMPTE-divided files. Unknown time bases are
  never silently timed against a default tempo.
- `UnsupportedFormatError` — SMF format 2 (formats 0 and 1 are supported).

## Layout

```
src/
  units.ts       branded Ticks / Milliseconds
  errors.ts      MidiImportError hierarchy
  events.ts      event, note, slice and diagnostic types
  tempo-map.ts   merged cross-track tempo map (tick <-> ms)
  timeline.ts    MidiTimeline: queries, activeNotesAt, slice
  import-midi.ts importMidi entry: validate, collect, assemble
test/
  fixtures.ts    SMF builders (tempo on a different track than notes, …)
  *.test.ts      vitest suites
  units.typecheck.ts  compile-time brand checks (tsc only)
```
