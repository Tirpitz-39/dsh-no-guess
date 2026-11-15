// dsh-ask-first - 不明白就先问：用户那句话不清楚时，拦截工具调用，强制先问。
//
// Host half. ZERO model calls: the "vague" decision is a rule, not an LLM.
//   - agent/pre-step  记录本轮最后一条用户消息（真人会话才挂）
//   - tools/pre-execute  看到用户消息模糊时，拦下第一次工具调用并要求先问；
//     本轮问过之后还接着动手，再拦一次（问完就停）
//
// Fail-open everywhere: a broken guard must never brick the harness.
// Output of the HTTP route is JSON; config lives in $DSH_HOME/ask-first/.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-ask-first'
export const inject = ['tools']

const ROUTE_PREFIX = '/dsh-ask-first'

/** Plugin version, read from package.json next to this file (best effort). */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const DEFAULTS = {
  enabled: true,
  timeoutMinutes: 10,
  maxBlocksPerTurn: 2,
  vagueMaxLength: 40,
  thinkingGate: true,
  ruleGate: false,
  modelGate: false,
}

/** Numeric config bounds; also used to sanitize hand-edited config files. */
const LIMITS = {
  timeoutMinutes: { min: 1, max: 120, def: 10, int: true },
  maxBlocksPerTurn: { min: 1, max: 10, def: 2, int: true },
  vagueMaxLength: { min: 10, max: 200, def: 40, int: true },
}

function clampNumber(value, spec) {
  const n = Number(value)
  if (!Number.isFinite(n)) return spec.def
  const rounded = spec.int ? Math.round(n) : n
  return Math.min(spec.max, Math.max(spec.min, rounded))
}

// Tools that never count as "动手": asking is the whole point, todo bookkeeping
// does not change the world, and the claim_* / wrapup_check family must always
// go through.
const ALWAYS_ALLOW = new Set([
  'ask_user_question',
  'todo_write',
  'wrapup_check',
  'claim_plan',
  'claim_verify',
  'claim_status',
  'claim_report',
  'subagent',
  'subagent_fork',
  'workflow',
])

// Short receipts that answer a previous question ("继续" / "1" / "好").
const ACK_RE =
  /^(?:继续|好|好的|收到|嗯|嗯嗯|行|可以|是|对|没错|就这样|先这样|知道了|明白|了解|不用|不|不要|ok|okay|yes|no|go|\d{1,2})$/i

// Things that usually mean "the user pointed at something without saying which".
const VAGUE_PRONOUN_RE = /(这个|那个|各个|哪些|这些|那些|它们?|刚才|上面|前面|之前|后面|模式|东西|情况|区别|样子)/i
const QUESTION_RE = /[?？]|吗|呢|什么|怎么|如何|哪个|哪些|为什么|啥/i
// Asking what something IS/DOES about a thing with no referent is the
// textbook "说不清" case. This beats the length/verb heuristics.
const ASK_PHRASE_RE = /(什么意思|干什么用|干什么的|干嘛用|干嘛的|什么用|怎么用|啥意思|啥用|有用吗|是啥|叫什么)/i
// Questions ABOUT the conversation ("you sure?", "is that OK?") are the user
// checking on us — not a vague task. Never arm on those.
const VERIFY_RE = /(你确定|确定吗|真的吗|有问题吗|是不是有问题|有什么问题|没问题吧|可以吗|行吗|行不行|对吗|对吧|靠谱吗)/
const VERB_RE =
  /(做|弄|改|写|看|说|搞|处理|设置|换|切|删|加|找|查|跑|运行|装|卸|开|关|继续|生成|整理|导出|安装|修复|优化|部署|提交|合并|测试|执行|搜索|下载|上传)/

const ASK_TEXT =
  '[dsh-ask-first] 先别动手。在问清楚「用户到底要干什么、要怎么干」之前，不许猜。' +
  '先用 ask_user_question 问清这两件事（1-3 条问题，每条给 2-4 个从用户原话推出来的具体选项）：' +
  '① 要干什么：目标是什么、最后要什么交付物、范围到哪（明确不做什么）；' +
  '② 要怎么干：用什么方式/工具/约束、什么算做好（验收标准）。' +
  '问完这一轮就停住等回答，不要在同一个回合里继续调用工具。'

