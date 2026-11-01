/**
 * The composer control: one 16 px icon inside a tool-row-sized button.
 *
 * All state lives in `machine.ts`; this component wires the published composer
 * state to that machine, performs the verified write-back (`draft.ts`), and
 * renders the phase.
 *
 * Accessibility contract (M3 §2.3):
 * - a control that cannot act *is* `disabled`, not merely `aria-disabled`:
 *   it is removed from the tab order and cannot be activated into a no-op;
 * - because a `disabled` button shows no native tooltip, the explanation lives
 *   on the wrapping `<span title=…>` — hover and screen-reader users both get
 *   the reason (`aria-label` mirrors it);
 * - `error` keeps its own `data-enhance-phase` but behaves exactly like `idle`
 *   (clickable, starts a new request), which is deliberate and documented.
 */

import React from 'react'
import type { EnhanceErrorCode, ReferencesMode } from '../shared/protocol.ts'
import { callEnhance } from './guard.ts'
import type { EnhanceNamespace } from './guard.ts'
import { enhanceSessions } from './machine.ts'
import type { SessionState } from './machine.ts'
import {
  applyDraft,
  composeDraft,
  meetsMinimumLength,
  parseDraft,
  referenceCountOf,
  runSpans,
  snapshotOf,
  splitOutput,
  submitPhaseOf,
  useAbsentInput,
} from './draft.ts'
import type { DraftDocument, DraftReading, DraftSnapshot, InputActionsLike, InputSelector } from './draft.ts'

/** Composer-block store (one per session) exposed by the conversation service. */
export interface ComposerBlockStore {
  getSnapshot(): { reason?: string } | undefined
  subscribe(listener: () => void): () => void
}

/** Session snapshot subset this plugin reads. */
interface SessionLike {
  removed?: boolean
}

/** Properties supplied by the `conversation.input.right` slot plus registration data. */
export interface EnhanceButtonProps {
  ns: EnhanceNamespace
  /** Locale seat bound to the `enhance` namespace (entry declares `locale`). */
  t?: (key: string, params?: Record<string, string>) => string
  sessionId?: unknown
  useInput?: InputSelector
  useSession?: (selector: (state: SessionLike | undefined) => unknown) => unknown
  inputActions?: InputActionsLike
  /** From the settings document; 1 when it could not be read. */
  minTextLength?: number
  /** From the settings document; `replace-text` unless configured otherwise. */
  referencesMode?: ReferencesMode
  /** Optional read-only access to the composer-block registry. */
  composerBlockStore?: ((sessionId: string) => ComposerBlockStore | undefined) | undefined
}

/** One write attempt, and how many independent undo entries it created. */
interface WriteResult {
  ok: boolean
  /** `insertText` calls that changed the draft; 0 when nothing usable was written. */
  steps: number
}

const STYLE_ID = 'dsh-enhance-prompt-style'

const CSS = `
.dsh-enhance-wrap {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.dsh-enhance-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.9;
  flex: none;
}
.dsh-enhance-button:hover:not(:disabled) { background: rgba(127, 127, 127, 0.16); }
.dsh-enhance-button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.dsh-enhance-button:disabled { opacity: 0.35; cursor: not-allowed; }
.dsh-enhance-icon { display: block; transform-origin: 50% 50%; }
.dsh-enhance-spin { animation: dsh-enhance-spin 900ms linear infinite; }
@keyframes dsh-enhance-spin { to { transform: rotate(360deg); } }
`

/** Install the small static stylesheet once, when the control first renders. */
function ensureEnhanceStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/**
 * @param props - slot properties, the mounted `remote.enhance` namespace, and settings.
 * @returns the composer control, or null when the draft is below `minTextLength`.
 */
