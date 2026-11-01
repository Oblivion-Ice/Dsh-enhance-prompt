# Client envelope contract (`window.__ModuleLoader__`)

This is the contract the browser shell expects from `lib/client.js`. It was
read from the shipped 0.2.1-rc.5 runtime, not inferred by trial:

- `@deepseek-ai/dsh-client-modules`: the registration facade injected into
  `<head>` (`bootInjections` in `lib/index.js`) and the `register` /
  `materialize` implementation in `lib/client.js`.
- The boot graph row that names a package (`__DSH_BOOT__.entries`), and the
  `dsh.client` declaration validator in the same package.

## The call

A bundle is one **classic script** (not an ES module) that synchronously calls:

```js
window.__ModuleLoader__.load({
  id: '<package name>',
  factory: (require) => {
    // optional CJS prelude
    var module = { exports: {} }
    var exports = module.exports
    // bundle body
    return module.exports
  },
})
```

No other call form is accepted. There is no `define`, no dependency array, no
async factory, and no default export convention.

## Fields

| Field | Required | Contract |
|---|---|---|
| `id` | yes | The package name from `package.json` (`dsh-enhance-prompt`). `register()` strips one trailing `/client`, so `dsh-enhance-prompt/client` resolves to the same row, but the bare package name is the canonical value. A different id registers a factory under a name the boot row never imports, and the row fails with `loaded without registering "<id>" via __ModuleLoader__.load`. |
| `factory` | yes | `(require) => exports`. It is stored, **not called**, when the script executes. It runs synchronously on first import/materialization and its return value becomes the module's exports. Returning `undefined` yields `undefined` exports, and the plugin's `apply`/`inject` face is then missing. |
| `chunk` | no | Only for package-local split chunks from `require.async('./client.<name>.js')`. Must match `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`. The main bundle must omit it. |

The facade has two modes:

1. **queue** — before `window.__ModuleLoader__.create(bootGraph)`. `load()`
   appends the registration to `pendingQueue`; nothing executes.
2. **live** — after `create()`. `load()` delegates straight to
   `ClientModuleSystem.register()`.

A bundle may therefore execute before the graph exists (the bootstrap batch
does), but ordinary plugin bundles are fetched lazily after boot. Registering the
same id twice while it is live throws
`duplicate factory registration for "<id>" (bundle executed twice without invalidate?)`.

## Inside `factory`

`require(specifier)` is the only module access:

1. the frozen platform seed table (`react`, `react-dom`, `react/jsx-runtime`,
   `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots`,
   `@deepseek-ai/dsh-client-ui-primitives`, …). The 0.2.1-rc.5 shell also seeds
   `zod`, but this plugin does not rely on that: its bundle inlines zod;
2. an already-materialized module;
3. a registered package factory, materialized recursively;
4. otherwise it throws. A missed require is a build-time externals drift, not a
   runtime fallback.

Resolution is synchronous, and a require cycle is fatal
(`require cycle through "<id>"`). `require.async('./client.<name>.js')` is the
only asynchronous form; a relative chunk must match the `client.*.js` pattern,
and a bare `require.async(spec)` delegates to the normal import path.

Dependencies between packages are **not** declared in the envelope. They come
from `package.json`:

```json
"dsh": {
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"],
    "external": ["@deepseek-ai/dsh-client-ui-conversation/client"]
  }
}
```

`inject` rows arrive before the consumer; `external` names exact non-baseline
modules the consumer requires. Type-only imports vanish and create no request.

## Failure reporting

Registration and materialization are deliberately loud:

- a bundle URL that loads without registering the boot row's id is recorded as
  `loaded without registering "<id>" via __ModuleLoader__.load`;
- a factory that throws is recorded as an import failure for that row and
  rethrown to the consumer;
- duplicate ids, invalid chunk names, require cycles, and missed requires throw;
- the Web boot audit reports the last failure text per entry; the page shows the
  failed plugin rather than silently continuing.

There is no per-registration error callback and no "try again inside the
factory" hook. Fail at build time instead.

## What this project emits

`build.mjs` compiles `src/client/index.tsx` to CommonJS and wraps it in exactly
the envelope above:

```js
window.__ModuleLoader__.load({
  id: "dsh-enhance-prompt",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    /* esbuild CJS body */
    return module.exports;
  },
});
```

- `format: 'cjs'` keeps the body as a function body, so module side effects run
  at materialization, not when the script arrives.
- `react` is the only external; the factory therefore calls `require("react")`
  and nothing else. `zod` (including the `zod/mini` tree) is inlined.
- `test/build.test.ts` executes the generated envelope with a fake loader and
  asserts the id, the lazily returned `apply`/`inject` face, the single external,
  the shared protocol marker, and the real zod codecs.

## Loader behaviour observed during M3

Measured while building the M3 evidence harness (a second client-only package,
`m3-probe`, mounted beside this plugin). None of these contradicted the contract
above; each is a precise failure message worth knowing before writing a plugin.

1. **`dsh.client` without `exports["./client"]` is a composition failure, not a
   warning.** The Host refuses to start the client graph:

   ```text
   client-modules: m3-probe declares dsh.client but exports no "./client" bundle
   ```

   The `./client` export is what the Host serves and what the boot row imports;
   a package whose `main` is correct but whose `exports` omits `./client` fails
   before any browser code runs.

2. **Service access on the client context is guarded by `inject`.** Reading a
   nested service that the plugin did not declare throws rather than answering
   `undefined`:

   ```text
   Error: cannot get property "remote.settings" without inject
   ```

   This is why this plugin reads the settings document only inside
   `ctx.inject(['remote.settings'], …)` (see `src/client/settings.ts`), and why
   the probe had to declare the same dependency before it could call
   `describe()`. Cordis 4.0.5 has no optional-inject form, so a hard declaration
   in `inject` would make the whole plugin wait forever on a host that serves no
   settings controller; the bounded wait inside `apply` is the workaround.

3. **Bundles are grouped into combo scripts.** In the running Web shell this
   plugin's bundle and the probe's arrived in one
   `/plugins/??a/client.js,b/client.js&rev=…` script; registration order inside
   the combo is the boot-graph order, and each entry still registers itself.

4. **Client `apply(ctx, config)` still receives no config** (M2 experiment 0.2,
   re-confirmed in M3: `apply` is called with two arguments, the second
   `undefined`). Rendering settings must come from a service, never from the
   loader.

## Write-back and undo granularity (M4 §1.1)

Read from the shipped `dsh-client-ui-conversation` bundle:

- the published `InputActions` face is `captureInsertion()`,
  `insertText(text, span)`, and `setDraft(text)` (plus attachments / submit);
- `insertText` commits with the Lexical `paste` tag — **one independent undo
  entry per call**;
- `setDraft` commits with `history-merge`, which folds the replacement into the
  previous undo entry; measured on the live composer, a Ctrl+Z after a plain
  `setDraft` enhancement removed the replacement **and** the user's typed draft.

There is no batch/transaction parameter and no `editor.update`-level action in
the published face, so N replacement runs cannot be merged into one undo entry
from a plugin (doing it would need a new Host API or the private
`DraftEditorRuntime.replaceText`). The plugin therefore writes every replacement
through `insertText` — one call for a plain draft, one per changed run between
chips — and states the resulting undo count in the applied tooltip. A manual
Ctrl+Z after a chip rewrite is therefore N presses, with a half-new draft in
between; the button's revert is the supported path and is exact.