const STOP_TEXT =
  '[dsh-ask-first] 你这一轮已经问过用户了，问完就该停住等回答。' +
  '不要在同一个回合里先问再自己猜着继续——那等于没问。'

// ------------------------------------------------------------------ paths

/**
 * DSH data root. Same resolution order as the harness itself:
 * config.dshHome (not reachable here) -> $DSH_HOME -> ~/.dsh.
 */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env) return env
  return join(homedir(), '.dsh')
}

function dataDir() {
  return join(dshHome(), 'ask-first')
}
function configPath() {
  return join(dataDir(), 'config.json')
}
function sessionsPath() {
  return join(dataDir(), 'sessions.json')
}
function logPath() {
  return join(dataDir(), 'ask-first.log')
}

function ensureDir() {
  try {
    mkdirSync(dataDir(), { recursive: true })
  } catch {}
}

export function readConfig() {
  let raw = null
  try {
    raw = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    raw = null
  }
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const cfg = { ...DEFAULTS }
  if (typeof src.enabled === 'boolean') cfg.enabled = src.enabled
  if (typeof src.thinkingGate === 'boolean') cfg.thinkingGate = src.thinkingGate
  if (typeof src.ruleGate === 'boolean') cfg.ruleGate = src.ruleGate
  if (typeof src.modelGate === 'boolean') cfg.modelGate = src.modelGate
  for (const key of Object.keys(LIMITS)) {
    if (src[key] !== undefined) cfg[key] = clampNumber(src[key], LIMITS[key])
  }
  return cfg
}

/** Atomic write: a crash mid-write must not leave a truncated config file. */
function writeFileAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {}
    // Direct write as a last resort (e.g. filesystem without rename).
    try {
      writeFileSync(file, content, 'utf8')
    } catch {
      throw error
    }
  }
}

export function writeConfig(patch) {
  ensureDir()
  const next = readConfig()
  if (patch && typeof patch === 'object') {
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (typeof patch.thinkingGate === 'boolean') next.thinkingGate = patch.thinkingGate
    if (typeof patch.ruleGate === 'boolean') next.ruleGate = patch.ruleGate
    if (typeof patch.modelGate === 'boolean') next.modelGate = patch.modelGate
    for (const key of Object.keys(LIMITS)) {
      if (patch[key] !== undefined) next[key] = clampNumber(patch[key], LIMITS[key])
    }
  }
  try {
    writeFileAtomic(configPath(), JSON.stringify(next, null, 2))
  } catch {}
  return next
}

