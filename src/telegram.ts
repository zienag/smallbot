import type { Summary } from "./summarize";

const MAX_WITH_NOTES = 4000;

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function changelogAnchorUrl(version: string): string {
  return `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#${version.replaceAll(".", "")}`;
}

/** Escapes HTML, then turns `backticks` into <code>. */
export function formatInline(s: string): string {
  return escapeHtml(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

export interface Post {
  product: string;
  version: string;
  url: string;
  summary: Summary;
  /** Full notes for the expandable quote; omit when the source is noisy. */
  notes?: string;
}

export function buildPost(post: Post): string {
  const head = [
    `<b>${escapeHtml(post.product)} <a href="${post.url}">${escapeHtml(post.version)}</a></b>`,
    post.summary.bullets.map((b) => `• ${formatInline(b)}`).join("\n"),
  ].join("\n\n");
  if (!post.notes) return head;

  // The quote is only useful when the summary compresses: with no more note
  // lines than bullets it just duplicates the post verbatim.
  const noteLines = post.notes.split("\n").filter((l) => l.trim()).length;
  if (noteLines <= post.summary.bullets.length) return head;

  const withNotes = `${head}\n\n<blockquote expandable>${formatInline(post.notes)}</blockquote>`;
  return withNotes.length <= MAX_WITH_NOTES ? withNotes : head;
}

export async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<number> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  });
  if (!res.ok) {
    throw new Error(`telegram sendMessage failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { result?: { message_id?: number } };
  return data.result?.message_id ?? 0;
}

export interface AlbumPhoto {
  bytes: ArrayBuffer;
  mediaType: string;
}

export const CAPTION_LIMIT = 1024;

/**
 * Classic album post: photos in a grid, text as the first photo's caption
 * (1024 limit). Bytes are uploaded by us — Telegram's fetcher fails
 * anthropic.com's UA filter.
 */
export async function sendAlbum(
  botToken: string,
  chatId: string,
  caption: string,
  photos: AlbumPhoto[],
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  photos.forEach((p, i) => {
    form.append(`photo${i}`, new Blob([p.bytes], { type: p.mediaType }), `photo${i}`);
  });
  let method: string;
  if (photos.length === 1) {
    method = "sendPhoto";
    form.append("photo", "attach://photo0");
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  } else {
    method = "sendMediaGroup"; // 2-10 photos
    form.append(
      "media",
      JSON.stringify(
        photos.map((_, i) =>
          i === 0
            ? { type: "photo", media: "attach://photo0", caption, parse_mode: "HTML" }
            : { type: "photo", media: `attach://photo${i}` },
        ),
      ),
    );
  }
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`telegram ${method} failed: ${res.status} ${await res.text()}`);
  }
}
