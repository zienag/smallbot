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
# {"ok":false,"failing":{"youtube_claude":{"failures":10,"error":"Error: youtube api failed: 403 quotaExceeded UCV03…","since":1788580200000}},"warnings":[],"at":"…"}
```

Every source's outcome is scored per tick in KV (`source_health:<anthropic|openai|status>`, one key per cron so coinciding ticks never overwrite each other; src/health.ts): consecutive failures, the latest error, when the run began. A healthy source has no entry, a dry run keeps no score.

**Warnings** are the errors a source caught and worked around — a lookup that failed and was read as "nothing found", a pin that did not stick, an enrichment that fell back to the bare post. The source stays healthy and the post may be wrong, so every such catch calls `warn` (src/health.ts) instead of `console.log`: the line is logged and kept in `source_warnings:<scope>` as `{source, message, count, since, at}`, a repeat counted rather than listed twice, the newest twenty per cron. A warning lives for a day after its last occurrence and then drops out by itself, so a deployed fix turns `/health` green with no KV surgery; `ok` is false while any is live. Which source a warning belongs to travels in `AsyncLocalStorage` (compatibility flag `nodejs_als`), since invocations that share an isolate interleave. Outside a source's run (the status bot's webhook, a force-post) `warn` only logs. `/health` is public: a message carries no user ids, which is why the status bot's DM failures stay plain log lines. The case that started it: D1 refused the archive lookup of every article url longer than 41 characters, each video posted apart from its article, and `/health` stayed green (2026-09-28).

Every `console.log` is also kept by Workers Logs for three days (`observability` in wrangler.jsonc; the free plan takes 200,000 lines a day), readable in the dashboard after the fact.

**The owner is never messaged.** He asked for a pipeline that finds and fixes its own misses, not one that asks him to watch it — a DM "source X is down" only moves the watching onto him (tried 2026-09-04, removed the same morning). Two things read `/health` instead:

- **Every Claude Code session in this repo** starts by reading it (SessionStart hook in .claude/settings.json), so a source that has been dark is the first thing the session sees, and it investigates and fixes before anything else.
- **The Health workflow** (.github/workflows/health.yml) — a curl every 30 minutes on GitHub's runners, no model, free on a public repo. When a source has failed four ticks (an hour), or any warning is live, it opens one issue labeled `health` with the `/health` JSON and starts the routine below with a POST to the routine's `/fire` endpoint (bearer token in the repo secret `ROUTINE_FIRE_TOKEN`, generated in the routine's API trigger dialog at claude.ai/code/routines, shown once; the issue number and the `/health` JSON travel as the request's `text`). An accepted call is recorded on the issue as the comment "Health routine started."; until that comment exists every half-hourly run calls again, so a refused call or a missing token delays the routine and does not lose it. One routine run per issue; when `/health` is green again the workflow closes the issue. **A miss that raised no error** (a post that went out wrong or bare: the model watch posting `gpt-6.1-sol` without the launch article the blog channel carried in the same tick, 2026-09-29) shows nowhere in `/health`, so a session that finds one while watching the chain hands it over as a report: `gh workflow run Health -f report='<what went out, what should have, the facts established>'` opens an issue labeled `reported` and starts the routine with its text; `/health` being green does not stop that run, and the routine closes the issue itself once its fix is pushed. A Claude session polled on a timer just to read `/health` was the first design and burned tokens on every green check, so the timer is the cheap half and the model runs only when there is something to fix.
- **The "smallbot health" routine** (claude.ai/code/routines) — a cloud Claude session (no connectors, repo only; its model is the alias `opus`, which the run resolves to the newest Opus by itself — a fixed id such as `claude-opus-5` stays on that model for ever, and did for a week after 5.5 shipped) started by the Health workflow's call and, as a fallback, by its weekly cron (`27 6 * * 1` UTC); step 1 of its prompt is the curl, so a green run costs two tool calls. **A GitHub issue cannot start a routine**: routines take GitHub events for pull requests and releases only (code.claude.com/docs/en/routines, Supported events), so the webhook trigger on `issues` that this was first built on never fired — ten issues from 2026-09-04 to 2026-09-14 started no run, and the one routine comment among them (#12) came from the Monday cron. It reads `/health`, failing sources and warnings alike, tells our breakage from their outage with a known-good control, fixes ours with the smallest change plus a test, runs the gates and pushes one commit to main, and comments on the issue; it never touches post formats, prompts, wiring or KV, never force-posts, never opens a PR or closes the issue; what it cannot settle it leaves for the next local session. Its first run (2026-09-04) diagnosed the YouTube outage correctly and then pushed a mobile notification to the owner anyway — `PushNotification` is now in its `disallowed_tools` and the prompt says outright that he is never contacted. Webhook triggers cannot be deleted through the API: two on `issues` events (`39081aef…`, `12dd54eb…`) remain attached from the first design and never fire.

**Who fixes what.** A bug the owner reports to a session is fixed by that session, directly and at once. A bug the chain found by itself (a `health` issue, a warning) is the routine's, and a session watching the chain repairs the chain — the workflow, the start call, the routine's prompt — and leaves the bug: a second fixer races the routine's push and hides whether self-repair works. On 2026-09-29 the second rule was stretched over a bug the owner had reported himself, and he got a report path and a lecture where he asked for a fix.

First check whether the failure is theirs: a known-good channel or repo as a control tells our breakage from their outage. The two health issues so far (#3 on 2026-09-04, #12 on 2026-09-14) were both `youtube.com/feeds/videos.xml` answering 404 for every channel on the planet for hours — a chronic outage of that feed, which is why the YouTube watch moved to the Data API (.claude/rules/youtube-sources.md).

## Deploys ride on `main`

A push to `main` runs the gates and then `wrangler deploy` (.github/workflows/ci.yml, secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` set from the Keychain with `gh secret set`), so the health routine's fixes go live without a laptop. A local `npx wrangler deploy` still works and is still the way to verify a change before pushing; the CI deploy is idempotent over it. D1 migrations are not in CI: apply them by hand (`--remote`) before pushing a schema change, as before.

