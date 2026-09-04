/**
 * A source that throws is caught, logged, and retried next tick — and nobody
 * reads the log. This keeps the score instead: which sources are failing, for
 * how long, with what error. Served at /health, read at the start of every
 * Claude Code session in this repo (.claude/settings.json), so a source that
 * has been dark for hours is the first thing the next session sees and fixes.
 * The owner is told nothing: what needs a decision reaches him as a finished
 * fix, not as a request to watch.
 */

/**
 * One key per cron, so the status tick and a company's tick landing on the
 * same minute never overwrite each other's score.
 */
export const HEALTH_PREFIX = "source_health:";

export function healthKey(scope: string): string {
  return `${HEALTH_PREFIX}${scope}`;
}

export interface SourceHealth {
  failures: number; // consecutive
  error: string; // the latest
  since: number; // epoch ms of the first failure in the run
}

export type HealthState = Record<string, SourceHealth>;

/** Applies one tick's outcome for a source. A healthy source has no entry. */
export function recordOutcome(state: HealthState, tag: string, error: string | null, now: number): void {
  if (error === null) {
    delete state[tag];
    return;
  }
  const entry = state[tag] ?? { failures: 0, error, since: now };
  entry.failures += 1;
  entry.error = error;
  state[tag] = entry;
}

export async function loadHealth(kv: KVNamespace, scope: string): Promise<HealthState> {
  const raw = await kv.get(healthKey(scope));
  return raw ? (JSON.parse(raw) as HealthState) : {};
}

export async function saveHealth(kv: KVNamespace, scope: string, state: HealthState): Promise<void> {
  if (Object.keys(state).length === 0) await kv.delete(healthKey(scope));
  else await kv.put(healthKey(scope), JSON.stringify(state));
}

/** Every cron's score in one map, for /health. */
export async function loadAllHealth(kv: KVNamespace): Promise<HealthState> {
  const all: HealthState = {};
  const { keys } = await kv.list({ prefix: HEALTH_PREFIX });
  for (const { name } of keys) {
    const raw = await kv.get(name);
    if (raw) Object.assign(all, JSON.parse(raw) as HealthState);
  }
  return all;
}
