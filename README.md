<p align="center">
  <img src="desktop/resources/app.png" width="96" alt="mu">
</p>
<h1 align="center">mu</h1>
<p align="center">μ · Only what's needed.</p>
<p align="center">A coding agent with a judgment kernel. Built on <a href="https://github.com/earendil-works/pi">pi</a>.</p>

<p align="center">
  <a href="https://github.com/qybaihe/mu/actions/workflows/ci.yml"><img src="https://github.com/qybaihe/mu/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/qybaihe/mu/actions/workflows/desktop.yml"><img src="https://github.com/qybaihe/mu/actions/workflows/desktop.yml/badge.svg" alt="Desktop app"></a>
  <a href="https://www.npmjs.com/package/mu-agent"><img src="https://img.shields.io/npm/v/mu-agent?label=mu-agent" alt="npm"></a>
</p>

<p align="center">
  <b>English</b> · <a href="docs/readme/README.zh-CN.md">简体中文</a> · <a href="docs/readme/README.zh-TW.md">繁體中文</a> · <a href="docs/readme/README.ja.md">日本語</a> · <a href="docs/readme/README.ko.md">한국어</a>
</p>

A coding agent makes hundreds of decisions per session that are not about the code: what stays in the context, whether a command is safe, whether a finding is worth telling another agent, when the work is done. Left to the big model, they cost tokens, latency and attention. Left to fixed rules, they are wrong too often. mu gives them to a **judge**: a small, fast model that answers one bounded question at a time, at 35 decision points in every turn. The big model keeps its attention for the work.

- **mu**: the command line. Everything pi does, plus the judgment kernel.
- **mu desktop**: a native app that carries mu and its runtime. Download, connect a model, start.
- **Jev**: the judge. Yes/no, choice and score questions, a probability per answer, every verdict in a ledger. A local judge (Laya) or any LLM can take a decision point instead.

> Early development. Its authors use it every day; nothing has been released yet. Names, settings and formats may still change.

## A turn

```
 you ──▶ input.preflight · task.frame · input.interjection
           │
           ▼
         model ──▶ tool call ──▶ tool.risk · tool.constraint · tool.approval ──▶ runs
           ▲                                                                     │
           │    tool.admission   chunk by chunk: into the context, or archived behind a pointer
           │    context.forget · context.compact   when the context grows        │
           └─────────────────────────────────────────────────────────────────────┘

 turn ends ──▶ turn.completion · turn.drift · turn.rewind · memory.applied · board.read · cache.warming
```

Every name is a decision point. Each one is asked as a short question about a small state; the answer changes what the model does next, never whether it asks you. Rules are the floor: a dangerous-looking command is caught by rules first, and the judge only vouches that you asked for it.

## Decision points

Each decision point is `active`, `shadow` (asked and logged, changes nothing: for comparing judges before switching one on) or `off`, and each can name its own judge: `jev`, `laya` (local), `llm:<provider>/<model>`, or a cascade such as `laya,jev`.

**Input**

| Decision point | Question | Effect |
| --- | --- | --- |
| `input.preflight` | What kind of message is this, and how much thinking does it need? | A one-line hint to the model; optionally the turn's thinking level |
| `task.frame` | A new task, a hard constraint, a correction, a subgoal, or no change? | Only a change rewrites the task frame: goal, your constraints word for word with their source, acceptance criteria |
| `input.interjection` | A message arrives while the agent works: interrupt now, or after this step? | The turn is cut, or the message waits |

**Context**

