# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cloudflare Worker on three crons — `*/15` Anthropic sources, `5,20,35,50` OpenAI sources, `*/5` the status watch — that watches release feeds and posts digests to Telegram channels as `@bipozavr_bot`. Wiring is in src/index.ts; a source whose chat-id var is unset is simply off.

| source | code | channel |
|---|---|---|
| Claude Code CHANGELOG.md | src/changelog.ts | `@claudecode_changelog` |
| Codex GitHub releases (atom) | src/codex.ts | `@codex_changelog` |
| new models, Anthropic + OpenAI | src/models.ts, src/openai_models.ts | `@model_drops` |
| Anthropic news + engineering | src/blogs.ts | `@anthropic_blogs` |
| OpenAI news + developer blog | src/openai_news.ts, src/openai_dev.ts | `@openai_blogs` |
| openai.com pages the feed never lists (via Hacker News) | src/hn.ts | `@openai_blogs` |
| Anthropic incidents | src/status.ts, src/status_bot.ts | `@anthropic_status` |
| YouTube channels (OpenAI; Anthropic + Claude) | src/youtube.ts | the matching blog channel |

Each blog channel carries one company's news, its technical writing, and its YouTube videos together, reposted with an LLM importance tier (major = pin, normal, minor = silent). The incident watch is the only source with no LLM in it and the only one on its own bot, `@anthropic_status_watch_bot`.

Per-source detail — feeds, gates, matching rules, test hooks — lives in `.claude/rules/` and loads by itself when you open the source's file.

## Commands

```sh
npm test                    # vitest — parsers and post formatting, on real feed fixtures
                            # no vitest config: it collects EVERY *.test.ts in the repo,
                            # including scratch files under .claude.local.temp/
npx vitest run -t "name"    # single test
npm run typecheck           # src only (workers-types globals)
npx tsc --noEmit -p test    # test/ has its OWN tsconfig — check both
npm run dev                 # wrangler dev --test-scheduled (local, DRY_RUN=1 via .dev.vars)
curl 'http://localhost:8787/__scheduled?cron=*/15+*+*+*+*'   # fire the Anthropic tick locally (OpenAI: cron=5,20,35,50+*+*+*+*)
npx wrangler dev --remote   # runs on the edge: the only way to exercise the BROWSER binding
```

Two tsconfigs are deliberate: src uses `@cloudflare/workers-types` globals, test/ uses node types. Merging them breaks on the conflicting global `URL` type — don't.

Prod verification, `/run` params, KV surgery and the deploy traps (a redeploy serves stale for ~a minute; a newly added cron can register yet never fire) are in docs/operations.md. **A push to `main` deploys** (CI), so main is prod. The Health workflow polls `/health` every half hour and opens a `health` issue when a source has been dark for an hour or has caught and worked around an error; that issue starts the "smallbot health" cloud routine, which fixes and pushes to main.

## Secrets & deploy

All credentials live in macOS Keychain (never in the repo; `.dev.vars` is generated and gitignored):

| service | account | what |
|---|---|---|
| `anthropic` | `api-key-smallbot` | Anthropic API key |
| `openai` | `api-key-smallbot` | OpenAI key — only ever reads `/v1/models` (service account `smallbot` in the Default project; the Admin API can mint service accounts, not plain project keys) |
| `google` | `api-key-smallbot` | YouTube Data API key — worker secret `YOUTUBE_API_KEY`; Google Cloud project `smallbot`, key restricted to that API |
| `telegram` | `bot-token-smallbot` | Bot token |
| `smallbot` | `trigger-secret` | `/run` endpoint secret |
| `smallbot` | `archive-read-secret` | `/archive` read-only token — deliberately not the trigger secret: a leak can read the archive, never post |
| `smallbot` | `archive-read-secret-work` | same, for the work machine; the worker secret is the whitespace-joined list of all of them |
| `telegram` | `manager-chat-id-zienag_botomat_bot` | owner's Telegram user id — worker secret `TELEGRAM_OWNER_CHAT_ID`, the `/run?preview=1` DM target |
| `telegram` | `bot-token-anthropic_status_watch_bot` | status bot token (Follow buttons + DMs) |
| `telegram` | `webhook-secret-anthropic_status_watch_bot` | status bot webhook `secret_token` |
| `cloudflare` | `api-token-smallbot` | scoped deploy token (Workers + KV) |

