/**
 * Draft adapter — the only place that reads or writes the composer.
 *
 * The composer publishes two projections of the draft:
 *
 * - `draft`: flat clipboard text, where every reference chip appears as its
 *   literal token (`@README.md`);
 * - `occurrences[]`: structured chips with `offset` / `length` in **clipboard**
 *   coordinates.
 *
 * The editor's own editing API (`insertText`) uses **detect** coordinates, in
 * which a chip occupies exactly one position instead of `length` characters.
 * The mapping is therefore `detect = clipboard − Σ(chipLength − 1)` over the
 * chips that end at or before the clipboard index (M2 experiment 0.2 measured
 * the one-character width; M3 experiment R re-measured it for multi-chip,
 * emoji, and multi-paragraph drafts).
 *
 * M3 §1 decision (option B, `referencesMode: 'replace-text'`): a chip is an
 * anchor that is never edited. Only the text runs between chips are replaced,
 * so a chip cannot be destroyed by a write, and the revert path restores the
 * captured runs instead of reconstructing chips.
 */

/** One reference chip, in clipboard coordinates. */
export interface ReferenceChip {
  source: string
  ref: string
  offset: number
  length: number
  label: string
  clipboardText: string
  appearance?: string
}

/** A draft split into its chips and the text runs between them. */
export interface DraftDocument {
  text: string
  chips: ReferenceChip[]
  /** `chips.length + 1` runs: before the first chip, between chips, after the last. */
  runs: string[]
}

/** What a rollback has to restore. */
export interface DraftSnapshot {
  text: string
  runs: string[]
  refs: string[]
}

/** Why a draft could not be mapped (never expected on a well-formed composer). */
export type ParseFailure = 'not-an-array' | 'bad-entries' | 'overlap' | 'token-mismatch'

/** Result of {@link parseDraft}. */
export type ParseResult =
  | { ok: true; document: DraftDocument }
  | { ok: false; failure: ParseFailure }

/** Published `InputState` subset this plugin reads. */
export interface InputStateLike {
  draft?: unknown
  occurrences?: unknown
  attachmentIds?: unknown
  draftRev?: unknown
  phase?: unknown
}

/** The span `insertText` accepts (detect coordinates + the revision it was read at). */
export interface DetectSpan {
  start: number
  end: number
  draftRev?: unknown
}

/** What `captureInsertion()` reports: the caret span plus the current draft revision. */
export interface InsertionCapture {
  start?: unknown
  end?: unknown
  draftRev?: unknown
}

/** Published `InputActions` subset this plugin calls. */
export interface InputActionsLike {
  setDraft?: (text: string) => void
  insertText?: (text: string, span: DetectSpan) => unknown
  captureInsertion?: () => InsertionCapture | undefined
}

/** `useInput` selector hook shape supplied by the slot. */
export type InputSelector = (selector: (state: InputStateLike | undefined) => unknown) => unknown

/** Fallback used when a slot does not publish the hook (never in this slot). */
export function useAbsentInput(): unknown {
  return undefined
}

/**
 * @param state - untrusted published input state.
 * @returns the plain-text draft projection.
 */
export function draftOf(state: InputStateLike | undefined): string {
  return typeof state?.draft === 'string' ? state.draft : ''
}

/**
 * @param state - untrusted published input state.
 * @returns how many reference chips the draft currently carries.
 */
export function referenceCountOf(state: InputStateLike | undefined): number {
  const occurrences = state?.occurrences
  return Array.isArray(occurrences) ? occurrences.length : 0
}

/**
 * @param state - untrusted published input state.
 * @returns the raw `occurrences` array (empty when absent).
 */
export function occurrencesOf(state: InputStateLike | undefined): unknown[] {
  return Array.isArray(state?.occurrences) ? state.occurrences : []
}

/**
 * @param state - untrusted published input state.
 * @returns the submit-machine phase (`plain` when unknown).
 */
export function submitPhaseOf(state: InputStateLike | undefined): string {
  return typeof state?.phase === 'string' ? state.phase : 'plain'
}

/**
 * @param draft - current projection.
 * @param minimum - configured `minTextLength`.
 * @returns whether the control should be rendered at all (never greyed for this).
 */
export function meetsMinimumLength(draft: string, minimum: number): boolean {
  return draft.trim().length >= Math.max(0, minimum)
}