| Decision point | Question | Effect |
| --- | --- | --- |
| `skills.disclosure` | Which skills are relevant to this task? | Only those enter the prompt; the rest stay findable |
| `capability.disclosure` | Does this task need an installed pack or MCP server? | It is opened, and its process started, only then |
| `tool.admission` | Per chunk of a long tool output: does this matter now? | What matters enters the context; the rest is archived behind a pointer |
| `tool.admission.test-log` | In a test log, what is repetition? | Exact repeats are folded once, losslessly; optionally the judge selects from the rest |
| `context.forget` | Above a context threshold, which tool results are stale? | Each becomes a one-line tombstone in outgoing requests |
| `context.compact` | Keep or prune this passage? | Compaction by judgment; no summary is written |
| `memory.recall` | Which lessons apply to this task? | They are brought into the turn |
| `memory.capture` | Does this message correct the agent or set a rule? | It becomes a lesson |
| `memory.outcome` | After going in circles, did the way out deserve a lesson? | A lesson from the run, not from you |
| `memory.worth` | A lesson the model or a sub-agent proposes: useful again, a one-off, or known already? | Kept or dropped |
| `memory.merge` | The same as an existing lesson, more precise, or contradicting it? | No duplicates; the more precise one replaces the older |
| `memory.applied` | Were the recalled lessons followed this turn? | A lesson recalled often and never followed retires |
| `cache.warming` | Will you be back before the prompt cache expires? | The cache is refreshed, or left to expire |

**Tools and safety**

| Decision point | Question | Effect |
| --- | --- | --- |
| `tool.risk` | A command the rules flag: did you ask for it? | Unsure means asking you |
| `tool.approval` | In the *Jev approves* mode: does the task clearly need this command, this change outside the project, this outside action, this sub-agent? | Only what it is sure of runs; the rest asks you |
| `tool.constraint` | Before a call that changes something: does it cross a constraint you stated? | The call is stopped |
| `files.locate` | Which files match what you describe? | Candidates ranked, instead of a string of greps |
| `browser.step` | Observe, one judgment, act: what is the next operation, on which element? | The built-in browser moves one step |
| `review.triage` | For each finding of `/review`: does it change behaviour, and is it about this change? | Findings ranked P0 to P3 |
| `diagnostics.delivery` | New language-server diagnostics after an edit: tell now, at the next pause, or never? | Errors reach the model; style warnings do not |

**Turn**

| Decision point | Question | Effect |
| --- | --- | --- |
| `turn.drift` | Every few steps: does the work still serve the goal? | Rules catch circles; the judge catches drift |
| `turn.rewind` | The same failure again and again: is this approach a dead end? | Back to a checkpoint |
| `turn.completion` | The model says it is done: did anything verify that? | One nudge if not |
| `output.drift` | While the model writes: does the tail of its output cross your constraints? | Experimental; corrected mid-stream |
| `goal.met` | In goal mode, when the big model gives no answer: is the condition met? | The fallback for `/goal` |
| `board.read` | Where do things stand, in multiple choice? | Feeds the plain-language board |
| `notify.routing` | An event such as the context budget: tell the model now, later, or never? | The model is told at the right time |

**Teamwork**

| Decision point | Question | Effect |
| --- | --- | --- |
| `swarm.routing` | Which role, model tier and thinking level for this delegated task? | The sub-agent that fits |
| `swarm.patch` | Did the sub-agent's patch stay within its task? | Judged from the task, the paths and the line counts |
| `hive.publish` | Is a bee's finding worth the shared board? | Published, or kept to itself |
| `hive.deliver` | Does a note on the board matter to this bee's work? | Delivered only then |
| `hive.relate` | Does a new finding replace, contradict or support an earlier one? | Corrections and disputes reach the bees that hold the old note |

## Judges

- **Jev** (hosted). Bounded questions with probabilities. Reached through TypeSafe, OpenRouter, the Vercel AI Gateway or any service that speaks the same protocol, each with its own address and key (`TYPESAFE_API_KEY`, `MU_JUDGE_OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`): the desktop app's judges page picks one, and by default the first whose key is set is used. Measured from the authors' own sessions: one warm question in about 0.3 s over HTTP/2; 16 chunks of tool output judged in one request in 0.44 s, the state billed once. Verdicts, probabilities and timings go to the ledger: `mu ledger`, or the judgments tab of the desktop app.
- **Laya** (local). A 322M-parameter judge that runs on your machine and never touches the network. Nothing is downloaded without your consent. Reliable on simple predicates, weaker on meta-judgments: run it in shadow next to Jev and read the ledger before giving it a decision point.
- **Any LLM**, as a tier: `llm:<provider>/<model>`.

