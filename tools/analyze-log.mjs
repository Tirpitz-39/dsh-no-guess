// dsh-no-guess log analyzer.
//
// Reads no-guess.log (JSONL) and reports what the gates did: how often they
// armed, which family fired, how many blocks turned into answers, how long the
// user took, and how many timeouts happened. Read-only: no network, no writes.
//
//   node tools/analyze-log.mjs                 # $DSH_HOME/no-guess/no-guess.log
//   node tools/analyze-log.mjs --file <path>
//   node tools/analyze-log.mjs --json
//
// The analyzer is intentionally heuristic about "false positives": it flags
// quick answers (<60 s) as candidates for a human to review. It never claims a
// block was wrong on its own — only the user can say that.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ARMED_EVENTS = ['arm', 'rule-arm', 'guess-arm', 'model-arm']
const SIGNALS = ['thinking', 'rule', 'model']
const QUICK_ANSWER_MS = 60_000

function defaultLogPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'no-guess', 'no-guess.log')
}

/**
 * @param {string} text raw JSONL
 * @returns {{ records: any[], badLines: number }}
 */
export function parseLog(text) {
  const records = []
  let badLines = 0
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') records.push(value)
      else badLines += 1
    } catch {
      badLines += 1
    }
  }
  return { records, badLines }
}

/**
 * @param {any[]} records parsed log lines
 * @returns {any} summary
 */
export function analyzeEvents(records) {
  const list = Array.isArray(records) ? records : []
  const events = {}
  const signals = {}
  const families = {}
  const bySession = new Map()
  const quick = []
  // answered only counts as a response to a block when the same session+turn
  // was actually blocked. Without turn data (logs written before the field
  // extension) the association cannot be made, so answerRate stays null
  // instead of reporting a misleading 127%.
  const blockedKeys = new Set()
  for (const record of list) {
    if (record.event === 'block-ask' && record.turn !== undefined) {
      blockedKeys.add(String(record.sid || '') + '|' + String(record.turn))
    }
  }
  let armed = 0
  let blockAsk = 0
  let blockStop = 0
  let asked = 0
  let answered = 0
  let answeredAfterBlock = 0
  let answeredLatencySum = 0
  let answeredLatencyCount = 0
  let timeout = 0
  let timeoutRelease = 0
  let firstAt = ''
  let lastAt = ''
  // P1: read tools pass while armed. The counterfactual is what makes "how
  // many reads did the legacy policy block" measurable.
  const readPass = { total: 0, byTool: {}, bySignal: {} }
  const blockTiers = {}
  const blockPolicies = {}

  const touchSession = (sid) => {
    if (!sid) return null
    let entry = bySession.get(sid)
    if (!entry) {
      entry = { sid, armed: 0, blocks: 0, answered: 0, timeouts: 0 }
      bySession.set(sid, entry)
    }
    return entry
  }

  for (const record of list) {
    const event = String(record.event || '')
    if (!event) continue
    events[event] = (events[event] || 0) + 1
    const sid = typeof record.sid === 'string' ? record.sid : ''
    const session = touchSession(sid)
    const at = typeof record.t === 'string' ? record.t : ''
    if (at && (!firstAt || at < firstAt)) firstAt = at
    if (at && (!lastAt || at > lastAt)) lastAt = at

    if (ARMED_EVENTS.includes(event)) {
      armed += 1
      if (session) session.armed += 1
      if (event === 'guess-arm' && typeof record.family === 'string') {
        families[record.family] = (families[record.family] || 0) + 1
      }
      const signal = typeof record.signal === 'string' ? record.signal : 'unknown'
      signals[signal] = (signals[signal] || 0) + 1
      continue
    }
    if (event === 'read-pass') {
      readPass.total += 1
      const passTool = typeof record.tool === 'string' ? record.tool : 'unknown'
      readPass.byTool[passTool] = (readPass.byTool[passTool] || 0) + 1
      const passSignal = typeof record.signal === 'string' ? record.signal : 'unknown'
      readPass.bySignal[passSignal] = (readPass.bySignal[passSignal] || 0) + 1
      continue
    }
    if (event === 'block-ask') {
      blockAsk += 1
      if (session) session.blocks += 1
      const tier = typeof record.tier === 'string' ? record.tier : 'unknown'
      blockTiers[tier] = (blockTiers[tier] || 0) + 1
      const policy = typeof record.policy === 'string' ? record.policy : 'unknown'
      blockPolicies[policy] = (blockPolicies[policy] || 0) + 1
    } else if (event === 'block-stop') {
      blockStop += 1
      if (session) session.blocks += 1
    } else if (event === 'asked') {
      asked += 1
    } else if (event === 'answered') {
      answered += 1
      if (session) session.answered += 1
      const afterBlock = record.turn !== undefined && blockedKeys.has(String(sid || '') + '|' + String(record.turn))
      if (afterBlock) {
        answeredAfterBlock += 1
        const latency = Number(record.latencyMs)
        if (Number.isFinite(latency) && latency >= 0) {
          answeredLatencySum += latency
          answeredLatencyCount += 1
          if (latency < QUICK_ANSWER_MS) {
            quick.push({ sid, turn: record.turn, latencyMs: latency })
          }
        }
      }
    } else if (event === 'timeout') {
      timeout += 1
      if (session) session.timeouts += 1
    } else if (event === 'timeout-release') {
      timeoutRelease += 1
    }
  }

  const blocked = blockAsk + blockStop
  return {
    records: list.length,
    events,
    armed,
    signal: signals,
    family: families,
    blocked,
    blockAsk,
    blockStop,
    asked,
    answered,
    answeredAfterBlock,
    answeredLatencyMeanMs: answeredLatencyCount ? Math.round(answeredLatencySum / answeredLatencyCount) : null,
    answerRate: blocked && answeredAfterBlock > 0 ? answeredAfterBlock / blocked : null,
    timeout,
    timeoutRelease,
    timeoutRate: blocked ? timeout / blocked : 0,
    quickAnswers: quick,
    readPass,
    blockTiers,
    blockPolicies,
    sessions: [...bySession.values()].sort((a, b) => b.armed + b.blocks - (a.armed + a.blocks)),
    firstAt,
    lastAt,
  }
}

