'use client';

import { useEffect, useState } from 'react';
import { connectors as connectorsApi, mcpServers, sandbox, type SandboxBenchmark } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, StatusPill } from '@/components/ui/badge';
import { AppSelect } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { errorText, formatBytes, formatMs, formatReduction, formatTokens, parseArgs, pretty } from './format';
import { BlockTitle, Pre } from './result-panel';

const INPUT =
  'w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]';

const genericCode = (tool: string) => `// The same question as the raw call, answered inside the gateway.
const res = await tools.${tool}({});
const rows = Array.isArray(res) ? res : (res.rows ?? []);
return { rows: rows.length };
`;

// The first question of the Codebound demo (scripts/sandbox-demo).
const DEMO = {
  tool: 'erp_orders_export',
  toolArgs: '{\n  "from": "2026-09-01",\n  "to": "2026-10-01"\n}',
  code: `// How many orders were delayed last month, and what revenue did they carry?
const res = await tools.erp_orders_export({ from: '2026-09-01', to: '2026-10-01' });
const late = res.rows.filter((o) => o.delivered_at && o.delivered_at > o.promised_at);
return {
  delayedOrders: late.length,
  revenue: Math.round(util.sum(late, (o) => o.total) * 100) / 100,
};
`,
};

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{label}</div>
      <div className="font-mono text-[18px] font-semibold">{value}</div>
      {hint && <div className="text-[11px] text-[var(--text-3)]">{hint}</div>}
    </div>
  );
}

