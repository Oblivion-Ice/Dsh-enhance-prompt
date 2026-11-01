/**
 * Desensitized request log.
 *
 * The plugin does not write session history, so this JSONL file is the only
 * audit trail. It never accepts the original text: the entry carries a SHA-256
 * hash and lengths only. The file lives under `$DSH_HOME/enhance/` and rotates
 * by size.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EnhanceErrorCode, EnhanceRoute } from '../shared/protocol.ts'

/** One line of `requests.jsonl`. */
export interface RequestLogEntry {
  ts: number
  sessionId: string | null
  route: EnhanceRoute | null
  inputChars: number
  outputChars: number
  elapsedMs: number
  outcome: 'ok' | 'error'
  inputHash: string
  code: EnhanceErrorCode | null
  truncated?: boolean
}

export interface LogOptions {
  home?: string | undefined
  maxBytes?: number | undefined
  keep?: number | undefined
}

export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024
export const DEFAULT_LOG_KEEP = 3

/**
 * Hash one input without retaining it.
 * @param text - exact user draft.
 * @returns `sha256:<hex>`.
 */
export function hashInput(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/**
 * Append one desensitized request record.
 * @param entry - the record to append.
 * @param options - home override and rotation bounds (tests use a temp home).
 * @returns the file that received the line.
 */
export function logRequest(entry: RequestLogEntry, options: LogOptions = {}): string {
  const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES
  const keep = options.keep ?? DEFAULT_LOG_KEEP
  const directory = join(home, 'enhance')
  const file = join(directory, 'requests.jsonl')
  const line = `${JSON.stringify(entry)}\n`
  mkdirSync(directory, { recursive: true })
  rotateIfNeeded(file, Buffer.byteLength(line, 'utf8'), maxBytes, keep)
  appendFileSync(file, line, 'utf8')
  return file
}

/**
 * Rotate `requests.jsonl` to `.1`, `.2`, ... when the next line would cross the cap.
 * @param file - active log path.
 * @param incomingBytes - bytes the next line will add.
 * @param maxBytes - per-file cap.
 * @param keep - number of rotated generations to retain.
 */
function rotateIfNeeded(file: string, incomingBytes: number, maxBytes: number, keep: number): void {
  if (!existsSync(file)) return
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return
  }
  if (size + incomingBytes <= maxBytes) return

  const oldest = `${file}.${keep}`
  if (existsSync(oldest)) unlinkSync(oldest)
  for (let index = keep - 1; index >= 1; index -= 1) {
    const from = `${file}.${index}`
    if (existsSync(from)) renameSync(from, `${file}.${index + 1}`)
  }
  renameSync(file, `${file}.1`)
}
