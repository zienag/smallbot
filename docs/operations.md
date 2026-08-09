# Operating the worker

## `/run`

POST-only, auth via `Authorization: Bearer <TRIGGER_SECRET>` (never a query param — those end up in logs).

| param | effect |
|---|---|
| *(none)* | normal pipeline, all sources except status |
| `version=X` | force-post one version (never touches KV) |
| `source=claude\|codex\|models\|openai\|blog\|openai_blog\|openai_dev\|youtube\|status` | which source the forced version/id/title/url-substring belongs to |
| `only=status` | run just the status tick (what the `*/5` cron does) |
| `dry=1\|0` | override `DRY_RUN` |
| `preview=1` | with `source=`+`version=`: deliver the force-posted message to the owner's DM (`TELEGRAM_OWNER_CHAT_ID`) instead of the channel — real Telegram rendering, no archive entry, no pin |

A dry run exercises the full pipeline including a real LLM call, posts nothing, and doesn't touch `last_posted_version`:

```sh
curl -X POST "https://smallbot.zienag.workers.dev/run?version=2.1.209&dry=1" \
  -H "Authorization: Bearer $(security find-generic-password -s smallbot -a trigger-secret -w)"
```

Dry responses carry the post text for every source except `claude`/`codex`, where the body is just `force-posted <source> <version> (dry)` and the post itself goes to `console.log` (i.e. `wrangler tail`).

## `/archive`

Read-only feed of everything the bot did to the channels (issue #2), for an external mirror. GET-only, auth via `Authorization: Bearer <token>` — a token that can read but never post or trigger. `ARCHIVE_READ_SECRET` is a whitespace-separated list, one token per consumer (Keychain: `smallbot`/`archive-read-secret`, `archive-read-secret-work`, …); to add or revoke one, edit the Keychain entries and re-put the joined list:

```sh
printf '%s %s' "$(security find-generic-password -s smallbot -a archive-read-secret -w)" \
  "$(security find-generic-password -s smallbot -a archive-read-secret-work -w)" \
  | npx wrangler secret put ARCHIVE_READ_SECRET
```

```sh
curl "https://smallbot.zienag.workers.dev/archive?since=0" \
  -H "Authorization: Bearer $(security find-generic-password -s smallbot -a archive-read-secret -w)"
```

Returns `{cursor, actions}`, up to 200 actions with `seq > since`, oldest first; poll again with `since=<cursor>`. Each action: `seq`, `ts` (epoch ms), `chat`, `kind` (`send|edit|pin|unpin`), `messageId`, and where present `text` (the exact HTML sent), `silent`, `tier`, `photos` (paths like `/archive/photo/<seq>/<idx>`, fetched with the same token — album bytes as posted). Message identity for replay is `(chat, messageId)`; an `edit` carries the full new text.

Storage is the `smallbot-archive` D1 database (tables `actions`, `photos`, `migrations/`). Retention 30 days, pruned on write; `seq` never rewinds (AUTOINCREMENT — a consumer cursor survives an emptied table). Writes are best-effort *after* a successful Telegram call: a failed insert logs and moves on, so a gap in the archive is possible and reposting to the channel is not. Dry runs and subscriber DMs are not archived; force-posts are.

Schema changes: add a numbered file under `migrations/`, then `npx wrangler d1 migrations apply smallbot-archive --local` for dev and `--remote` before the deploy. By-hand inspection:

```sh
npx wrangler d1 execute smallbot-archive --remote \
  --command "SELECT seq, ts, chat, kind, message_id FROM actions ORDER BY seq DESC LIMIT 10"
```

## Deploy traps

**After `wrangler deploy` the old instance can keep serving `/run` for up to ~a minute** — a "fix didn't work" verdict right after deploying is unreliable (bit us twice), re-check before debugging.

**A newly added cron trigger can register but never fire.** The `*/5` cron added on 2026-07-27 was listed by the `/schedules` API yet produced zero invocations for a full day (per-minute GraphQL `workersInvocationsAdaptive` showed only `*/15` ticks), then came alive after the next day's redeploy re-put the schedule set. After adding a cron, don't trust the deploy output or the schedules listing — verify a real tick: `npx wrangler tail smallbot --format json` across a matching minute, or the per-minute GraphQL query.

**`wrangler secret put` immediately followed by `wrangler deploy` can lose the secret**: the deploy snapshots bindings into a new version and can pick up the pre-put value (bit us with `ARCHIVE_READ_SECRET` — the token 403'd until the secret was re-put). Deploy first, then put secrets; after a put-then-deploy, re-put.

**`--remote` needs `CLOUDFLARE_API_TOKEN` exported** or it dies on expired auth, and it authenticates `/run` against the **`.dev.vars` `TRIGGER_SECRET`**, which is not the Keychain one — reading the wrong one gets a bare `forbidden`.

## KV by hand

To re-trigger an already-seen model/news item for a real test:

```sh
npx wrangler kv key get/put --remote --namespace-id 2254c70148884faa8d27f6fd73e08e81 <key>
```

Remove the entry from the relevant seen-set. `--remote` is mandatory — without it wrangler hits an empty local simulator ("Value not found"). Prefer the `/run?source=…&version=…&dry=1` hooks — they render the same post without touching KV or the channel.

The keys: `last_posted_version` (claude), `codex_last_posted_version`, `known_models` / `openai_known_models` (JSON id arrays), `openai_blog_seen` (JSON guid array), `anthropic_blog_seen` / `openai_dev_blog_seen` (JSON url arrays), `status_incidents` (JSON incident-id → `{messageId, postedUpdates}`), `status_subs:<incident id>` (JSON chat-id arrays), `youtube_seen:<channel key>` (JSON video-id arrays), `resolved_model` / `resolved_model_sonnet` (24h TTL caches).
