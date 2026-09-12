# U2A2A Orchestration

A local, zero-dependency app that puts you and several coding-agent CLIs — **Claude Code**, **Codex**,
and **Grok** — into one conversation, with a shared artifact pool, a task queue, and a decision tray.

> **The interface is in Japanese.** This README is the only English document; an English UI is not part
> of the first release. If you cannot read Japanese, the screen will be hard to use.

> **Repository:** `TODO — fill in the public URL before publishing.`

---

## What it does

- **Threads per topic.** Each topic is its own workspace, and each agent keeps a separate CLI session
  per topic, so contexts do not bleed into each other. You can branch a topic from any message.
- **Agent-to-agent relay.** Forward a message to another agent, or start a Q&A relay where each reply is
  delivered to every participant and exactly one agent is woken per turn.
- **Shared artifact pool.** A real folder (`u2a2a/pool/`) browsable from the UI. Agents read and write
  files there by path; reviews, fixes and version history hang off those files.
- **Task queue.** Turn any message into a task, copy its prompt into an agent app, paste the result back.
- **Decision tray.** Agents can put a multiple-choice question or a start-work proposal in front of you
  as buttons instead of prose. Approving a proposal registers the tasks it names.
- **Artifact verification.** A patch delivered as an `impl-*` folder **can** carry a `manifest.json`;
  when it does, the server records which mandatory checks were declared and which were actually
  confirmed. Ordinary files dropped into the pool have no manifest and are not verified.

## Requirements

- **Node.js 22 or newer.** The server uses `fs.globSync`, which landed in Node 22.
- **No npm dependencies.** The Node standard library only.
- At least one agent CLI on your `PATH`, already logged in:
  `claude` (`/login`), `codex` (`codex login`), `grok` (writes `~/.grok/auth.json`).
  The app works without any of them — you can paste replies by hand.
- `git` is needed for the tests and for repository/base-commit lookups. `ffmpeg` is optional (video).

## Start

```bash
node u2a2a/server.mjs
```

Open <http://127.0.0.1:4742>. Set `U2A2A_PORT` to use a different port.

```bash
cd u2a2a && npm test    # the test suite (no install step needed)
```

---

## Read this before you run it

### It is local-only, and only lightly defended

The server **listens on `127.0.0.1` only**. On top of that it checks the origin of every request:

- The `Host` header must be `127.0.0.1`, `localhost` or `[::1]` with the port the server started on.
  Anything else is rejected with `403` — this is the minimum defence against DNS rebinding.
- For anything other than `GET`/`HEAD`, the `Origin` header is checked **before the body is read**.
  A mismatched origin, or `Origin: null` (a `file://` page or a sandboxed iframe), gets `403`.
- A request with **no** `Origin` (curl, scripts, tests) passes as long as the `Host` is right.

Allowing `localhost` and `[::1]` is about **how the header is spelled**; the socket is still bound to
`127.0.0.1`. If `localhost` resolves to `::1` on your machine, the connection fails before it reaches
this check — open `http://127.0.0.1:<port>` instead.

**Do not expose this to a network you do not control.** There is no authentication, no TLS, and no
per-user separation. Anyone who can reach the port can read every conversation and start agent runs
that cost you money.

### Your data is stored in plain text

| Path | Contents |
|---|---|
| `u2a2a/data/state.json` | Every message, topic, task, CLI session id, token usage and cost |
| `u2a2a/data/tray.jsonl` | Decision-tray requests and their answers |
| `u2a2a/data/checks.jsonl` | The artifact-verification audit log |
| `u2a2a/pool/` | Artifacts, uploaded files, and an automatic Markdown mirror of every thread |

All of it is unencrypted JSON and Markdown on your disk. **Both directories are in `.gitignore`**
(`u2a2a/data/` and `u2a2a/pool/`), so a normal `git add -A` will not commit them — but nothing stops you
from adding them with `-f`, and nothing redacts what you paste into a conversation.

### Never commit credentials

- Agent CLIs keep their own credentials outside this repository (`~/.claude`, `~/.codex`, `~/.grok`).
  This app never reads or copies them.
- Image generation reads a Google Gemini key from the `GEMINI_API_KEY` environment variable, or from
  `u2a2a/data/gemini.key` (first line). That file sits in the gitignored data directory — **keep it
  there**, and do not paste keys into messages, artifacts or issues.

### What leaves your machine

- **At startup, if Grok is already logged in.** If `~/.grok/auth.json` exists, the server runs one short
  `grok` probe to find out whether the login still works. That request reaches xAI **before you turn
  anything on**, and it does not depend on any auto-reply setting. If you have never logged into Grok,
  nothing happens.
- **Agent CLIs, when their auto-reply is ON.** The app spawns that vendor's CLI and hands it the recent
  messages of the topic, the thread summary, file-change notes, and (for linked projects) the project's
  name, path, branch and README excerpt. The CLI sends that to its vendor — Anthropic, OpenAI and/or
  xAI, depending on which agents you enable.
- **Google Gemini, only when you generate an image.** `u2a2a/tools/nanobanana.py` sends the prompt to
  the Gemini API with the key described above. This is independent of the auto-reply switches.
- Nothing else phones home. There is no telemetry.

Agent runs cost money. The app has spend and runtime caps — set them with `PATCH /api/budgets`, read
them back from `GET /api/state` — and it stops all automatic activity when a cap is reached. The caps
are off until you set them.

### The first run is deliberately quiet

- **Every agent starts with auto-reply OFF** in a fresh environment, so your first message cannot start
  a paid CLI run by accident. Turn on the agents you want from the thread headers.
  An existing `u2a2a/data/state.json` keeps whatever you had set.
- While every agent is still OFF, a new thread is created with **Claude Code and Codex** as its
  participants. Once you enable auto-reply, new threads default to the agents that are both enabled and
  authenticated. (Only Grok's login is actually checked; Claude Code and Codex are treated as
  authenticated without verifying it.)
- The write permission handed to each agent CLI points at `u2a2a/pool/` only, and the repository is
  passed as read-only. **This is not a sandbox.** The agents are also allowed to run `python3`, so a
  shell command can still reach outside the pool — the server does not stop it.

---

## What has actually been verified

| | Verified | Not verified |
|---|---|---|
| Node | 22.x on macOS, by hand | **CI has never run.** `.github/workflows/test.yml` exists but no run has gone green yet — the Node and OS it proves will be written here once one does. Other major versions are untested; `engines` says `>=22` because that is the API floor, not because 23+ was tried |
| OS | Development and manual testing on macOS | Linux — only through the CI workflow, which has not run. Windows — not tried at all |
| Agent CLIs | Exercised by hand against the versions the authors happened to have | **No CLI version is pinned or verified.** The tests use fake CLIs on `PATH`, so a green CI says nothing about a real `claude` / `codex` / `grok` |
| Browsers | The UI is developed against current Chromium-based browsers | Firefox, Safari, older browsers |

If a combination is not in the "verified" column, treat it as unknown rather than broken — and please
report what you find.

---

## Layout

```
README.md                 this file
.github/workflows/        CI (Node 22, npm test)
u2a2a/
  server.mjs              the whole server
  lib.mjs                 pure helpers shared with the tests
  tray.mjs                decision tray (pure functions)
  verification.mjs        artifact verification (pure functions)
  public/                 the UI (plain ES modules, no build step)
  test/                   node:test suites
  tools/                  helper scripts (image generation, avatar assets)
  data/                   runtime state — gitignored
  pool/                   artifacts and thread mirrors — gitignored
```

`u2a2a/README.md` is the detailed Japanese documentation: every feature, the API surface, and the
specifications the agents agreed on.
