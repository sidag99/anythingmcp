'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';

interface PreviewEntry {
  repo: string;
  branch: string;
  url: string;
  commit?: string;
  updatedAt?: string;
  production?: boolean;
}

interface PreviewIndex {
  generatedAt?: string;
  entries: PreviewEntry[];
}

interface Loaded {
  host: string;
  index: PreviewIndex;
}

function isPreviewIndex(value: unknown): value is PreviewIndex {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Preview environments only: a slim bar above the app listing every deployed
 * branch of both repositories, with the current one selected. Reads the index
 * the preview router publishes (PREVIEW_INDEX_URL at request time); renders
 * nothing on production, for signed-out visitors, or when there is nowhere
 * else to go.
 */
export function BranchSwitcher({ indexUrl }: { indexUrl?: string }) {
  const { user } = useAuth();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!indexUrl) return;
    const host = window.location.host;
    const controller = new AbortController();
    fetch(indexUrl, { cache: 'no-store', signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (isPreviewIndex(data)) setLoaded({ host, index: data });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [indexUrl]);

  if (!indexUrl || !user || !loaded || loaded.index.entries.length < 2) return null;

  const { host, index } = loaded;
  const current = index.entries.find((entry) => hostOf(entry.url) === host);
  const repos = Array.from(new Set(index.entries.map((entry) => entry.repo)));

  return (
    <div className="flex items-center justify-center gap-3 bg-neutral-900 px-4 py-1.5 text-xs text-neutral-100">
      <span>Branch</span>
      <select
        aria-label="Switch branch"
        value={current?.url ?? ''}
        onChange={(event) => {
          if (event.target.value) window.location.assign(event.target.value);
        }}
        className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-100"
      >
        {!current && <option value="">…</option>}
        {repos.map((repo) => (
          <optgroup key={repo} label={repo}>
            {index.entries
              .filter((entry) => entry.repo === repo)
              .map((entry) => (
                <option key={entry.url} value={entry.url}>
                  {entry.branch}
                  {entry.production ? ' (production)' : ''}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {current?.commit && (
        <span className="font-mono text-neutral-400">{current.commit.slice(0, 7)}</span>
      )}
    </div>
  );
}
