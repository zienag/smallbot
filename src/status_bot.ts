import { type Incident, fetchIncidents } from "./status";
import { escapeHtml, answerCallbackQuery, sendMessage } from "./telegram";

// Per-incident subscriber lists live in their own keys: the webhook is their
// only writer and the cron only reads them, so the two never race the way they
// would on the shared card-state key.
export const SUBS_PREFIX = "status_subs:";

export interface StatusBotEnv {
  RELEASES: KVNamespace;
  TELEGRAM_STATUS_BOT_TOKEN?: string;
  TELEGRAM_STATUS_BOT_USERNAME?: string;
  STATUS_WEBHOOK_SECRET?: string;
}

export async function getSubscribers(kv: KVNamespace, incidentId: string): Promise<number[]> {
  const raw = await kv.get(SUBS_PREFIX + incidentId);
  return raw ? (JSON.parse(raw) as number[]) : [];
}

async function putSubscribers(kv: KVNamespace, incidentId: string, subs: number[]): Promise<void> {
  if (subs.length === 0) await kv.delete(SUBS_PREFIX + incidentId);
  else await kv.put(SUBS_PREFIX + incidentId, JSON.stringify(subs));
}

/**
 * DMs one update to every subscriber, loud — the whole point of following an
 * incident is being interrupted by it. A 403 means the user blocked the bot;
 * they are dropped rather than retried forever.
 */
export async function notifySubscribers(
  env: StatusBotEnv,
  incidentId: string,
  text: string,
): Promise<void> {
  const subs = await getSubscribers(env.RELEASES, incidentId);
  if (subs.length === 0) return;
  const alive: number[] = [];
  for (const chatId of subs) {
    try {
      await sendMessage(env.TELEGRAM_STATUS_BOT_TOKEN!, chatId, text);
      alive.push(chatId);
    } catch (err) {
      if (!String(err).includes("403")) alive.push(chatId);
      console.log(`status dm to ${chatId} failed: ${err}`);
    }
  }
  if (alive.length !== subs.length) await putSubscribers(env.RELEASES, incidentId, alive);
}

function followedConfirmation(incident: Incident | undefined): string {
  const name = incident ? escapeHtml(incident.name) : "this incident";
  return `Following <b>${name}</b> — updates will land here until it resolves. Beep!`;
}

interface TelegramUpdate {
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
  };
  message?: {
    from?: { id: number };
    chat: { id: number; type: string };
    text?: string;
  };
}

async function subscribe(env: StatusBotEnv, userId: number, incidentId: string): Promise<void> {
  const subs = await getSubscribers(env.RELEASES, incidentId);
  if (!subs.includes(userId)) await putSubscribers(env.RELEASES, incidentId, [...subs, userId]);
}

async function handleCallback(
  env: StatusBotEnv,
  cq: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<void> {
  const token = env.TELEGRAM_STATUS_BOT_TOKEN!;
  const incidentId = cq.data?.startsWith("sub:") ? cq.data.slice(4) : undefined;
  if (!incidentId) {
    await answerCallbackQuery(token, cq.id);
    return;
  }

  const subs = await getSubscribers(env.RELEASES, incidentId);
  if (subs.includes(cq.from.id)) {
    await putSubscribers(env.RELEASES, incidentId, subs.filter((id) => id !== cq.from.id));
    await answerCallbackQuery(token, cq.id, { text: "Unfollowed." });
    return;
  }

  // The confirmation DM doubles as the reachability probe: Telegram forbids
  // bots from opening a conversation, so a user who never started the bot gets
  // a deep link instead — Start delivers the same subscription via its payload.
  const incident = (await fetchIncidents()).find((i) => i.id === incidentId);
  try {
    await sendMessage(token, cq.from.id, followedConfirmation(incident));
  } catch {
    await answerCallbackQuery(token, cq.id, {
      url: `https://t.me/${env.TELEGRAM_STATUS_BOT_USERNAME}?start=sub_${incidentId}`,
    });
    return;
  }
  await putSubscribers(env.RELEASES, incidentId, [...subs, cq.from.id]);
  await answerCallbackQuery(token, cq.id, { text: "Following — updates via DM." });
}

async function handleMessage(
  env: StatusBotEnv,
  msg: NonNullable<TelegramUpdate["message"]>,
): Promise<void> {
  if (msg.chat.type !== "private" || !msg.text) return;
  const token = env.TELEGRAM_STATUS_BOT_TOKEN!;
  const [command, payload] = msg.text.trim().split(/\s+/, 2);

  if (command === "/start" && payload?.startsWith("sub_")) {
    const incidentId = payload.slice(4);
    await subscribe(env, msg.chat.id, incidentId);
    const incident = (await fetchIncidents()).find((i) => i.id === incidentId);
    await sendMessage(token, msg.chat.id, followedConfirmation(incident));
    return;
  }
  if (command === "/start") {
    await sendMessage(
      token,
      msg.chat.id,
      "I follow Anthropic incidents for @anthropic_status. Tap Follow under an " +
        "incident card there and its updates will arrive here, with sound. Beep!",
    );
    return;
  }
  if (command === "/list") {
    const incidents = await fetchIncidents();
    const lines: string[] = [];
    const subKeys = await env.RELEASES.list({ prefix: SUBS_PREFIX });
    for (const key of subKeys.keys) {
      const incidentId = key.name.slice(SUBS_PREFIX.length);
      if (!(await getSubscribers(env.RELEASES, incidentId)).includes(msg.chat.id)) continue;
      const incident = incidents.find((i) => i.id === incidentId);
      lines.push(incident ? `• ${escapeHtml(incident.name)}` : `• ${incidentId} (archived)`);
    }
    await sendMessage(
      token,
      msg.chat.id,
      lines.length ? `You follow:\n${lines.join("\n")}` : "You follow nothing right now.",
    );
    return;
  }
  if (command === "/stop") {
    const subKeys = await env.RELEASES.list({ prefix: SUBS_PREFIX });
    for (const key of subKeys.keys) {
      const incidentId = key.name.slice(SUBS_PREFIX.length);
      const subs = await getSubscribers(env.RELEASES, incidentId);
      if (subs.includes(msg.chat.id)) {
        await putSubscribers(env.RELEASES, incidentId, subs.filter((id) => id !== msg.chat.id));
      }
    }
    await sendMessage(token, msg.chat.id, "Unfollowed everything.");
  }
}

/** Webhook entry point; never throws — Telegram retries non-200s forever. */
export async function handleTelegramUpdate(env: StatusBotEnv, update: TelegramUpdate): Promise<void> {
  try {
    if (update.callback_query) await handleCallback(env, update.callback_query);
    else if (update.message) await handleMessage(env, update.message);
  } catch (err) {
    console.log(`status webhook failed: ${err}`);
  }
}
