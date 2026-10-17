# Sandbox code mode

Code mode lets an AI agent run a short JavaScript snippet **inside AnythingMCP,
next to the data**, instead of pulling every row through the model. The script
calls the MCP server's own tools, filters and aggregates the result in place, and
only the small answer goes back to the model.

Use it when a tool would return a long list and the agent only needs a count, a
sum, a filtered subset, a join or a summary.

Code mode is served only on per-server endpoints (`/mcp/<serverId>`) that the
caller has authenticated to. The shared `/mcp` endpoint and the public
`/mcp/demo` server never offer it.

- [Tools](#tools)
- [What a script can use](#what-a-script-can-use)
- [Who a script runs as](#who-a-script-runs-as)
- [Read-only by default](#read-only-by-default)
- [Saved scripts](#saved-scripts)
- [Dashboard and REST API](#dashboard-and-rest-api)
- [Limits and configuration](#limits-and-configuration)
- [Errors](#errors)
- [What is stored](#what-is-stored)
- [Database connectors](#database-connectors)
- [Security model](#security-model)
- [Known limits](#known-limits)
- [Cloud and self-hosted](#cloud-and-self-hosted)

## Tools

Four tools are added to the server's tool list, after the connector tools. A
connector tool that already uses one of these names keeps its name and the code
mode tool of that name is not registered.

| Tool | Does |
|------|------|
| `sandbox_run_script` | Runs `code`, or a saved script given as `scriptName`. Optional `args` (exposed to the script as `args`) and `timeoutMs` (1000 to 30000). Provide exactly one of `code` and `scriptName`. |
| `sandbox_create_script` | Saves a named script for this MCP server. The code is syntax-checked, not executed. |
| `sandbox_edit_script` | Changes a saved script's code and/or description. Only the script's author can do this. The version goes up when the code changes. |
| `sandbox_list_scripts` | Lists the saved scripts with version, owner flag (`ownedByYou`) and last run. |

The description of `sandbox_run_script` includes a signature list of the tools
the script may call, so the agent knows the names and parameters without a
second round trip.

## What a script can use

The script is the body of an async function: top-level `await` and `return` work,
and the returned value must be JSON.

`shop_list_orders` below stands for any tool of your server.

```js
const rows = await tools.shop_list_orders({ status: 'delayed', limit: 500 });
const byCarrier = util.groupBy(rows, (r) => r.carrier);
return Object.fromEntries(
  Object.entries(byCarrier).map(([carrier, list]) => [carrier, list.length]),
);
```

| Name | Meaning |
|------|---------|
| `tools.<name>(args)` | Calls one of the MCP server's tools and resolves to its result. `args` must be an object. |
| `tools.list()` | The names of the tools this script may call. |
| `tools.describe(name)` | The description, parameters and output schema of one tool. |
| `args` | The `args` object passed to `sandbox_run_script`. |
| `util.daysAgo(n)`, `util.startOfMonth(date?)`, `util.endOfMonth(date?)` | `YYYY-MM-DD` strings, in UTC. |
| `util.groupBy(rows, keyFn)`, `util.sum(rows, fn?)` | Small helpers for the common aggregations. |
| `console.log`, `info`, `warn`, `error`, `debug` | Collected into `meta.logs` of the result. |

Everything else is absent. The script runs in a bare V8 isolate with no
filesystem, network, `process`, `require`, timers, `Buffer` or WebAssembly, and
it never sees connector credentials: the only way out is `tools.<name>`.

The isolate runs inside the backend process, separated from it at the V8 level
(heap, globals, no shared objects). It is not a separate operating system process
or a container.

## Who a script runs as

A script calls tools with the **caller's own session**:

- The tenant (organization) and user come from the authenticated MCP session. A
  script cannot choose or change them.
- `tools.*` contains only the tools that survived the server's role filter for
  this caller, the same tools they would see in the normal tool list. A tool the
  caller cannot call directly cannot be called from a script either.
- Each call is scoped to the connector that owns the tool, so two connectors with
  a tool of the same name do not collide.
- The role allow-list is read again at the start of every run, so a role change
  takes effect on the next script, not on the next session.
- Arguments are checked against the tool's own input schema on the host before
  the connector is called, the same as for a direct call. Unknown fields are
  dropped.
- Every connector call is audited as a normal tool invocation, and carries the
  ID of the run that made it (see [What is stored](#what-is-stored)).

## Read-only by default

A script can call **read-only tools only**. This is a policy of the instance, not
something an agent or a script can ask for:

- A tool is read-only when its annotations say so: `GET` and `HEAD` on REST
  connectors, GraphQL queries, OData reads, and database tools whose connector has
  `readOnly: true` or whose SQL is provably a single `SELECT`. Anything else
  (a `POST`, a mutation, a database connector without `readOnly`, an unknown
  kind of connector) counts as a write.
- Write tools are left out of `tools.list()`, and the sandbox's description of the
  available tools does not show them. A script that calls one anyway, or asks
  `tools.describe` about it, gets `WRITE_NOT_ALLOWED`, raised before the connector is
  reached. A script can catch it and carry on reading.
- If a tool has an explicit `readOnlyHint` set by an administrator, that value
  wins over the derived one. Setting it to `true` on a tool that changes data
  lets scripts call it: treat it as a statement of trust.
- The agent can still call a write tool **directly**, outside a script, exactly as
  without code mode; role filters and the client's own confirmations apply.
- An operator can allow writes for the whole instance with
  `SANDBOX_ALLOW_WRITES=true`. It is read on the host at startup. It is not a tool
  argument, a REST field or a script input, so nothing an agent sends can turn it
  on. When it is on, `sandbox_run_script` is announced with `readOnlyHint: false`;
  when it is off, with `readOnlyHint: true` (and `openWorldHint: true` in both
  cases, because the tools it calls reach outside).

## Saved scripts

A saved script belongs to one MCP server. Names are lowercase, start with a
letter and are 2 to 64 characters of `a-z`, `0-9`, `_` or `-`; a name is unique
per server.

A saved script runs with the authority of **whoever runs it**, not of whoever
wrote it. To keep a user with fewer permissions from planting code that a more
privileged user's agent then runs, only a script's author can edit it. Anyone
else saves their own copy under a new name. When a saved script runs, the result
includes `script: { name, version, ownedByYou }` so the caller can see whose code
ran.

## Dashboard and REST API

The dashboard has a **Code mode** page (under *Build*) with four tabs: *Scripts*
(read, write, save, run and delete), *Runs* (history), *Isolation tests* (the live
negative-test suite) and *Benchmark* (one raw tool call against a script that
answers the same question). Viewers can read scripts and the history but not run
or change anything.

The same operations are available over REST with the dashboard's JWT. All routes
are under `/api/sandbox`, scoped to the caller's active organization; a server of
another organization answers `404`, never `403`.

| Route | Does |
|-------|------|
| `POST /servers/:serverId/run` | Run `code` or a saved `scriptId` (exactly one), with optional `args` and `timeoutMs`. A failing script still answers `200` with `ok: false`; `429` means the organization is at `SANDBOX_MAX_CONCURRENT`. Needs ADMIN or EDITOR. |
| `GET /servers/:serverId/scripts` | Saved scripts (without code unless `includeCode=1`). Any role. |
| `POST /servers/:serverId/scripts` | Save a script. The code is syntax-checked, not run. Needs ADMIN or EDITOR. |
| `GET /scripts/:scriptId` | One script, with its code. |
| `PATCH /scripts/:scriptId` | Change code and/or description. Author only. Needs ADMIN or EDITOR. |
| `DELETE /scripts/:scriptId` | Delete. Its author or an ADMIN. Answers `204`. |
| `GET /servers/:serverId/runs?limit=` | Recent runs. An ADMIN sees all of them; anyone else sees their own, because a run keeps a preview of what the connectors returned. |
| `POST /servers/:serverId/isolation-tests` | Runs the fixed negative-test suite against the live sandbox with synthetic tools. Touches no connector. Needs ADMIN or EDITOR. |
| `POST /servers/:serverId/benchmark` | Calls one read-only tool once, as a model would see it, and runs a script that answers the same question. Returns bytes, estimated tokens (bytes ÷ 4) and latency of both. Needs ADMIN or EDITOR. |

Closing the connection while a run is in flight cancels it: the isolate is
disposed and the run ends as `CANCELLED`.

## Limits and configuration

Each run is bounded. The environment variables set the defaults for the whole
instance and are read at startup, so changing one needs a restart. They are all
optional. For the numeric ones, an unset, empty, non-numeric or non-positive
value falls back to the default. `SANDBOX_ENABLED` turns code mode off only when
it is exactly `false`.

| Variable | Default | Limits |
|----------|---------|--------|
| `SANDBOX_ENABLED` | `true` | Set to `false` to stop offering the four tools. |
| `SANDBOX_MEMORY_MB` | `128` | V8 heap of one run. |
| `SANDBOX_TIMEOUT_MS` | `10000` | Wall clock for the whole run, including time spent waiting on connectors. |
| `SANDBOX_MAX_OUTPUT_BYTES` | `32768` | Size of the JSON the script returns. |
| `SANDBOX_MAX_CONNECTOR_CALLS` | `50` | `tools.*` calls in one run. |
| `SANDBOX_MAX_CONNECTOR_BYTES` | `67108864` | Total size of the connector results pulled into one run. |
| `SANDBOX_MAX_CONCURRENT` | `4` | Runs in flight at once per organization; more fail with `BUSY`. |
| `SANDBOX_CONNECTOR_TIMEOUT_MS` | `15000` | One connector call. It is also bounded by what is left of the run. |
| `SANDBOX_MAX_CONNECTOR_RESPONSE_BYTES` | `67108864` | One connector response, checked before it is copied into the isolate. |
| `SANDBOX_ALLOW_WRITES` | unset | Exactly `true` lets scripts call write tools. See [Read-only by default](#read-only-by-default). |

Fixed limits: 64 KiB of code, 100 log lines of at most 500 characters each.

`SANDBOX_TIMEOUT_MS` is the **default**, not a ceiling: a caller can pass
`timeoutMs` between 1000 and 30000 to `sandbox_run_script` for a single run.

## Errors

A failed run returns `ok: false` with `error: { code, message, hint, line, column }`
and the usual `meta`. `hint` says what to try next. `line` and `column` refer to
the agent's own code, not to any wrapper.

| Code | Meaning |
|------|---------|
| `SYNTAX_ERROR` | The code does not parse. |
| `RUNTIME_ERROR` | The script threw, returned something that is not JSON, or finished without a result. |
| `TIMEOUT` | The run exceeded its wall clock. |
| `MEMORY_LIMIT` | The run exceeded the heap limit. |
| `OUTPUT_TOO_LARGE` | The returned JSON is larger than `SANDBOX_MAX_OUTPUT_BYTES`. |
| `CODE_TOO_LARGE` | The code is larger than 64 KiB. |
| `TOOL_NOT_ALLOWED` | `tools.<name>` is not in the caller's tool list. |
| `TOOL_ERROR` | A tool call failed, or its arguments were not an object or did not fit the tool's input schema. |
| `WRITE_NOT_ALLOWED` | The tool changes data and writes are not allowed. |
| `CONNECTOR_TIMEOUT` | One connector call took longer than `SANDBOX_CONNECTOR_TIMEOUT_MS`. |
| `CANCELLED` | The caller went away before the script finished. |
| `CONNECTOR_CALL_LIMIT` | More than `SANDBOX_MAX_CONNECTOR_CALLS` calls. |
| `CONNECTOR_BYTES_LIMIT` | More than `SANDBOX_MAX_CONNECTOR_BYTES` of connector data. |
| `BUSY` | `SANDBOX_MAX_CONCURRENT` runs are already in flight for the organization. |

## What is stored

Every run is recorded in the `sandbox_runs` table, whether it came from a saved
script or inline code: the code (a snapshot, so the run stays explainable after
the script changes), the arguments and the result, each bounded to a preview (8
KiB and 16 KiB), the error if any, and the run's `meta` (duration, call counts,
bytes, tool names, log lines). The result preview can therefore contain data
that came from a connector.

Every connector call a script makes is also recorded as a normal tool invocation in
the audit log, and its `clientInfo` carries `sandboxRunId`: the ID of the
`sandbox_runs` row of that run. Starting from a run you can find every call it made,
and starting from an audit row you can find the script that made it. Credentials
that come from environment variables are redacted from the stored previews, as for
any tool call; a token written literally into a connector's configuration is not
(the same limitation as in the existing audit log).

Runs are not pruned automatically; they are removed together with their MCP
server or organization. A failure to store a run is logged and never turns a
finished run into an error for the caller.

Saved scripts are stored in `sandbox_scripts`. Every query on both tables is
filtered by `organizationId`, and both tables are in the optional row-level
security script, which is off by default (see
[Row-level security](operations/row-level-security.md)).

## Database connectors

Code mode is most useful on a database connector, because a query can return a
very large table.

- Give the connector `"readOnly": true` in its configuration. With it, every tool
  of the connector counts as a read and the engine refuses anything but a read.
  Without it, only a tool whose SQL is provably a single `SELECT` counts as a read;
  the others cannot be called from a script.
- A SQL tool returns at most **1000 rows** by default and reports
  `truncated: true` with the real `totalRows`. A connector can raise that with
  `"maxRows": N` in its configuration (up to 250,000; any other value falls back
  to 1000). SQLite streams the result, so memory follows the cap; the other drivers
  hand the full result to the backend before it is cut, so also bound the query
  (a date range, a `LIMIT`) on a very large table. For code mode, raise the cap far
  enough that one call can return the range the script needs, and make the script
  fail loudly on `truncated` rather than aggregate a partial list.
- A placeholder (`${name}` or `$name`) in a tool's SQL is filled from the call's
  arguments. An optional parameter that is left out and has no default stays in the
  SQL as literal text, so give each optional filter a JSON Schema `default` that
  matches everything (for example `"default": "0000-01-01"` for a lower date bound).

## Security model

What stops what, and which layer does it. Code mode adds an isolate and a policy
in front of the connectors; it does not add a new operating-system boundary.

| Concern | Enforced by | Layer |
|---------|-------------|-------|
| A script reads the host's files, environment or secrets | The isolate has no `require`, `process`, filesystem or global with secrets | V8 isolate |
| A script reaches the internet or the internal network | The isolate has no `fetch`, sockets or timers; the only way out is `tools.<name>` | V8 isolate |
| A script reads another customer's data | Tenant and user come from the authenticated session and are fixed on the host; every query filters by `organizationId`; a script cannot name another connector | Application |
| A script calls a tool its caller may not | The tool list is the caller's own, filtered by role and read again for each run; each call is re-checked | Application |
| A script changes data | Read-only policy checked on every call before the connector is reached | Application |
| A script loops, allocates or floods | Wall clock for the whole run, heap cap, call and byte caps, per-call timeout, per-organization concurrency cap, output cap | V8 isolate and application |
| Large results exhaust the host | Responses are size-checked before they are copied in; the total is capped | Application |
| A bug in V8 or in `isolated-vm` lets a script out of the isolate | **Not prevented by this feature.** The isolate shares the backend's process, user and network | Operating system / infrastructure |

The last row is the honest limit of the design: an escape from V8 would run with
the backend's own permissions. If your threat model includes hostile script
authors and a V8 zero-day, run the backend in a container or VM with a read-only
filesystem, a non-root user, no route to anything it should not reach, and its
own database credentials limited to what it needs, and keep Node and
`isolated-vm` up to date. `SANDBOX_ENABLED=false` removes the feature entirely.

The *Isolation tests* tab (and the `isolation-tests` endpoint) runs a fixed set of
attempts to escape, exhaust or bypass the sandbox and shows which layer stopped
each one. They use synthetic tools and touch no customer data.

## Known limits

Code mode is built to work correctly first; these are the limits to know before
scaling it.

- **In-process.** The isolates run inside the backend process, sharing its CPU and
  memory with everything else. There is no worker pool and no separate service.
  Running many heavy scripts at once slows the whole instance.
- **Concurrency is per organization.** `SANDBOX_MAX_CONCURRENT` caps one
  organization. There is no instance-wide cap, so many organizations running at
  once are bounded only by the host.
- **Memory is not only the heap.** A connector result is held in the backend,
  copied into the isolate and sometimes serialised again, so a very large payload
  can take several times its size in host memory for the duration of a run (the 44 MB test raised the backend's resident memory by about 190 MB).
  Tune `SANDBOX_MAX_CONNECTOR_BYTES` and `SANDBOX_MEMORY_MB` to the machine.
- **One process, one machine.** There is no distribution of runs across
  backends; each instance enforces its own limits.
- **Runs are not pruned** and keep result previews, which can contain connector
  data (see [What is stored](#what-is-stored)).
- **Tokens are estimated** in the benchmark as bytes ÷ 4; no tokenizer is used.
- **Runtime support.** `isolated-vm` 7 needs Node 24 or newer and ships prebuilt
  binaries for Node 24 and 26 on glibc and musl (Alpine) for x86-64 and arm64.
  The sandbox test suites pass on Node 24 and 26 on glibc and on Alpine; see
  [docs/sandbox/README.md](sandbox/README.md#runtimes-tested).

## Cloud and self-hosted

Code mode behaves the same in both deployment modes: the same tools, the same
limits, the same storage. Nothing in it depends on `DEPLOYMENT_MODE`, and it needs
no extra service, because the isolate runs inside the backend.