export function EnhanceButton(props: EnhanceButtonProps): React.ReactElement | null {
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  const useInput = props.useInput ?? useAbsentInput
  const useSession = (props.useSession ?? useAbsentInput) as (selector: (state: SessionLike | undefined) => unknown) => unknown
  // The slot supplies `t` because the entry declares `locale`; the fallback keeps
  // a slot-prop drift from throwing inside render (it would show the key instead).
  const t = props.t ?? ((key: string): string => key)

  const draftValue = useInput(state => state?.draft)
  const occurrencesValue = useInput(state => (Array.isArray(state?.occurrences) ? state.occurrences : null))
  const machinePhaseValue = useInput(state => state?.phase)
  const removedValue = useSession(state => (state?.removed === true ? true : false))
  const draft = typeof draftValue === 'string' ? draftValue : ''
  const occurrences = Array.isArray(occurrencesValue) ? occurrencesValue : []
  const references = referenceCountOf({ occurrences })
  const submitPhase = submitPhaseOf(typeof machinePhaseValue === 'string' ? { phase: machinePhaseValue } : undefined)
  const removed = removedValue === true
  const mode: ReferencesMode = props.referencesMode === 'disabled' ? 'disabled' : 'replace-text'

  const getState = React.useCallback((): SessionState => enhanceSessions.get(sessionId), [sessionId])
  const state = React.useSyncExternalStore(enhanceSessions.subscribe, getState, getState)

  const blockStore = React.useMemo(
    () => (typeof props.composerBlockStore === 'function' && sessionId !== ''
      ? props.composerBlockStore(sessionId)
      : undefined),
    [props.composerBlockStore, sessionId],
  )
  const subscribeBlock = React.useCallback(
    (listener: () => void) => (blockStore === undefined ? () => {} : blockStore.subscribe(listener)),
    [blockStore],
  )
  const readBlock = React.useCallback(
    () => (blockStore === undefined ? undefined : blockStore.getSnapshot()),
    [blockStore],
  )
  const composerBlock = React.useSyncExternalStore(subscribeBlock, readBlock, readBlock)

  const draftRef = React.useRef(draft)
  draftRef.current = draft
  const occurrencesRef = React.useRef(occurrences)
  occurrencesRef.current = occurrences
  /** Serializes click handling: a revert or a multi-run write is not re-entrant. */
  const pendingRef = React.useRef(false)

  React.useEffect(() => {
    ensureEnhanceStyle()
  }, [])

  // Invariant 2: an applied result survives only while the editor still shows it.
  React.useEffect(() => {
    enhanceSessions.reconcile(sessionId, draft)
  }, [sessionId, draft, state.phase, state.after])

  // Invariant 4: switching or unmounting aborts this session's request and forgets it.
  React.useEffect(() => () => {
    enhanceSessions.dispose(sessionId)
  }, [sessionId])

  const busy = state.phase === 'enhancing'
  const applied = state.phase === 'applied'
  const machineBusy = submitPhase === 'adjudicating' || submitPhase === 'submitting'
  const locked = sessionId === '' || removed || machineBusy || composerBlock !== undefined
  const blockedByReferences = mode === 'disabled' && references > 0
  const minimum = typeof props.minTextLength === 'number' ? props.minTextLength : 1

  /** Reads the composer exactly as the write-back verifier sees it. */
  const readComposer = React.useCallback((): DraftReading => ({
    draft: draftRef.current,
    refs: occurrencesRef.current
      .map(entry => (typeof entry === 'object' && entry !== null ? (entry as { ref?: unknown }).ref : undefined))
      .filter((ref): ref is string => typeof ref === 'string'),
  }), [])

  /**
   * Writes one plain-text draft and verifies it landed (§2.1).
   *
   * `insertText` over the whole draft is used rather than `setDraft` because the
   * latter commits with the editor's `history-merge` tag: measured on the live
   * composer (M4 §1.1), a Ctrl+Z after a `setDraft` enhancement removed the
   * replacement **and the user's typed draft** together, ending on an empty
   * composer. `insertText` is one independent undo operation ("paste" tag), so
   * undo restores the click-moment draft in exactly one press.
   */
  const writePlain = React.useCallback(async (text: string): Promise<WriteResult> => {
    const actions = props.inputActions
    if (typeof actions?.insertText === 'function' && typeof actions?.captureInsertion === 'function') {
      const end = draftRef.current.length
      const outcome = await applyDraft({
        write: () => {
          const capture = actions.captureInsertion?.()
          if (capture === undefined || capture.draftRev === undefined) return false
          const accepted = actions.insertText?.(text, { start: 0, end, draftRev: capture.draftRev })
          return accepted !== false
        },
        expected: text,
        read: readComposer,
      })
      return { ok: outcome.ok, steps: 1 }
    }
    // A host without the editor actions: whole-document replacement is the only
    // write available. This path cannot guarantee undo granularity (documented).
    if (typeof actions?.setDraft !== 'function') return { ok: false, steps: 0 }
    const outcome = await applyDraft({
      write: () => {
        actions.setDraft?.(text)
        return true
      },
      expected: text,
      read: readComposer,
    })
    return { ok: outcome.ok, steps: 1 }
  }, [props.inputActions, readComposer])

  /**
   * Replaces only the text runs of a chip draft, keeping every chip in place.
   * Runs are written last-to-first so earlier detect spans stay valid; the
   * revision is re-read before every call because `insertText` refuses a span
   * captured at any other revision (`span.draftRev !== rev` → `false`).
   */
  const writeSegmented = React.useCallback(async (
    document: DraftDocument,
    runs: readonly string[],
  ): Promise<WriteResult> => {
    const actions = props.inputActions
    if (typeof actions?.insertText !== 'function' || typeof actions?.captureInsertion !== 'function') {
      return { ok: false, steps: 0 }
    }
    const spans = runSpans(document)
    const expected = composeDraft(runs, document.chips)
    let written = 0
    const outcome = await applyDraft({
      write: () => {
        for (let index = runs.length - 1; index >= 0; index -= 1) {
          if (runs[index] === document.runs[index]) continue
          const span = spans[index]
          if (span === undefined) return false
          const capture = actions.captureInsertion?.()
          if (capture === undefined || capture.draftRev === undefined) return false
          const accepted = actions.insertText?.(
            runs[index] as string,
            { start: span.start, end: span.end, draftRev: capture.draftRev },
          )
          if (accepted === false) return false
          written += 1
        }
        return true
      },
      expected,
      expectedRefs: document.chips.map(chip => chip.ref),
      read: readComposer,
    })
    return { ok: outcome.ok, steps: written }
  }, [props.inputActions, readComposer])

  /** Restores a captured snapshot, chips included, and verifies it. */
  const restore = React.useCallback(async (snapshot: DraftSnapshot): Promise<boolean> => {
    if (snapshot.refs.length === 0) return (await writePlain(snapshot.text)).ok
    const current = parseDraft(draftRef.current, occurrencesRef.current)
    if (!current.ok || current.document.chips.length !== snapshot.refs.length) {
      // The chip set changed under us; a segmented restore cannot be exact.
      return false
    }
    const sameRefs = current.document.chips.every((chip, index) => chip.ref === snapshot.refs[index])
    if (!sameRefs) return false
    return (await writeSegmented(current.document, snapshot.runs)).ok
  }, [writePlain, writeSegmented])

  /** Applies one accepted model answer, returning false when it was rolled back. */
  const applyOutcome = React.useCallback(async (
    text: string,
    document: DraftDocument,
  ): Promise<WriteResult> => {
    let result: WriteResult
    if (document.chips.length === 0) {
      result = await writePlain(text)
    } else {
      // Chips are anchors: the answer has to carry every token, in order.
      const runs = splitOutput(text, document.chips)
      result = runs === null ? { ok: false, steps: 0 } : await writeSegmented(document, runs)
    }
    if (result.ok) return result
    // Self-proving failure: put the user's draft back and report it.
    await restore(snapshotOf(document))
    return { ok: false, steps: 0 }
  }, [writePlain, writeSegmented, restore])

  const onClick = React.useCallback(async () => {
    if (locked || pendingRef.current) return
    const live = enhanceSessions.get(sessionId)
    if (live.phase === 'enhancing') {
      enhanceSessions.cancel(sessionId)
      return
    }
    if (live.phase === 'applied') {
      if (live.after !== draftRef.current) {
        // The user edited after the write-back: drop the snapshot, then enhance
        // the new text on this same click rather than restoring stale content.
        enhanceSessions.reconcile(sessionId, draftRef.current)
      } else if (live.before !== null) {
        const snapshot = live.before
        pendingRef.current = true
        try {
          // Commit only after the composer accepted the restore, so a refused
          // revert keeps the affordance (and the snapshot) intact.
          if (await restore(snapshot)) enhanceSessions.rollback(sessionId)
        } finally {
          pendingRef.current = false
        }
        return
      }
    }
    if (blockedByReferences) return
    const text = draftRef.current
    if (!meetsMinimumLength(text, minimum)) return
    const parsed = parseDraft(text, occurrencesRef.current)
    if (!parsed.ok) {
      enhanceSessions.reportFailure(sessionId, 'references_unsupported')
      return
    }
    const document = parsed.document
    const ticket = enhanceSessions.start(sessionId, snapshotOf(document))
    if (ticket === null) return
    pendingRef.current = true
    try {
      const input = sessionId === '' ? { text } : { text, sessionId }
      const outcome = await callEnhance(props.ns, input, ticket.controller.signal)
      if (outcome === null) return
      // The record may have been cancelled, replaced, or disposed while the call
      // was in flight; only the exact request that started it may write anything.
      const current = enhanceSessions.get(sessionId)
      if (current.phase !== 'enhancing' || current.controller !== ticket.controller) return
      // Safety: the user changed the draft while the request was in flight; do not
      // overwrite that edit (the click-moment snapshot no longer describes the draft).
      if (current.before?.text !== draftRef.current) {
        enhanceSessions.cancel(sessionId)
        return
      }
      if (outcome.ok) {
        const accepted = await applyOutcome(outcome.text, document)
        if (!accepted.ok) {
          enhanceSessions.settle(sessionId, ticket, { ok: false, code: 'apply_failed' })
          return
        }
        enhanceSessions.settle(sessionId, ticket, { ...outcome, undoSteps: accepted.steps })
        return
      }
      enhanceSessions.settle(sessionId, ticket, outcome)
    } finally {
      pendingRef.current = false
    }
  }, [locked, blockedByReferences, sessionId, minimum, props.ns, applyOutcome, restore])

  if (!busy && !meetsMinimumLength(draft, minimum)) return null

  const label = locked
    ? t('locked')
    : blockedByReferences
      ? t('references')
      : busy
        ? t('enhancing')
        : applied
          ? (state.undoSteps !== undefined && state.undoSteps > 1
              ? `${t('revert')}${t('undoHint', { steps: String(state.undoSteps) })}`
              : t('revert'))
          : state.phase === 'error' && state.error !== undefined
            ? t('error', { code: state.error.code })
            : t('title')

  const disabled = locked || blockedByReferences

  return (
    <span className="dsh-enhance-wrap" title={label}>
      <button
        type="button"
        className="dsh-enhance-button"
        title={label}
        aria-label={label}
        aria-busy={busy ? 'true' : undefined}
        data-dsh-enhance="m3"
        data-enhance-phase={state.phase}
        data-enhance-references={references}
        data-enhance-mode={mode}
        disabled={disabled}
        onClick={onClick}
      >
        {applied ? <RevertIcon /> : <SparkIcon spinning={busy} />}
      </button>
    </span>
  )
}

/** @param props - whether the icon spins. @returns the 16 px sparkle icon. */
function SparkIcon(props: { spinning: boolean }): React.ReactElement {
  return (
    <svg
      className={props.spinning ? 'dsh-enhance-icon dsh-enhance-spin' : 'dsh-enhance-icon'}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7.9 1.9l1.2 3.4 3.4 1.2-3.4 1.2-1.2 3.4-1.2-3.4L3.3 6.5l3.4-1.2z" />
      <path d="M12.4 10.5l.35 1.05 1.05.35-1.05.35-.35 1.05-.35-1.05-1.05-.35 1.05-.35z" />
    </svg>
  )
}

/** @returns the 16 px undo icon shown in the applied phase. */
function RevertIcon(): React.ReactElement {
  return (
    <svg
      className="dsh-enhance-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.47" />
      <path d="M3.1 2.6v3.2h3.2" />
    </svg>
  )
}
