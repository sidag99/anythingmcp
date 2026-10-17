import { ApiError } from '@/lib/api';

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/** Tokens are always an estimate: four bytes to a token, no tokenizer involved. */
export function estTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

/** Share of the pulled-in data that did not reach the model, as a percentage. */
export function reductionPct(pulled: number, returned: number): number | null {
  if (pulled <= 0) return null;
  return Math.round((1 - returned / pulled) * 10_000) / 100;
}

/**
 * How much smaller the answer is than the raw data, in words a person takes in. A percentage
 * stops saying anything past 99.9% (57 MB down to 34 bytes reads as "-100%"), so a big gap
 * is shown as a factor instead.
 */
export function formatReduction(rawBytes: number, keptBytes: number): string | null {
  if (rawBytes <= 0 || keptBytes < 0 || keptBytes >= rawBytes) return null;
  const factor = rawBytes / Math.max(keptBytes, 1);
  if (factor >= 1_000_000) return `${(factor / 1_000_000).toFixed(1)} million× smaller`;
  if (factor >= 1_000) return `${Math.round(factor).toLocaleString('en-US')}× smaller`;
  if (factor >= 10) return `${Math.round(factor)}× smaller`;
  return `−${Math.round((1 - keptBytes / rawBytes) * 100)}%`;
}

export type ParsedArgs =
  | { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false; message: string };

/** An optional JSON object typed into a textarea. Empty means "none". */
export function parseArgs(text: string): ParsedArgs {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, message: 'Arguments must be a JSON object, like {"month": "2026-09"}.' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (err) {
    return { ok: false, message: `Arguments are not valid JSON: ${(err as Error).message}` };
  }
}

/** A message for the user from a failed request, including a busy-organization 429. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const nested = err.body?.error;
    if (nested && typeof nested === 'object' && typeof nested.message === 'string') return nested.message;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