Read with `security find-generic-password -s <service> -a <account> -w`.

```sh
export CLOUDFLARE_API_TOKEN=$(security find-generic-password -s cloudflare -a api-token-smallbot -w)
export CLOUDFLARE_ACCOUNT_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts" | python3 -c "import json,sys; print(json.load(sys.stdin)['result'][0]['id'])")
npx wrangler deploy
```

## Architecture invariants

Pipeline per tick (src/index.ts), per feed source: fetch releases → candidates are versions `> <source>_last_posted_version` (KV) **and** `<= npm latest` (npm dist-tag guards against entries that aren't actually released: `@anthropic-ai/claude-code` / `@openai/codex`) → post oldest-first, max 5 per tick. Sources are isolated: one failing doesn't block the others.

- **KV is written only after a successful Telegram post.** An error aborts that source's loop; the next tick resumes from the same place. This is the idempotency/catch-up mechanism — don't reorder it.
- **Within a tick, sources read each other's KV writes through `readingOwnWrites`** (src/kv.ts, wrapped in `runGroup`): a plain KV read can be answered from the edge cache of an earlier read, up to a minute old, so a source that checks another's seen-set seconds after it was written would miss the post and double it.
- **First run (empty KV) posts only the newest item, not history.** Same for every seen-set: the first tick seeds silently.
- **Feeds whose server supports it are polled conditionally** (src/conditional.ts, KV `http_validators`): a 304 means nothing new, and a validator is committed only once everything the content carried was posted, so a tick that stopped early re-reads the feed. Rewinding a cursor by hand means resetting its validator too.
- **A feed's own novelty signal is not enough** — a seen-set alone replays a publisher's backfill. Every watch adds a second gate (age, npm dist-tag, the newsroom's list, an API diff); a fact is never LLM-inferred from a title.
- **A publisher's own listing is not enough either** — OpenAI shipped the GPT-6 Astra launch page listed in no feed, list or sitemap (2026-09-03). Hacker News front-page stories are the input that does not depend on the publisher's CMS: an openai.com article the feed does not carry at all is posted from there (src/hn.ts).
- **The worker keeps its own score and never messages the owner.** Failing sources are counted per tick (src/health.ts) and served at `/health`, next to the errors a healthy source caught and worked around (`warn`, never a bare `console.log`); every session here starts by reading it (SessionStart hook) and fixes what is dark before doing anything else. A DM to the owner only moves the watching onto him — he refused that outright.
- The full KV key inventory (per-source cursors, seen-sets, caches) is in the KV-by-hand section of docs/operations.md; per-source key names are also in that source's `.claude/rules/` file.
- **Every channel action is archived to D1** (`ARCHIVE`, src/archive.ts) after the Telegram call succeeds; read-only at `/archive`. Best-effort: a failed insert must not abort the source loop — a retry would repost. Details: docs/operations.md.
- **Three crons, one company's sources per invocation** — the free plan meters CPU per invocation and every fetch or KV read costs ~2 ms of it, so Anthropic and OpenAI sources ride separate ticks and the status watch its own `*/5` (outside `runPipeline`: coinciding ticks racing on one KV key would double-post). The cron strings in src/crons.ts (`ANTHROPIC_CRON`, `OPENAI_CRON`, `STATUS_CRON`) must literally match wrangler.jsonc; a drifted one logs `unknown cron` and runs nothing. Ask a source's network only when it can matter (the npm dist-tag only once a feed has something newer).
- **openai.com pages are never fetched directly** — a plain fetch trips Cloudflare and earns a ~10h 403 (rungs: docs/openai-access.md). Anthropic press pages are the one direct fetch (non-Mozilla UAs 403; `BOT_UA`, src/html.ts).
- **Channels have live subscribers; post format is owner-approved.** Anything beyond the cron's normal job (force-post, repost, deletion, pin) needs the owner's yes for that exact action. Iterate with `dry=1`/`preview=1` — they touch no channel.
- **Everything is English** — posts, bot and channel descriptions, code comments, docs. Every prompt that generates post text must say so outright; one that doesn't has already shipped a post in another language.
- **Don't hardcode model bumps.** The digest model is resolved from `/v1/models` at runtime (src/summarize.ts).

Avatars and press images: docs/assets.md. Telegram bot lifecycle: the manage-telegram-bot skill. The `@alfred_service_account` user account, for what the Bot API refuses: the dev-creds skill.
