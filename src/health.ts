/**
 * A source that throws is caught, logged, and retried next tick — and nobody
 * reads the log. This keeps the score instead: which sources are failing, for
 * how long, with what error. Served at /health, read at the start of every
 * Claude Code session in this repo (.claude/settings.json), so a source that
 * has been dark for hours is the first thing the next session sees and fixes.
 * The owner is told nothing: what needs a decision reaches him as a finished
 * fix, not as a request to watch.
 *
 * An error a source catches and works around (a lookup that failed and was
 * read as "nothing found", a pin that did not stick) leaves the source
 * healthy and the post wrong, so it is kept too, as a warning: the archive
 * lookup that D1 refused for weeks was visible nowhere but a live log tail.
 */

import { AsyncLocalStorage } from "node:async_hooks";

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

export const WARNINGS_PREFIX = "source_warnings:";

export function warningsKey(scope: string): string {
  return `${WARNINGS_PREFIX}${scope}`;
}

export interface Warning {
  source: string;
  message: string;
  count: number;
  since: number; // epoch ms of the first occurrence
  at: number; // epoch ms of the latest
}

/**
 * A warning outlives its tick, or the one tick that doubled a post would be
 * erased by the next clean one; a day without a repeat and it is gone, which
 * is how a fix shows at /health without anyone clearing KV.
 */
export const WARNING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_WARNINGS = 20;

// Invocations share an isolate and interleave at every await (the status tick
// lands on the same minute as a company's), so the source a warning belongs
// to travels with the async context, not in a module variable.
const collector = new AsyncLocalStorage<string[]>();

/**
 * For an error that is caught and worked around. Outside a source's run (the
 * bot webhook, a force-post) it is a log line only. The message is served at
 * the public /health: no user ids in it.
 */
export function warn(message: string): void {
  console.log(message);
  collector.getStore()?.push(message);
}

/** Runs a source, gathering into `messages` what it warns about. */
export function collectingWarnings<T>(messages: string[], run: () => Promise<T>): Promise<T> {
  return collector.run(messages, run);
}

export function liveWarnings(warnings: Warning[], now: number): Warning[] {
  return warnings.filter((w) => now - w.at <= WARNING_TTL_MS);
}

/** Adds one source's warnings of a tick: a repeat is counted, not listed twice. */
export function mergeWarnings(kept: Warning[], source: string, messages: string[], now: number): Warning[] {
  const merged = liveWarnings(kept, now).map((w) => ({ ...w }));
  for (const message of messages) {
    const known = merged.find((w) => w.source === source && w.message === message);
    if (known) {
      known.count += 1;
      known.at = now;
    } else {
      merged.push({ source, message, count: 1, since: now, at: now });
    }
  }
  return merged.sort((a, b) => a.at - b.at).slice(-MAX_WARNINGS);
}

export async function loadWarnings(kv: KVNamespace, scope: string): Promise<Warning[]> {
  const raw = await kv.get(warningsKey(scope));
  return raw ? (JSON.parse(raw) as Warning[]) : [];
}

export async function saveWarnings(kv: KVNamespace, scope: string, warnings: Warning[]): Promise<void> {
  await kv.put(warningsKey(scope), JSON.stringify(warnings));
}

/** Every cron's live warnings, oldest first, for /health. */
export async function loadAllWarnings(kv: KVNamespace, now: number): Promise<Warning[]> {
  const all: Warning[] = [];
  const { keys } = await kv.list({ prefix: WARNINGS_PREFIX });
  for (const { name } of keys) {
    const raw = await kv.get(name);
    if (raw) all.push(...liveWarnings(JSON.parse(raw) as Warning[], now));
  }
  return all.sort((a, b) => a.at - b.at);
}