/** @param {string} text raw JSONL */
export function analyzeText(text) {
  const { records, badLines } = parseLog(text)
  return { badLines, ...analyzeEvents(records) }
}

function pct(value) {
  return (value * 100).toFixed(0) + '%'
}

export function formatSummary(summary, file) {
  const lines = []
  lines.push('dsh-no-guess log summary')
  lines.push('file: ' + (file || '(unknown)'))
  lines.push('records=' + summary.records + ' bad=' + summary.badLines + ' sessions=' + summary.sessions.length)
  if (summary.firstAt || summary.lastAt) lines.push('range: ' + summary.firstAt + ' → ' + summary.lastAt)
  lines.push('')
  const signalParts = SIGNALS.map((name) => name + ' ' + (summary.signal[name] || 0)).join(' / ')
  const familyParts = Object.entries(summary.family)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => name + ' ' + count)
    .join(', ')
  lines.push('armed     ' + summary.armed + '   (' + signalParts + ')')
  lines.push('families  ' + (familyParts || '-'))
  lines.push('blocked   ' + summary.blocked + '   (block-ask ' + summary.blockAsk + ' / block-stop ' + summary.blockStop + ')')
  const tierParts = Object.entries(summary.blockTiers || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => name + ' ' + count)
    .join(', ')
  if (summary.blockTiers && Object.keys(summary.blockTiers).length) lines.push('by tier   ' + tierParts)
  const passParts = Object.entries((summary.readPass && summary.readPass.byTool) || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => name + ' ' + count)
    .join(', ')
  lines.push('read-pass ' + ((summary.readPass && summary.readPass.total) || 0) + '   (by tool: ' + (passParts || '-') + ')')
  const answerRateText =
    summary.answerRate === null ? 'n/a (no turn-linked answers in this log)' : pct(summary.answerRate)
  lines.push(
    'asked     ' +
      summary.asked +
      '   answered ' +
      summary.answered +
      ' (after block ' +
      summary.answeredAfterBlock +
      ')   answer-rate ' +
      answerRateText,
  )
  lines.push('timeout   ' + summary.timeout + '   timeout-rate ' + pct(summary.timeoutRate) + '   released ' + summary.timeoutRelease)
  lines.push(
    'mean answer latency ' +
      (summary.answeredLatencyMeanMs === null ? 'n/a' : (summary.answeredLatencyMeanMs / 1000).toFixed(1) + 's'),
  )
  lines.push('')
  if (summary.quickAnswers.length) {
    lines.push('quick answers (<60s, false-positive candidates for human review): ' + summary.quickAnswers.length)
    for (const item of summary.quickAnswers.slice(0, 10)) {
      lines.push('  sid=' + (item.sid || '?') + ' turn=' + (item.turn ?? '?') + ' latency=' + (item.latencyMs / 1000).toFixed(1) + 's')
    }
  } else {
    lines.push('quick answers (<60s, false-positive candidates for human review): 0')
  }
  return lines.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  let file = ''
  let json = false
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--file') {
      file = args[i + 1] || ''
      i += 1
    } else if (args[i] === '--json') {
      json = true
    }
  }
  const path = file || defaultLogPath()
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    console.error('cannot read log: ' + path)
    process.exit(2)
  }
  const summary = analyzeText(text)
  if (json) {
    console.log(JSON.stringify({ file: path, ...summary }, null, 2))
    return
  }
  console.log(formatSummary(summary, path))
}

// Only run when invoked directly (the tests import analyzeText). Compare the
// resolved entry path, not a suffix: test/analyze-log.mjs also ends with the
// file name and must not trigger the CLI.
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main()
