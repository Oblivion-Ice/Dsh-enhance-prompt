/**
 * M3 client state machine — one isolated, session-addressed record.
 *
 * The invariants from the M2 kickoff are implemented here as pure transitions so
 * they can be unit-tested without React:
 *
 * 1. a settled response is accepted only while `seq` AND `controller` still match;
 * 2. `applied` drops back to `idle` (clearing `before`/`after`) as soon as the
 *    live draft differs from the written-back text;
 * 3. rollback exists only in `applied` and always ends in `idle`;
 * 4. disposal aborts the in-flight controller and deletes the session record;
 * 5. every click path is gated by `phase`, not by a local boolean.
 */

import type { EnhanceErrorCode } from '../shared/protocol.ts'
import type { DraftSnapshot } from './draft.ts'

/** The four observable phases. `error` is clickable and behaves like `idle`. */
export type Phase = 'idle' | 'enhancing' | 'applied' | 'error'

/** One session's complete enhance state. */
export interface SessionState {
  phase: Phase
  /** Draft (text runs plus chip refs) captured at the moment the request started. */
  before: DraftSnapshot | null
  /** Text written back by the accepted response. */
  after: string | null
  /** Terminal failure, rendered as `error: <code>` in the tooltip. */
  error?: { code: EnhanceErrorCode } | undefined
  /**
   * Independent undo entries the accepted write created (M4 §1.1). One for a
   * plain draft, one per changed text run for a chip draft. Used only to tell the
   * user how far Ctrl+Z is from the original; the button's revert is unaffected.
   */
  undoSteps?: number | undefined
  /** In-flight cancellation handle; always null outside `enhancing`. */
  controller: AbortController | null
  /** Monotonic request sequence; stale responses never match. */
  seq: number
}

/** The identity a pending response must still match to be accepted. */
export interface EnhanceTicket {
  seq: number
  controller: AbortController
}

/** A session that has never run an enhance, or was reset by divergence. */
export const IDLE_STATE: SessionState = Object.freeze({
  phase: 'idle',
  before: null,
  after: null,
  controller: null,
  seq: 0,
})

/**
 * @param before - draft captured at click time.
 * @param controller - abort handle owned by the new request.
 * @param previous - current record (used for the sequence).
 * @returns the enhancing record and the ticket a response must carry.
 */
export function begin(
  previous: SessionState,
  before: DraftSnapshot,
  controller: AbortController,
): { state: SessionState; ticket: EnhanceTicket } {
  const seq = previous.seq + 1
  return {
    state: {
      phase: 'enhancing',
      before,
      after: null,
      controller,
      seq,
    },
    ticket: { seq, controller },
  }
}

/**
 * @param state - current record.
 * @param ticket - identity captured at request start.
 * @returns whether a response arriving now is still the one this state waits for.
 */
export function isCurrent(state: SessionState, ticket: EnhanceTicket): boolean {
  return state.phase === 'enhancing'
    && state.seq === ticket.seq
    && state.controller === ticket.controller
}

/**
 * Accept one successful response.
 * @param state - current record.
 * @param ticket - identity of the accepted request.
 * @param text - cleaned model output that was just written back.
 * @param undoSteps - independent undo entries the write created (default 1).
 * @returns the applied record, or the untouched record when stale (invariant 1).
 */
export function succeed(state: SessionState, ticket: EnhanceTicket, text: string, undoSteps = 1): SessionState {
  if (!isCurrent(state, ticket)) return state
  return {
    phase: 'applied',
    before: state.before,
    after: text,
    undoSteps: Math.max(1, undoSteps),
    controller: null,
    seq: state.seq,
  }
}

/**
 * Accept one failed response. `aborted` is silent (invariant: no error affordance
 * after a cancel), so it lands in `idle` instead of `error`.
 * @param state - current record.
 * @param ticket - identity of the failed request.
 * @param code - normalized protocol error code.
 * @returns the next record, or the untouched record when stale (invariant 1).
 */
export function fail(state: SessionState, ticket: EnhanceTicket, code: EnhanceErrorCode): SessionState {
  if (!isCurrent(state, ticket)) return state
  if (code === 'aborted') return { ...IDLE_STATE, seq: state.seq }
  return {
    phase: 'error',
    before: null,
    after: null,
    error: { code },
    controller: null,
    seq: state.seq,
  }
}

/**
 * Cancel the in-flight request (invariant 5: the click is routed by phase).
 * The sequence advances so a response already on the wire is discarded.
 * @param state - current record.
 * @returns the idle record and the controller the caller must abort.
 */
export function cancel(state: SessionState): { state: SessionState; controller: AbortController | null } {
  return { state: { ...IDLE_STATE, seq: state.seq + 1 }, controller: state.controller }
}

/**
 * Drop `applied` as soon as the live draft diverges from the written-back text.
 * @param state - current record.
 * @param draft - live editor projection.
 * @returns the demoted record, or the untouched record.
 */
