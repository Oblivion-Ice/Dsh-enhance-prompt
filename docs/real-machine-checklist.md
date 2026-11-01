# Real-machine checklist (manual acceptance)

This is the repeatable manual pass for `dsh-enhance-prompt`, written for the
future maintainer rather than for a review. It assumes Windows and the installed
DeepSeek Harness app at `D:\Deepseek\DeepSeek Harness.exe`.

Two ways to run it:

- **Manual** — follow the numbered checks in a normal desktop session.
- **Automated** — `pwsh -File tools/m4-final-verify.ps1 -Tarball <path>` runs
  the whole from-zero sequence in an isolated home and a **second full Electron
  shell** (separate `--user-data-dir` and CDP port), so the running app is not
  touched. Its output goes to `.m4/final-verify.out.txt`.

The isolated home is `$env:DSH_HOME`; the profile is `profiles/desktop`. Never
point `DSH_HOME` at the real home while experimenting.

## 0. Setup

| # | How | Look for | Pass |
|---|---|---|---|
| 0.1 | Install the packed tarball into the profile (README §Install) and add the bundle row + config row. | `node_modules/dsh-enhance-prompt` exists; `package.json` `dsh.profile.bundles` names it; `cordis.patch.yml` has the `enhance` config. | all three |
| 0.2 | Quit the app completely and relaunch. | A new `DeepSeek Harness.exe` process set (Task Manager). | pids before ≠ after |
| 0.3 | Open a new session. | The app boots without a red error; no `failed to import` line. | yes |

## 1. The control exists and is not the M0 text box

| # | How | Look for | Pass |
|---|---|---|---|
| 1.1 | Look at the composer tool row, immediately left of the model selector (before Send). | A 16 px sparkle/gear-style icon inside a 28 px square. | icon present |
| 1.2 | Hover it. | A tooltip `增强提示词` / `Enhance prompt`. | tooltip text |
| 1.3 | Confirm it is not the old uppercase `ENHANCE` text box. | No text label inside a bordered box. | not a text box |
| 1.4 | Clear the draft. | The control disappears entirely (not greyed). | absent |
| 1.5 | Type one character. | The control reappears. | present |
| 1.6 | Screenshot the tool row with the tooltip visible. | Save as `.m4/desktop-composer.png`. | file exists |

## 2. Plain draft: enhance → revert (exact)

| # | How | Look for | Pass |
|---|---|---|---|
| 2.1 | Type `帮我写个登录页`, click the control. | The icon spins; after a few seconds the draft is replaced by a longer prompt; icon becomes the revert glyph; tooltip `恢复原文`. | `data-enhance-phase="applied"` |
| 2.2 | Click the revert glyph. | The draft is the original, character for character; phase returns to `idle`. | exact text |
| 2.3 | Enhance again, then press Ctrl+Z once. | The original draft returns (one undo entry for a plain write). | exact text |
| 2.4 | Enhance again, then edit one character, then press Ctrl+Z. | The edit is not silently overwritten by a late result; the plugin drops stale results. | edit survives |

## 3. Reference draft: chips are preserved

| # | How | Look for | Pass |
|---|---|---|---|
| 3.1 | Clear the draft, type `@`, pick a workspace file from the menu, then type ` 帮我写个登录页`. | One chip pill, plus text. `data-enhance-references="1"`. | 1 chip |
| 3.2 | Click the control; wait for `applied`. | The text around the chip is rewritten; the chip is still a chip (pill, hoverable, not literal `@name`). | chip count unchanged |
| 3.3 | Read the applied tooltip when the write used more than one run. | It includes `请用按钮回滚；手动撤销需按 N 次`. | N shown |
| 3.4 | Press Ctrl+Z once. | The draft is a half-new mix (this is the documented manual-undo cost), phase `idle`. | mixed state, not a crash |
| 3.5 | Enhance again, then click the revert glyph. | Text **and** chip are exactly what they were before the first click; chip count and `refs` unchanged. | exact restore |
| 3.6 | Screenshot the chip draft before and after revert. | `.m4/ref-before.png`, `.m4/ref-reverted.png`. | files exist |

