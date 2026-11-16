// DSH contract test: pins the host shapes this plugin depends on.
//
// The host (DSH) owns these events and decision objects. When the host renames
// an event, drops a payload field, or changes a decision kind, this test fails
// with the exact assumption that broke — instead of the plugin silently never
// firing again (the M1 failure mode from the 0.4.5 review).
//
// The snapshot in fixtures/host-contract.json is exported from the live host
// through the Event Inspect provider; refresh it with tools/export-contract
// instructions and commit the diff alongside a plugin change when the contract
// legitimately moved.
//
//   node test/dsh-contract.mjs
import { readFileSync } from 'node:fs'

const CONTRACT = JSON.parse(readFileSync(new URL('./fixtures/host-contract.json', import.meta.url), 'utf8'))
const INDEX = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

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

// 1. Every host event the plugin subscribes to must still exist.
const REQUIRED_EVENTS = ['tools/pre-execute', 'agent/pre-step', 'agent/created', 'agent/disposed', 'tools/result']
for (const name of REQUIRED_EVENTS) {
  check('contract: event ' + name + ' exists', Boolean(CONTRACT.events[name]), 'missing from snapshot')
}

// 2. agent/pre-step payload shape: the plugin reads messages/turn/step.
const preStep = CONTRACT.events['agent/pre-step'] || {}
for (const field of ['messages', 'turn', 'step']) {
  check(
    'contract: pre-step payload has ' + field,
    Array.isArray(preStep.payloadFields) && preStep.payloadFields.includes(field) && String(preStep.signature).includes(field),
    JSON.stringify(preStep.payloadFields),
  )
}

// 3. Decision objects: the plugin returns deny (block) and reads allow.
const preToolDecision = CONTRACT.types.PreToolDecision || ''
for (const kind of ['allow', 'deny', 'cancel', 'ask']) {
  check('contract: PreToolDecision has kind ' + kind, preToolDecision.includes("kind: '" + kind + "'"), preToolDecision.slice(0, 80))
}
check(
  'contract: PreToolDecision has no allow-with-note channel',
  !/kind: 'allow'[\s\S]*additionalContexts/.test(preToolDecision),
  'host contract changed: allow now carries context — revisit hint mode',
)

// 4. PreStepDecision: reject | enter(messages) — the hint-mode injection channel.
const preStepDecision = CONTRACT.types.PreStepDecision || ''
check('contract: PreStepDecision has enter', preStepDecision.includes("kind: 'enter'") && preStepDecision.includes('messages'))
check('contract: PreStepDecision has reject', preStepDecision.includes("kind: 'reject'"))

// 5. ToolExecutionInput: the guard reads name / arguments / agent.
const toolInput = CONTRACT.types.ToolExecutionInput || ''
for (const field of ['name', 'arguments', 'agent', 'signal']) {
  check('contract: ToolExecutionInput has ' + field, toolInput.includes('readonly ' + field), toolInput.slice(0, 60))
}

// 6. ToolCallKind: the P1 tier table will mirror these categories.
const toolCallKind = CONTRACT.types.ToolCallKind || ''
for (const kind of ['read', 'execute']) {
  check("contract: ToolCallKind includes '" + kind + "'", toolCallKind.includes("'" + kind + "'"))
}

// 7. Every DSH-namespaced event name the plugin source subscribes to must be in
// the snapshot. Plain `req.on('data')` / `req.on('end')` stream listeners are
// HTTP plumbing, not host events, so only names with a `/` are considered.
const subscribed = [...INDEX.matchAll(/(?:\.on|\.once)\(\s*'([\w/.-]*\/[\w/.-]+)'/g)].map((m) => m[1])
const known = new Set(Object.keys(CONTRACT.events))
for (const name of new Set(subscribed)) {
  check('source: subscribes to known event ' + name, known.has(name), 'plugin uses an event the contract snapshot does not know')
}

// 8. Snapshot sanity: it must carry the export provenance, or nobody can tell
// whether it is ancient.
check('contract: snapshot records exportedAt', typeof CONTRACT.exportedAt === 'string' && CONTRACT.exportedAt.length > 0)
check('contract: snapshot records source', typeof CONTRACT.source === 'string' && CONTRACT.source.length > 0)

console.log('CONTRACTTEST PASS=' + pass + ' FAIL=' + fail)
if (fail > 0) process.exit(1)
