# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cloudflare Worker (crons `*/15` and `*/5`) that watches release feeds and posts digests to Telegram channels as `@bipozavr_bot`. Wiring is in src/index.ts; a source whose chat-id var is unset is simply off.

| source | code | channel |
|---|---|---|
| Claude Code CHANGELOG.md | src/changelog.ts | `@claudecode_changelog` |
| Codex GitHub releases (atom) | src/codex.ts | `@codex_changelog` |
| new models, Anthropic + OpenAI | src/models.ts, src/openai_models.ts | `@model_drops` |
| Anthropic news + engineering | src/blogs.ts | `@anthropic_blogs` |
| OpenAI news + developer blog | src/openai_news.ts, src/openai_dev.ts | `@openai_blogs` |
| Anthropic incidents | src/status.ts, src/status_bot.ts | `@anthropic_status` |

Each blog channel carries one company's news and its technical writing together, reposted with an LLM importance tier (major = pin, normal, minor = silent). The incident watch is the only source with no LLM in it and the only one on its own bot, `@anthropic_status_watch_bot`.

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
curl 'http://localhost:8787/__scheduled?cron=*/15+*+*+*+*'   # fire a cron tick locally
npx wrangler dev --remote   # runs on the edge: the only way to exercise the BROWSER binding
```

Two tsconfigs are deliberate: src uses `@cloudflare/workers-types` globals, test/ uses node types. Merging them breaks on the conflicting global `URL` type — don't.

Prod verification, `/run` params, KV surgery and the deploy traps (a redeploy serves stale for ~a minute; a newly added cron can register yet never fire) are in docs/operations.md.

## Secrets & deploy

All credentials live in macOS Keychain (never in the repo; `.dev.vars` is generated and gitignored):

| service | account | what |
|---|---|---|
| `anthropic` | `api-key-smallbot` | Anthropic API key |
| `openai` | `api-key-smallbot` | OpenAI key — only ever reads `/v1/models` (service account `smallbot` in the Default project; the Admin API can mint service accounts, not plain project keys) |
| `telegram` | `bot-token-smallbot` | Bot token |
| `smallbot` | `trigger-secret` | `/run` endpoint secret |
| `smallbot` | `archive-read-secret` | `/archive` read-only token — deliberately not the trigger secret: a leak can read the archive, never post |
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
- **First run (empty KV) posts only the newest item, not history.** Same for every seen-set: the first tick seeds silently.
- **A feed's own novelty signal is not enough** — a seen-set alone will replay whatever a publisher backfills. Every watch pairs it with a second gate (age, an npm dist-tag, the newsroom's own list, an API diff), and a fact is never inferred by an LLM from a title.
- KV keys: `last_posted_version` (claude), `codex_last_posted_version`, `known_models` / `openai_known_models` (JSON id arrays), `openai_blog_seen` (JSON guid array), `anthropic_blog_seen` / `openai_dev_blog_seen` (JSON url arrays), `status_incidents` (JSON incident-id → `{messageId, postedUpdates}`), `status_subs:<incident id>` (JSON chat-id arrays), `resolved_model` / `resolved_model_sonnet` (24h TTL caches).
- **Every channel action (send/edit/pin/unpin) is archived to D1** (`ARCHIVE` binding, src/archive.ts) right after the Telegram call succeeds, and served read-only at `/archive` under its own token. The write is best-effort by design — a failed insert must not abort the source loop, since a retry would repost to the live channel. 30-day retention, pruned on write; details in docs/operations.md.
- **The status watch runs on its own `*/5` cron, outside `runPipeline`** — the two schedules coincide every 15 minutes and would race on one KV key. `STATUS_CRON` in src/index.ts must match the string in wrangler.jsonc literally; a drift silently kills the channel.
- **openai.com pages are never fetched directly** — the newsroom is behind a Cloudflare challenge and a plain fetch earns a ~10h 403. Evidence and the working rungs: docs/openai-access.md. Anthropic press pages are the one thing fetched directly (they 403 non-Mozilla UAs; `BOT_UA` in src/html.ts).
- **The channels have live subscribers, and post format is owner-approved.** Anything that is not the cron doing its normal job — a force-post, a repost of old items, a deletion, a pin — needs the owner's yes for that exact action; `dry=1` renders the same post and publishes nothing, so iterate there.
- **Everything is English** — posts, bot and channel descriptions, code comments, docs. Every prompt that generates post text must say so outright; one that doesn't has already shipped a post in another language.
- **Don't hardcode model bumps.** The digest model is resolved from `/v1/models` at runtime (src/summarize.ts).

Avatars and press images: docs/assets.md. Telegram bot lifecycle: the manage-telegram-bot skill. The `@alfred_service_account` user account, for what the Bot API refuses: the dev-creds skill.