The tick status itself (`console.log` of every source's one-line result) is in `npx wrangler tail smallbot` live and in Workers Logs for three days; a `/run?dry=1` shows the same lines on demand.

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

**KV operations are metered per day on the account**, not per worker: the free plan allows 100,000 reads and 1,000 each of writes, deletes and lists a day, and Cloudflare mails "KV daily operation limit 50% reached" at half (2026-09-23, 09-24, 10-06). Which bucket is filling is visible only in the dashboard (Workers KV → namespaces); the writes to suspect first are `http_validators`, rewritten by every tick in which any feed's validator changed, and `/health`, which costs two `list` operations per call.

**`wrangler secret put` immediately followed by `wrangler deploy` can lose the secret**: the deploy snapshots bindings into a new version and can pick up the pre-put value (bit us with `ARCHIVE_READ_SECRET` — the token 403'd until the secret was re-put). Deploy first, then put secrets; after a put-then-deploy, re-put.

**`--remote` needs `CLOUDFLARE_API_TOKEN` exported** or it dies on expired auth, and it authenticates `/run` against the **`.dev.vars` `TRIGGER_SECRET`**, which is not the Keychain one — reading the wrong one gets a bare `forbidden`.

## KV by hand

To re-trigger an already-seen model/news item for a real test:

```sh
npx wrangler kv key get/put --remote --namespace-id 2254c70148884faa8d27f6fd73e08e81 <key>
```

Remove the entry from the relevant seen-set. `--remote` is mandatory — without it wrangler hits an empty local simulator ("Value not found"). Prefer the `/run?source=…&version=…&dry=1` hooks — they render the same post without touching KV or the channel.

The keys: `last_posted_version` (claude), `codex_last_posted_version`, `known_models` / `openai_known_models` (JSON id arrays), `openai_blog_seen` (JSON guid array), `anthropic_blog_seen` / `openai_dev_blog_seen` (JSON url arrays), `status_incidents` (JSON incident-id → `{messageId, postedUpdates}`), `status_subs:<incident id>` (JSON chat-id arrays), `youtube_seen:<channel key>` (JSON video-id arrays), `resolved_model` / `resolved_model_sonnet` (24h TTL caches), `http_validators` (JSON url → `{etag, lastModified}` of the feeds polled conditionally: the changelog, the Codex atom, the blog indexes, the YouTube uploads playlists), `openai_unlisted` (JSON guid → epoch ms of the news list's last "not listed" verdict; delete an entry to have the list re-asked at once), `source_health:<anthropic|openai|status>` (JSON source tag → `{failures, error, since}` of the sources currently failing; absent when all is well; merged view at `/health`), `source_warnings:<anthropic|openai|status>` (JSON array of the errors sources caught and worked around, each kept a day past its last occurrence). The HN watch has no key of its own: what it posts goes into `openai_blog_seen`.

**When you rewind a cursor or a seen-set by hand, delete the feed's entry from `http_validators` too** — otherwise the next tick asks the server "changed since?", gets a 304, and reports `unchanged` instead of replaying what you meant to replay. A plain `/run?dry=1` after a real tick shows the same `unchanged` for the same reason.
