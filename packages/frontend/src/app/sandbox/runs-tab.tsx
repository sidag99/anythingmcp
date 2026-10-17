'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { sandbox, type SandboxRunRecord } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, StatusPill } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { errorText, formatBytes, formatMs, formatWhen, pretty } from './format';
import { BlockTitle, Pre } from './result-panel';

const GRID = '150px minmax(0,1.3fr) 130px 80px minmax(0,1.4fr)';

export function RunsTab({ serverId, token, isAdmin }: { serverId: string; token: string; isAdmin: boolean }) {
  const [runs, setRuns] = useState<SandboxRunRecord[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const fetchAll = useCallback(
    () => Promise.all([sandbox.runs(serverId, token, 50), sandbox.scripts(serverId, token)]),
    [serverId, token],
  );

  // State is set when the request settles, never synchronously inside the effect.
  const show = useCallback(
    (request: ReturnType<typeof fetchAll>) =>
      request
        .then(([rows, scripts]) => {
          setRuns(rows);
          setNames(Object.fromEntries(scripts.map((s) => [s.id, s.name])));
          setError(null);
        })
        .catch((err) => setError(errorText(err)))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void show(fetchAll());
  }, [fetchAll, show]);

  const refresh = () => {
    setLoading(true);
    void show(fetchAll());
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-[18px] py-3">
        <div>
          <div className="text-[13px] font-semibold">Recent runs</div>
          <div className="text-[11.5px] text-[var(--text-3)]">
            {isAdmin
              ? 'Every member’s runs on this server, newest first.'
              : 'Your runs on this server, newest first. A run keeps a preview of what came back, so members only see their own.'}
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={refresh} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      {error && <div className="px-[18px] py-3 text-[12.5px] text-[var(--danger)]">{error}</div>}
      {runs?.length === 0 && (
        <div className="px-[18px] py-8 text-center text-[12.5px] text-[var(--text-3)]">No runs yet.</div>
      )}

      {runs && runs.length > 0 && (
        <>
          <div
            className="hidden items-center gap-3 border-b border-[var(--border)] bg-[var(--surface-2)] px-[18px] py-[11px] text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text-3)] md:grid"
            style={{ gridTemplateColumns: GRID }}
          >
            <span>Time</span>
            <span>Script</span>
            <span>Result</span>
            <span>Took</span>
            <span>Data: kept in the gateway → to the model</span>
          </div>
          {runs.map((r) => {
            const isOpen = open === r.id;
            return (
              <Fragment key={r.id}>
                <button
                  type="button"
                  data-testid="run-row"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : r.id)}
                  className="grid w-full items-center gap-3 border-b border-[var(--border)] px-[18px] py-[11px] text-left text-[13px] transition-colors hover:bg-[var(--surface-2)]"
                  style={{ gridTemplateColumns: GRID }}
                >
                  <span className="font-mono text-[12px] text-[var(--text-3)]">{formatWhen(r.createdAt)}</span>
                  <span className="truncate font-mono text-[12.5px]">
                    {r.scriptId ? (names[r.scriptId] ?? 'saved script') : <span className="text-[var(--text-3)]">inline code</span>}
                  </span>
                  <span>
                    {r.ok ? (
                      <StatusPill tone="success" dot="var(--ok)">OK</StatusPill>
                    ) : (
                      <StatusPill tone="danger" dot="var(--danger)">{r.errorCode ?? 'Failed'}</StatusPill>
                    )}
                  </span>
                  <span className="font-mono text-[12px] text-[var(--text-2)]">{formatMs(r.meta.ms)}</span>
                  <span className="font-mono text-[12px] text-[var(--text-2)]">
                    {formatBytes(r.meta.bytesFromConnectors)} → {formatBytes(r.meta.bytesReturned)}
                  </span>
                </button>

                {isOpen && (
                  <div className="border-b border-[var(--border)] bg-[var(--surface-2)] px-[18px] py-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <BlockTitle>Code</BlockTitle>
                        <Pre maxH="max-h-64">{r.code}</Pre>
                      </div>
                      <div>
                        <BlockTitle>{r.ok ? 'Result (preview)' : 'Error'}</BlockTitle>
                        <Pre maxH="max-h-64">{r.ok ? pretty(r.resultPreview) : `${r.errorCode}: ${r.errorMessage}`}</Pre>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-3)]">
                      <Badge tone="neutral">
                        {r.meta.connectorCalls} connector call{r.meta.connectorCalls === 1 ? '' : 's'}
                      </Badge>
                      {r.meta.toolsCalled.length > 0 && (
                        <span>
                          Tools: <span className="font-mono text-[var(--text-2)]">{r.meta.toolsCalled.join(', ')}</span>
                        </span>
                      )}
                      {r.args != null && (
                        <span>
                          Arguments: <span className="font-mono text-[var(--text-2)]">{JSON.stringify(r.args)}</span>
                        </span>
                      )}
                      <span className={cn('ml-auto font-mono text-[10.5px]')}>run {r.id}</span>
                    </div>
                    {r.meta.logs.length > 0 && (
                      <div className="mt-3">
                        <BlockTitle>console.log</BlockTitle>
                        <Pre maxH="max-h-32">{r.meta.logs.join('\n')}</Pre>
                      </div>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}
        </>
      )}
    </Card>
  );
}
