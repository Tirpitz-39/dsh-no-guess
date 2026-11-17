// Analyzer tests. No runtime needed: feed constructed JSONL lines.
//
//   node test/analyze-log.mjs
import { analyzeText, formatSummary, parseLog } from '../tools/analyze-log.mjs'

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log('PASS ' + name)
  } else {
    fail += 1
    console.log('FAIL ' + name + (extra === undefined ? '' : ' — ' + String(extra)))
  }
}

const SAMPLE = [
  '{"t":"2026-11-16T10:00:00.000Z","event":"guess-arm","sid":"s1","family":"zh-intent","signal":"thinking","turn":1}',
  '{"t":"2026-11-16T10:00:01.000Z","event":"block-ask","sid":"s1","tool":"pwsh","tier":"execute","signal":"thinking","turn":1,"policy":"tiered"}',
  '{"t":"2026-11-16T10:00:02.000Z","event":"asked","sid":"s1","turn":1,"latencyMs":1500}',
  '{"t":"2026-11-16T10:00:03.000Z","event":"read-pass","sid":"s1","tool":"read","tier":"read","signal":"thinking","turn":1,"policy":"tiered"}',
  '{"t":"2026-11-16T10:00:30.000Z","event":"answered","sid":"s1","turn":1,"latencyMs":29000}',
  '{"t":"2026-11-16T10:01:00.000Z","event":"guess-arm","sid":"s1","family":"en-intent","signal":"thinking","turn":2}',
  '{"t":"2026-11-16T10:01:01.000Z","event":"block-ask","sid":"s1","tool":"edit","tier":"write","signal":"thinking","turn":2,"policy":"tiered"}',
  '{"t":"2026-11-16T10:01:02.000Z","event":"asked","sid":"s1","turn":2,"latencyMs":1000}',
  '{"t":"2026-11-16T10:01:05.000Z","event":"answered","sid":"s1","turn":2,"latencyMs":4000}',
  '{"t":"2026-11-16T10:05:00.000Z","event":"rule-arm","sid":"s2","signal":"rule","turn":1}',
  '{"t":"2026-11-16T10:05:01.000Z","event":"block-ask","sid":"s2","tool":"pwsh","tier":"execute","signal":"rule","turn":1,"policy":"tiered"}',
  '{"t":"2026-11-16T10:15:01.000Z","event":"timeout","sid":"s2","turn":1}',
].join('\n')

{
  const { records, badLines } = parseLog(SAMPLE)
  check('parse: counts records', records.length === 12, records.length)
  check('parse: no bad lines', badLines === 0, badLines)
}

{
  const { badLines } = parseLog('{"event":"arm"}\nnot-json\n\n{"event":"block-ask"}')
  check('parse: bad lines are counted and skipped', badLines === 1, badLines)
}

{
  const summary = analyzeText('')
  check('empty log does not crash', summary.records === 0 && summary.armed === 0 && summary.blocked === 0)
}

{
  const summary = analyzeText(SAMPLE)
  check('analyze: records', summary.records === 12, summary.records)
  check('analyze: armed = arm events', summary.armed === 3, summary.armed)
  check('analyze: signals split', summary.signal.thinking === 2 && summary.signal.rule === 1, JSON.stringify(summary.signal))
  check('analyze: families counted', summary.family['zh-intent'] === 1 && summary.family['en-intent'] === 1, JSON.stringify(summary.family))
  check('analyze: blocked = block-ask + block-stop', summary.blocked === 3 && summary.blockAsk === 3 && summary.blockStop === 0)
  check('analyze: asked/answered', summary.asked === 2 && summary.answered === 2)
  check('analyze: answer rate', Math.abs(summary.answerRate - 2 / 3) < 1e-9, summary.answerRate)
  check('analyze: timeout + rate', summary.timeout === 1 && Math.abs(summary.timeoutRate - 1 / 3) < 1e-9)
  check('analyze: mean latency', summary.answeredLatencyMeanMs === 16500, summary.answeredLatencyMeanMs)
  check('analyze: quick answers flagged', summary.quickAnswers.length === 2, summary.quickAnswers.length)
  check('analyze: session grouping', summary.sessions.length === 2, summary.sessions.length)
  check('analyze: first/last timestamps', summary.firstAt === '2026-11-16T10:00:00.000Z' && summary.lastAt === '2026-11-16T10:15:01.000Z')
  const text = formatSummary(summary, 'test.log')
  check('format: mentions armed and blocked', /armed\s+3/.test(text) && /blocked\s+3/.test(text), text)
  check('format: lists family', /zh-intent 1/.test(text), text)
  check('analyze: read-pass counted', summary.readPass.total === 1 && summary.readPass.byTool.read === 1, JSON.stringify(summary.readPass))
  check('analyze: block tiers split', summary.blockTiers.execute === 2 && summary.blockTiers.write === 1, JSON.stringify(summary.blockTiers))
  check('format: lists read-pass', /read-pass 1/.test(text), text)
}

{
  // Old logs (before the field extension) must not crash the analyzer.
  const legacy = [
    '{"t":"2026-11-01T00:00:00.000Z","event":"guess-arm","sid":"old"}',
    '{"t":"2026-11-01T00:00:01.000Z","event":"block-ask","sid":"old","tool":"pwsh"}',
    '{"t":"2026-11-01T00:00:02.000Z","event":"asked","sid":"old"}',
    '{"t":"2026-11-01T00:00:03.000Z","event":"answered","sid":"old"}',
  ].join('\n')
  const summary = analyzeText(legacy)
  check('legacy: unknown signal bucket', summary.signal.unknown === 2 || summary.signal.unknown >= 1, JSON.stringify(summary.signal))
  check('legacy: no latency still works', summary.answered === 1 && summary.answeredLatencyMeanMs === null)
  check('legacy: answer rate is n/a, not a fake number', summary.answerRate === null, summary.answerRate)
}

console.log('ANALYZETEST PASS=' + pass + ' FAIL=' + fail)
if (fail > 0) process.exit(1)
