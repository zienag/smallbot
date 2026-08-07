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

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data?: string; url?: string }[][];
}

export async function sendMessage(
  botToken: string,
  chatId: string | number,
  text: string,
  opts: { silent?: boolean; keyboard?: InlineKeyboard } = {},
): Promise<number> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_notification: opts.silent ?? false,
      ...(opts.keyboard ? { reply_markup: opts.keyboard } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`telegram sendMessage failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { result?: { message_id?: number } };
  return data.result?.message_id ?? 0;
}

/** Edits are always silent — that is the whole point of the card design. */
export async function editMessageText(
  botToken: string,
  chatId: string | number,
  messageId: number,
  text: string,
  opts: { keyboard?: InlineKeyboard } = {},
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(opts.keyboard ? { reply_markup: opts.keyboard } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`telegram editMessageText failed: ${res.status} ${await res.text()}`);
  }
}

export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  opts: { text?: string; url?: string } = {},
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, ...opts }),
  });
  if (!res.ok) {
    throw new Error(`telegram answerCallbackQuery failed: ${res.status} ${await res.text()}`);
  }
}

/** Needs the bot to be a channel admin with the pin right. */
export async function pinMessage(
  botToken: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/pinChatMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  if (!res.ok) {
    throw new Error(`telegram pinChatMessage failed: ${res.status} ${await res.text()}`);
  }
}

export async function unpinMessage(
  botToken: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/unpinChatMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  if (!res.ok) {
    throw new Error(`telegram unpinChatMessage failed: ${res.status} ${await res.text()}`);
  }
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
): Promise<number> {
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
  const data = (await res.json()) as {
    result?: { message_id?: number } | { message_id?: number }[];
  };
  const first = Array.isArray(data.result) ? data.result[0] : data.result;
  return first?.message_id ?? 0;
}