// Session-level overrides survive restarts: { [sid]: { enabled: boolean } }.
export function readSessionOverrides() {
  try {
    const raw = JSON.parse(readFileSync(sessionsPath(), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function writeSessionOverride(sid, patch) {
  ensureDir()
  const all = readSessionOverrides()
  const prev = all[sid] && typeof all[sid] === 'object' ? all[sid] : {}
  all[sid] = { ...prev, ...(patch ?? {}), updatedAt: Date.now() }
  // Keep the file bounded.
  const keys = Object.keys(all)
  if (keys.length > 500) {
    for (const key of keys.slice(0, keys.length - 500)) delete all[key]
  }
  try {
    writeFileSync(sessionsPath(), JSON.stringify(all), 'utf8')
  } catch {}
  return all[sid]
}

const LOG_MAX_BYTES = (() => {
  const n = Number(process.env.DSH_ASK_FIRST_LOG_MAX_BYTES)
  return Number.isFinite(n) && n >= 16 * 1024 ? Math.floor(n) : 2 * 1024 * 1024
})()
const LOG_KEEP_BYTES = Math.max(1024, Math.floor(LOG_MAX_BYTES / 2))
let logWritesSinceCheck = 0

/** Keep the JSONL log bounded: rotate to the tail half once it passes 2 MiB. */
function rotateLogIfNeeded() {
  try {
    if (statSync(logPath()).size <= LOG_MAX_BYTES) return
    const content = readFileSync(logPath(), 'utf8')
    writeFileAtomic(logPath(), content.slice(-LOG_KEEP_BYTES))
  } catch {}
}

export function logLine(event, data) {
  try {
    ensureDir()
    // logLine sits on the tool-call path; only stat the file every 128 writes.
    logWritesSinceCheck += 1
    if (logWritesSinceCheck >= 128) {
      logWritesSinceCheck = 0
      rotateLogIfNeeded()
    }
    appendFileSync(logPath(), JSON.stringify({ t: new Date().toISOString(), event, ...(data ?? {}) }) + '\n', 'utf8')
  } catch {}
}

// ------------------------------------------------------------------ rules

export function isAck(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  return ACK_RE.test(t)
}

// Guess signal: only phrases that point AT the user's intent. Bare "我猜" is
// too common (self-referential discussions of this very feature trip it), but
// "I guess" / "I think the user" style admissions are treated as guessing on
// purpose (user opted into more blocks over fewer).
// Matching happens AFTER whitespace is stripped, so English patterns are
// written without spaces ("I guess the user" -> "iguesstheuser").
const GUESS_RE =
  /(我猜用户|猜用户想|不确定用户|不清楚用户|不知道用户要|用户可能是想|用户大概是想要|用户要的应该是|iguesstheuser|imguessingtheuser|guessingwhattheuser|iguessthat|iguessthis|iguessthey|iguessit|iguessits|notsurewhattheuser|unsurewhattheuser|notsurewhatyoumean|unsurewhatyoumean|dontknowwhattheuser|dontknowwhatyouwant|dontknowwhatyoumean|canttellwhattheuser|canttellwhatyoumean|theuserprobablywants|userprobablywants|theuserlikelywants|userlikelywants|theusermightwant|maybetheuserwants|perhapstheuser|assumingtheuser|ithinktheuser|ibelievetheuser|ithinkyouwant|ithinkyoumean)/i

export function extractGuessText(session) {
  try {
    const snap = session && Array.isArray(session.eventsSnapshot) ? session.eventsSnapshot : []
    // The newest assistant message is often an interim tool-call message whose
    // reasoning block is empty; scan the last few and merge their reasoning.
    const parts = []
    let seen = 0
    for (let i = snap.length - 1; i >= 0 && seen < 5; i -= 1) {
      const ev = snap[i]
      if (!ev || ev.type !== 'assistant/message') continue
      seen += 1
      const msg = ev.data && ev.data.message
      const blocks = msg && Array.isArray(msg.content) ? msg.content : []
      for (const b of blocks) {
        if (b && b.type === 'reasoning' && typeof b.text === 'string' && b.text.trim()) {
          parts.push(b.text)
        }
      }
    }
    return parts.join('\n').trim()
  } catch {
    return ''
  }
}

export function extractUserText(messages) {
  const list = Array.isArray(messages) ? messages : []
  // Only the LAST human message matters: the payload carries conversation
  // history too, and joining all of it would make every real request look long.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i]
    if (!message || message.role !== 'user') continue
    const srcKind = message.source && typeof message.source.kind === 'string' ? message.source.kind : ''
    if (srcKind === 'runtime-context') continue
    // Plugin-injected notices are not the user speaking.
    if (srcKind.startsWith('dsh-')) continue
    const parts = []
    for (const block of message.content ?? []) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim())
      }
    }
    const text = parts.join('\n').trim()
    if (!text) continue
    if (/^Background subagent [\w-]+ finished/.test(text)) continue
    // Scheduled-task prompts are machine reminders, not the human speaking.
    // Require the fixed body too: a bare prefix must not be able to hide a
    // real instruction (adversarial check A2).
    if (/^\[SCHEDULE REMINDER\]\s+This is a scheduled message/i.test(text)) continue
    return text.slice(0, 4000)
  }
  return ''
}

