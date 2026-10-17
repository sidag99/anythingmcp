'use client';

import { useState } from 'react';
import { sandbox, type IsolationResult } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { errorText, formatMs } from './format';

const GRID = '28px minmax(0,2.2fr) minmax(0,1.5fr) 70px 70px';

function Mark({ passed }: { passed: boolean }) {
  return passed ? (
    <svg aria-label="passed" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  ) : (
    <svg aria-label="failed" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/**
 * The judges’ screen: the negative tests, run live. They use synthetic tools, so
 * they touch no connector and no customer’s data.
 */
export function IsolationTab({ serverId, token, canWrite }: { serverId: string; token: string; canWrite: boolean }) {
  const [results, setResults] = useState<IsolationResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalMs, setTotalMs] = useState<number | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    const started = performance.now();
    try {
      setResults(await sandbox.isolationTests(serverId, token));
      setTotalMs(performance.now() - started);
    } catch (err) {
      setResults(null);
      setError(errorText(err));
    } finally {
      setRunning(false);
    }
  };

  const passed = results?.filter((r) => r.passed).length ?? 0;
  const allPassed = results !== null && passed === results.length;

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="max-w-[640px]">
          <div className="text-[14px] font-semibold">Nothing to bypass</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-2)]">
            A script runs in an empty JavaScript world: there is no <span className="font-mono">require</span>,{' '}
            <span className="font-mono">process</span>, <span className="font-mono">fetch</span> or file system in it, so
            there is nothing to get around. This runs the fixed suite against the live sandbox: each case tries to leave
            it, exhaust it, or reach something it should not, and passes only if it is stopped for the right reason. The
            cases use synthetic tools, so no connector and no customer’s data is touched.
          </p>
        </div>
        <Button onClick={() => void run()} disabled={running || !canWrite} size="lg">
          {running ? 'Running the suite…' : 'Run isolation suite'}
        </Button>
      </Card>
      {!canWrite && <div className="text-[12px] text-[var(--text-3)]">Viewers cannot run the suite.</div>}
      {error && <div role="alert" className="rounded-lg bg-[var(--t-danger-bg)] px-3.5 py-2.5 text-[12.5px] text-[var(--t-danger-fg)]">{error}</div>}

      {results && (
        <Card className="overflow-hidden" data-testid="isolation-results">
          <div
            className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-[18px] py-4"
            style={{ background: allPassed ? 'var(--t-success-bg)' : 'var(--t-danger-bg)' }}
          >
            <span className="text-[22px] font-semibold" style={{ color: allPassed ? 'var(--t-success-fg)' : 'var(--t-danger-fg)' }}>
              {passed} of {results.length} passed
            </span>
            {totalMs !== null && (
              <span className="text-[12.5px]" style={{ color: allPassed ? 'var(--t-success-fg)' : 'var(--t-danger-fg)' }}>
                in {formatMs(totalMs)}
              </span>
            )}
          </div>
          <div
            className="hidden items-center gap-3 border-b border-[var(--border)] bg-[var(--surface-2)] px-[18px] py-[11px] text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text-3)] md:grid"
            style={{ gridTemplateColumns: GRID }}
          >
            <span />
            <span>Attempt</span>
            <span>Expected → actual</span>
            <span>Took</span>
            <span>Source</span>
          </div>
          {results.map((r) => (
            <div
              key={r.id}
              data-testid="isolation-row"
              data-passed={r.passed}
              className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 border-b border-[var(--border)] px-[18px] py-3 text-[13px] md:grid-cols-[28px_minmax(0,2.2fr)_minmax(0,1.5fr)_70px_70px]"
            >
              <span className="pt-0.5">
                <Mark passed={r.passed} />
              </span>
              <span className="min-w-0">
                <span className="block font-medium">{r.name}</span>
                <span className="block text-[12px] leading-snug text-[var(--text-3)]">{r.claim}</span>
                {r.detail && <span className="mt-1 block text-[12px] text-[var(--danger)]">{r.detail}</span>}
              </span>
              <span className="col-start-2 flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] md:col-start-auto">
                <Badge tone="neutral">{r.expectedCode}</Badge>
                <span className="text-[var(--text-3)]">→</span>
                <Badge tone={r.passed ? 'success' : 'danger'}>{r.actualCode}</Badge>
              </span>
              <span className="col-start-2 pt-0.5 font-mono text-[12px] text-[var(--text-2)] md:col-start-auto">
                {formatMs(r.ms)}
                <span className="ml-3 text-[11px] text-[var(--text-3)] md:hidden">{r.specRef}</span>
              </span>
              <span className="hidden pt-0.5 font-mono text-[11px] text-[var(--text-3)] md:block">{r.specRef}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