/**
 * Turn one untrusted `occurrences` entry into a chip.
 * @param value - untrusted entry.
 * @param draft - draft the chip belongs to.
 * @returns the chip, or undefined when the entry is unusable.
 */
function chipOf(value: unknown, draft: string): ReferenceChip | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  const offset = entry.offset
  const length = entry.length
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return undefined
  if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0) return undefined
  if (offset + length > draft.length) return undefined
  const clipboardText = typeof entry.clipboardText === 'string'
    ? entry.clipboardText
    : draft.slice(offset, offset + length)
  if (clipboardText.length === 0) return undefined
  return {
    source: typeof entry.source === 'string' ? entry.source : 'reference',
    ref: typeof entry.ref === 'string' ? entry.ref : clipboardText,
    offset,
    length,
    label: typeof entry.label === 'string' ? entry.label : clipboardText,
    clipboardText,
    ...typeof entry.appearance === 'string' ? { appearance: entry.appearance } : {},
  }
}

/**
 * Split the published draft at its chips and validate the mapping.
 *
 * Rejects (rather than guesses) when a chip is out of bounds, overlaps another
 * chip, or its `clipboardText` is not the draft substring at `offset` — the
 * M3 stop condition for `occurrences` semantics that differ from the
 * experiment.
 *
 * @param draft - clipboard projection.
 * @param occurrences - published chip table.
 * @returns the document, or the reason it cannot be mapped.
 */
export function parseDraft(draft: string, occurrences: unknown): ParseResult {
  if (occurrences !== undefined && occurrences !== null && !Array.isArray(occurrences)) {
    return { ok: false, failure: 'not-an-array' }
  }
  const entries = Array.isArray(occurrences) ? occurrences : []
  const chips: ReferenceChip[] = []
  for (const entry of entries) {
    const chip = chipOf(entry, draft)
    if (chip === undefined) return { ok: false, failure: 'bad-entries' }
    chips.push(chip)
  }
  chips.sort((a, b) => a.offset - b.offset)
  for (let index = 0; index < chips.length; index += 1) {
    const chip = chips[index] as ReferenceChip
    if (index > 0) {
      const previous = chips[index - 1] as ReferenceChip
      if (chip.offset < previous.offset + previous.length) return { ok: false, failure: 'overlap' }
    }
    if (draft.slice(chip.offset, chip.offset + chip.length) !== chip.clipboardText) {
      return { ok: false, failure: 'token-mismatch' }
    }
  }
  const runs: string[] = []
  let cursor = 0
  for (const chip of chips) {
    runs.push(draft.slice(cursor, chip.offset))
    cursor = chip.offset + chip.length
  }
  runs.push(draft.slice(cursor))
  return { ok: true, document: { text: draft, chips, runs } }
}

/**
 * Map a clipboard index to the editor's detect coordinates.
 * @param clipboardIndex - index in the flat clipboard text.
 * @param chips - chips of the same draft.
 * @returns the detect index.
 */
export function detectIndex(clipboardIndex: number, chips: readonly ReferenceChip[]): number {
  let collapsed = 0
  for (const chip of chips) {
    if (chip.offset + chip.length <= clipboardIndex) collapsed += chip.length - 1
    else break
  }
  return clipboardIndex - collapsed
}

/**
 * Detect spans of every text run of a parsed draft.
 * @param document - parsed draft.
 * @returns one span per run, in run order.
 */
export function runSpans(document: DraftDocument): DetectSpan[] {
  const spans: DetectSpan[] = []
  let clipboard = 0
  for (let index = 0; index < document.runs.length; index += 1) {
    const run = document.runs[index] as string
    const start = clipboard
    const end = start + run.length
    spans.push({ start: detectIndex(start, document.chips), end: detectIndex(end, document.chips) })
    clipboard = end + (document.chips[index]?.length ?? 0)
  }
  return spans
}

/**
 * Interleave rewritten runs with the chip tokens they sit between.
 * @param runs - `chips.length + 1` rewritten runs.
 * @param chips - chips in clipboard order.
 * @returns the exact draft text a successful segmented write must produce.
 */