## 4. `referencesMode: 'disabled'`

| # | How | Look for | Pass |
|---|---|---|---|
| 4.1 | Set `referencesMode: disabled` in the config; reload the page. | With a chip draft the control is `disabled` (not hidden), tooltip `请先移除引用再增强`; wrapper `title` carries the same text. | disabled + reason |
| 4.2 | Force a click (or `.focus()` + Enter). | Nothing happens: no request line, same draft, same phase. | no-op |
| 4.3 | Clear the chips; type plain text. | The control is enabled again. | enabled |

## 5. Invalid config: no control, field-level log

| # | How | Look for | Pass |
|---|---|---|---|
| 5.1 | Set `timeoutMs: abc` in the profile config and restart. | No control is rendered for any draft (M4 §1.2). | absent |
| 5.2 | Read the Host stderr / direct-host output. | `enhance (dsh-enhance-prompt): ValidationError: invalid config: - $.timeoutMs expected number but got abc`. | field-level line |
| 5.3 | Use the settings document check (optional). | `describe()` succeeds; the `enhance` namespace is absent. | absent |
| 5.4 | Restore a valid config and restart. | The control returns. | present |

## 6. Enabled toggle

| # | How | Look for | Pass |
|---|---|---|---|
| 6.1 | Set `enabled: false` and reload. | No control; console info `disabled by config`; `enhance` namespace value `enabled:false`. | absent |
| 6.2 | Set `enabled: true` (no restart needed for the volatile cell), reload. | The control returns. | present |

## 7. Cancel is real

| # | How | Look for | Pass |
|---|---|---|---|
| 7.1 | Type text, click the control, then click the spinning icon while `enhancing`. | No error state; draft unchanged; the Host request log gains a line with `outcome: "error"`, `code: "aborted"`. | log line |
| 7.2 | Repeat, but instead clear or edit the draft while `enhancing`. | The Host request runs to completion (log `ok`) and the Client drops the result; no write-back. | edit survives, no overwrite |

## 8. Session isolation

| # | How | Look for | Pass |
|---|---|---|---|
| 8.1 | Enhance in session A, switch to session B while it runs. | B shows no control state from A and no text; the Host records `aborted` for A (the unmount aborts). | no cross-session text |
| 8.2 | Return to A. | A is `idle` with its draft intact. | idle |

## 9. Uninstall

| # | How | Look for | Pass |
|---|---|---|---|
| 9.1 | Remove the bundle row + patch row, `node $pnpm remove dsh-enhance-prompt` (or delete the junction), quit and relaunch. | The Host boots with empty stderr; no control on any draft; `describe()` has no `enhance` namespace. | clean boot |
| 9.2 | Delete `$DSH_HOME/enhance/` manually. | The data directory is gone; the app is unaffected. | gone |

## 10. Artifacts to keep

- `M4-REPORT.md` — the M4 report and evidence index;
- `.m4/final-verify.out.txt` — the automated from-zero run (every segment);
- `.m4/desktop-composer.png`, `.m4/ref-*.png` — visual evidence;
- `$DSH_HOME/enhance/requests.jsonl` — only if a request-level question arises
  (desensitized; delete after inspection).

## Notes for the next maintainer

- The plugin's Client bundle is loaded at page boot. After rebuilding `lib/`,
  reload the page (junction) or relaunch the app (tarball) before judging.
- Settings are read once per activation; `enabled` / `minTextLength` /
  `referencesMode` changes re-gate on reload.
- The applied tooltip's `N` is the number of changed text runs, not the number
  of chips; a run the model left byte-identical is not written.
- The automated script uses a **second** Electron instance (`--user-data-dir` +
  `--remote-debugging-port`), so it can run while the desktop app stays open.
  Do not use `--user-data-dir` on the normal app; that would hide the real
  profile's state.
