// dsh-no-guess smoke test. Runs without the DSH runtime: fake ctx/agent,
// temp DSH_HOME, no web server.
//
//   node test/smoke.mjs
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ask-first-test-'))

const mod = await import('../index.js')
const { apply, looksVague, isAck, extractUserText, writeConfig } = mod

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

// ---------------- rules ----------------

check('vague: 各个模式有什么区别', looksVague('各个模式有什么区别') === true)
check('vague: 那个怎么办', looksVague('那个怎么办') === true)
check('vague: 这个呢', looksVague('这个呢') === true)
check('not vague: 你好鱼', looksVague('你好鱼') === false)
check('not vague: 你确定没有问题？', looksVague('你确定没有问题？') === false)
check('not vague: 有问题吗', looksVague('有问题吗') === false)
check('not vague: 可以吗', looksVague('可以吗') === false)
check('not vague: 继续', looksVague('继续') === false)
check('not vague: 1', looksVague('1') === false)
check('not vague: 帮我改一下 config.json', looksVague('帮我改一下 config.json') === false)
check('not vague: long sentence', looksVague('把 E 盘的那个项目文档整理成一份周报发给我') === false)
check('ack: 好', isAck('好') === true)
check('ack: ok', isAck('ok') === true)
check('ack: 各个模式有什么区别 is not ack', isAck('各个模式有什么区别') === false)

const text = extractUserText([
  { role: 'user', content: [{ type: 'text', text: '运行时上下文' }], source: { kind: 'runtime-context' } },
  { role: 'user', content: [{ type: 'text', text: '各个模式有什么区别' }] },
])
check('extractUserText skips runtime-context', text === '各个模式有什么区别', text)

const historyText = extractUserText([
  { role: 'user', content: [{ type: 'text', text: '帮我修一下 ~/projects/demo 里的配置，顺便看看日志' }] },
  { role: 'assistant', content: [{ type: 'text', text: '好的，已处理' }] },
  { role: 'user', content: [{ type: 'text', text: '各个模式有什么区别' }] },
])
check('extractUserText returns only the last user message', historyText === '各个模式有什么区别', historyText)

const subNotifyText = extractUserText([
  { role: 'user', content: [{ type: 'text', text: '那个怎么样' }] },
  { role: 'user', content: [{ type: 'text', text: 'Background subagent abc-123 finished and will do no further work unless you send it more.' }] },
])
check('extractUserText skips subagent notices', subNotifyText === '那个怎么样', subNotifyText)

const scheduleText = extractUserText([
  {
    role: 'user',
    content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: "s-1"' }],
  },
])
check('extractUserText skips schedule reminders', scheduleText === '', scheduleText)

// ---------------- guard ----------------

function makeCtx() {
  const handlers = { preExecute: [], agentCreated: [] }
  return {
    handlers,
    logger: { info() {}, warn() {} },
    on(event, fn) {
      if (event === 'tools/pre-execute') handlers.preExecute.push(fn)
      if (event === 'agent/created') handlers.agentCreated.push(fn)
      return () => {}
    },
    effect(fn) {
      try {
        fn()
      } catch {}
      return () => {}
    },
    inject() {},
    get() {
      return undefined
    },
  }
}

function makeAgent(sid, header) {
  const preStep = []
  return {
    id: sid,
    session: { id: sid, header: header || {}, eventsSnapshot: [] },
    ctx: {
      on(event, fn) {
        if (event === 'agent/pre-step') preStep.push(fn)
        return () => {}
      },
    },
    preStep,
    followup: async () => {},
  }
}

// Rule fallback on for the rule-based cases below
writeConfig({ enabled: true, ruleGate: true })

const next = async () => ({ kind: 'enter', messages: [] })
const ctx = makeCtx()
apply(ctx)
check('guard registered', ctx.handlers.preExecute.length === 1)
check('agent hook registered', ctx.handlers.agentCreated.length === 1)

const agent = makeAgent('s-main', { origin: 'web' })
ctx.handlers.agentCreated[0]({ agent })
check('pre-step hooked', agent.preStep.length === 1)

async function runPreStep(a, userText, turn = 1) {
  await a.preStep[0](
    {
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      turn,
      step: 1,
    },
    next,
  )
}
async function runTool(name, a) {
  return ctx.handlers.preExecute[0]({ name, arguments: {}, agent: a }, next)
}

await runPreStep(agent, '各个模式有什么区别')
const blocked = await runTool('pwsh', agent)
check('vague message blocks first tool call', blocked && blocked.kind === 'deny', JSON.stringify(blocked))
check('block reason mentions ask', /ask_user_question/.test(blocked && blocked.reason ? blocked.reason : ''))
check(
  'block reason asks goal + method',
  /要干什么/.test(blocked && blocked.reason ? blocked.reason : '') &&
    /要怎么干/.test(blocked && blocked.reason ? blocked.reason : ''),
)

