// dsh-no-guess config & robustness tests.
//
//   node test/config.mjs
//
// Covers what the smoke test does not: config defaults/sanitizing, atomic
// writes, bounded logs, and cross-platform DSH_HOME resolution.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ask-first-config-'))
// Small cap so the rotation test stays fast; the plugin honours this override.
process.env.DSH_ASK_FIRST_LOG_MAX_BYTES = String(64 * 1024)

const { readConfig, writeConfig, dshHome, logLine } = await import('../index.js')

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

const dir = join(process.env.DSH_HOME, 'ask-first')
mkdirSync(dir, { recursive: true })
const configFile = join(dir, 'config.json')

// ---------------- defaults ----------------

const def = readConfig()
const ALL_KEYS = ['enabled', 'timeoutMinutes', 'maxBlocksPerTurn', 'vagueMaxLength', 'thinkingGate', 'ruleGate', 'modelGate']
check('defaults expose every known field', ALL_KEYS.every((k) => k in def), Object.keys(def).join(','))
check('default: enabled', def.enabled === true)
check('default: thinkingGate on', def.thinkingGate === true)
check('default: ruleGate off', def.ruleGate === false)
check('default: modelGate off', def.modelGate === false)
check('default: logUserText off (privacy)', def.logUserText === false)

// ---------------- read-back (no stale cache) ----------------

const before = readConfig()
before.enabled = false
check('readConfig returns a fresh object (not a shared cache)', readConfig().enabled === true)
const writtenConfig = writeConfig({ logUserText: true })
check('writeConfig applies logUserText', writtenConfig.logUserText === true)
check('writeConfig round-trips through readConfig', readConfig().logUserText === true)
writeConfig({ logUserText: false })

// Rapid hand-edits inside one filesystem mtime tick must each be read back. An
// mtime-only cache used to serve the previous value on 4ms-resolution
// filesystems, which made this suite flaky.
writeFileSync(configFile, JSON.stringify({ timeoutMinutes: 30 }), 'utf8')
const rapidA = readConfig().timeoutMinutes
writeFileSync(configFile, JSON.stringify({ timeoutMinutes: 90 }), 'utf8')
const rapidB = readConfig().timeoutMinutes
check('rapid writes are read back, not cached', rapidA === 30 && rapidB === 90, `${rapidA}/${rapidB}`)

// A broken config followed by a good write must not leave the defaults behind.
writeFileSync(configFile, '{not json', 'utf8')
const brokenNow = readConfig().timeoutMinutes
writeFileSync(configFile, JSON.stringify({ timeoutMinutes: 45 }), 'utf8')
const afterBroken = readConfig().timeoutMinutes
check('bad JSON then a good write is read back', brokenNow === 10 && afterBroken === 45, `${brokenNow}/${afterBroken}`)

// ---------------- broken / hand-edited config ----------------

writeFileSync(configFile, '{not json', 'utf8')
const broken = readConfig()
check('broken JSON falls back to defaults', broken.enabled === true && broken.timeoutMinutes === 10 && broken.ruleGate === false)

writeFileSync(configFile, JSON.stringify({ timeoutMinutes: 999, maxBlocksPerTurn: -5, vagueMaxLength: 'abc', enabled: 'yes' }), 'utf8')
const clamped = readConfig()
check('timeoutMinutes clamped to 120', clamped.timeoutMinutes === 120, clamped.timeoutMinutes)
check('maxBlocksPerTurn clamped to 1', clamped.maxBlocksPerTurn === 1, clamped.maxBlocksPerTurn)
check('non-numeric vagueMaxLength falls back to 40', clamped.vagueMaxLength === 40, clamped.vagueMaxLength)
check('non-boolean enabled ignored', clamped.enabled === true)

// ---------------- write path ----------------

const written = writeConfig({ timeoutMinutes: 0, enabled: false })
check('writeConfig clamps timeoutMinutes to 1', written.timeoutMinutes === 1, written.timeoutMinutes)
check('writeConfig applies enabled=false', written.enabled === false)

const reread = readConfig()
check('config round-trips through disk', reread.enabled === false && reread.timeoutMinutes === 1)

const parsed = JSON.parse(readFileSync(configFile, 'utf8'))
check('config file stays valid JSON', parsed && typeof parsed === 'object')
const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
check('atomic write leaves no tmp files', leftovers.length === 0, leftovers.join(','))

// ---------------- DSH_HOME resolution ----------------

const savedHome = process.env.DSH_HOME
check('dshHome honours DSH_HOME', dshHome() === savedHome)
delete process.env.DSH_HOME
const fallback = dshHome()
check('dshHome falls back to ~/.dsh', fallback === join(homedir(), '.dsh'), fallback)
process.env.DSH_HOME = savedHome

// ---------------- log rotation ----------------

const logFile = join(dir, 'ask-first.log')
for (let i = 0; i < 2000; i += 1) logLine('test', { i, pad: 'x'.repeat(80) })
const size = statSync(logFile).size
check('log stays bounded after rotation', size <= 64 * 1024, size)

const tail = readFileSync(logFile, 'utf8').trim().split('\n').slice(-1)[0]
let tailOk = false
try {
  tailOk = typeof JSON.parse(tail).event === 'string'
} catch {}
check('log tail is still a complete JSONL line', tailOk, tail.slice(0, 80))

console.log('CONFIGTEST PASS=' + pass + ' FAIL=' + fail)
if (fail > 0) process.exit(1)