export function composeDraft(runs: readonly string[], chips: readonly ReferenceChip[]): string {
  let text = ''
  for (let index = 0; index < runs.length; index += 1) {
    text += runs[index]
    const chip = chips[index]
    if (chip !== undefined) text += chip.clipboardText
  }
  return text
}

/**
 * Split a model answer back into the runs between the same chips.
 *
 * The answer must carry every chip token exactly once, in the original order;
 * anything else is a rejected write (the caller reports `apply_failed`), never
 * a silently degraded one.
 *
 * @param output - cleaned model output.
 * @param chips - chips of the draft that was sent.
 * @returns the runs, or null when the tokens do not line up.
 */
export function splitOutput(output: string, chips: readonly ReferenceChip[]): string[] | null {
  const runs: string[] = []
  let cursor = 0
  for (const chip of chips) {
    const at = output.indexOf(chip.clipboardText, cursor)
    if (at < 0) return null
    runs.push(output.slice(cursor, at))
    cursor = at + chip.clipboardText.length
  }
  runs.push(output.slice(cursor))
  return runs
}

/** What a reader reports about the composer after a write. */
export interface DraftReading {
  draft: string
  refs: readonly string[]
}

/** Outcome of one verified write. */
export interface ApplyOutcome {
  ok: boolean
  /** Why the write was not accepted. */
  reason?: 'no-writer' | 'writer-refused' | 'mismatch'
  /** What the composer showed when verification gave up. */
  seen?: string
}

/** One verified write: perform it, then read the composer back. */
export interface ApplyRequest {
  /** Performs the write; `false` means the editor refused an action outright. */
  write: () => boolean
  /** Exact draft the write must produce. */
  expected: string
  /** Exact chip refs the composer must still carry, in order. */
  expectedRefs?: readonly string[]
  /** Reads the live composer projection. */
  read: () => DraftReading
  /** One frame/tick; injected so tests do not need a real layout clock. */
  wait?: () => Promise<void>
  /** How long verification may take. */
  deadlineMs?: number
  /** Injectable clock. */
  now?: () => number
}

/** Default verification budget: about three frames on a 60 Hz display. */
export const APPLY_DEADLINE_MS = 600

/**
 * @returns a promise resolved after the next animation frame (or a macrotask).
 */
export function nextFrame(): Promise<void> {
  return new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { resolve() })
    else setTimeout(resolve, 0)
  })
}

/**
 * @param reading - what the composer currently shows.
 * @param request - expected values.
 * @returns whether a write landed exactly.
 */
function matches(reading: DraftReading, request: ApplyRequest): boolean {
  if (reading.draft !== request.expected) return false
  if (request.expectedRefs === undefined) return true
  if (reading.refs.length !== request.expectedRefs.length) return false
  return reading.refs.every((ref, index) => ref === request.expectedRefs?.[index])
}

/**
 * Write, then verify on the next frame (M3 §2.1).
 *
 * `setDraft()` returns nothing, so "the function exists" is not evidence that
 * anything happened: a blocked composer ignores the write. This wrapper reads
 * the published draft (and chip refs) back and reports whether the composer
 * really took the text. A mismatch is the caller's signal to restore the
 * snapshot and surface `apply_failed`.
 *
 * @param request - write plus expectations.
 * @returns whether the composer shows exactly the expected text.
 */
export async function applyDraft(request: ApplyRequest): Promise<ApplyOutcome> {
  let accepted: boolean
  try {
    accepted = request.write()
  } catch {
    accepted = false
  }
  if (!accepted) return { ok: false, reason: 'writer-refused', seen: request.read().draft }
  const wait = request.wait ?? nextFrame
  const now = request.now ?? Date.now
  const deadline = now() + (request.deadlineMs ?? APPLY_DEADLINE_MS)
  // Read once synchronously: a synchronous editor update is already visible.
  for (;;) {
    const reading = request.read()
    if (matches(reading, request)) return { ok: true }
    if (now() >= deadline) return { ok: false, reason: 'mismatch', seen: reading.draft }
    await wait()
  }
}

/**
 * Build the rollback snapshot of a parsed draft.
 * @param document - parsed draft.
 * @returns the snapshot stored in the state machine.
 */
export function snapshotOf(document: DraftDocument): DraftSnapshot {
  return {
    text: document.text,
    runs: [...document.runs],
    refs: document.chips.map(chip => chip.ref),
  }
}
