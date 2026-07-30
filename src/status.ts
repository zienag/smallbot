import { escapeHtml } from "./telegram";

export const STATUS_INCIDENTS_KEY = "status_incidents";

// status.anthropic.com redirects here. Statuspage's public API needs no key and
// returns the 50 most recent incidents with their full update timeline, so one
// fetch is both the trigger and the content — no LLM in this source, the bodies
// are already two terse English sentences. Scheduled maintenances sit behind a
// separate endpoint and are ignored: two of them in two years.
const INCIDENTS_URL = "https://status.claude.com/api/v2/incidents.json";

export type Impact = "none" | "minor" | "major" | "critical";

export interface IncidentUpdate {
  id: string;
  status: string; // investigating | identified | monitoring | resolved
  body: string;
  createdAt: string;
}

export interface Incident {
  id: string;
  name: string;
  impact: Impact;
  resolved: boolean;
  url: string;
  startedAt: string;
  components: string[];
  updates: IncidentUpdate[]; // oldest first
}

interface RawIncident {
  id: string;
  name: string;
  impact: Impact;
  status: string;
  shortlink: string;
  created_at: string;
  started_at?: string;
  components?: { name: string }[];
  incident_updates?: { id: string; status: string; body: string; created_at: string }[];
}

/** "Claude Console (platform.claude.com)" → "Claude Console". */
function componentLabel(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "");
}

export function parseIncidents(body: string): Incident[] {
  const raw = JSON.parse(body) as { incidents?: RawIncident[] };
  return (raw.incidents ?? []).map((i) => ({
    id: i.id,
    name: i.name,
    impact: i.impact,
    resolved: i.status === "resolved" || i.status === "postmortem",
    url: i.shortlink,
    startedAt: i.started_at ?? i.created_at,
    components: (i.components ?? []).map((c) => componentLabel(c.name)),
    // The API lists updates newest first; the channel reads oldest first.
    updates: (i.incident_updates ?? [])
      .map((u) => ({ id: u.id, status: u.status, body: u.body, createdAt: u.created_at }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }));
}

/** Newest first, as the API returns them. */
export async function fetchIncidents(): Promise<Incident[]> {
  const res = await fetch(INCIDENTS_URL);
  if (!res.ok) throw new Error(`status page fetch failed: ${res.status}`);
  return parseIncidents(await res.text());
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

// Statuspage's stock phrases carry nothing beyond the status word — 71% of all
// update bodies in a month of history. The card collapses them into the
// timeline line and quotes only text a human actually wrote.
const CANNED = new Set([
  "We are currently investigating this issue.",
  "We are continuing to investigate this issue.",
  "The issue has been identified and a fix is being implemented.",
  "We are continuing to work on a fix for this issue.",
  "A fix has been implemented and we are monitoring the results.",
  "We are continuing to monitor for any further issues.",
  "This incident has been resolved.",
  "This issue has been resolved.",
]);

export function isCanned(body: string): boolean {
  return CANNED.has(body.trim());
}

function elapsedLabel(incident: Incident, update: IncidentUpdate): string {
  const elapsed = Date.parse(update.createdAt) - Date.parse(incident.startedAt);
  return elapsed >= 60_000 ? formatDuration(elapsed) : "";
}

/**
 * The status walk: `investigating → identified 16m → resolved 2h 43m`.
 * How long each step took is the one thing the status page doesn't show.
 * Consecutive same-status updates collapse into their first occurrence —
 * "we are continuing to work on a fix" is not a new state.
 */
export function formatTimeline(incident: Incident): string {
  const steps: string[] = [];
  let last = "";
  for (const update of incident.updates) {
    if (update.status === last) continue;
    last = update.status;
    const age = elapsedLabel(incident, update);
    steps.push(`${escapeHtml(update.status)}${age ? ` ${age}` : ""}`);
  }
  return steps.join(" → ");
}

/**
 * The whole incident as one channel message, re-rendered from scratch on every
 * change and applied with editMessageText: the channel holds one card per
 * incident, not a stream of near-identical updates.
 */
export function formatIncidentCard(incident: Incident): string {
  const head = `<b><a href="${incident.url}">${escapeHtml(incident.name)}</a></b>`;
  const meta = [incident.impact === "none" ? "" : incident.impact, incident.components.join(", ")]
    .filter(Boolean)
    .join(" · ");
  const bespoke = incident.updates
    .filter((u) => !isCanned(u.body))
    .map((u) => escapeHtml(u.body));
  return [`${head}${meta ? `\n${meta}` : ""}`, formatTimeline(incident), ...bespoke].join("\n\n");
}

/** One update as a standalone DM to a subscriber. */
export function formatUpdateDm(incident: Incident, update: IncidentUpdate): string {
  const age = elapsedLabel(incident, update);
  const suffix = age ? ` · ${age}${update.status === "resolved" ? " total" : " in"}` : "";
  return (
    `<b>${escapeHtml(incident.name)}</b>\n` +
    `<b>${escapeHtml(update.status)}</b>${suffix}\n${escapeHtml(update.body)}`
  );
}

/** Worth a notification and a pin while it lasts. */
export function isHighImpact(incident: Incident): boolean {
  return incident.impact === "major" || incident.impact === "critical";
}

export interface IncidentState {
  /** The incident's card message, edited in place; 0 when nothing was posted (seeded). */
  messageId: number;
  postedUpdates: string[];
}

export type StatusState = Record<string, IncidentState>;

export function seedState(incidents: Incident[]): StatusState {
  const state: StatusState = {};
  for (const incident of incidents) {
    state[incident.id] = { messageId: 0, postedUpdates: incident.updates.map((u) => u.id) };
  }
  return state;
}

export function pendingUpdates(state: StatusState, incident: Incident): IncidentUpdate[] {
  const posted = new Set(state[incident.id]?.postedUpdates ?? []);
  return incident.updates.filter((u) => !posted.has(u.id));
}

/**
 * Drops incidents that fell off the feed. The API returns a fixed window of
 * the 50 most recent, so anything missing is old enough to never come back.
 */
export function pruneState(state: StatusState, incidents: Incident[]): StatusState {
  const live = new Set(incidents.map((i) => i.id));
  return Object.fromEntries(Object.entries(state).filter(([id]) => live.has(id)));
}
