'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { ApiError, mcpServers, sandbox } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { AppSelect } from '@/components/ui/select';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { BenchmarkTab } from './benchmark-tab';
import { errorText } from './format';
import { IsolationTab } from './isolation-tab';
import { RunsTab } from './runs-tab';
import { ScriptsTab } from './scripts-tab';

type Tab = 'scripts' | 'runs' | 'isolation' | 'benchmark';

const TABS: { value: Tab; label: string }[] = [
  { value: 'scripts', label: 'Scripts' },
  { value: 'runs', label: 'Runs' },
  { value: 'isolation', label: 'Isolation tests' },
  { value: 'benchmark', label: 'Benchmark' },
];

export default function SandboxPage() {
  const { token, user } = useAuth();
  const [servers, setServers] = useState<{ id: string; name: string }[] | null>(null);
  const [serverId, setServerId] = useState('');
  const [tab, setTab] = useState<Tab>('scripts');
  // The server for which code mode answered "turned off" (derived, so nothing is reset by hand).
  const [offFor, setOffFor] = useState('');
  const [error, setError] = useState<string | null>(null);

  const role = user?.role;
  const off = offFor === serverId;
  const canWrite = role !== 'VIEWER';
  const isAdmin = role === 'ADMIN';

  useEffect(() => {
    if (!token) return;
    mcpServers
      .list(token)
      .then((list) => {
        setServers(list);
        setServerId((current) => current || list[0]?.id || '');
      })
      .catch((err) => setError(errorText(err)));
  }, [token]);

  // Code mode can be switched off for the whole instance (SANDBOX_ENABLED=false).
  useEffect(() => {
    if (!token || !serverId) return;
    sandbox.scripts(serverId, token).catch((err) => {
      if (err instanceof ApiError && err.status === 404 && /turned off/i.test(err.message)) setOffFor(serverId);
    });
  }, [token, serverId]);

  const picker = servers && servers.length > 0 && (
    <AppSelect
      aria-label="MCP server"
      value={serverId}
      onValueChange={setServerId}
      className="h-[34px] rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[12.5px] text-[var(--text-2)]"
      options={servers.map((s) => ({ value: s.id, label: s.name }))}
    />
  );

  return (
    <AppShell
      title="Code mode"
      subtitle="Agents run short scripts next to the data. Only the answer goes back to the model."
      actions={picker || undefined}
    >
      {error && <div role="alert" className="mb-4 rounded-lg bg-[var(--t-danger-bg)] px-3.5 py-2.5 text-[12.5px] text-[var(--t-danger-fg)]">{error}</div>}

      {servers?.length === 0 && (
        <Card className="p-8 text-center text-[13px] text-[var(--text-2)]">
          Code mode is part of an MCP server. <Link className="text-[var(--brand)] hover:underline" href="/mcp-server">Create one</Link> and assign a connector to it first.
        </Card>
      )}

      {off && (
        <Card className="p-8 text-center text-[13px] text-[var(--text-2)]">
          Code mode is turned off on this instance (<span className="font-mono">SANDBOX_ENABLED=false</span>).
        </Card>
      )}

      {token && serverId && !off && (
        <>
          <div role="tablist" aria-label="Code mode" className="mb-4 inline-flex gap-0.5 rounded-[10px] bg-[var(--surface-2)] p-[3px]">
            {TABS.map((t) => (
              <button
                key={t.value}
                role="tab"
                type="button"
                aria-selected={tab === t.value}
                onClick={() => setTab(t.value)}
                className={cn(
                  'rounded-[7px] px-3.5 py-1.5 text-[12.5px] font-medium transition-colors',
                  tab === t.value
                    ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--text-3)] hover:text-[var(--text)]',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* keyed by server: choosing another one starts each tab from a clean state */}
          {tab === 'scripts' && <ScriptsTab key={serverId} serverId={serverId} token={token} canWrite={canWrite} isAdmin={isAdmin} />}
          {tab === 'runs' && <RunsTab key={serverId} serverId={serverId} token={token} isAdmin={isAdmin} />}
          {tab === 'isolation' && <IsolationTab key={serverId} serverId={serverId} token={token} canWrite={canWrite} />}
          {tab === 'benchmark' && <BenchmarkTab key={serverId} serverId={serverId} token={token} canWrite={canWrite} />}
        </>
      )}
    </AppShell>
  );
}