const ask1 = await runTool('ask_user_question', agent)
check('ask_user_question always passes', ask1 && ask1.kind === 'enter')

const blocked2 = await runTool('pwsh', agent)
check('tool after asking is blocked (ask then stop)', blocked2 && blocked2.kind === 'deny', JSON.stringify(blocked2))

const blocked3 = await runTool('pwsh', agent)
check('third call in same turn passes (maxBlocksPerTurn=2)', blocked3 && blocked3.kind === 'enter', JSON.stringify(blocked3))

await runPreStep(agent, '继续', 2)
const afterAck = await runTool('pwsh', agent)
check('ack receipt does not arm', afterAck && afterAck.kind === 'enter', JSON.stringify(afterAck))

// subagent dispatch itself is never blocked
await runPreStep(agent, '那个怎么样', 6)
const subagentCall = await runTool('subagent', agent)
check('subagent tool always passes', subagentCall && subagentCall.kind === 'enter', JSON.stringify(subagentCall))

// ask-phrase ("干什么用的") must arm even with an action-looking char
await runPreStep(agent, '这个配置文件是干什么用的', 3)
const askPhrase = await runTool('pwsh', agent)
check('ask-phrase message arms', askPhrase && askPhrase.kind === 'deny', JSON.stringify(askPhrase))

// modelGate on, but no llm service -> fail-open (no block)
writeConfig({ enabled: true, modelGate: true })
await runPreStep(agent, '把酒吧改成蛋炒饭店', 4)
const gateNoLlm = await runTool('pwsh', agent)
check('modelGate without llm fails open', gateNoLlm && gateNoLlm.kind === 'enter', JSON.stringify(gateNoLlm))
writeConfig({ modelGate: false })

// guess signal from the model's own reasoning blocks
await runPreStep(agent, '把 E 盘那个项目整理成周报', 5)
agent.session.eventsSnapshot = [
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '我猜用户是想问模式的区别' }] } },
  },
]
const guessBlocked = await runTool('pwsh', agent)
check('guess signal in reasoning blocks', guessBlocked && guessBlocked.kind === 'deny', JSON.stringify(guessBlocked))
agent.session.eventsSnapshot = []

// subagent session is never gated
const sub = makeAgent('s-sub', { origin: 'subagent', parentSession: 's-main' })
ctx.handlers.agentCreated[0]({ agent: sub })
check('subagent gets no pre-step hook', sub.preStep.length === 0)
const subBlocked = await runTool('pwsh', sub)
check('subagent tool call passes', subBlocked && subBlocked.kind === 'enter', JSON.stringify(subBlocked))

// disabled config
writeConfig({ enabled: false })
const off = await runTool('pwsh', agent)
check('disabled config lets calls through', off && off.kind === 'enter', JSON.stringify(off))
writeConfig({ enabled: true })

// default mode: thinking gate is primary, rule gate off
writeConfig({ enabled: true, ruleGate: false })
await runPreStep(agent, '那个怎么样', 99)
const noRuleArm = await runTool('pwsh', agent)
check('thinking mode: vague message alone does not arm', noRuleArm && noRuleArm.kind === 'enter', JSON.stringify(noRuleArm))
agent.session.eventsSnapshot = [
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '我猜用户是想问模式的区别' }] } },
  },
]
const thinkArm = await runTool('pwsh', agent)
check('thinking mode: reasoning guess arms', thinkArm && thinkArm.kind === 'deny', JSON.stringify(thinkArm))
agent.session.eventsSnapshot = []

// machine turn: schedule reminder is not a human message -> never arm
writeConfig({ enabled: true, ruleGate: false })
await runPreStep(agent, '[SCHEDULE REMINDER]\nThis is a scheduled message from the user', 100)
agent.session.eventsSnapshot = [
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '我猜用户是想问模式的区别' }] } },
  },
]
const machineTurn = await runTool('pwsh', agent)
check('machine turn: no human message -> no arm', machineTurn && machineTurn.kind === 'enter', JSON.stringify(machineTurn))
agent.session.eventsSnapshot = []
writeConfig({ enabled: true, ruleGate: true })

// cross-turn contamination: a guess from an earlier turn must not arm this one
writeConfig({ enabled: true, ruleGate: false })
await runPreStep(agent, '帮我改一下 config.json', 120)
agent.session.eventsSnapshot = [
  {
    type: 'assistant/message',
    data: { turn: 119, message: { content: [{ type: 'reasoning', text: '我猜用户是想问模式的区别' }] } },
  },
  {
    type: 'assistant/message',
    data: { turn: 120, message: { content: [{ type: 'reasoning', text: '先读配置文件，然后改 timeout' }] } },
  },
]
const staleGuess = await runTool('pwsh', agent)
check('cross-turn: turn N-1 guess does not arm turn N', staleGuess && staleGuess.kind === 'enter', JSON.stringify(staleGuess))
agent.session.eventsSnapshot = [
  {
    type: 'assistant/message',
    data: { turn: 120, message: { content: [{ type: 'reasoning', text: '我猜用户是想改 timeout' }] } },
  },
]
const currentGuess = await runTool('pwsh', agent)
check('cross-turn: turn N guess still arms turn N', currentGuess && currentGuess.kind === 'deny', JSON.stringify(currentGuess))
agent.session.eventsSnapshot = []