/**
 * Heuristic: does this user message look like it points at something without
 * saying what? Short + pronoun/noun-without-context + no action verb = vague.
 * Pure greetings and receipts never arm.
 */
export function looksVague(text, maxLength = DEFAULTS.vagueMaxLength) {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (isAck(t)) return false
  // "你确定吗 / 可以吗" — the user is checking on us, not giving a task.
  if (VERIFY_RE.test(t)) return false
  if (t.length > maxLength) return false
  // A greeting is not a task.
  if (/^(你好|您好|在吗|嗨|哈喽|hello|hi|hey|嗨嗨|早上好|晚上好|晚安|谢谢|感谢)[\s!！。.~～?？]*$/i.test(t)) return false
  // "什么意思 / 干什么用的" about an unreferenced thing: ask before acting.
  if (ASK_PHRASE_RE.test(t)) return true
  const hasPronoun = VAGUE_PRONOUN_RE.test(t)
  const hasQuestion = QUESTION_RE.test(t)
  const hasVerb = VERB_RE.test(t)
  if (hasPronoun && !hasVerb) return true
  if (hasQuestion && !hasVerb && t.length <= 25) return true
  return false
}

export function isSubagentSession(session) {
  try {
    const header = (session && session.header) || {}
    if (header.origin === 'subagent') return true
    if (header.parentSession !== undefined && header.parentSession !== null) return true
    if (typeof header.parentSessionId === 'string' && header.parentSessionId !== '') return true
  } catch {}
  return false
}

/** Only human-facing sessions get gated. Scheduled/QQ/bridge sessions have nobody to answer. */
export function isHumanSession(session) {
  try {
    if (!session) return false
    if (isSubagentSession(session)) return false
    const header = (session && session.header) || {}
    const origin = header.origin
    if (origin === undefined || origin === null || origin === '') return true
    return ['user', 'desktop', 'web', 'cli', 'app'].includes(String(origin))
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ state

function getState(states, sid) {
  let st = states.get(sid)
  if (!st) {
    st = {
      armed: false,
      askedThisTurn: false,
      blocksThisTurn: 0,
      blockedAt: 0,
      lastText: '',
      lastTurn: 0,
      lastUserAt: 0,
      timer: null,
    }
    states.set(sid, st)
  }
  return st
}

function clearTimer(st) {
  try {
    if (st && st.timer) clearTimeout(st.timer)
  } catch {}
  if (st) st.timer = null
}

function armTimeout(agent, sid, st, cfg) {
  clearTimer(st)
  const ms = Math.max(1, Number(cfg.timeoutMinutes) || DEFAULTS.timeoutMinutes) * 60_000
  st.timer = setTimeout(() => {
    try {
      st.timer = null
      if (!st.armed || !st.blockedAt) return
      if (st.askedThisTurn) return
      if (Date.now() - st.lastUserAt < ms) return
      st.armed = false
      logLine('timeout', { sid })
      const followup = agent && typeof agent.followup === 'function' ? agent.followup : null
      if (!followup) return
      Promise.resolve(
        followup.call(agent, {
          id: randomUUID(),
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                '[dsh-ask-first] 用户超过 ' +
                Math.max(1, Number(cfg.timeoutMinutes) || DEFAULTS.timeoutMinutes) +
                ' 分钟没有回复你的提问。按最小假设继续，并在回答开头用一句话写明你假定了什么。',
            },
          ],
          source: { kind: 'dsh-ask-first' },
        }),
      ).catch(() => {})
    } catch {}
  }, ms)
  if (st.timer && typeof st.timer.unref === 'function') st.timer.unref()
}

// Optional model judgement (modelGate). This is the ONLY code path that spends
// tokens, and it only runs when the user turns modelGate on in settings.
const JUDGE_SYSTEM =
  '你是需求判定器，只输出严格 JSON：{"needClarify":true|false,"reason":"<=30字"}。' +
  '判断用户这句话是否已经说清两件事：①要干什么（目标、交付物、范围）②要怎么干（方式、约束、验收标准）。' +
  '缺任一件、指代不明、或要求自相矛盾（比如在酒吧点蛋炒饭、不放油不开火做蛋炒饭）→ true；' +
  '两件都说清、信息足够动手 → false。'

