# Codebound demo: an ERP with 150,000 orders

Makes the "tool result too large for the model" problem real, and measures what code
mode does about it.

```bash
node scripts/sandbox-demo/generate-db.mjs        # packages/backend/demo/koch-demo.sqlite (29 MB) + ground-truth.json
AMCP_EMAIL=admin@example.com AMCP_PASSWORD=... \
  node scripts/sandbox-demo/seed.mjs             # connector, 5 tools, server "koch-demo", API key, 3 saved scripts
node scripts/sandbox-demo/benchmark.mjs          # the three questions, three ways
```

`generate-db.mjs` is deterministic (fixed seed, fixed "today" of 2026-10-15). It writes
2,000 customers, 500 products, 150,000 orders (about 12% delivered late, about 4% still
open) and 450,000 order lines, and computes the answers in plain JavaScript, independent
of SQL and of the sandbox.

`seed.mjs` goes through the REST API, so the running gateway registers the tools live. The
connector is `readOnly: true` with `maxRows: 200000`; see `docs/connectors/database.md`.
Needs a backend built from this branch.

## The questions

1. How many orders were delayed last month, and what revenue did they carry?
2. Revenue by product category for the last quarter.
3. Top 10 customers by cumulative delay days this year.

## What `benchmark.mjs` measures

Each question, three ways, against the running gateway, median of 3 runs:

| Way | What it is |
|---|---|
| conventional | Every intermediate result goes back through the model. Best effort: it uses each filter the tools offer (`status=delayed`), pages of 1,000 rows. |
| raw SQL | An agent that aggregates in the database with the connector's own `execute_query`. The strongest baseline for a SQL source. |
| sandbox | One `sandbox_run_script` call with the saved script. |

**Measured:** tool calls, bytes of MCP response text that reach the model, wall time,
and whether each answer equals the ground truth.
**Estimated:** tokens, as bytes / 4. No tokenizer and no language model is involved, so
how well a model would read the conventional pages is *not* measured; for that column the
check is only that the retrieved data suffices to derive the right answer.

Results of the last run are in [`last-benchmark.json`](last-benchmark.json) and are
summarised in the review notes. The honest reading: against paging, code mode cuts what
reaches the model by 99.8% to 99.99%; against a SQL-capable agent the answers are equally
small and the sandbox is slower, because the rows cross the bridge. Its niche is sources
that cannot aggregate (REST, SOAP, OData) and logic that spans connectors.
