/**
 * dsh-enhance-prompt — Client half (1.0.0).
 *
 * One `conversation.input.right` entry (id `enhance`, order `10`) whose control
 * rewrites the composer draft through one auxiliary Host call. The client half
 * receives no loader config (M2 experiment 0.2), so rendering settings are read
 * from the documented settings document (`ctx.remote.settings`, namespace = the
 * profile entry id `enhance`, M3 §2.2); `enabled: false` registers no slot entry
 * at all.
 *
 * The Remote contribution stays hand-written (no generator). Its codec is a real
 * zod factory: the M0 review rejected `() => null` as a placeholder. zod is
 * bundled into `lib/client.js` by `build.mjs`; only `react` is external.
 */

import React from 'react'
import * as z from 'zod/mini'
import { ENHANCE_ERROR_CODES, ENHANCE_PROTOCOL_TAG } from '../shared/protocol.ts'
import type { EnhanceInput } from '../shared/protocol.ts'
import { EnhanceButton } from './button.tsx'
import { awaitSettings } from './settings.ts'
import zh from '../../locale/zh.json' with { type: 'json' }
import en from '../../locale/en.json' with { type: 'json' }

/** Locale namespace owned by this package; both dictionaries must share keys. */
const NS = 'enhance'

/**
 * The minimal client Cordis context this plugin calls (M4 §1.3).
 *
 * The client half is not an imported package with declarations; it is the
 * `apply(ctx)` seat the module loader materializes (see
 * `docs/client-envelope.md`). This local structural type keeps the calls honest
 * without inventing an ambient module for a surface the plugin does not import.
 * `useInput` / `inputActions` are typed by `draft.ts` (`InputSelector`,
 * `InputActionsLike`) because they arrive as slot props, not as `ctx` services.
 */
export interface ClientContext {
  remote: {
    $mount(contribution: unknown): Promise<unknown>
  }
  locale: {
    register(namespace: string, dictionaries: Record<string, unknown>): () => void
    bind(namespace: string): (key: string, params?: Record<string, string>) => string
  }
  effect(callback: () => unknown, label?: string): unknown
  inject(deps: string[], callback: (scoped: any) => unknown): unknown
  get(name: string): any
}

let inputSchema: z.ZodMiniType<EnhanceInput> | undefined
let resultSchema: z.ZodMiniType<unknown> | undefined

/** @returns the strict wire codec for `enhance/run` input. */
function inputCodec(): z.ZodMiniType<EnhanceInput> {
  inputSchema ??= z.strictObject({
    text: z.string(),
    sessionId: z.optional(z.string()),
    model: z.optional(z.string()),
    locale: z.optional(z.union([z.literal('zh'), z.literal('en')])),
  })
  return inputSchema
}

/** @returns the strict wire codec for `enhance/run` result. */
function resultCodec(): z.ZodMiniType<unknown> {
  resultSchema ??= z.union([
    z.strictObject({
      ok: z.literal(true),
      text: z.string(),
      route: z.strictObject({
        provider: z.string().check(z.minLength(1)),
        model: z.string().check(z.minLength(1)),
      }),
      elapsedMs: z.number().check(z.gte(0)),
    }),
    z.strictObject({
      ok: z.literal(false),
      code: z.enum(ENHANCE_ERROR_CODES),
      message: z.string(),
    }),
  ])
  return resultSchema
}

/** One descriptor of the hand-written `enhance` Remote group. */
function descriptor(options: {
  id: string
  method: string
  description: string
  parameters: unknown[]
  result: unknown
  cancellation?: unknown
}): Record<string, unknown> {
  return {
    id: options.id,
    service: 'enhance',
    namespace: 'enhance',
    method: options.method,
    description: options.description,
    invocation: { kind: 'direct' },
    parameters: options.parameters,
    ...options.cancellation === undefined ? {} : { cancellation: options.cancellation },
    result: options.result,
  }
}

// Hand-written equivalent of a generated `TYPERT_REMOTE` contribution.
// The Gateway mounts this group as `remote.enhance`; every codec claims
// strict because `$mount()` rejects fields without one.
//
// M3 §2.2 removed the second method (`enhance/settings`): the rendering
// settings now come from `ctx.remote.settings`, the documented namespace the
// Client already reaches, so there is one descriptor and one contract here.
const CONTRIBUTION = {
  package: 'dsh-enhance-prompt',
  descriptors: [
    descriptor({
      id: 'dsh-enhance-prompt#enhance/run',
      method: 'run',
      description: 'Rewrite one prompt with a single auxiliary Host model call.',
      parameters: [{
        name: 'input',
        wire: 'input',
        description: 'draft text plus optional session/model hints.',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: `${ENHANCE_PROTOCOL_TAG}#EnhanceInput`,
          create: inputCodec,
        },
        strictCodec: {
          mode: 'strict',
          typeSymbol: `${ENHANCE_PROTOCOL_TAG}#EnhanceInput`,
          create: inputCodec,
        },
      }],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: `${ENHANCE_PROTOCOL_TAG}#EnhanceResult`,
        create: resultCodec,
      },
    }),
  ],
}

/**
 * @param ctx - client Cordis context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  await ctx.remote.$mount(CONTRIBUTION)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'enhance: dictionaries')
  const t = ctx.locale.bind(NS)

  const settings = await awaitSettings(ctx)
  if (settings.kind === 'inactive') {
    // M4 §1.2: describe() succeeded but the `enhance` namespace is absent, so the
    // Host entry did not activate (almost always an invalid config). Registering
    // the slot here would render a control that can only answer
    // `error: llm_failed`, which blames the model for a configuration mistake.
    // The Host already printed the field-level ValidationError; the Client names
    // the cause once in the console and renders nothing.
    console.warn(
      '[dsh-enhance-prompt] no "enhance" settings namespace: the Host entry is not active '
      + '(invalid config?) — no control registered',
    )
    return
  }
  if (!settings.settings.enabled) {
    console.info('[dsh-enhance-prompt] disabled by config: no slot entry registered')
    return
  }
  const rendering = settings.settings

  ctx.inject(['remote.enhance'], (scoped: any) => {
    const ns = scoped.remote.enhance
    // Read-only access to the per-session composer-block registry. It is not
    // part of the slot's standard props, so it is feature-detected and optional.
    const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
    const composerBlockStore = (sessionId: string) => {
      try {
        const blocks = conversation?.blocks
        return typeof blocks?.storeFor === 'function' ? blocks.storeFor(sessionId) : undefined
      } catch {
        return undefined
      }
    }

    const dispose = scoped.slots.inject('conversation.input.right', () => scoped.slots.register({
      name: 'conversation.input.right',
      id: 'enhance',
      order: 10,
      locale: NS,
      label: () => t('title'),
    }, (props: Record<string, unknown>) => React.createElement(EnhanceButton, {
      ...props,
      ns,
      minTextLength: rendering.minTextLength,
      referencesMode: rendering.referencesMode,
      composerBlockStore,
    })))

    return () => {
      if (typeof dispose === 'function') dispose()
    }
  })
}

/** Required client services; `remote.enhance` is injected after `$mount()`. */
export const inject = ['slots', 'locale', 'remote'] as const
