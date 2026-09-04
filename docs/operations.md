# Operating the worker

## `/run`

POST-only, auth via `Authorization: Bearer <TRIGGER_SECRET>` (never a query param — those end up in logs).

| param | effect |
|---|---|
| *(none)* | normal pipeline, all sources except status |
| `version=X` | force-post one version (never touches KV) |
| `source=claude\|codex\|models\|openai\|blog\|openai_blog\|openai_hn\|openai_dev\|youtube\|status` | which source the forced version/id/title/url-substring belongs to |
| `only=status` | run just the status tick (what the `*/5` cron does) |
| `dry=1\|0` | override `DRY_RUN` |
| `preview=1` | with `source=`+`version=`: deliver the force-posted message to the owner's DM (`TELEGRAM_OWNER_CHAT_ID`) instead of the channel — real Telegram rendering, no archive entry, no pin |

A dry run exercises the full pipeline including a real LLM call, posts nothing, and doesn't touch `last_posted_version`:

```sh
curl -X POST "https://smallbot.zienag.workers.dev/run?version=2.1.209&dry=1" \
  -H "Authorization: Bearer $(security find-generic-password -s smallbot -a trigger-secret -w)"
```

Dry responses carry the post text for every source except `claude`/`codex`, where the body is just `force-posted <source> <version> (dry)` and the post itself goes to `console.log` (i.e. `wrangler tail`).

## `/health` — who is failing, since when

GET, no auth (it names sources and carries their error lines, nothing that can post or read the archive):

```sh
/usr/bin/curl -s https://smallbot.zienag.workers.dev/health
# {"ok":false,"failing":{"youtube_claude":{"failures":10,"error":"Error: youtube feed fetch failed: 404 UCV03…","since":1788580200000}},"at":"…"}
```

Every source's outcome is scored per tick in KV (`source_health:<anthropic|openai|status>`, one key per cron so coinciding ticks never overwrite each other; src/health.ts): consecutive failures, the latest error, when the run began. A healthy source has no entry, a dry run keeps no score.

**The owner is never messaged.** He asked for a pipeline that finds and fixes its own misses, not one that asks him to watch it — a DM "source X is down" only moves the watching onto him (tried 2026-09-04, removed the same morning). Two things read `/health` instead:

- **Every Claude Code session in this repo** starts by reading it (SessionStart hook in .claude/settings.json), so a source that has been dark is the first thing the session sees, and it investigates and fixes before anything else.
- **The "smallbot health" routine** (claude.ai/code/routines) — a cloud Claude session every 6 hours (`27 */6 * * *` UTC, Opus 5, no connectors, repo only) that reads `/health`, tells our breakage from their outage with a known-good control, fixes ours with the smallest change plus a test, runs the gates and pushes one commit to main. It never touches post formats, prompts, wiring or KV, never force-posts, never opens a PR; what it cannot settle it leaves for the next local session. Its first run (2026-09-04) diagnosed the YouTube outage correctly and then pushed a mobile notification to the owner anyway — `PushNotification` is now in its `disallowed_tools` and the prompt says outright that he is never contacted.

First check whether the failure is theirs: on 2026-09-04 `youtube.com/feeds/videos.xml` answered 404 for every channel on the planet for hours (Google's generic error page, `server: YouTube RSS Feeds server`) — a known-good channel as a control tells our breakage from their outage.

## Deploys ride on `main`

A push to `main` runs the gates and then `wrangler deploy` (.github/workflows/ci.yml, secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` set from the Keychain with `gh secret set`), so the health routine's fixes go live without a laptop. A local `npx wrangler deploy` still works and is still the way to verify a change before pushing; the CI deploy is idempotent over it. D1 migrations are not in CI: apply them by hand (`--remote`) before pushing a schema change, as before.

The tick status itself (`console.log` of every source's one-line result) is only in `npx wrangler tail smallbot`; a `/run?dry=1` shows the same lines on demand.

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

**A newly added cron trigger can register but never fire.** The `*/5` cron added on 2026-07-27 was listed by the `/schedules` API yet produced zero invocations for a full day (per-minute GraphQL `workersInvocationsAdaptive` showed only `*/15` ticks), then came alive after the next day's redeploy re-put the schedule set. After adding a cron, don't trust the deploy output or the schedules listing — verify a real tick: `npx wrangler tail smallbot --format json` across a matching minute, or the per-minute GraphQL query. The three crons are told apart by the literal string in the event (`groupForCron` in src/crons.ts): a tick for a string the code doesn't know logs `unknown cron` and runs nothing.

**CPU is metered per invocation, and every fetch or KV read costs the runtime ~2 ms of it regardless of size** (measured 2026-09-02: parsers for a whole tick were ~7 ms, the rest was network operations). That is why the sources ride two crons instead of one and the npm dist-tag is asked only when a feed has something newer. Cloudflare's free plan allows 10 ms per invocation with tolerance for occasional overruns; watch `cpuTimeP50/P99` in the GraphQL analytics after adding a source.

**`wrangler secret put` immediately followed by `wrangler deploy` can lose the secret**: the deploy snapshots bindings into a new version and can pick up the pre-put value (bit us with `ARCHIVE_READ_SECRET` — the token 403'd until the secret was re-put). Deploy first, then put secrets; after a put-then-deploy, re-put.

**`--remote` needs `CLOUDFLARE_API_TOKEN` exported** or it dies on expired auth, and it authenticates `/run` against the **`.dev.vars` `TRIGGER_SECRET`**, which is not the Keychain one — reading the wrong one gets a bare `forbidden`.

## KV by hand

To re-trigger an already-seen model/news item for a real test:

```sh
npx wrangler kv key get/put --remote --namespace-id 2254c70148884faa8d27f6fd73e08e81 <key>
```

Remove the entry from the relevant seen-set. `--remote` is mandatory — without it wrangler hits an empty local simulator ("Value not found"). Prefer the `/run?source=…&version=…&dry=1` hooks — they render the same post without touching KV or the channel.

The keys: `last_posted_version` (claude), `codex_last_posted_version`, `known_models` / `openai_known_models` (JSON id arrays), `openai_blog_seen` (JSON guid array), `anthropic_blog_seen` / `openai_dev_blog_seen` (JSON url arrays), `status_incidents` (JSON incident-id → `{messageId, postedUpdates}`), `status_subs:<incident id>` (JSON chat-id arrays), `youtube_seen:<channel key>` (JSON video-id arrays), `resolved_model` / `resolved_model_sonnet` (24h TTL caches), `http_validators` (JSON url → `{etag, lastModified}` of the feeds polled conditionally: the changelog, the Codex atom, the blog indexes), `openai_unlisted` (JSON guid → epoch ms of the news list's last "not listed" verdict; delete an entry to have the list re-asked at once), `source_health:<anthropic|openai|status>` (JSON source tag → `{failures, error, since}` of the sources currently failing; absent when all is well; merged view at `/health`). The HN watch has no key of its own: what it posts goes into `openai_blog_seen`.

**When you rewind a cursor or a seen-set by hand, delete the feed's entry from `http_validators` too** — otherwise the next tick asks the server "changed since?", gets a 304, and reports `unchanged` instead of replaying what you meant to replay. A plain `/run?dry=1` after a real tick shows the same `unchanged` for the same reason.