What this buys, in the authors' own sessions: the context never fills, because tool output enters chunk by chunk and stale results are dropped without a summary; in failing test logs, 51% of the bytes were exact repeats and are folded losslessly; the prompt cache stays warm because the kernel guesses when you will be back.

## The hive

Every multi-agent system answers the same question: should what one agent knows be told to another? The usual answers are none (report to the main agent only), everything (the whole history in a group chat or a hand-off), each agent's own big model, or fixed rules and the environment. mu's answer: the judge is the gate.

A hive is two to six bees, each with its own focus. Bees read code, run commands and browse; they never edit, the main model makes the change. Each time a bee finishes saying something, `hive.publish` asks once: is there a finding, a dead end, a decision or a blocker here worth sharing? What is worth it goes on a shared, append-only board. For each new note, `hive.deliver` asks once per other bee: does this touch its focus? If so, the note is delivered, marked *a finding, not an instruction*.

Because the board only grows, a later conclusion can overturn an earlier one: a bee reports that the tests will not run, then clears an environment variable and they do. `hive.relate` reads the relation between two notes: *supersedes*, *contradicts* or *supports*. A superseded conclusion becomes a correction, delivered to every bee that holds the old one. Two notes that contradict each other both stay, marked as a dispute; if nobody settles it within a minute, a verifying bee is sent.

<p align="center"><img src="docs/readme/swarm.png" width="960" alt="The desktop app's hive tab: what four bees are doing, the map of deliveries between them, and each delivery's words"></p>

The desktop app's hive tab is where this happens. One row per bee: role, model, what it is doing or has just said. The map draws who delivered a finding to whom: the more went along a line, the thicker it is; corrections and disputes have their own marks; a finding lights its line the moment it arrives. The flow lists every delivery's words; the judgments list every verdict. The hive card in the conversation carries the map in miniature and opens this tab.

A real run: three bees, nine minutes, 117 candidates judged, 27 on the board, 16 delivered to the bee that needed them. Every verdict is in the run's log.

`/swarm` shows what each bee is doing; `/swarm stop` asks for reports now; `/swarm kill` ends them. A bee out of time is asked for its report and ended if none comes; a stuck model or tool is handled by the watchdog. A hive always returns.

## The plain-language board

Frontier models get better at the work and worse at talking about it: each generation's progress reports read more like output for another machine, denser, more opaque, less like a person speaking. mu does not ask the working model to narrate itself. With the board on (`/board`, or the switch on the desktop app's board tab), every step the agent takes becomes one plain line on the board the moment it ends: a file changed, a check passed or failed, a command run, reading folded into one line that counts up. Every time the agent says something mid-run, `board.read` asks the judge whether it is news; when it is, a model chosen for one thing only, that it speaks plainly (`/board model`), retells it for a person and keeps the board's state current: what is happening now, how many items of the checklist are done, and what waits on you. A finished run is summed up as the account's last line, with the account kept above it, so you always see what was done, not only that it is done.

<p align="center"><img src="docs/readme/board.png" width="960" alt="The desktop app's plain-language board: how far the work is, what is happening now, what happened before; context use and cache hit rate at the top"></p>

The working model keeps its own language for the work; what appears on the board can always be read at a glance. The board follows the permission mode, the goal and the sub-agents, and when the agent changes course, so does the wording. The two numbers at the top are context use and cache hit rate, the direct result of the context and cache decisions above.

## The desktop app

A native app with mu and its runtime inside: no Node to install, nothing downloaded at the first start. Everything the command line has, plus a work panel beside the conversation:

**board** · **judgments** (the ledger live: every verdict with its question) · **hive** · **lessons** · **files** · **preview** · **source** · **browser** (the built-in browser the agent drives, one step at a time, with its goal, pause and stop)

The permission mode and the goal sit in the composer; `⌘K` opens the command palette. Model sign-in happens in the app: ChatGPT, Claude, Grok and Google (Gemini CLI / Antigravity) subscriptions, or an API key for any provider pi supports. Claude Code and Codex CLI conversations can be imported and continued.

Builds for macOS (Apple silicon / Intel), Windows (x64 / Arm) and Linux (x64 / Arm) are made by GitHub Actions and published under [Releases](https://github.com/qybaihe/mu/releases).

## Command line

```bash
npm i -g mu-agent
mu            # an interactive session in the current directory
mu doctor     # checks the installation, the judges and the connections
```

Node 22.19 or newer. `mu -p "prompt"` runs once and prints; `mu -c` continues the last session. `mu import --list` finds your Claude Code and Codex conversations, `mu import <file>` brings them in. `mu ledger [n]` prints what the judge decided in the last n sessions. The command line and the desktop app share accounts, settings and lessons.

| Command | What it does |
| --- | --- |
| `/status` | The judges, each decision point's mode, what was kept out of the context, the latest verdicts |
| `/mu judge <judges>` | Which judges answer, in which order: `laya`, `laya,jev`, `llm:<provider>/<model>` |
| `/mu route <point> <judge>` | One decision point on its own judge |
| `/mu mode <point> <off\|shadow\|active>` | Switch one decision point |
| `/frame` | The task frame: goal, your constraints with their source, acceptance criteria |
| `/goal <condition>` | Keep working until the condition holds; `/goal clear` ends it |
| `/permissions` | Full access / Jev approves / minimal |
| `/board` | The plain-language board on or off |
| `/remember`, `/lessons`, `/forget` | Keep a lesson, list them, retire one |
| `/review`, `/commit` | Review the change with findings ranked P0 to P3; write the commits |
| `/checkpoints`, `/rewind` | List the checkpoints; go back to one |
| `/agents`, `/swarm` | Send sub-agents; watch every one at work |
| `/browse`, `/jobs` | The built-in browser; background jobs |
| `/capabilities`, `/ledger` | Installed capabilities and which are open; the latest verdicts |
| `/import-chat` | Import a Claude Code or Codex conversation |
| `/doctor` | Check the setup and the connections |

pi's own commands (`/model`, `/thinking`, `/login`, `/resume`, `/tree`, `/fork`, `/compact`, `/export` and the rest) are unchanged. `MU_JUDGE=laya,jev mu` overrides the judges for one run.

## Privacy

Keys stay on this machine. mu never downloads a model or a runtime on its own; anything that needs a download asks first. The judge sees only the fields a question needs; every verdict is logged locally, and you can read them all.

## Development

```bash
npm install --ignore-scripts   # dependencies, without lifecycle scripts
npm run check                  # formatting, lint, types
./test.sh                      # tests (the ones that need a model are skipped without a key)
```

The desktop app is in `desktop/`: `bun install`, then `KYRN_ROOT="$(cd .. && pwd)" bun run start` runs the development build against the mu in this repository (run `npm install` at the root first). Layout and contribution rules: [AGENTS.md](AGENTS.md).

## Credits and license

mu is built on [pi](https://github.com/earendil-works/pi) (the coding agent, MIT; the root [LICENSE](LICENSE) covers `packages/` and `kyrn/`) and [AionUi](https://github.com/iOfficeAI/AionUi) (the desktop app, Apache 2.0; `desktop/` keeps its [LICENSE](desktop/LICENSE)). We are grateful to both. Third-party code in the judgment kernel is listed in [THIRD_PARTY_NOTICES.md](packages/kyrn-judge/THIRD_PARTY_NOTICES.md).

## Community

Support and discussion: [linux.do](https://linux.do).