export function reconcile(state: SessionState, draft: string): SessionState {
  if (state.phase !== 'applied') return state
  if (state.after !== null && draft === state.after) return state
  return { ...IDLE_STATE, seq: state.seq }
}

/**
 * Roll back an applied result (invariant 3).
 * @param state - current record.
 * @returns the idle record plus the draft to restore, or null when not applicable.
 */
export function rollback(state: SessionState): { state: SessionState; before: DraftSnapshot } | null {
  if (state.phase !== 'applied' || state.before === null) return null
  return { state: { ...IDLE_STATE, seq: state.seq + 1 }, before: state.before }
}

/**
 * Session-addressed registry shared by every button instance. One record per
 * session id; no global state leaks between conversations (invariant 4).
 */
export class EnhanceSessions {
  private readonly records = new Map<string, SessionState>()
  private readonly listeners = new Set<() => void>()

  /** @param sessionId - conversation id. @returns the stable current record. */
  get(sessionId: string): SessionState {
    return this.records.get(sessionId) ?? IDLE_STATE
  }

  /** @param sessionId - conversation id. @returns whether a record exists. */
  has(sessionId: string): boolean {
    return this.records.has(sessionId)
  }

  /**
   * Subscribe to any record replacement (react `useSyncExternalStore` shape).
   * @param listener - called after every committed transition.
   * @returns unsubscribe handle.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** @param next - replacement record. @returns nothing. */
  private set(sessionId: string, next: SessionState): void {
    if (next === this.get(sessionId)) return
    this.records.set(sessionId, next)
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Start a request for one session. A start is refused while the record is
   * `enhancing`; callers route that click to {@link cancel} instead (invariant 5).
   * @param sessionId - conversation id.
   * @param before - draft captured at click time.
   * @returns the ticket the response must echo, or null when a request is already in flight.
   */
  start(sessionId: string, before: DraftSnapshot): EnhanceTicket | null {
    const current = this.get(sessionId)
    if (current.phase === 'enhancing') return null
    const controller = new AbortController()
    const { state, ticket } = begin(current, before, controller)
    this.set(sessionId, state)
    return ticket
  }

  /**
   * Accept a response whose request may belong to another session generation.
   * @param sessionId - conversation id.
   * @param ticket - identity captured at request start.
   * @param outcome - normalized success or failure.
   * @returns whether the response was accepted.
   */
  settle(
    sessionId: string,
    ticket: EnhanceTicket,
    outcome: { ok: true; text: string; undoSteps?: number } | { ok: false; code: EnhanceErrorCode },
  ): boolean {
    if (!this.records.has(sessionId)) return false
    const current = this.get(sessionId)
    const next = outcome.ok
      ? succeed(current, ticket, outcome.text, outcome.undoSteps)
      : fail(current, ticket, outcome.code)
    if (next === current) return false
    this.set(sessionId, next)
    return true
  }

  /** @param sessionId - conversation id. @returns nothing; aborts the in-flight request. */
  cancel(sessionId: string): void {
    const { state, controller } = cancel(this.get(sessionId))
    controller?.abort()
    this.set(sessionId, state)
  }

  /**
   * Surface a client-side failure that never reached the Host (an unmappable
   * chip table, for instance) as an `error` record, so the tooltip explains it.
   * @param sessionId - conversation id.
   * @param code - normalized protocol code.
   * @returns nothing.
   */
  reportFailure(sessionId: string, code: EnhanceErrorCode): void {
    const current = this.get(sessionId)
    if (current.phase === 'enhancing') return
    this.set(sessionId, {
      phase: 'error',
      before: null,
      after: null,
      error: { code },
      controller: null,
      seq: current.seq + 1,
    })
  }

  /**
   * @param sessionId - conversation id.
   * @returns the snapshot to write back, or null when the session is not `applied`.
   */
  rollback(sessionId: string): DraftSnapshot | null {
    const result = rollback(this.get(sessionId))
    if (result === null) return null
    this.set(sessionId, result.state)
    return result.before
  }

  /**
   * @param sessionId - conversation id.
   * @param draft - live editor projection.
   * @returns nothing; demotes `applied` when the user edited the draft.
   */
  reconcile(sessionId: string, draft: string): void {
    const current = this.get(sessionId)
    const next = reconcile(current, draft)
    if (next !== current) this.set(sessionId, next)
  }

  /**
   * Abort and forget one session (session switch or unmount).
   * @param sessionId - conversation id.
   * @returns nothing.
   */
  dispose(sessionId: string): void {
    const current = this.records.get(sessionId)
    if (current === undefined) return
    current.controller?.abort()
    this.records.delete(sessionId)
    for (const listener of [...this.listeners]) listener()
  }

  /** Abort and forget every session. @returns nothing. */
  disposeAll(): void {
    for (const sessionId of [...this.records.keys()]) this.dispose(sessionId)
  }
}

/** Module-level registry shared by the slot entries. */
export const enhanceSessions = new EnhanceSessions()
