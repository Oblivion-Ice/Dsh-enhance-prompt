# Changelog

All notable changes to `dsh-enhance-prompt`. The project is a DSH desktop plugin;
versions before `1.0.0` were milestone builds kept only in the repository.

## 1.0.0 — 2026-11-01

First stable release. Functionally complete; the M4 cycle only made it
deliverable.

### Fixed

- **One undo entry per plain write.** A plain draft is now written with one
  whole-span `insertText` instead of `setDraft`. Measured: `setDraft` commits
  with the editor's `history-merge` tag, so Ctrl+Z after a plain enhancement
  removed the replacement **and** the user's typed draft; `insertText` is one
  independent undo entry, so one Ctrl+Z restores the click-moment draft.
- **An invalid config no longer renders a control that can only fail.** When
  `describe()` succeeds but the `enhance` settings namespace is absent, the Host
  entry did not activate; the Client now logs the cause and registers no slot
  entry instead of answering every click with `error: llm_failed` (closes M3
  deviation 12). A failed `describe()` still falls back to the documented
  defaults and renders.
- **`tsc` is a real type check.** `noCheck: false`, `skipLibCheck: true`, and a
  minimal `src/types/` ambient shim for the Node builtins and DSH packages the
  sources use. Zero errors, no `@ts-expect-error`. `npm run verify` runs build,
  tests, and the type gate.

### Added

- The applied tooltip states the manual-undo cost when it exceeds one press:
  `恢复原文（请用按钮回滚；手动撤销需按 N 次）` / `Revert to original (use this
  button to revert; manual undo takes N presses)`.
- `CHANGELOG.md`, a release distribution decision (packed tarball), and
  `docs/real-machine-checklist.md`.
- `tools/m4-final-verify.ps1`: one from-zero script that uninstalls, installs the
  packed tarball into a clean profile, cold-starts the **full Electron shell**,
  drives plain/reference/disabled/invalid cases in the application renderer, and
  uninstalls again.

### Changed

- Version `1.0.0`; the release artifact is `dsh-enhance-prompt-1.0.0.tgz`.
- README rewritten around the stable behaviour: install (tarball and junction),
  config table with volatile semantics, three-state table, reference/`apply_failed`
  guarantees, undo granularity, cancel semantics, the `Model-visible ⟺ logged`
  deviation, and Known Limitations.

## 0.3.0-m3 — 2026-11-01

Hardening and reference write-back.

- Reference drafts are preserved: only the text runs between chips are rewritten
  (`referencesMode: 'replace-text'`); chips are never edited, so a failed write
  cannot destroy one. `referencesMode: 'disabled'` is the M2-compatible fallback.
- Every write is verified by reading the published draft and chip refs back;
  mismatch → restore the click-moment snapshot → `apply_failed`.
- `insertText` needs the current `draftRev`; the plugin re-reads it before every
  call.
- Real `disabled` controls (not `aria-disabled`); disabled reasons live on the
  wrapper `title`.
- Rendering settings come from the documented `ctx.remote.settings` namespace;
  the plugin-private `enhance/settings` method was removed.
- `dsh.client.inject` reduced to the two packages actually needed.

## 0.2.0-m2 — 2026-11-01

- Session-isolated state machine (`idle / enhancing / applied` + `error`),
  stale-response rejection by `seq` + controller identity.
- Real cancellation via `ns.run(input, signal)`; the Host records `aborted`.
- zh/en locale dictionaries and a locale-aware slot entry.
- tarball acceptance in a clean profile.

## 0.1.5-m1.5 — 2026-11-01

- `build.mjs` emits the whole `lib/` (Host ESM + browser bundle) in one pass;
  the hand-written loader envelope was replaced by an esbuild pipeline.

## 0.1.0-m1 — 2026-10-31

- Host service and the hand-written Remote binding (`enhance/run`), route
  resolution, one auxiliary model call, output cleanup, desensitized request log,
  config schema and validation.
- First end-to-end Client control in `conversation.input.right`.

## 0.1.0-m0 — 2026-10-31

- Channel proof: hand-written Typert contribution + `ctx.remote.$mount()`, Host
  SRC resolution. No host artifact modified.
