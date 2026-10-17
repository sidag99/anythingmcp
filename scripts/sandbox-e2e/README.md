# Sandbox end-to-end verification

Checks code mode on a **running** AnythingMCP, over real HTTP: the real JWT guard,
roles, Postgres, and connectors that call real (local) upstream servers. The unit
tests prove the parts; this proves the assembled product, including the claims of
the Codebound brief: no other customer's data, no internet, no host access.

75 checks in 11 groups: `core`, `scripts`, `read-only`, `isolation` (18 attempts to
leave the sandbox), `limits`, `deadlines`, `tenant` (two customers), `roles`,
`secrets`, `audit`, `big` (up to 44 MB). Each check records its evidence;
[`last-run.json`](last-run.json) is the result of the run described in the review notes.

## Run it

**Use a throwaway database.** The seed creates users, an organization and connectors.

```bash
# 1. a database and the backend (see AGENTS.md), with two extra settings for this test:
#    SSRF_ALLOW_LOCALHOST=true       lets the connectors call the local mock upstreams
#    SANDBOX_CONNECTOR_TIMEOUT_MS=2000   so the "connector never answers" checks are quick
cd packages/backend && npm run build && node dist/src/main.js

# 2. the mock upstreams: customer A on :9101 (with /echo, /hang, /big), customer B on :9102
node scripts/sandbox-e2e/mock-upstream.mjs &

# 3. seed (admin, editor with a one-tool role, viewer, and a second customer) and run
node scripts/sandbox-e2e/seed.mjs
node scripts/sandbox-e2e/e2e.mjs            # ONLY=tenant,roles node ... runs a subset
```

Settings (environment): `AMCP_URL` (default `http://127.0.0.1:4000`), `DATABASE_URL`
(default `postgresql://amcp:amcp-test@127.0.0.1:5433/anythingmcp`; the seed and some
checks read the database with `psql`).

The auth endpoints are rate limited; if the seed reports 429, wait a minute and rerun.

## What it does not prove

- It runs on one Node version and glibc. Other runtimes: see the review notes.
- The upstreams are local mocks, so network failure modes are simulated, not real.
- Two customers are two organizations on one gateway. Row-level isolation *inside* a
  shared database depends on how an administrator configured that connector (see the
  threat model in `docs/sandbox-code-mode.md`).
