# Code mode for AnythingMCP: review notes

Written for the Codebound hackathon brief *"Sandbox for AI Agents in AnythingMCP"*
(KOCH Freiburg GmbH). This page says what was there, what was added, how it helps, and
where it is still limited. Every number below comes from a run on this branch; the ones
that are estimates say so.

**Reference docs:** [sandbox-code-mode.md](../sandbox-code-mode.md) (how to use and
configure it) · [demo and benchmark](../../scripts/sandbox-demo/README.md) ·
[end-to-end checks](../../scripts/sandbox-e2e/README.md)

---

## In one minute

- **The problem (from the brief):** about 1 in 8 tool calls returns more than 50 KB, the
  biggest 44 MB. All of it goes through the model, which is slow, expensive, and often
  does not fit at all.
- **What was built:** an agent can send a short JavaScript script instead. It runs in an
  isolated V8 sandbox *inside* AnythingMCP, next to the connectors. The script calls the
  same tools, filters and sums the data there, and **only the small answer goes back to
  the model**.
- **Does it work:** on a real running stack, a question over 150,000 orders was answered
  by **one call returning 354 bytes** instead of 77 calls and 7.3 MB; a 44 MB response
  was reduced to a **34-byte** answer. The answers equal an independently computed ground
  truth.
- **Is it safe:** 75 end-to-end checks pass (two customers, 18 escape attempts, limits,
  roles, secrets, audit), plus a 20-case isolation suite you can run from the dashboard.
  Scripts are **read-only by default**. One honest limit: the isolate is a V8 boundary
  inside the backend process, not an operating-system boundary (see
  [Security](#security-what-is-and-is-not-guaranteed)).
- **Can you see it:** yes, a new **Code mode** page in the dashboard
  ([screenshots](#screenshots)).

---

## What the brief asks, and where it is answered

> *"A working script can be created, edited, and executed within the sandbox, with no
> access to other customers' data, the internet, or the host."*

| Requirement | How it is met | Evidence |
|---|---|---|
| **Create** a script | `sandbox_create_script` (MCP), `POST /api/sandbox/servers/:id/scripts`, or the *New script* button. The code is syntax-checked on save. | [03](#3-write-save-run) · e2e group `scripts` |
| **Edit** a script | `sandbox_edit_script`, `PATCH /api/sandbox/scripts/:id`, *Edit* in the page. Only the author can edit; the version goes up. | e2e `scripts` · unit tests |
| **Execute** a script | `sandbox_run_script` (MCP), `POST .../run`, *Run* in the page. Runs in a fresh isolate with limits on time, memory, calls and bytes. | [02](#2-run-it-the-data-flow-line) · e2e `core`, `limits`, `deadlines` |
| **No other customers' data** | Tenant and user come from the authenticated session on the host; a script cannot choose them. Every query filters by `organizationId`. Two customers with *same-named tools* are kept apart. | e2e group `tenant` (10 checks) |
| **No internet** | The isolate has no `fetch`, sockets, timers or modules. The only way out is `tools.<name>`, which goes through the gateway's normal connector path. | isolation suite · e2e `isolation` |
| **No host access** | No `require`, `process`, file system or environment inside the isolate; credentials never enter it. 18 attempts to escape (constructor chains, prototype tricks, `import()`, `WebAssembly`, …) all fail. | [05](#5-the-isolation-suite) · e2e `isolation`, `secrets` |

---

## What existed, what was added

**Starting point.** AnythingMCP is an open-source gateway that turns APIs and databases
into MCP tools. Commit `0e24d7f` (yours) had already added the core of code mode: the
`isolated-vm` runtime, the four MCP tools, saved scripts with their tables and
migration, limits, errors, and about 1,700 lines of tests.

**Added on top, in five commits** (about 7,700 lines changed, 60 files):

| Commit | What it added |
|---|---|
| `d74f237` | Documentation of the feature and its `SANDBOX_*` settings. |
| `f94fce4` | The **REST API** under `/api/sandbox` that the dashboard uses; the **live isolation suite** (20 cases); one shared rule for "which tools can this caller see" so MCP and REST cannot disagree. |
| `721da23` | **Security hardening** (see below). |
| `9927761` | An opt-in **`maxRows`** setting for database connectors, a **150,000-order demo** with ground truth, a **benchmark**, and the **75-check end-to-end suite**. |
| `79e4465` | The **dashboard page** and its Playwright test. |

### The hardening, in plain words

These came from a security review of the first version. Each has tests.

1. **Read-only by default.** A script can only call tools that cannot change data
   (GET/HEAD, GraphQL queries, read-only database connectors, provable `SELECT`).
   Writes fail with `WRITE_NOT_ALLOWED` before the connector is touched. An operator can
   switch writes on with `SANDBOX_ALLOW_WRITES=true`; no agent or script can.
2. **Arguments are validated on the host** against each tool's input schema, like a
   direct call, so a script cannot send a shape the tool never accepted.
3. **Access is re-checked for every run**, so a role change applies to the next script,
   not the next session.
4. **A deadline for every connector call** (and for the whole run), so a slow upstream
   cannot hold the isolate; **cancellation** if the client disconnects.
5. **A size cap on each connector response** *before* it is copied into the sandbox.
6. **Audit link:** every connector call a script makes is logged as a normal tool call
   and carries the **run ID**, so you can go from a run to its calls and back.
7. **Per-user run history:** a run keeps a preview of what the connectors returned, so
   non-admins see only their own runs.

---

## How it works

```
 AI agent ──MCP──▶ AnythingMCP gateway
                      │  sandbox_run_script(code)
                      ▼
              ┌─────────────────────┐     tools.erp_orders_list({...})
              │  V8 isolate         │ ───────────────────────────────┐
              │  your script        │                                │ host checks: caller's tools,
              │  no fs / net / env  │ ◀──────── rows (copied in) ────┘ read-only, args, size, time
              └─────────────────────┘
                      │  small JSON answer
                      ▼
                 back to the model       (the rows never left the gateway)
```

The script is the body of an async function with `tools.<name>(args)`, `args`, a few
`util` helpers and `console.log`. Example (the demo's first question):

```js
const res = await tools.erp_orders_export({ from, to });
const late = res.rows.filter((o) => o.delivered_at && o.delivered_at > o.promised_at);
return { delayedOrders: late.length, revenue: util.sum(late, (o) => o.total) };
```

---

## How it improves things: measured

Demo: an ERP database with **150,000 orders and 450,000 order lines** (29 MB), exposed
through a read-only database connector, as it would be in AnythingMCP. Three questions,
each answered three ways against the running gateway (median of 3 runs;
[`last-benchmark.json`](../../scripts/sandbox-demo/last-benchmark.json)):

| | Conventional (every row via the model) | Raw SQL by the agent | **Code mode** |
|---|---|---|---|
| **Q1** delayed orders last month + revenue | 1 call, 192 KB, ~49,000 tokens | 1 call, 104 B | **1 call, 354 B, ~89 tokens** |
| **Q2** revenue by category, last quarter | **77 calls, 7.3 MB, ~1.9 M tokens** (does not fit a 200k window) | 1 call, 605 B | **1 call, 535 B, ~134 tokens** |
| **Q3** top 10 customers by delay days | 10 calls, 2.1 MB, ~549,000 tokens (does not fit) | 1 call, 1.2 KB | **1 call, 1.1 KB, ~287 tokens** |
| Bytes to the model vs conventional | | | **−99.82% / −99.99% / −99.95%** |

The 44 MB case from the brief (dashboard *Benchmark* tab, [screenshot 07](#7-the-44-mb-case)):
the raw call puts **57 MB (~15 million estimated tokens)** in front of the model; the
script returns **34 bytes** after pulling 45 MB inside the gateway: **about 1.8 million
times smaller**.

**How to read this honestly**

- *Measured:* number of calls, bytes of MCP response text that reach the model, wall
  time, and whether each answer equals the ground truth (all do).
- *Estimated:* tokens, as bytes ÷ 4. No tokenizer and no language model was run, so how
  well a model reads the conventional pages is **not** measured.
- Against an agent that can aggregate in SQL, code mode's answers are equally small, and
  it is **slower** (84 to 546 ms against 38 to 101 ms) because rows cross the bridge.
  Its niche is data sources that cannot aggregate (REST, SOAP, OData) and logic that
  spans several connectors, which is most of what AnythingMCP connects.
- There was **no live LLM run** in these tests. Calls were made by scripts that stand in
  for the agent. The MCP surface itself is covered by the integration tests, which use
  the official MCP client against the real server.

---

## Screenshots

Taken from the real dashboard against the real stack by
[`scripts/sandbox-demo/screenshots.mjs`](../../scripts/sandbox-demo/screenshots.mjs).
The script fails on any browser console error, and none occurred.

### 1. Saved scripts
A saved script is readable; the badge says whose it is.

![Scripts tab](screenshots/01-scripts.png)

### 2. Run it: the data-flow line
The line that matters: *pulled 1.17 MB from the connectors, returned 79 B to the model.*
Answer: 922 delayed orders, which equals the ground truth.

![A script run](screenshots/02-script-run.png)

### 3. Write, save, run
A new script written in the page, saved, run, then deleted (one run shown).

![New script](screenshots/03-new-script.png)

### 4. Run history
Every run is recorded with code, arguments, result preview and connector calls.

![Runs tab](screenshots/04-runs.png)

### 5. The isolation suite
The "judges' screen": 20 attempts to leave, exhaust or bypass the sandbox, each passing
only if it is stopped **for the right reason**.

![Isolation tests](screenshots/05-isolation.png)

### 6. Benchmark
One raw tool call against a script that answers the same question.

![Benchmark](screenshots/06-benchmark.png)

### 7. The 44 MB case

![Benchmark at 44 MB](screenshots/07-benchmark-44mb.png)

### 8. A viewer is read-only
Viewers can read scripts but cannot run or change them.

![Viewer](screenshots/08-viewer-read-only.png)

### 9. On a phone

![Phone](screenshots/09-phone-isolation.png)

---

## Security: what is and is not guaranteed

| Concern | Stopped by | Layer |
|---|---|---|
| Reading host files, environment, secrets | No `require`/`process`/fs/env in the isolate; credentials never enter it | V8 isolate |
| Internet or internal network | No `fetch`/sockets/timers; only `tools.*` leaves | V8 isolate |
| Another customer's data | Tenant/user fixed on the host from the session; `organizationId` on every query | Application |
| A tool the caller may not call | Caller's own role-filtered list, re-read every run, re-checked every call | Application |
| Changing data | Read-only policy checked on every call | Application |
| Loops, memory, floods | Wall clock, heap cap, call/byte caps, per-call timeout, per-org concurrency, output cap | Isolate + application |
| **A bug in V8/`isolated-vm` that escapes the isolate** | **Not prevented by this feature** | OS / infrastructure |

The last row is the main limit. The isolate shares the backend's process and user. For
hostile script authors, run the backend in a locked-down container or VM (non-root,
read-only file system, only the network and database access it needs) and keep Node and
`isolated-vm` current. `SANDBOX_ENABLED=false` removes the feature.

Also known: the existing audit logger redacts credentials that come from environment
variables but **not** a token written literally into a connector's configuration. That
predates this work and applies to every tool call; it is noted in the docs.

---

## How it was checked

All on this branch; commands run from the repository root unless stated.

| Check | Result |
|---|---|
| Backend unit + integration tests (`npx jest` in `packages/backend`) | **20,026 passed, 0 failed** (1,449 live-only tests skipped) |
| Backend `tsc --noEmit` and `eslint` (no `--fix`) | no errors; the 14 lint warnings are in older files ([details](#final-results)) |
| Sandbox-related suites on **Node 22** (this machine, `isolated-vm` built from source) | 10 suites, **276 / 276** |
| The same on **Node 24.22 and 26.12** (glibc) with `isolated-vm`'s shipped prebuilds | **276 / 276** each |
| The same on **Alpine 3.22 / musl, Node 24.22 and 26.12** (a chroot, official musl Node builds) | **253 / 253** each ¹ |
| Real-stack end-to-end ([`scripts/sandbox-e2e`](../../scripts/sandbox-e2e)): real JWT guard, roles, Postgres, local mock upstreams | **75 / 75** |
| Isolation suite, live, from the dashboard | **20 / 20** |
| Frontend `tsc`, `eslint` and the whole Playwright suite (`next dev`, mocked API) | `tsc` clean; no `eslint` warnings in the new files (26 existing ones elsewhere); Playwright **192 / 192**, 4 of them new (`tests/e2e/sandbox.spec.ts`) |
| Screenshot run against the real stack | 9 pictures, no console errors |

¹ 253 rather than 276: the one spec left out tests the SQLite driver (`better-sqlite3`),
whose binary in this workspace is built for glibc. It passes on glibc Node 24 and 26.

### Runtimes tested

- `isolated-vm` 7 declares **Node ≥ 24**. This workspace runs Node 22 (the repository's
  own minimum is 22.12); the suites pass there too, with a locally compiled binary.
- The package ships prebuilt binaries for Node 24 (ABI 137) and 26 (ABI 147), for glibc
  **and musl**, x86-64 and arm64. The project's `Dockerfile` uses `node:26-alpine`, which
  is the musl/ABI-147 combination tested above.
- **Not tested:** arm64 (no machine for it), and the actual `docker build` (no Docker
  daemon in this environment; the Alpine chroot stands in for the musl part). The musl
  check ran the sandbox suites, not the entire application.

The 75 end-to-end checks, by group: `core` 3, `scripts` 2, `read-only` 5, `isolation` 18,
`limits` 13, `deadlines` 4, `tenant` 10, `roles` 7, `secrets` 4, `audit` 4, `big` 5.

### Final results

Run on this branch with Node 22.22, in `packages/backend`:

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0, no errors |
| `npx eslint "{src,apps,libs,test}/**/*.ts"` (no `--fix`, as in CI) | 0 errors, 14 warnings, **none in files this work added or changed** (they are in `sso.service.spec.ts`, `users.controller.ts`, `app.module.ts` line 1 and similar, all older) |
| `npx jest` (whole backend) | **668 suites passed, 4 skipped; 20,026 tests passed, 1,449 skipped, 0 failed.** The skipped tests are the live-service specs that need `RUN_<NAME>_LIVE=1` and real credentials |

Nothing failed, and no failure was left out. The skipped live specs were not run.

---

## Differences from the plan, and decisions taken

The implementation plan (`CODEBOUND_SPEC.md`) and a later security review were followed
where possible. Where this branch differs:

| Plan said | What was done | Why |
|---|---|---|
| Audit rows with `toolId: 'sandbox_run_script'` | Runs are in `sandbox_runs`; their **ID is stored on each connector call's audit row** (`clientInfo.sandboxRunId`) | `toolId` is a required foreign key to a real tool; `sandbox_run_script` is not a row in that table |
| Run history for the organization | **Per user** (admins see all) | A run keeps a preview of connector results; one user must not read another's, whose tool access may differ |
| Demo seed as a Prisma script (`prisma/seed-sandbox-demo.ts`) | A REST-driven script (`scripts/sandbox-demo/seed.mjs`) | The running gateway registers tools live, and it works on any instance |
| Docs file name | `docs/sandbox-code-mode.md` | Matches the existing docs |
| Benchmark may call any tool | The raw call is **read-only tools only** | A benchmark must not change data |
| A big "−99.8% bytes" number on the benchmark | Shown as a **factor** ("1.8 million× smaller") once the gap passes 10×; the percentages stay beside it | Past 99.9% a percentage reads "−100%" and says nothing |
| Benchmark card compares the answer with the ground truth | Only the command-line benchmark (`benchmark.mjs`) does; the dashboard card shows both paths' numbers and the script's answer | The dashboard works on any tool and question, and has no ground truth for an arbitrary one |

Decisions taken with your guidance: **first make it work correctly; scale is out of
scope and documented as limits** · **read-only by default**, with write policy left as an
operator setting until you see how AnythingMCP wants to organise it.

---

## Limits: what to know before scaling

Documented in [Known limits](../sandbox-code-mode.md#known-limits). In short:

- Isolates run **inside the backend process**, sharing its CPU and memory; there is no
  worker pool and no separate service.
- Concurrency is capped **per organization** (default 4). There is **no instance-wide
  cap**.
- A large response costs **several times its size** in host memory while it runs (the
  44 MB test raised the backend's resident memory by about 190 MB).
- Each backend instance enforces its own limits; there is no distribution of runs.
- Only SQLite streams database results; the other drivers load the whole result before
  `maxRows` cuts it, so bound the query too.
- Runs are not pruned and keep result previews.
- Tokens are estimated (bytes ÷ 4).
- Not done: a global concurrency cap, run pruning, shared-toolset registration, and a
  `sandbox_describe_tools` tool. They were optional in the plan and do not affect the
  brief's metric.

---

## Try it yourself

```bash
./setup.sh                                  # Local development; see AGENTS.md
# start the backend on :4000 and the frontend on :3000 (npm run dev)
node scripts/sandbox-demo/generate-db.mjs   # the 150,000-order database + ground truth
AMCP_EMAIL=you@example.com AMCP_PASSWORD='...' \
  node scripts/sandbox-demo/seed.mjs        # connector, 5 tools, server "koch-demo", 3 saved scripts
node scripts/sandbox-demo/benchmark.mjs     # the three questions, three ways
```

Then open **Code mode** in the sidebar (Build), choose `koch-demo`, and open *Scripts*,
*Isolation tests* or *Benchmark*. To connect a real agent, use
`http://localhost:4000/mcp/<serverId>` with the API key printed by the seed; it will see
`sandbox_run_script` and its three companions next to the data tools.

To redo the pictures: `node scripts/sandbox-demo/screenshots.mjs` (needs the same
admin login; see the header of that file). To redo the end-to-end checks, follow
[`scripts/sandbox-e2e/README.md`](../../scripts/sandbox-e2e/README.md), on a throwaway
database.

---

## Where things are

| Area | Location |
|---|---|
| Runtime, bridge, limits, errors | `packages/backend/src/sandbox/` |
| REST API | `sandbox-api.controller.ts` (+ `.module.ts`) |
| Isolation suite | `sandbox/isolation-suite.ts` |
| One rule for "tools this caller sees", read-only classification | `packages/backend/src/mcp-server/visible-tools.ts` |
| `maxRows` | `packages/backend/src/connectors/engines/database.engine.ts` |
| Dashboard page | `packages/frontend/src/app/sandbox/` |
| Demo, benchmark, screenshots | `scripts/sandbox-demo/` |
| End-to-end checks | `scripts/sandbox-e2e/` |
| User documentation | `docs/sandbox-code-mode.md` |
