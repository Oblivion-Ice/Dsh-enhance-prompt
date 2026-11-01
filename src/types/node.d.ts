/**
 * Minimal ambient declarations for the Node.js builtins used by this repository
 * (M4 §1.3).
 *
 * The project has no `@types/node` and no DSH type packages: the desktop profile
 * is offline and `tsc` is a gate, not an installer. These declarations cover
 * exactly the surface `src/` and `test/` touch, so `noCheck: false` becomes a
 * real semantic check instead of a parse check. Anything a type needs beyond
 * this file fails the gate, which is the point.
 */

declare const process: {
  env: Record<string, string | undefined>
}

declare const Buffer: {
  byteLength(value: string, encoding?: string): number
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string, encoding?: 'utf8'): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: 'sha256'): Hash
}

declare module 'node:fs' {
  export function appendFileSync(path: string, data: string, encoding?: 'utf8'): void
  export function existsSync(path: string | URL): boolean
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function renameSync(from: string, to: string): void
  export function statSync(path: string | URL): { size: number }
  export function unlinkSync(path: string): void
  export function readFileSync(path: string | URL, encoding: 'utf8'): string
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function mkdtempSync(prefix: string): string
  export function readdirSync(path: string | URL): string[]
  const fs: {
    readFileSync: typeof readFileSync
    existsSync: typeof existsSync
    statSync: typeof statSync
    readdirSync: typeof readdirSync
    mkdtempSync: typeof mkdtempSync
    rmSync: typeof rmSync
  }
  export default fs
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
}

declare module 'node:assert/strict' {
  interface AssertStrict {
    (value: unknown, message?: string): asserts value
    equal(actual: unknown, expected: unknown, message?: string): void
    notEqual(actual: unknown, expected: unknown, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    ok(value: unknown, message?: string): asserts value
    match(value: string, regExp: RegExp, message?: string): void
    doesNotMatch(value: string, regExp: RegExp, message?: string): void
    throws(fn: () => unknown, expected?: RegExp | ((error: unknown) => boolean) | (new (...args: any[]) => unknown), message?: string): void
    rejects(
      promise: Promise<unknown>,
      expected?: RegExp | ((error: unknown) => boolean) | (new (...args: any[]) => unknown),
      message?: string,
    ): Promise<void>
  }
  const assert: AssertStrict
  export default assert
}

declare module 'node:test' {
  interface TestContext {
    mock: {
      timers: {
        enable(options?: { apis?: string[] }): void
        tick(milliseconds: number): void
      }
    }
  }
  type TestFunction = (context: TestContext) => void | Promise<void>
  function test(name: string, fn?: TestFunction): Promise<void>
  export default test
}

declare module 'node:vm' {
  interface RunningOptions {
    filename?: string
  }
  function runInNewContext(code: string, contextObject?: object, options?: RunningOptions): unknown
  const vm: { runInNewContext: typeof runInNewContext }
  export default vm
}
