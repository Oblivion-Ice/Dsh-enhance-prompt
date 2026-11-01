/**
 * Loader-facing configuration schema.
 *
 * Mirrors `resolveConfig`; the loader applies defaults before `apply`, while
 * `resolveConfig` re-applies them for tests and for any caller that imports the
 * Host module directly. Cross-field route validation stays in `resolveConfig`
 * because the schema cannot express "both or neither".
 *
 * `enabled` and `minTextLength` are `.volatile()` on purpose (M3 §2.2): only
 * volatile fields are projected into the `dsh-settings` namespace, and that
 * namespace is the documented path the Client half reads them from
 * (`ctx.remote.settings`, namespace = profile entry id). The consequence is
 * recorded in the README: a Host-side config edit that touches only these two
 * fields does not restart the plugin, and the Client re-reads them when it
 * activates.
 */

import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  minTextLength: z.number().min(0).max(1_000_000).default(1).volatile(),
  referencesMode: z.union(['replace-text', 'disabled']).default('replace-text').volatile(),
  maxInputChars: z.number().min(1).max(1_000_000).default(4000),
  maxOutputChars: z.number().min(1).max(100_000).default(800),
  timeoutMs: z.number().min(1).max(2_147_483_647).default(20000),
  provider: z.string(),
  model: z.string(),
  logRequests: z.boolean().default(true),
  shortcut: z.string(),
})
