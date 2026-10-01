/**
 * Base class for every failure reported by {@link importMidi}.
 *
 * Importing is atomic: whenever the input cannot be turned into a fully
 * consistent timeline, `importMidi` throws a `MidiImportError` subclass and
 * no partial timeline is produced.
 */
export class MidiImportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The input bytes are not a parseable Standard MIDI File. */
export class MalformedMidiError extends MidiImportError {}

/**
 * The file's time base is not supported. Only PPQ (ticks per quarter note)
 * files are imported; SMPTE-divided files are rejected explicitly instead of
 * being timed against a guessed default tempo.
 */
export class UnsupportedTimeBaseError extends MidiImportError {}

/** The SMF format is not supported. Only formats 0 and 1 are imported. */
export class UnsupportedFormatError extends MidiImportError {}
