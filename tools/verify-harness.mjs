/**
 * Playwright harness for the M4 from-zero verification.
 *
 * It drives the **real Electron renderer** over CDP (`--remote-debugging-port`),
 * not a browser tab pointed at the same URL: the page under test is the
 * application window, and the process set around it is the cold-start evidence.
 */
import { chromium } from 'file:///C:/Users/融冰/.dsh/dsh-browser/node_modules/.pnpm/node_modules/playwright-core/index.mjs'

export const say = (label, value) => console.log(`\n### ${label}\n${JSON.stringify(value, null, 2)}`)

/** @param port - CDP port of the shell launched by tools/m4-final-verify.ps1. */
export async function connect(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0]
  const page = context.pages().find(candidate => candidate.url().startsWith('dsh-app://')) ?? context.pages()[0]
  page.setDefaultTimeout(30000)
  return { browser, context, page }
}

/** Click the first visible button whose accessible name matches, tolerating a mask. */
async function clickAny(page, names) {
  for (const name of names) {
    const locator = page.getByRole('button', { name })
    if (await locator.count() === 0) continue
    try {
      await locator.first().click({ timeout: 2500 })
      return String(name)
    } catch {
      // A modal mask can cover this candidate; try the next name.
    }
  }
  return null
}

/**
 * Dismiss the first-run onboarding overlay. A fresh `--user-data-dir` shows it;
 * the flow begins at "开始设置", then the quota step "跳过" opens a confirmation
 * dialog ("我知道了").
 */
export async function dismissOnboarding(page, waitMs = 0) {
  const clicked = []
  // The first-run flow can mount several seconds after the composer does (the
  // boot-time account/quota probe decides). Wait for it before concluding "none".
  const ticks = Math.ceil(waitMs / 500)
  for (let tick = 0; tick < ticks; tick += 1) {
    const overlay = page.locator('[class*="onboardingOverlay"]')
    const dialog = page.getByRole('dialog')
    if (await overlay.count() > 0 || await dialog.count() > 0) break
    await page.waitForTimeout(500)
  }
  for (let step = 0; step < 24; step += 1) {
    const dialog = page.getByRole('dialog')
    if (await dialog.count() > 0) {
      const text = await dialog.first().innerText()
      if (/跳过充值|skip/i.test(text)) {
        const name = await clickAny(page, [/^我知道了$/, /^OK$/, /^确认$/])
        if (name !== null) clicked.push(name)
        await page.waitForTimeout(600)
        continue
      }
    }
    const overlay = page.locator('[class*="onboardingOverlay"]')
    if (await overlay.count() === 0) {
      // A step unmounts before the next one mounts; only absence across a
      // settled window means the flow really finished.
      await page.waitForTimeout(900)
      if (await overlay.count() === 0) return clicked
      continue
    }
    const overlayText = await overlay.first().innerText()
    const order = /欢迎使用|Welcome/i.test(overlayText)
      ? [/^开始设置$/, /^Get started$/, /^跳过$/, /^Skip$/, /^继续$/, /^Continue$/]
      : [/^跳过$/, /^Skip$/, /^继续$/, /^Continue$/, /^开始使用$/, /^完成$/, /^关闭$/, /^我知道了$/]
    const name = await clickAny(page, order)
    if (name === null) {
      const fallback = await clickAny(page, [/^继续$/, /^Continue$/, /^跳过$/, /^Skip$/, /^开始设置$/])
      if (fallback === null) return clicked
      clicked.push(fallback)
    } else {
      clicked.push(name)
    }
    await page.waitForTimeout(700)
  }
  return clicked
}

/** @returns the composer locator once the app shell has rendered it. */
export async function composerOf(page) {
  const composer = page.locator('[data-composer-input="true"][contenteditable="true"]').first()
  await composer.waitFor({ timeout: 45000 })
  // The onboarding overlay can mount after the composer; never click through it.
  await page.waitForFunction(
    () => document.querySelector('[class*="onboardingOverlay"]') === null,
    undefined,
    { timeout: 20000 },
  ).catch(() => {})
  return composer
}

/** Read the plugin surface and the composer projection from the live DOM. */
export function readState(page) {
  return page.evaluate(() => {
    const node = document.querySelector('[data-dsh-enhance]')
    const editor = document.querySelector('[data-composer-input="true"]')
    return {
      exists: node !== null,
      phase: node === null ? null : node.getAttribute('data-enhance-phase'),
      title: node === null ? null : node.getAttribute('aria-label'),
      wrapTitle: node === null ? null : node.parentElement?.getAttribute('title') ?? null,
      disabled: node === null ? null : node.disabled === true,
      mode: node === null ? null : node.getAttribute('data-enhance-mode'),
      refs: node === null ? null : node.getAttribute('data-enhance-references'),
      draft: editor === null ? null : editor.textContent,
      chips: editor === null ? 0 : editor.querySelectorAll('[data-composer-chip]').length,
    }
  })
}

/** Wait for one click to settle into `applied` or `error`. */
export async function settle(page, timeout = 90000) {
  await page.waitForFunction(() => {
    const phase = document.querySelector('[data-dsh-enhance]')?.getAttribute('data-enhance-phase')
    return phase === 'applied' || phase === 'error'
  }, undefined, { timeout })
}

/** Type a plain draft from a blank composer. */
export async function typeDraft(page, composer, text) {
  await dismissOnboarding(page)
  await composer.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  await dismissOnboarding(page)
  await composer.click()
  await page.keyboard.type(text)
  await page.waitForTimeout(700)
}

/** Type `@`, pick the first file option, then append text; returns the option label. */
export async function typeReferenceDraft(page, composer, text) {
  await dismissOnboarding(page)
  await composer.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  await dismissOnboarding(page)
  await composer.click()
  await page.keyboard.type('@')
  await page.waitForTimeout(1800)
  const options = await page.getByRole('option').allTextContents()
  const files = options.filter(entry => !entry.includes('进入目录'))
  const target = (files[0] ?? options[0] ?? '').trim()
  if (target === '') throw new Error('the reference menu offered no option')
  await page.getByRole('option').filter({ hasText: target }).first().click()
  await page.waitForTimeout(900)
  await page.keyboard.type(` ${text}`)
  await page.waitForTimeout(700)
  return { target, optionCount: options.length }
}

/** @returns the number of Host request-log lines, or -1 when the file is absent. */
export function requestCount(page, requestsPath) {
  return page.evaluate(async path => {
    try {
      const response = await fetch(`file:///${path.replaceAll('\\', '/')}`)
      if (!response.ok) return -1
      const text = await response.text()
      return text.trim() === '' ? 0 : text.trim().split('\n').length
    } catch {
      return -1
    }
  }, requestsPath)
}