async function judgeByModel(ctx, text) {
  try {
    const get = typeof ctx.get === 'function' ? (name) => ctx.get(name) : () => undefined
    const llm = get('llm')
    if (!llm || typeof llm.stream !== 'function') return null
    let route = null
    try {
      const sel = get('agentDefaultModel')
      const now = sel && typeof sel.currentSelection === 'function' ? sel.currentSelection() : null
      if (now && now.provider && now.model) route = { provider: now.provider, model: now.model }
    } catch {}
    if (!route) return null
    const controller = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.abort()
      } catch {}
    }, 30_000)
    if (timer && typeof timer.unref === 'function') timer.unref()
    let output = ''
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        temperature: 0,
        maxTokens: 200,
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: String(text).slice(0, 2000) }] }],
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
      }
    } finally {
      clearTimeout(timer)
    }
    const match = /\{[\s\S]*\}/.exec(output)
    if (!match) return null
    const verdict = JSON.parse(match[0])
    logLine('model-judge', {
      need: verdict.needClarify === true,
      reason: String(verdict.reason || '').slice(0, 60),
    })
    return verdict.needClarify === true
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ http

function sendJson(res, status, value) {
  try {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try {
      res.destroy()
    } catch {}
  }
}

function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        try {
          req.destroy()
        } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function isLoopback(req) {
  const address = req && req.socket && req.socket.remoteAddress
  return address === undefined || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function handleRoute(ctx, states, req, res) {
  try {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    const cfg = readConfig()

    if (req.method === 'GET' && (path === '/' || path === '/state')) {
      const sid = url.searchParams.get('sessionId') || ''
      const override = sid ? readSessionOverrides()[sid] : undefined
      const st = sid ? states.get(sid) : undefined
      return sendJson(res, 200, {
        ok: true,
        config: cfg,
        sessionId: sid || null,
        sessionEnabled: override && typeof override.enabled === 'boolean' ? override.enabled : null,
        effectiveEnabled: override && typeof override.enabled === 'boolean' ? override.enabled : cfg.enabled,
        armed: st ? st.armed === true : false,
        blockedAt: st ? st.blockedAt || 0 : 0,
      })
    }
    if (req.method === 'GET' && path === '/config') {
      return sendJson(res, 200, { ok: true, config: cfg })
    }
    if (req.method === 'POST' && path === '/config') {
      readJsonBody(req)
        .then((body) => {
          const patch = {}
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          if (body.timeoutMinutes !== undefined) patch.timeoutMinutes = body.timeoutMinutes
          if (body.maxBlocksPerTurn !== undefined) patch.maxBlocksPerTurn = body.maxBlocksPerTurn
          if (body.vagueMaxLength !== undefined) patch.vagueMaxLength = body.vagueMaxLength
          if (typeof body.modelGate === 'boolean') patch.modelGate = body.modelGate
          if (typeof body.thinkingGate === 'boolean') patch.thinkingGate = body.thinkingGate
          if (typeof body.ruleGate === 'boolean') patch.ruleGate = body.ruleGate
          const next = writeConfig(patch)
          logLine('config', { patch })
          sendJson(res, 200, { ok: true, config: next })
        })
        .catch((error) => sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }))
      return
    }
    if (req.method === 'POST' && path === '/session') {
      readJsonBody(req)
        .then((body) => {
          const sid = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (!sid) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
          const patch = {}
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          const all = readSessionOverrides()
          const prev = all[sid] && typeof all[sid] === 'object' ? { ...all[sid] } : {}
          delete prev.updatedAt
          if (typeof body.enabled !== 'boolean') delete prev.enabled
          writeSessionOverride(sid, { ...prev, ...patch })
          const st = states.get(sid)
          if (st) clearTimer(st)
          logLine('session', { sid, enabled: patch.enabled })
          return sendJson(res, 200, { ok: true })
        })
        .catch((error) => sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }))
      return
    }
    if (req.method === 'GET' && path === '/log') {
      let content = ''
      try {
        content = readFileSync(logPath(), 'utf8')
      } catch {}
      const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('lines') || 100)))
      const lines = content.trim().split('\n').filter(Boolean).slice(-limit)
      return sendJson(res, 200, { ok: true, lines })
    }
    return sendJson(res, 404, { ok: false, error: 'unknown route ' + req.method + ' ' + path })
  } catch (error) {
    try {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    } catch {}
  }
}

