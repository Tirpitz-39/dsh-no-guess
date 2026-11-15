# dsh-no-guess · Don't Guess

> Don't guess. When the request is unclear, ask before acting.

[中文](README.md) | **English**

[![test](https://github.com/Tirpitz-39/dsh-no-guess/actions/workflows/test.yml/badge.svg)](https://github.com/Tirpitz-39/dsh-no-guess/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-no-guess?style=flat-square)](https://www.npmjs.com/package/dsh-no-guess)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B67B4?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-amber?style=flat-square)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg?style=flat-square)](package.json)
![platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-2ea44f?style=flat-square)
[![ask-first](https://img.shields.io/badge/ask--first-no--guess-orange?style=flat-square)](#)

## What it does

The primary trigger is the **reasoning chain**: before every tool call, the plugin scans the model's recent reasoning. When the model's own reasoning admits it is guessing the user's intent ("I guess the user meant…", "not sure what the user wants…"), the first tool call is blocked and the model has to clarify first.

What happens when blocked:

1. It must call `ask_user_question` and clarify two layers: **what to do** (goal / deliverable / scope) and **how to do it** (method / constraints / acceptance criteria), with 2–4 concrete options per question;
2. If it keeps calling tools in the same turn after asking, it is blocked once more — *ask, then stop*;
3. At most `maxBlocksPerTurn` (default 2) blocks per turn, then everything goes through — it never deadlocks.

The literal-rule fallback (`ruleGate`, **off by default**) also blocks on short message + pronoun/question + no action verb. It is noisier and will produce false positives; enable it only if you want the extra guard.

How reasoning is read: DSH keeps the full thinking text in `reasoning` blocks of assistant messages (longest observed: 4459 chars), but the interim message right before a tool call has an empty reasoning block — so the plugin merges the last 5 assistant messages before matching.

## What it never blocks

- Receipts: "continue", "ok", "sure", "1", "2"…
- Confirmation questions about the conversation itself ("are you sure?", "does that work?") — that is not a task
- Subagent sessions, scheduled tasks, QQ/bridge sessions — nobody there to answer
- **Machine turns**: injected messages such as `[SCHEDULE REMINDER]` or plugin followups are not the human speaking. With no human `lastText` in the turn, the thinking gate does not fire
- `subagent` / `subagent_fork` / `workflow` dispatch itself (subagents never ask anyway)
- The master switch is off (settings page or the composer button)
- `ask_user_question` / `todo_write` / `claim_*` / `wrapup_check` themselves

## Configuration

Change it on the settings page (Settings → Ask First) or via `POST /dsh-no-guess/config`. Hand-editing `config.json` also works; bad values are clamped back into range.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `thinkingGate` | `true` | primary trigger: guess signals in the reasoning chain |
| `ruleGate` | `false` | literal-rule fallback, noisier |
| `modelGate` | `false` | model-based judgement (beta, costs tokens) |
| `timeoutMinutes` | `10` | after a block, how long to wait before continuing with the smallest assumption, 1–120 |
| `maxBlocksPerTurn` | `2` | max blocks per turn, 1–10 |
| `vagueMaxLength` | `40` | message length below which a message counts as "unclear", 10–200 |

## Timeout

If the user does not reply within `timeoutMinutes` (default 10) after a block, the plugin posts a message into the session: continue with the smallest assumption and state that assumption at the top of the answer. The turn is then no longer blocked.

## Model gate (modelGate, beta, off by default)

> **Status: unfinished (beta).** The chain works (call the model → judge needClarify → block), but the judge only sees a **single message** with no conversation context and tends to be too strict — it classified "test it out" as missing information in testing. The thinking gate is the reliable trigger; treat this as a fallback and expect it to over-block.

When enabled, every message the rules did not block is sent to a model that decides whether the request is missing information or self-contradictory (e.g. ordering fried rice in a bar, making fried rice without oil or fire).

- Off by default; costs zero tokens while off
- A few hundred tokens per judgement
- Model unavailable / 30 s timeout / unparsable output → fail open (let it through)
- Known limitation: single message only, no context; feeding the last 2–3 turns would be the next step

## The "guessing" signal

When the model's reasoning or answer contains phrases that admit it is guessing the user's intent, that is treated as the model admitting it is guessing, and the call is blocked so it asks first, regardless of how clear the user's message was.

- Chinese phrases: 我猜用户 / 不确定用户 / 不知道用户要 / 用户可能是想 / 用户要的应该是
- English phrases: "I guess the user" / "not sure what the user" / "I think the user" / "the user probably wants" / "I guess that" / "not sure what you mean"

Matching is case-insensitive and whitespace-insensitive (a phrase split across lines still matches). English conversations arm through these signals; reasoning without a guessing phrase is not blocked.

> Measured (2026-11-16): with `deepseek-flash`, the `reasoning` block of assistant messages is often empty (empty reasoning + tool call), so for that model the signal mostly comes from the answer text. With models that do emit reasoning, the reasoning is scanned too.

## Data

Everything lives under `DSH_HOME/ask-first/`. If the host does not set `DSH_HOME`, the fallback is `~/.dsh/ask-first/` (same resolution order as DSH itself; works on Windows, macOS and Linux). The directory keeps its pre-rename name `ask-first`; that is an implementation detail and does not affect the plugin name.

| File | Contents |
|---|---|
| `config.json` | the settings above; written atomically (temp file + rename) |
| `sessions.json` | per-session overrides (reserved) |
| `ask-first.log` | JSONL of every block/question/timeout; rotated at 2 MiB, keeping the tail half (`DSH_ASK_FIRST_LOG_MAX_BYTES` overrides the cap) |

## Install

Requirements: DSH (with the `tools` and `webServer` services) and Node.js ≥ 18.

```bash
git clone https://github.com/Tirpitz-39/dsh-no-guess
dsh plugin add file:./dsh-no-guess
```

For local development you can point it at your working copy instead: `dsh plugin add file:<plugin-dir>`.

Restart DSH afterwards. Settings → Ask First, or the "Ask First" button next to the composer.

## Tests

```bash
npm test                 # all four suites
node test/smoke.mjs      # 38 checks: rules / blocking / passthrough / receipts / subagents / machine turns / thinking chain
node test/edge-cases.mjs # 20 edge samples
node test/attack.mjs     # 10 adversarial samples (forged prefixes, split phrases, hard resistance, subagent bypass…)
node test/config.mjs     # 19 checks: defaults/clamping, atomic writes, log rotation, cross-platform data dir
```

The tests need no DSH runtime: fake `ctx` / fake `agent`, `DSH_HOME` pointed at a temp directory. CI runs them on ubuntu and windows with Node 18/20/22.

Adversarial suite currently **0 vulnerabilities / 10 samples**: the forged `[SCHEDULE REMINDER]` prefix and the newline-split phrase have been fixed; a forged `source` is host-generated and not constructible by the user (low risk); "the model never admits it is guessing" is an inherent limitation.

## Known limitations

- **Phrase matching, not intent understanding**: the signal is a phrase list (Chinese and English). A model that guesses intent without using any of those phrases will not arm; the English list deliberately errs on the side of more blocks, so "I guess"-style reasoning in normal work may trigger it.
- `modelGate` sees a single message only and over-blocks
- Work routed through `subagent` / `workflow` is not gated inside the subagent (by design — subagents should not ask the user)

## License

MIT
