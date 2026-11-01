/**
 * State-machine invariants (M2 §3, carried into M3). Pure and store-level
 * tests; no React.
 *
 * M3 changed only the shape of the click-moment snapshot: it now carries the
 * text runs and chip refs (`DraftSnapshot`) so a reference draft can be
 * restored without reconstructing chips.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EnhanceSessions,
  begin,
  cancel,
  fail,
  IDLE_STATE,
  isCurrent,
  reconcile,
  rollback,
  succeed,
} from '../src/client/machine.ts'
import type { DraftSnapshot } from '../src/client/draft.ts'

/** A plain (no-chip) snapshot, the shape a draft without references produces. */
const snap = (text: string): DraftSnapshot => ({ text, runs: [text], refs: [] })

test('machine: begin captures the click-moment draft and a fresh ticket', () => {
  const controller = new AbortController()
  const { state, ticket } = begin(IDLE_STATE, snap('帮我写个登录页'), controller)
  assert.equal(state.phase, 'enhancing')
  assert.deepEqual(state.before, snap('帮我写个登录页'))
  assert.equal(state.after, null)
  assert.equal(state.error, undefined)
  assert.equal(state.controller, controller)
  assert.equal(state.seq, 1)
  assert.deepEqual(ticket, { seq: 1, controller })
  assert.equal(isCurrent(state, ticket), true)
})

test('machine: a reference snapshot survives begin and reports through before.text', () => {
  const controller = new AbortController()
  const reference: DraftSnapshot = { text: '@README.md  改写', runs: ['', '  改写'], refs: ['@README.md'] }
  const { state } = begin(IDLE_STATE, reference, controller)
  assert.deepEqual(state.before, reference)
  assert.equal(state.before?.text, '@README.md  改写')
  assert.equal(state.before?.refs.length, 1)
})

test('machine: a stale seq or replaced controller is discarded', () => {
  const first = begin(IDLE_STATE, snap('a'), new AbortController())
  const second = begin(first.state, snap('b'), new AbortController())
  assert.equal(isCurrent(second.state, first.ticket), false)
  assert.equal(succeed(second.state, first.ticket, 'x'), second.state)
  assert.equal(fail(second.state, first.ticket, 'llm_failed'), second.state)
  // Same seq, different controller identity: also stale.
  const forged = { seq: first.ticket.seq, controller: new AbortController() }
  assert.equal(isCurrent(first.state, forged), false)
  assert.equal(succeed(first.state, forged, 'x'), first.state)
})

test('machine: success lands in applied with before/after and no controller', () => {
  const { state, ticket } = begin(IDLE_STATE, snap('before text'), new AbortController())
  const applied = succeed(state, ticket, 'after text')
  assert.equal(applied.phase, 'applied')
  assert.deepEqual(applied.before, snap('before text'))
  assert.equal(applied.after, 'after text')
  assert.equal(applied.controller, null)
  assert.equal(applied.seq, state.seq)
  assert.equal(applied.undoSteps, 1)
})

test('machine: applied remembers how many undo entries the write created (M4 §1.1)', () => {
  const { state, ticket } = begin(IDLE_STATE, snap('@a before @b'), new AbortController())
  assert.equal(succeed(state, ticket, 'after', 3).undoSteps, 3)
  assert.equal(succeed(state, ticket, 'after', 0).undoSteps, 1)
})

test('machine: failure lands in error; aborted is silent', () => {
  const { state, ticket } = begin(IDLE_STATE, snap('before'), new AbortController())
  const errored = fail(state, ticket, 'too_long')
  assert.equal(errored.phase, 'error')
  assert.deepEqual(errored.error, { code: 'too_long' })
  assert.equal(errored.before, null)
  assert.equal(errored.after, null)

  const { state: again, ticket: againTicket } = begin(errored, snap('before'), new AbortController())
  const aborted = fail(again, againTicket, 'aborted')
  assert.equal(aborted.phase, 'idle')
  assert.equal(aborted.error, undefined)
})

test('machine: apply_failed is a reported error, not a silent idle', () => {
  const { state, ticket } = begin(IDLE_STATE, snap('before'), new AbortController())
  const failed = fail(state, ticket, 'apply_failed')
  assert.equal(failed.phase, 'error')
  assert.deepEqual(failed.error, { code: 'apply_failed' })
  assert.equal(failed.before, null)
})

test('machine: cancel clears the record and invalidates the response', () => {
  const controller = new AbortController()
  const { state, ticket } = begin(IDLE_STATE, snap('before'), controller)
  const cancelled = cancel(state)
  cancelled.controller?.abort()
  assert.equal(controller.signal.aborted, true)
  assert.equal(cancelled.state.phase, 'idle')
  assert.equal(cancelled.state.before, null)
  assert.equal(cancelled.state.controller, null)
  assert.ok(cancelled.state.seq > state.seq)
  assert.equal(isCurrent(cancelled.state, ticket), false)
  assert.equal(succeed(cancelled.state, ticket, 'late'), cancelled.state)
})

