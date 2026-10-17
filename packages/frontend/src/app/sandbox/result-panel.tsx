'use client';

import type { SandboxRunResponse } from '@/lib/api';
import { Badge, StatusPill } from '@/components/ui/badge';
import { formatBytes, formatMs, pretty, reductionPct } from './format';

/** The label above a block of output, in the style of the audit log. */
export function BlockTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{children}</h4>
  );
}

export function Pre({ children, maxH = 'max-h-72' }: { children: React.ReactNode; maxH?: string }) {
  return (
    <pre
      className={`${maxH} overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-xs text-[var(--text)]`}
    >
      {children}
    </pre>
  );
}

/**
 * What one run did, led by the number that is the point of code mode: how much
 * data was pulled in next to the connectors, against how little went back.
 */
export function RunResultPanel({ run }: { run: SandboxRunResponse }) {
  const { meta } = run;
  const saved = reductionPct(meta.bytesFromConnectors, meta.bytesReturned);
  return (
    <div className="space-y-3" data-testid="run-result">
      <div className="flex flex-wrap items-center gap-2">
        {run.ok ? (
          <StatusPill tone="success" dot="var(--ok)">Succeeded</StatusPill>
        ) : (
          <StatusPill tone="danger" dot="var(--danger)">{run.error?.code ?? 'Failed'}</StatusPill>
        )}
        <Badge tone="neutral">{formatMs(meta.ms)}</Badge>
        <Badge tone="neutral">
          {meta.connectorCalls} connector call{meta.connectorCalls === 1 ? '' : 's'}
        </Badge>
        {run.script && (
          <Badge tone="brand">
            {run.script.name} v{run.script.version}
            {run.script.ownedByYou ? '' : ' (written by someone else)'}
          </Badge>
        )}
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 text-[12.5px]">
        <span className="text-[var(--text-2)]">Pulled </span>
        <strong className="font-mono">{formatBytes(meta.bytesFromConnectors)}</strong>
        <span className="text-[var(--text-2)]"> from the connectors, returned </span>
        <strong className="font-mono">{formatBytes(meta.bytesReturned)}</strong>
        <span className="text-[var(--text-2)]"> to the model</span>
        {saved !== null && meta.bytesFromConnectors > meta.bytesReturned && (
          <span className="ml-2 font-semibold text-[var(--ok)]">−{saved}%</span>
        )}
      </div>

      {run.ok ? (
        <div>
          <BlockTitle>Result</BlockTitle>
          <Pre>{pretty(run.result)}</Pre>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--danger)] bg-[var(--t-danger-bg)] px-3.5 py-3 text-[12.5px] text-[var(--t-danger-fg)]">
          <div className="font-semibold">
            {run.error?.code}
            {run.error?.line ? ` — line ${run.error.line}${run.error.column ? `, column ${run.error.column}` : ''}` : ''}
          </div>
          <div className="mt-1">{run.error?.message}</div>
          {run.error?.hint && <div className="mt-1.5 opacity-80">Hint: {run.error.hint}</div>}
        </div>
      )}

      {meta.toolsCalled.length > 0 && (
        <div className="text-[12px] text-[var(--text-3)]">
          Tools called: <span className="font-mono text-[var(--text-2)]">{meta.toolsCalled.join(', ')}</span>
        </div>
      )}
      {meta.logs.length > 0 && (
        <div>
          <BlockTitle>console.log</BlockTitle>
          <Pre maxH="max-h-40">{meta.logs.join('\n')}</Pre>
        </div>
      )}
      <div className="font-mono text-[10.5px] text-[var(--text-3)]">run {run.runId}</div>
    </div>
  );
}
