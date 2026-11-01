/**
 * Minimal ambient declarations for the DSH packages this plugin imports
 * (M4 §1.3).
 *
 * The shipped DSH packages are compiled JS inside `app.asar`; they are not
 * installed as type dependencies in this offline repository and the plugin only
 * uses a small, measured slice of each. Each declaration below names exactly
 * what the sources call — `Service` and the Remote marker, `BlockAssembler` /
 * `createUserMessage`, the deadline helpers, and the Schemastery builder chain.
 * A wider use fails the type gate rather than silently passing.
 */

declare module '@deepseek-ai/cordis' {
  export class Service {
    constructor(ctx: unknown, name: string)
  }
}

declare module '@deepseek-ai/dsh-llm' {
  export function createUserMessage(input: {
    content: Array<{ type: 'text'; text: string }>
  }): unknown

  export class BlockAssembler {
    push(chunk: { type: string; [key: string]: unknown }): void
    blocks(): Array<{ type: string; text?: string }>
    readonly finish: { kind: string; failure?: { code?: string } }
  }
}

declare module '@deepseek-ai/dsh-timeout' {
  export interface DeadlineHandle {
    signal: AbortSignal
    [Symbol.dispose](): void
  }
  export function deadline(upstream: AbortSignal | undefined, timeoutMs: number, code: string): DeadlineHandle
  export function timeoutOf(source: unknown, code: string): unknown
}

declare module '@deepseek-ai/schemastery' {
  interface Schema<T> {
    default(value: T): Schema<T>
    min(value: number): Schema<T>
    max(value: number): Schema<T>
    volatile(): Schema<T>
  }
  const z: {
    object(shape: Record<string, unknown>): unknown
    boolean(): Schema<boolean>
    number(): Schema<number>
    string(): Schema<string>
    union(values: readonly string[]): Schema<string>
  }
  export default z
}
