// Append-only archive of every channel action, for the read-only /archive
// endpoint (issue #2): an outside consumer replays a channel from it instead
// of re-implementing the pipeline or reading Telegram back.

export type ActionKind = "send" | "edit" | "pin" | "unpin";

export interface ArchivePhoto {
  bytes: ArrayBuffer;
  mediaType: string;
}

export interface ChannelAction {
  chat: string;
  kind: ActionKind;
  messageId: number;
  /** Rendered HTML exactly as sent; absent for pin/unpin. */
  text?: string;
  silent?: boolean;
  tier?: string;
  photos?: ArchivePhoto[];
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 200;

/**
 * Best-effort by design: the Telegram post already went out, so a failed
 * archive write must not abort the source loop — aborting would repost to the
 * live channel, which is worse than a hole in the archive (the consumer owns
 * dedup and gap handling per the issue).
 */
export async function recordAction(db: D1Database | undefined, action: ChannelAction): Promise<void> {
  if (!db) return;
  try {
    const inserted = await db
      .prepare(
        "INSERT INTO actions (ts, chat, kind, message_id, text, silent, tier) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
      .bind(
        Date.now(),
        action.chat,
        action.kind,
        action.messageId,
        action.text ?? null,
        action.silent == null ? null : action.silent ? 1 : 0,
        action.tier ?? null,
      )
      .run();
    for (const [idx, photo] of (action.photos ?? []).entries()) {
      await db
        .prepare("INSERT INTO photos (action_seq, idx, media_type, bytes) VALUES (?1, ?2, ?3, ?4)")
        .bind(inserted.meta.last_row_id, idx, photo.mediaType, photo.bytes)
        .run();
    }
    await pruneExpired(db);
  } catch (err) {
    console.log(`archive write failed: ${err}`);
  }
}

async function pruneExpired(db: D1Database): Promise<void> {
  const cutoff = Date.now() - RETENTION_MS;
  await db
    .prepare("DELETE FROM photos WHERE action_seq IN (SELECT seq FROM actions WHERE ts < ?1)")
    .bind(cutoff)
    .run();
  await db.prepare("DELETE FROM actions WHERE ts < ?1").bind(cutoff).run();
}

interface ActionRow {
  seq: number;
  ts: number;
  chat: string;
  kind: ActionKind;
  message_id: number;
  text: string | null;
  silent: number | null;
  tier: string | null;
  photo_count: number;
}

export interface ArchivedAction {
  seq: number;
  ts: number;
  chat: string;
  kind: ActionKind;
  messageId: number;
  text?: string;
  silent?: boolean;
  tier?: string;
  /** Paths under this worker, fetched with the same token. */
  photos?: string[];
}

export function rowToAction(row: ActionRow): ArchivedAction {
  return {
    seq: row.seq,
    ts: row.ts,
    chat: row.chat,
    kind: row.kind,
    messageId: row.message_id,
    ...(row.text == null ? {} : { text: row.text }),
    ...(row.silent == null ? {} : { silent: row.silent === 1 }),
    ...(row.tier == null ? {} : { tier: row.tier }),
    ...(row.photo_count > 0
      ? { photos: Array.from({ length: row.photo_count }, (_, i) => `/archive/photo/${row.seq}/${i}`) }
      : {}),
  };
}

/** `since` is the last seq the consumer has (exclusive); 0 reads from the start. */
export async function readActions(
  db: D1Database,
  since: number,
): Promise<{ cursor: number; actions: ArchivedAction[] }> {
  const { results } = await db
    .prepare(
      `SELECT a.seq, a.ts, a.chat, a.kind, a.message_id, a.text, a.silent, a.tier,
              (SELECT COUNT(*) FROM photos p WHERE p.action_seq = a.seq) AS photo_count
       FROM actions a WHERE a.seq > ?1 ORDER BY a.seq LIMIT ${PAGE_LIMIT}`,
    )
    .bind(since)
    .all<ActionRow>();
  const actions = results.map(rowToAction);
  return { cursor: actions.length > 0 ? actions[actions.length - 1].seq : since, actions };
}

export async function readPhoto(
  db: D1Database,
  seq: number,
  idx: number,
): Promise<{ mediaType: string; bytes: Uint8Array } | null> {
  const row = await db
    .prepare("SELECT media_type, bytes FROM photos WHERE action_seq = ?1 AND idx = ?2")
    .bind(seq, idx)
    .first<{ media_type: string; bytes: number[] }>();
  // D1 hands BLOBs back as a plain number array (Array.from), not an ArrayBuffer.
  return row ? { mediaType: row.media_type, bytes: new Uint8Array(row.bytes) } : null;
}
