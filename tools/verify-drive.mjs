/**
 * One UI phase of the M4 from-zero verification (plain Node + Playwright).
 *
 * Usage:
 *   node tools/verify-drive.mjs --port 9440 --phase plain --requests <jsonl> [--shots <dir>]
 *
 * Phases: clean | plain | reference | disabled | invalid | uninstalled
 * Prints labelled JSON blocks to stdout; the PowerShell orchestrator appends them
 * to `.m4/final-verify.out.txt`.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  connect,
  composerOf,
  dismissOnboarding,
  readState,
  say,
  settle,
  typeDraft,
  typeReferenceDraft,
} from './verify-harness.mjs'

const arg = (name, fallback = undefined) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const port = arg('port', '9440')
const phase = arg('phase', 'clean')
const requestsPath = arg('requests', '')
const shots = arg('shots', '.m4')

const countRequests = () => {
  try {
    return fs.readFileSync(requestsPath, 'utf8').trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

const shot = async (page, name) => {
  fs.mkdirSync(shots, { recursive: true })
  const file = path.join(shots, name)
  await page.screenshot({ path: file })
  return file
}

const { browser, page } = await connect(port)
const consoleTail = []
page.on('console', message => consoleTail.push(`${message.type()}: ${message.text()}`))
page.on('pageerror', error => consoleTail.push(`pageerror: ${error.message}`))
// Let the boot-time account/quota probe decide whether the first-run flow mounts.
await page.waitForTimeout(4000)
const onboarding = await dismissOnboarding(page, 12000)
const composer = await composerOf(page)
const button = page.locator('[data-dsh-enhance]').first()

if (phase === 'clean') {
  const blank = await readState(page)
  await typeDraft(page, composer, '帮我写个登录页')
  const typed = await readState(page)
  await button.hover().catch(() => {})
  await page.waitForTimeout(400)
  const icon = await page.evaluate(() => {
    const node = document.querySelector('[data-dsh-enhance]')
    const svg = node?.querySelector('svg') ?? null
    const box = node?.getBoundingClientRect() ?? null
    const editor = document.querySelector('[data-composer-input="true"]')
    const composerBox = editor?.getBoundingClientRect() ?? null
    return {
      textContent: (node?.textContent ?? '').trim(),
      svg: svg !== null,
      svgWidth: svg === null ? null : svg.getAttribute('width'),
      svgHeight: svg === null ? null : svg.getAttribute('height'),
      box: box === null ? null : { width: Math.round(box.width), height: Math.round(box.height) },
      title: node?.getAttribute('title') ?? null,
      ariaLabel: node?.getAttribute('aria-label') ?? null,
      hovered: node?.matches(':hover') ?? false,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      composerBox: composerBox === null ? null : { x: composerBox.x, y: composerBox.y, width: composerBox.width, height: composerBox.height },
    }
  })
  const fullShot = await shot(page, 'desktop-composer.png')
  let clipShot = null
  if (icon.composerBox !== null) {
    fs.mkdirSync(shots, { recursive: true })
    const y = Math.max(0, Math.floor(icon.composerBox.y - 70))
    const height = Math.min(icon.viewport.height - y, Math.floor(icon.composerBox.height + 110))
    const width = Math.min(icon.viewport.width, Math.floor(icon.composerBox.width + 40))
    const x = Math.max(0, Math.floor(icon.composerBox.x - 20))
    clipShot = path.join(shots, 'desktop-composer-closeup.png')
    await page.screenshot({ path: clipShot, clip: { x, y, width, height } })
  }
  say('clean', {
    onboarding,
    blank,
    typed,
    icon,
    screenshots: [fullShot, clipShot].filter(Boolean),
    pass: blank.exists === false
      && typed.exists === true
      && typed.phase === 'idle'
      && typed.draft === '帮我写个登录页'
      && icon.svg === true
      && icon.textContent === ''
      && icon.title === '增强提示词'
      && icon.ariaLabel === '增强提示词',
  })
} else if (phase === 'plain') {
  await typeDraft(page, composer, '帮我写个登录页')
  const before = await readState(page)
  await button.click()
  await settle(page)
  const applied = await readState(page)
  const appliedShot = await shot(page, 'desktop-plain-applied.png')
  await button.click()
  await page.waitForTimeout(1400)
  const reverted = await readState(page)
  const revertedShot = await shot(page, 'desktop-plain-reverted.png')
  // One more round for the manual-undo measurement (plain = one entry).
  await button.click()
  await settle(page)
  const secondApplied = await readState(page)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(800)
  const undone = await readState(page)
  const roundTrip = undone.draft === before.draft
  say('plain', {
    before,
    applied: { phase: applied.phase, title: applied.title, changed: applied.draft !== before.draft },
    reverted: { phase: reverted.phase, exact: reverted.draft === before.draft, chips: reverted.chips },
    undo: {
      applied: secondApplied.phase,
      afterOneCtrlZ: undone.draft,
      restoredInOnePress: roundTrip,
    },
    screenshots: [appliedShot, revertedShot],
    pass: applied.phase === 'applied'
      && applied.draft !== before.draft
      && reverted.draft === before.draft
      && reverted.chips === 0
      && roundTrip,
  })
} else if (phase === 'reference') {
  const menu = await typeReferenceDraft(page, composer, '帮我写个登录页')
  const before = await readState(page)
  await button.click()
  await settle(page)
  const applied = await readState(page)
  const appliedShot = await shot(page, 'desktop-reference-applied.png')
  await button.click()
  await page.waitForTimeout(1600)
  const reverted = await readState(page)
  const revertedShot = await shot(page, 'desktop-reference-reverted.png')
  const hint = /(\d+)\s*(?:次|presses)/.exec(applied.title ?? '')
  // Measure the documented manual-undo cost of a second, identical round.
  await button.click()
  await settle(page)
  const appliedAgain = await readState(page)
  const hint2 = /(\d+)\s*(?:次|presses)/.exec(appliedAgain.title ?? '')
  const undoSteps = []
  let restoredByUndo = false
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(750)
    const afterUndo = await readState(page)
    undoSteps.push({ draft: afterUndo.draft, chips: afterUndo.chips, phase: afterUndo.phase })
    if (afterUndo.draft === before.draft && afterUndo.chips === before.chips) {
      restoredByUndo = true
      break
    }
  }
  say('reference', {
    menu,
    before: { draft: before.draft, refs: before.refs, chips: before.chips },
    applied: {
      phase: applied.phase,
      title: applied.title,
      draft: applied.draft,
      refs: applied.refs,
      chips: applied.chips,
      undoHintSteps: hint === null ? null : Number(hint[1]),
    },
    reverted: { draft: reverted.draft, refs: reverted.refs, chips: reverted.chips },
    manualUndo: {
      secondTitle: appliedAgain.title,
      hintSteps: hint2 === null ? null : Number(hint2[1]),
      presses: undoSteps.length,
      restored: restoredByUndo,
      path: undoSteps,
    },
    screenshots: [appliedShot, revertedShot],
    pass: applied.phase === 'applied'
      && applied.chips === before.chips
      && applied.refs === before.refs
      && applied.draft !== before.draft
      && reverted.draft === before.draft
      && reverted.refs === before.refs
      && reverted.chips === before.chips
      && restoredByUndo
      && (hint2 === null || Number(hint2[1]) === undoSteps.length),
  })
} else if (phase === 'disabled') {
  const menu = await typeReferenceDraft(page, composer, '帮我写个登录页')
  const before = await readState(page)
  const requestsBefore = countRequests()
  // A disabled <button> ignores activation; this proves it is a real no-op.
  await page.evaluate(() => document.querySelector('[data-dsh-enhance]')?.click())
  await page.waitForTimeout(900)
  const after = await readState(page)
  const requestsAfter = countRequests()
  const plain = await (async () => {
    await typeDraft(page, composer, '帮我写个登录页')
    return readState(page)
  })()
  say('disabled', {
    menu,
    references: { mode: before.mode, disabled: before.disabled, title: before.title, wrapTitle: before.wrapTitle },
    afterForcedClick: { draft: before.draft === after.draft, phase: before.phase === after.phase, chips: after.chips },
    requests: { before: requestsBefore, after: requestsAfter },
    plainDraft: { exists: plain.exists, disabled: plain.disabled, title: plain.title },
    pass: before.mode === 'disabled'
      && before.disabled === true
      && (before.title ?? '').includes('请先移除引用再增强')
      && before.draft === after.draft
      && before.phase === after.phase
      && requestsBefore === requestsAfter
      && plain.exists === true
      && plain.disabled === false,
  })
} else if (phase === 'invalid' || phase === 'uninstalled') {
  await typeDraft(page, composer, '帮我写个登录页')
  const cold = await readState(page)
  // Reload so the activation-time console warning is observable in this window.
  await page.reload({ waitUntil: 'domcontentloaded' })
  const composerAgain = await composerOf(page)
  await typeDraft(page, composerAgain, '帮我写个登录页')
  await page.waitForTimeout(1200)
  const afterReload = await readState(page)
  say(phase, {
    cold: { exists: cold.exists, draft: cold.draft },
    afterReload: { exists: afterReload.exists, draft: afterReload.draft },
    consoleTail: consoleTail.slice(-8),
    pass: cold.exists === false && afterReload.exists === false,
  })
} else {
  say('error', { message: `unknown phase ${phase}` })
  process.exitCode = 1
}

await browser.close()
