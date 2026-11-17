// P1 tier-policy tests: static table, overrides, read-pass counterfactual,
// legacy fallback, unknown-tool fail-closed.
//
//   node test/tiers.mjs
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'no-guess-tiers-'))

const mod = await import('../index.js')
const { apply, resolveTier, TOOL_TIERS, writeConfig, readConfig } = mod

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

// ---------------- static table ----------------
check('tier: read tool', resolveTier('read') === 'read')
check('tier: grep is read', resolveTier('grep') === 'read')
check('tier: edit is write', resolveTier('edit') === 'write')
check('tier: remember is write', resolveTier('remember') === 'write')
check('tier: pwsh is execute', resolveTier('pwsh') === 'execute')
check('tier: subagent is execute', resolveTier('subagent') === 'execute')
check('tier: send_to_session is external', resolveTier('send_to_session') === 'external')
check('tier: schedule_create is external', resolveTier('schedule_create') === 'external')
check('tier: ask_user_question is allow', resolveTier('ask_user_question') === 'allow')
check('tier: unknown tool is unknown', resolveTier('never-seen-tool') === 'unknown')
check('tier: table covers the live registry (>=70)', Object.keys(TOOL_TIERS).length >= 70, Object.keys(TOOL_TIERS).length)

// ---------------- overrides ----------------
check('tier: override wins', resolveTier('pwsh', { tierOverrides: { pwsh: 'read' } }) === 'read')
check('tier: invalid override ignored', resolveTier('pwsh', { tierOverrides: { pwsh: 'bogus' } }) === 'execute')
check('tier: override can mark unknown tool', resolveTier('never-seen-tool', { tierOverrides: { 'never-seen-tool': 'read' } }) === 'read')

// ---------------- guard behaviour ----------------
function makeCtx(services) {
  const handlers = { preExecute: [], agentCreated: [], agentDisposed: [] }
  return {
    handlers,
    logger: { info() {}, warn() {} },
    on(event, fn) {
      if (event === 'tools/pre-execute') handlers.preExecute.push(fn)
      if (event === 'agent/created') handlers.agentCreated.push(fn)
      if (event === 'agent/disposed') handlers.agentDisposed.push(fn)
      return () => {}
    },
    effect(fn) {
      try {
        fn()
      } catch {}
      return () => {}
    },
    inject() {},
    get(name) {
      return services && services[name]
    },
  }
}

function makeAgent(sid) {
  const preStep = []
  const toolResult = []
  return {
    id: sid,
    session: { id: sid, header: { origin: 'web' }, eventsSnapshot: [] },
    ctx: {
      on(event, fn) {
        if (event === 'agent/pre-step') preStep.push(fn)
        if (event === 'tools/result') toolResult.push(fn)
        return () => {}
      },
    },
    preStep,
    toolResult,
    followup: async () => {},
  }
}

const next = async () => ({ kind: 'enter', messages: [] })
const ctx = makeCtx({ tools: {} })
apply(ctx)
const agent = makeAgent('s-tier')
ctx.handlers.agentCreated[0]({ agent })

async function runPreStep(text, turn) {
  await agent.preStep[0]({ messages: [{ role: 'user', content: [{ type: 'text', text }] }], turn, step: 1 }, next)
}
async function runTool(name) {
  return ctx.handlers.preExecute[0]({ name, arguments: {}, agent }, next)
}

const LOG = join(process.env.DSH_HOME, 'no-guess', 'no-guess.log')
function sliceLog() {
  try {
    return readFileSync(LOG, 'utf8')
  } catch {
    return ''
  }
}

// tiered: read passes while armed, write is blocked, both logged.
{
  writeConfig({ enabled: true, ruleGate: true, readPolicy: 'tiered', tierOverrides: {} })
  await runPreStep('各个模式有什么区别', 10)
  const readCall = await runTool('read')
  check('tiered: read passes while armed', readCall && readCall.kind === 'enter', JSON.stringify(readCall))
  const grepCall = await runTool('grep')
  check('tiered: grep passes while armed', grepCall && grepCall.kind === 'enter', JSON.stringify(grepCall))
  const editCall = await runTool('edit')
  check('tiered: edit blocked while armed', editCall && editCall.kind === 'deny', JSON.stringify(editCall))

  const log = sliceLog()
  check('log: read-pass recorded', /"event":"read-pass"[^\n]*"tier":"read"/.test(log), 'missing read-pass')
  check('log: read-pass carries policy', /"event":"read-pass"[^\n]*"policy":"tiered"/.test(log))
  check('log: block-ask records tier write', /"event":"block-ask"[^\n]*"tier":"write"/.test(log), 'missing block-ask tier')
}

// unknown tool fails closed and is logged as unknown (not execute).
{
  await runPreStep('那个怎么样', 11)
  const unknownCall = await runTool('never-seen-tool')
  check('tiered: unknown tool blocked', unknownCall && unknownCall.kind === 'deny', JSON.stringify(unknownCall))
  check('log: unknown tier recorded', /"event":"block-ask"[^\n]*"tier":"unknown"/.test(sliceLog()))
}

// tierOverrides: pwsh treated as read passes while armed.
{
  writeConfig({ readPolicy: 'tiered', tierOverrides: { pwsh: 'read' } })
  await runPreStep('那个怎么样', 12)
  const pwshOverride = await runTool('pwsh')
  check('override: pwsh treated as read passes while armed', pwshOverride && pwshOverride.kind === 'enter', JSON.stringify(pwshOverride))
  writeConfig({ tierOverrides: {} })
}

// legacy: back to pre-P1 behaviour — read is blocked while armed.
{
  writeConfig({ readPolicy: 'legacy' })
  await runPreStep('各个模式有什么区别', 13)
  const readLegacy = await runTool('read')
  check('legacy: read blocked while armed', readLegacy && readLegacy.kind === 'deny', JSON.stringify(readLegacy))
  check('log: legacy policy recorded', /"policy":"legacy"/.test(sliceLog()))
  writeConfig({ readPolicy: 'tiered' })
}

// not armed: everything passes regardless of tier.
{
  await runPreStep('帮我改一下 config.json', 14)
  const editIdle = await runTool('edit')
  check('tiered: edit passes when not armed', editIdle && editIdle.kind === 'enter', JSON.stringify(editIdle))
  const pwshIdle = await runTool('pwsh')
  check('tiered: pwsh passes when not armed', pwshIdle && pwshIdle.kind === 'enter', JSON.stringify(pwshIdle))
}

// config persistence and sanitizing.
{
  writeConfig({ readPolicy: 'legacy', tierOverrides: { foo: 'read', bar: 'bogus' } })
  const cfg = readConfig()
  check('config: readPolicy persists', cfg.readPolicy === 'legacy', cfg.readPolicy)
  check('config: valid override kept', cfg.tierOverrides.foo === 'read')
  check('config: invalid tier override dropped', !('bar' in cfg.tierOverrides))
  writeConfig({ readPolicy: 'tiered', tierOverrides: {} })
}

console.log('TIERTEST PASS=' + pass + ' FAIL=' + fail)
if (fail > 0) process.exit(1)