// ------------------------------------------------------------------ plugin

export function apply(ctx) {
  const states = new Map()
  const agents = new Map()

  const logger = (level, message) => {
    try {
      const sink = ctx.logger && ctx.logger[level]
      if (typeof sink === 'function') sink.call(ctx.logger, 'dsh-ask-first: ' + message)
    } catch {}
  }

  // Per-agent pre-step: remember the latest user message.
  const attachAgent = (agent) => {
    try {
      if (!agent || isSubagentSession(agent.session)) return
      const sid = String((agent.session && agent.session.id) || agent.id || '')
      if (!sid) return
      if (agents.has(sid)) return
      agents.set(sid, agent)
      const scoped = agent.ctx || ctx
      const dispose = scoped.on('agent/pre-step', async (payload, next) => {
        try {
          await handlePreStep(sid, agent, payload)
        } catch {}
        return next()
      })
      // The user answering ask_user_question means the guessing window is over:
      // clear the armed state so the same turn can continue normally.
      const disposeResult = scoped.on('tools/result', (payload) => {
        try {
          const toolName =
            payload && (payload.name || (payload.tool && payload.tool.name) || (payload.call && payload.call.name))
          if (toolName !== 'ask_user_question') return
          const st = states.get(sid)
          if (!st) return
          st.armed = false
          st.blockedAt = 0
          clearTimer(st)
          logLine('answered', { sid })
        } catch {}
      })
      ctx.effect(() => () => {
        try {
          dispose && dispose()
        } catch {}
        try {
          disposeResult && disposeResult()
        } catch {}
        if (agents.get(sid) === agent) agents.delete(sid)
        const st = states.get(sid)
        if (st) clearTimer(st)
      }, 'dsh-ask-first: pre-step ' + sid)
    } catch (error) {
      logger('warn', 'attach failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  const handlePreStep = async (sid, agent, payload) => {
    const p = payload || {}
    if (p.step !== 1) return
    const text = extractUserText(p.messages)
    if (!text) {
      // Machine turn (schedule reminder / plugin followup): clear stale state so
      // the gates do not inherit the previous human message.
      const machine = getState(states, sid)
      machine.lastText = ''
      machine.armed = false
      machine.askedThisTurn = false
      machine.blocksThisTurn = 0
      machine.blockedAt = 0
      clearTimer(machine)
      return
    }
    const cfg = readConfig()
    const st = getState(states, sid)
    st.lastText = text
    st.lastTurn = Number(p.turn) || 0
    st.lastUserAt = Date.now()
    st.askedThisTurn = false
    st.blocksThisTurn = 0
    st.blockedAt = 0
    clearTimer(st)
    if (!cfg.enabled) {
      st.armed = false
      return
    }
    if (isAck(text)) {
      st.armed = false
      return
    }
    st.armed = cfg.ruleGate === true ? looksVague(text, cfg.vagueMaxLength) : false
    // Optional paid gate: a model judges whether the request is missing
    // context or self-contradictory. Off by default; fail-open on any error.
    if (!st.armed && cfg.modelGate === true) {
      try {
        const need = await judgeByModel(ctx, text)
        if (need === true) {
          st.armed = true
          logLine('model-arm', { sid, text: text.slice(0, 120) })
        }
      } catch {}
    }
    if (st.armed) logLine('arm', { sid, turn: st.lastTurn, text: text.slice(0, 120) })
  }

  // Global guard: block the first tool call while the request is still vague.
  const guard = async (exec, next) => {
    try {
      const session = exec && exec.agent ? exec.agent.session : null
      if (!session) return next()
      if (!isHumanSession(session)) return next()
      const sid = String(session.id || '')
      if (!sid) return next()
      // Lazy attach: sessions created before the plugin loaded still get the
      // pre-step hook on their next tool call (arms from the next user message).
      if (!agents.has(sid)) {
        try {
          attachAgent(exec.agent)
        } catch {}
      }
      const cfg = readConfig()
      const st = getState(states, sid)
      const override = readSessionOverrides()[sid]
      const effectiveEnabled =
        override && typeof override.enabled === 'boolean' ? override.enabled : cfg.enabled
      if (!effectiveEnabled) return next()

      const tool = String((exec && exec.name) || '')
      if (tool === 'ask_user_question') {
        st.askedThisTurn = true
        st.blockedAt = 0
        clearTimer(st)
        logLine('asked', { sid })
        return next()
      }
      if (ALWAYS_ALLOW.has(tool)) return next()
      // Rule fallback (opt-in): the user message itself looks underspecified.
      if (!st.armed && cfg.ruleGate === true && st.lastText) {
        if (looksVague(st.lastText, cfg.vagueMaxLength)) {
          st.armed = true
          logLine('rule-arm', { sid, text: st.lastText.slice(0, 120) })
        }
      }
      // Primary gate: the model's own reasoning admits it is guessing intent.
      // Only for turns that actually came from a human message — machine turns
      // (schedule reminders / plugin followups) have no lastText and must not arm.
      if (!st.armed && cfg.thinkingGate !== false && st.blocksThisTurn === 0 && st.lastText) {
        const guess = extractGuessText(session)
        // Strip whitespace before matching so a newline cannot split the phrase
        // (adversarial check A5).
        if (guess && GUESS_RE.test(guess.replace(/\s+/g, ''))) {
          st.armed = true
          logLine('guess-arm', { sid, head: guess.slice(0, 140) })
        }
      }
      if (!st.armed) return next()

      // Timeout grace: the user is not coming back; let it through.
      if (st.blockedAt && Date.now() - st.blockedAt > Math.max(1, cfg.timeoutMinutes) * 60_000) {
        st.armed = false
        logLine('timeout-release', { sid, tool })
        return next()
      }

      if (st.askedThisTurn) {
        if (st.blocksThisTurn >= cfg.maxBlocksPerTurn) return next()
        st.blocksThisTurn += 1
        st.blockedAt = Date.now()
        logLine('block-stop', { sid, tool })
        return { kind: 'deny', reason: STOP_TEXT }
      }

      if (st.blocksThisTurn >= cfg.maxBlocksPerTurn) return next()
      st.blocksThisTurn += 1
      st.blockedAt = Date.now()
      armTimeout(exec.agent, sid, st, cfg)
      logLine('block-ask', { sid, tool, text: st.lastText.slice(0, 120) })
      return {
        kind: 'deny',
        reason: ASK_TEXT + '\n\n你用户刚才那句：' + st.lastText.slice(0, 160),
      }
    } catch {
      return next()
    }
  }

  ctx.effect(() => {
    const offGuard = ctx.on('tools/pre-execute', guard)
    return () => {
      try {
        offGuard && offGuard()
      } catch {}
    }
  }, 'dsh-ask-first: guard')

  ctx.effect(() => {
    const off = ctx.on('agent/created', (payload) => {
      try {
        attachAgent((payload && payload.agent) || payload)
      } catch {}
    })
    return () => {
      try {
        off && off()
      } catch {}
    }
  }, 'dsh-ask-first: agent hooks')

  try {
    ctx.inject(['webServer'], (child) => {
      try {
        child.effect(() => {
          const off = child.webServer.register({
            kind: 'prefix',
            path: ROUTE_PREFIX,
            handler: (req, res) => handleRoute(ctx, states, req, res),
          })
          return () => {
            try {
              off && off()
            } catch {}
          }
        }, 'dsh-ask-first: http route')
      } catch {}
    })
  } catch {}

  logger('info', 'loaded v' + VERSION)
}