export function BenchmarkTab({ serverId, token, canWrite }: { serverId: string; token: string; canWrite: boolean }) {
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [tool, setTool] = useState('');
  const [toolArgs, setToolArgs] = useState('');
  const [code, setCode] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SandboxBenchmark | null>(null);

  // The tools of the connectors assigned to this server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const server = await mcpServers.get(serverId, token);
        const ids: string[] = (server.connectors ?? []).map((c: any) => c.connector?.id ?? c.connectorId).filter(Boolean);
        const full = await Promise.all(ids.map((id) => connectorsApi.get(id, token)));
        const names = full.flatMap((c: any) => (c.tools ?? []).map((t: any) => t.name as string)).sort();
        if (cancelled) return;
        setToolNames(names);
        if (names.length > 0) {
          setTool(names[0]);
          setCode(genericCode(names[0]));
        }
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, token]);

  const pick = (name: string) => {
    setTool(name);
    setCode(genericCode(name));
    setResult(null);
  };

  const useDemo = () => {
    setTool(DEMO.tool);
    setToolArgs(DEMO.toolArgs);
    setCode(DEMO.code);
    setResult(null);
  };

  const run = async () => {
    const args = parseArgs(toolArgs);
    if (!args.ok) {
      setError(args.message);
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await sandbox.benchmark(serverId, { toolName: tool, toolArgs: args.value, code }, token));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRunning(false);
    }
  };

  const raw = result?.raw;
  const script = result?.script;

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5">
        <div>
          <div className="text-[14px] font-semibold">Raw tool call against a script</div>
          <p className="mt-1 max-w-[680px] text-[12.5px] leading-relaxed text-[var(--text-2)]">
            Calls one read-only tool once, the way a model would see it, and runs a script that answers the same question
            inside the gateway. Compares what each path puts in front of the model. Tokens are estimated as bytes ÷ 4.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-[11.5px] font-semibold text-[var(--text-2)]" id="bench-tool-label">
                Tool to call directly
              </label>
              <AppSelect
                aria-labelledby="bench-tool-label"
                value={tool}
                onValueChange={pick}
                className="h-9 w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 font-mono text-[12.5px] text-[var(--text-2)]"
                options={toolNames.length ? toolNames.map((n) => ({ value: n, label: n })) : [{ value: '', label: 'No tools on this server' }]}
              />
              {toolNames.includes(DEMO.tool) && (
                <button type="button" onClick={useDemo} className="mt-1.5 text-[12px] font-medium text-[var(--brand)] hover:underline">
                  Use the demo question (delayed orders last month)
                </button>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-[11.5px] font-semibold text-[var(--text-2)]" htmlFor="bench-tool-args">
                Tool arguments (JSON, optional)
              </label>
              <textarea
                id="bench-tool-args"
                spellCheck={false}
                rows={4}
                className={cn(INPUT, 'py-2 font-mono text-xs')}
                value={toolArgs}
                onChange={(e) => setToolArgs(e.target.value)}
                placeholder='{"from": "2026-09-01", "to": "2026-10-01"}'
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-[11.5px] font-semibold text-[var(--text-2)]" htmlFor="bench-code">
              Script that answers the same question
            </label>
            <textarea
              id="bench-code"
              spellCheck={false}
              rows={10}
              className={cn(INPUT, 'py-2 font-mono text-xs leading-relaxed')}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void run()} disabled={running || !tool || !code.trim() || !canWrite} size="lg">
            {running ? 'Running both…' : 'Run both'}
          </Button>
          {!canWrite && <span className="text-[12px] text-[var(--text-3)]">Viewers cannot run benchmarks.</span>}
          <span className="text-[12px] text-[var(--text-3)]">
            Only read-only tools can be called for real. The tool is called once, and the script once.
          </span>
        </div>
        {error && <div role="alert" className="rounded-lg bg-[var(--t-danger-bg)] px-3.5 py-2.5 text-[12.5px] text-[var(--t-danger-fg)]">{error}</div>}
      </Card>

      {result && (
        <div className="space-y-4" data-testid="benchmark-result">
          {result.reduction && (
            <Card className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-5 py-4" style={{ background: 'var(--t-success-bg)' }}>
              <span className="text-[34px] font-semibold leading-none" style={{ color: 'var(--t-success-fg)' }} data-testid="reduction-bytes">
                {formatReduction(raw?.bytes ?? 0, script?.bytes ?? 0) ?? `−${result.reduction.bytesPct}%`}
              </span>
              <span className="text-[14px]" style={{ color: 'var(--t-success-fg)' }}>
                reaches the model ({result.reduction.bytesPct}% fewer bytes, {result.reduction.tokensPct}% fewer est. tokens)
              </span>
            </Card>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <div className="text-[13px] font-semibold">Raw tool call</div>
                {raw && (raw.ok ? <StatusPill tone="neutral">everything goes to the model</StatusPill> : <StatusPill tone="danger">failed</StatusPill>)}
              </div>
              {raw?.ok ? (
                <div className="grid grid-cols-3 gap-3">
                  <Metric label="To the model" value={formatBytes(raw.bytes ?? 0)} />
                  <Metric label="Est. tokens" value={formatTokens(raw.estTokens ?? 0)} hint="bytes ÷ 4" />
                  <Metric label="Latency" value={formatMs(raw.ms)} />
                </div>
              ) : (
                <div className="text-[12.5px] text-[var(--danger)]">{raw?.error ?? 'The call failed.'}</div>
              )}
            </Card>
            <Card className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <div className="text-[13px] font-semibold">Sandbox script</div>
                {script ? (
                  script.ok ? <StatusPill tone="success" dot="var(--ok)">answered</StatusPill> : <StatusPill tone="danger">{script.error?.code}</StatusPill>
                ) : (
                  <Badge tone="neutral">not run</Badge>
                )}
              </div>
              {script ? (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <Metric label="To the model" value={formatBytes(script.bytes)} />
                    <Metric label="Est. tokens" value={formatTokens(script.estTokens)} hint="bytes ÷ 4" />
                    <Metric label="Latency" value={formatMs(script.ms)} />
                  </div>
                  <div className="text-[12px] text-[var(--text-3)]">
                    {script.connectorCalls} connector call{script.connectorCalls === 1 ? '' : 's'}; pulled{' '}
                    <span className="font-mono text-[var(--text-2)]">{formatBytes(script.bytesFromConnectors)}</span> inside the gateway.
                  </div>
                  {script.ok ? (
                    <div>
                      <BlockTitle>Answer</BlockTitle>
                      <Pre maxH="max-h-48">{pretty(script.result)}</Pre>
                    </div>
                  ) : (
                    <div className="rounded-lg bg-[var(--t-danger-bg)] px-3.5 py-2.5 text-[12.5px] text-[var(--t-danger-fg)]">
                      {script.error?.message}
                      {script.error?.hint && <div className="mt-1 opacity-80">Hint: {script.error.hint}</div>}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-[12.5px] text-[var(--text-3)]">The script was not run because the raw call failed.</div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
