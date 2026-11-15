/**
 * Replay recorded sessions through the thinking gate and report how often it
 * would arm.
 *
 *   node test/replay.mjs                       # test/fixtures/*.jsonl
 *   node test/replay.mjs <file|dir>            # any decompressed session JSONL
 *   node test/replay.mjs --max-rate 0.5        # red line (default 0.5)
 *
 * A turn arms when the merged reasoning of that turn matches GUESS_RE — the
 * same test the plugin runs in tools/pre-execute. Turns without a human
 * `user/message` are skipped (machine turns never arm).
 *
 * Exit code 1 when the overall arm rate exceeds the red line, so the number
 * lives in CI instead of in someone's memory.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GUESS_RE } from '../index.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const DEFAULT_MAX_RATE = 0.5

/** @param {string} p */
function collectJsonl(p) {
  /** @type {string[]} */
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  const stat = statSync(p)
  if (stat.isDirectory()) walk(p)
  else out.push(p)
  return out.sort()
}

/**
 * @param {string} text
 * @returns {{ turns: Array<{ turn: number, armed: boolean, sample: string }>, humanTurns: number }}
 */
export function replaySession(text) {
  /** @type {Map<number, { reasoning: string[], human: boolean }>} */
  const byTurn = new Map()
  let current = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'turn/start' && ev.data && typeof ev.data.turn === 'number') {
      current = ev.data.turn
      continue
    }
    if (ev.type === 'user/message') {
      const kind = ev.data && ev.data.source && ev.data.source.kind
      // Only a real `user` message (or no source at all) is the human speaking;
      // agent-instructions / runtime-context / skill-catalog are host injections.
      const human = typeof kind !== 'string' || kind === 'user'
      if (human) {
        const turn = typeof ev.data?.turn === 'number' ? ev.data.turn : current
        const slot = byTurn.get(turn) ?? { reasoning: [], human: false }
        slot.human = true
        byTurn.set(turn, slot)
      }
      continue
    }
    if (ev.type === 'assistant/message') {
      const turn = ev.data && typeof ev.data.turn === 'number' ? ev.data.turn : current
      const slot = byTurn.get(turn) ?? { reasoning: [], human: false }
      const blocks = (ev.data && ev.data.message && ev.data.message.content) ?? []
      for (const block of blocks) {
        if (block && block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
          slot.reasoning.push(block.text)
        }
      }
      byTurn.set(turn, slot)
    }
  }

  /** @type {Array<{ turn: number, armed: boolean, sample: string }>} */
  const turns = []
  for (const [turn, slot] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    if (!slot.human || slot.reasoning.length === 0) continue
    const merged = slot.reasoning.join('\n')
    const armed = GUESS_RE.test(merged.replace(/\s+/g, ''))
    const armedReason = armed ? slot.reasoning.find(text => GUESS_RE.test(text.replace(/\s+/g, ''))) : null
    const sample = String(armedReason ?? merged).split('\n').find(line => line.trim().length > 0) ?? ''
    turns.push({ turn, armed, sample: sample.slice(0, 80) })
  }
  return { turns, humanTurns: turns.length }
}

function main() {
  const args = process.argv.slice(2)
  let target = FIXTURES
  let maxRate = DEFAULT_MAX_RATE
  let verbose = false
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--max-rate') {
      maxRate = Number(args[i + 1])
      i += 1
    } else if (args[i] === '--verbose') {
      verbose = true
    } else if (!args[i].startsWith('--')) {
      target = args[i]
    }
  }

  let files
  try {
    files = collectJsonl(target)
  } catch {
    console.log(`no session files under ${target}`)
    return
  }
  if (files.length === 0) {
    console.log(`no .jsonl session files under ${target}`)
    return
  }

  let totalTurns = 0
  let totalArmed = 0
  for (const file of files) {
    let parsed
    try {
      parsed = replaySession(readFileSync(file, 'utf8'))
    } catch (error) {
      console.log(`skip ${file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const armed = parsed.turns.filter(turn => turn.armed).length
    totalTurns += parsed.humanTurns
    totalArmed += armed
    const rate = parsed.humanTurns === 0 ? 0 : (armed / parsed.humanTurns) * 100
    console.log(`file  ${file}`)
    console.log(`      human turns=${parsed.humanTurns} armed=${armed} rate=${rate.toFixed(1)}%`)
    if (verbose) {
      for (const turn of parsed.turns.filter(t => t.armed).slice(0, 3)) {
        console.log(`      turn ${turn.turn}: ${turn.sample}`)
      }
    }
  }

  const overall = totalTurns === 0 ? 0 : totalArmed / totalTurns
  const verdict = overall > maxRate ? 'FAIL' : 'OK'
  console.log('')
  console.log(
    `total human turns=${totalTurns} armed=${totalArmed} rate=${(overall * 100).toFixed(1)}% ` +
      `(red line ${(maxRate * 100).toFixed(0)}%) -> ${verdict}`,
  )
  if (verdict === 'FAIL') process.exit(1)
}

// Only run when invoked directly (the tests import replaySession).
if (process.argv[1] && process.argv[1].endsWith('replay.mjs')) main()
