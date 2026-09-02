/**
 * The three crons of wrangler.jsonc, dispatched by the literal string the
 * event carries — a drift between the two files leaves a tick unowned, which
 * the scheduled handler logs rather than guesses about.
 *
 * Each company's sources ride their own cron so an idle tick pays for one
 * company's fetches, not both: the free plan meters CPU per invocation, and
 * every fetch or KV read costs the runtime about 2 ms regardless of size.
 * Incidents get the fastest cron: their median life is under an hour and a
 * quarter of them are shorter than 25 minutes, so a 15-minute loop would
 * routinely collapse one into a single message that opens and resolves at once.
 *
 * Not in src/index.ts: workerd treats every export of the entry module as a
 * handler and refuses to start on a string.
 */
export type Group = "anthropic" | "openai";
export const GROUPS: Group[] = ["anthropic", "openai"];

export const ANTHROPIC_CRON = "*/15 * * * *";
export const OPENAI_CRON = "5,20,35,50 * * * *";
export const STATUS_CRON = "*/5 * * * *";

export function groupForCron(cron: string): Group | "status" | null {
  if (cron === STATUS_CRON) return "status";
  if (cron === ANTHROPIC_CRON) return "anthropic";
  if (cron === OPENAI_CRON) return "openai";
  return null;
}
