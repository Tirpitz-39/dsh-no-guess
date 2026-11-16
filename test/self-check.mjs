// Self-check tests: startup wiring, first-use shape checks, reasoning trio.
//
//   node test/self-check.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'no-guess-selfcheck-'))

const mod = await import('../index.js')
const { apply, selfCheckState, reasoningStatus } = mod

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

// ---------------- healthy startup ----------------
{
  const ctx = makeCtx({ tools: {} })
  apply(ctx)
  const state = selfCheckState()
  check('self-check: guard hook registered', state.hooks.preExecute === 'registered', JSON.stringify(state.hooks))
  check('self-check: agent/created hook registered', state.hooks.agentCreated === 'registered')
  check('self-check: agent/disposed hook registered', state.hooks.agentDisposed === 'registered')
  check('self-check: tools service seen', state.toolsService === true)
  check('self-check: healthy start is not degraded', state.degraded === false, JSON.stringify(state.reasons))

  const agent = makeAgent('s-self')
  ctx.handlers.agentCreated[0]({ agent })
  await agent.preStep[0]({ messages: [{ role: 'user', content: [{ type: 'text', text: '那个怎么样' }] }], turn: 3, step: 1 }, next)
  const afterStep = selfCheckState()
  check('self-check: first pre-step shape ok', afterStep.firstPreStep === 'ok', afterStep.firstPreStep)

  agent.session.eventsSnapshot = [
    {
      type: 'assistant/message',
      data: { turn: 3, message: { content: [{ type: 'reasoning', text: '我猜用户是想问一下' }] } },
    },
  ]
  await ctx.handlers.preExecute[0]({ name: 'pwsh', arguments: {}, agent }, next)
  const afterGuard = selfCheckState()
  check('self-check: first guard shape ok', afterGuard.firstGuard === 'ok', afterGuard.firstGuard)
  check('self-check: reasoning present recorded', afterGuard.reasoning.present >= 1, JSON.stringify(afterGuard.reasoning))
}

// ---------------- reasoning trio ----------------
{
  const session = { eventsSnapshot: [{ type: 'assistant/message', data: { turn: 7, message: { content: [] } } }] }
  check('reasoning status: empty when assistant has no reasoning blocks', reasoningStatus(session, 7) === 'empty')
  check('reasoning status: absent when no assistant message', reasoningStatus({ eventsSnapshot: [] }, 9) === 'absent')
  const withReasoning = {
    eventsSnapshot: [{ type: 'assistant/message', data: { turn: 8, message: { content: [{ type: 'reasoning', text: 'x' }] } } }],
  }
  check('reasoning status: present when a reasoning block exists', reasoningStatus(withReasoning, 8) === 'present')
}

// ---------------- bad payload degrades (fresh module instance) ----------------
// Module-level self-check state is a singleton; the healthy block above already
// recorded firstPreStep='ok', so a shape test needs a fresh module instance.
{
  const fresh = await import('../index.js?bad-shape=' + Date.now())
  const ctx = makeCtx({ tools: {} })
  fresh.apply(ctx)
  const agent = makeAgent('s-shape')
  ctx.handlers.agentCreated[0]({ agent })
  // step/turn are wrong types on purpose
  await agent.preStep[0]({ messages: 'nope', step: 'nope', turn: 'nope' }, next)
  const state = fresh.selfCheckState()
  check(
    'self-check: bad pre-step payload degrades',
    state.degraded === true && state.reasons.some((r) => r.reason === 'pre-step-payload-shape'),
    JSON.stringify(state.reasons),
  )
}

// ---------------- missing tools service degrades (fresh module instance) ----------------
{
  const fresh = await import('../index.js?missing-tools=' + Date.now())
  const ctx = makeCtx({})
  fresh.apply(ctx)
  const state = fresh.selfCheckState()
  check(
    'self-check: missing tools service degrades',
    state.degraded === true && state.reasons.some((r) => r.reason === 'tools-service-missing'),
    JSON.stringify(state.reasons),
  )
}

console.log('SELFCHECKTEST PASS=' + pass + ' FAIL=' + fail)
if (fail > 0) process.exit(1)