test('machine: rollback exists only in applied and ends in idle', () => {
  assert.equal(rollback(IDLE_STATE), null)
  const { state, ticket } = begin(IDLE_STATE, snap('original'), new AbortController())
  assert.equal(rollback(state), null)
  const applied = succeed(state, ticket, 'rewritten')
  const rolled = rollback(applied)
  assert.equal(rolled?.state.phase, 'idle')
  assert.deepEqual(rolled?.before, snap('original'))
  assert.equal(rolled?.state.before, null)
  assert.equal(rolled?.state.after, null)
  assert.equal(rollback(rolled!.state), null)
})

test('machine: a reference rollback keeps the runs and the refs', () => {
  const reference: DraftSnapshot = { text: '@a 前 @b 后', runs: ['', ' 前 ', ' 后'], refs: ['@a', '@b'] }
  const { state, ticket } = begin(IDLE_STATE, reference, new AbortController())
  const rolled = rollback(succeed(state, ticket, '@a 新 @b 更'))
  assert.deepEqual(rolled?.before, reference)
})

test('machine: applied diverges when the live draft differs from after', () => {
  const { state, ticket } = begin(IDLE_STATE, snap('original'), new AbortController())
  const applied = succeed(state, ticket, 'rewritten')
  assert.equal(reconcile(applied, 'rewritten'), applied)
  const diverged = reconcile(applied, 'rewritten + my edit')
  assert.equal(diverged.phase, 'idle')
  assert.equal(diverged.before, null)
  assert.equal(diverged.after, null)
  // Non-applied phases are untouched.
  assert.equal(reconcile(state, 'anything'), state)
})

test('machine: reportFailure surfaces a client-side code and refuses to clobber enhancing', () => {
  const sessions = new EnhanceSessions()
  const ticket = sessions.start('S', snap('draft'))!
  sessions.reportFailure('S', 'apply_failed')
  assert.equal(sessions.get('S').phase, 'enhancing')
  sessions.settle('S', ticket, { ok: false, code: 'apply_failed' })
  assert.equal(sessions.get('S').phase, 'error')

  sessions.cancel('S')
  sessions.reportFailure('S', 'references_unsupported')
  assert.deepEqual(sessions.get('S').error, { code: 'references_unsupported' })
})

test('sessions: records are isolated per session and disposal aborts', async () => {
  const sessions = new EnhanceSessions()
  const ticketA = sessions.start('A', snap('draft A'))
  assert.ok(ticketA !== null)
  assert.equal(sessions.get('A').phase, 'enhancing')
  assert.equal(sessions.get('B').phase, 'idle')

  // A second start on an enhancing session is refused (invariant 5).
  assert.equal(sessions.start('A', snap('again')), null)
  assert.equal(sessions.get('A').controller, ticketA!.controller)

  sessions.dispose('A')
  assert.equal(ticketA!.controller.signal.aborted, true)
  assert.equal(sessions.has('A'), false)
  assert.equal(sessions.get('A').phase, 'idle')
  assert.equal(sessions.settle('A', ticketA!, { ok: true, text: 'late' }), false)

  const ticketB = sessions.start('B', snap('draft B'))
  assert.ok(ticketB !== null)
  assert.equal(sessions.settle('B', ticketB!, { ok: true, text: 'B result' }), true)
  assert.equal(sessions.get('B').phase, 'applied')
  assert.deepEqual(sessions.rollback('B'), snap('draft B'))
  assert.equal(sessions.get('B').phase, 'idle')
})

test('sessions: settle rejects a stale ticket after rollback or cancel', () => {
  const sessions = new EnhanceSessions()
  const ticket = sessions.start('S', snap('original'))!
  sessions.cancel('S')
  assert.equal(sessions.settle('S', ticket, { ok: true, text: 'late' }), false)
  assert.equal(sessions.get('S').phase, 'idle')

  const appliedTicket = sessions.start('S', snap('original'))!
  sessions.settle('S', appliedTicket, { ok: true, text: 'rewritten' })
  sessions.rollback('S')
  assert.equal(sessions.settle('S', appliedTicket, { ok: true, text: 'late again' }), false)
  assert.equal(sessions.get('S').phase, 'idle')
})

test('sessions: subscribers see every committed transition and nothing else', () => {
  const sessions = new EnhanceSessions()
  let calls = 0
  const unsubscribe = sessions.subscribe(() => {
    calls += 1
  })
  const ticket = sessions.start('S', snap('a'))!
  assert.equal(calls, 1)
  sessions.reconcile('S', 'unrelated while enhancing')
  assert.equal(calls, 1)
  sessions.settle('S', ticket, { ok: true, text: 'b' })
  assert.equal(calls, 2)
  sessions.reconcile('S', 'b')
  assert.equal(calls, 2)
  sessions.reconcile('S', 'edited')
  assert.equal(calls, 3)
  unsubscribe()
  sessions.dispose('S')
  assert.equal(calls, 3)
})