// "不确定用户" alone is too broad (it fires while the model is unsure what a
// config value is); only the intent-word suffixes count.
writeConfig({ enabled: true, ruleGate: false })
await runPreStep(agent, '那个怎么样', 130)
agent.session.eventsSnapshot = [
  {
    type: 'assistant/message',
    data: { turn: 130, message: { content: [{ type: 'reasoning', text: '不确定用户配置里 timeout 是多少，先读一下' }] } },
  },
]
const noIntent = await runTool('pwsh', agent)
check('intent suffix: "不确定用户配置" does not arm', noIntent && noIntent.kind === 'enter', JSON.stringify(noIntent))
agent.session.eventsSnapshot = [
  {
    type: 'assistant/message',
    data: { turn: 130, message: { content: [{ type: 'reasoning', text: '不确定用户想要什么，先问一下' }] } },
  },
]
const withIntent = await runTool('pwsh', agent)
check('intent suffix: "不确定用户想要" arms', withIntent && withIntent.kind === 'deny', JSON.stringify(withIntent))
agent.session.eventsSnapshot = []

// A human message that names the plugin marks a turn about the plugin itself.
writeConfig({ enabled: true, ruleGate: false })
await runPreStep(agent, '帮我看下 dsh-no-guess 这个插件', 131)
agent.session.eventsSnapshot = [
  {
    type: 'assistant/message',
    data: { turn: 131, message: { content: [{ type: 'reasoning', text: '我猜用户是想问这个插件的拦截逻辑' }] } },
  },
]
const selfTalk = await runTool('pwsh', agent)
check('self-discussion: plugin name in the user message exempts the turn', selfTalk && selfTalk.kind === 'enter', JSON.stringify(selfTalk))
agent.session.eventsSnapshot = []

// privacy: the log must not carry user text unless logUserText is on
const LOG_FILE = join(process.env.DSH_HOME, 'ask-first', 'ask-first.log')
writeConfig({ enabled: true, ruleGate: false, logUserText: false })
await runPreStep(agent, '那个怎么样', 121)
agent.session.eventsSnapshot = [
  {
    type: 'assistant/message',
    data: { turn: 121, message: { content: [{ type: 'reasoning', text: '我猜用户是想问模式的区别' }] } },
  },
]
await runTool('pwsh', agent)
const logDefault = readFileSync(LOG_FILE, 'utf8')
check(
  'privacy: log omits user text by default',
  !logDefault.includes('那个怎么样') && !logDefault.includes('我猜用户'),
  'log leaked user text',
)
agent.session.eventsSnapshot = []

writeConfig({ enabled: true, ruleGate: false, logUserText: true })
await runPreStep(agent, '那个怎么样', 122)
agent.session.eventsSnapshot = [
  {
    type: 'assistant/message',
    data: { turn: 122, message: { content: [{ type: 'reasoning', text: '我猜用户是想问模式的区别' }] } },
  },
]
await runTool('pwsh', agent)
const logOptIn = readFileSync(LOG_FILE, 'utf8')
check('privacy: logUserText=true records the text', logOptIn.includes('那个怎么样'), 'text not logged')
agent.session.eventsSnapshot = []
writeConfig({ logUserText: false })

// replay: the regression script groups by turn and only counts human turns
{
  const { replaySession } = await import('./replay.mjs')
  const replayText = [
    '{"type":"turn/start","data":{"turn":1}}',
    '{"type":"user/message","data":{"source":{"kind":"user"},"content":[]}}',
    '{"type":"assistant/message","data":{"turn":1,"message":{"content":[{"type":"reasoning","text":"I guess the user wants X"}]}}}',
    '{"type":"turn/start","data":{"turn":2}}',
    '{"type":"user/message","data":{"source":{"kind":"agent-instructions"},"content":[]}}',
    '{"type":"assistant/message","data":{"turn":2,"message":{"content":[{"type":"reasoning","text":"我猜用户是想问"}]}}}',
  ].join('\n')
  const replay = replaySession(replayText)
  check('replay: only human turns are counted', replay.humanTurns === 1, JSON.stringify(replay))
  check('replay: an armed turn reports armed', replay.turns.length === 1 && replay.turns[0].armed === true, JSON.stringify(replay.turns))
}

console.log('SELFTEST PASS=' + pass + ' FAIL=' + fail)
if (fail > 0) process.exit(1)
