# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cloudflare Worker (cron `*/15`) that watches release feeds and posts digests to Telegram channels as `@bipozavr_bot`. Sources (src/index.ts): Claude Code (CHANGELOG.md → `@claudecode_changelog`), Codex (GitHub Releases atom feed → `@codex_changelog`), and a new-models watch → `@model_drops` (Anthropic `/v1/models` diff + OpenAI news RSS, LLM-classified). A source whose chat-id var is unset is simply off. PLAN.md is the original design doc — partially stale (the verdict line was dropped from posts; the model is now auto-resolved, not a fixed constant).

## Commands

```sh
npm test                    # vitest — parser/format/version tests on a real changelog fixture
npx vitest run -t "name"    # single test
npm run typecheck           # src only (workers-types globals)
npx tsc --noEmit -p test    # test/ has its OWN tsconfig — check both
npm run dev                 # wrangler dev --test-scheduled (local, DRY_RUN=1 via .dev.vars)
curl 'http://localhost:8787/__scheduled?cron=*/15+*+*+*+*'   # fire a cron tick locally
```

Two tsconfigs are deliberate: src uses `@cloudflare/workers-types` globals, test/ uses node types. Merging them breaks on the conflicting global `URL` type — don't.

## Secrets & deploy

All credentials live in macOS Keychain (never in the repo; `.dev.vars` is generated and gitignored):

| service | account | what |
|---|---|---|
| `anthropic` | `api-key-smallbot` | Anthropic API key |
| `telegram` | `bot-token-smallbot` | Bot token |
| `smallbot` | `trigger-secret` | `/run` endpoint secret |
| `cloudflare` | `api-token-smallbot` | scoped deploy token (Workers + KV) |

Read with `security find-generic-password -s <service> -a <account> -w`.

Deploy:

```sh
export CLOUDFLARE_API_TOKEN=$(security find-generic-password -s cloudflare -a api-token-smallbot -w)
export CLOUDFLARE_ACCOUNT_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts" | python3 -c "import json,sys; print(json.load(sys.stdin)['result'][0]['id'])")
npx wrangler deploy
```

Prod verification (dry-run exercises the full pipeline including a real LLM call, posts nothing, doesn't touch `last_posted_version`):

```sh
curl "https://smallbot.zienag.workers.dev/run?secret=$(security find-generic-password -s smallbot -a trigger-secret -w)&version=2.1.209&dry=1"
```

`/run` params: no `version` → normal pipeline (all sources); `version=X` → force-post one version (never touches KV); `source=claude|codex` → which feed the forced version belongs to; `dry=1|0` → override DRY_RUN.

## Architecture invariants

Pipeline per tick (src/index.ts), per feed source: fetch releases → candidates are versions `> <source>_last_posted_version` (KV) **and** `<= npm latest` (npm dist-tag guards against entries that aren't actually released: `@anthropic-ai/claude-code` / `@openai/codex`) → post oldest-first, max 5 per tick. Sources are isolated: one failing doesn't block the others.

- **KV is written only after a successful Telegram post.** An error aborts that source's loop; the next tick resumes from the same place. This is the idempotency/catch-up mechanism — don't reorder it.
- First run (empty KV) posts only the newest release, not history. Same for the model watch: first run seeds `known_models` silently.
- KV keys: `last_posted_version` (claude), `codex_last_posted_version`, `known_models` (JSON id array), `resolved_model` (24h TTL cache).
- **Codex source** (src/codex.ts): GitHub Releases *atom feed*, not the REST API — anonymous API quota (60 req/h/IP) is always exhausted on Cloudflare's shared egress IPs. Stable releases are tags `rust-vX.Y.Z` exactly (parse the `<id>`, not `<title>` — titles are inconsistent); alphas and `python-v*` are skipped. Release body HTML is flattened to text for the LLM; no blockquote in posts (body is PR-link noise), header links to the release page.
- **Model watch, Anthropic** (src/models.ts): diff `/v1/models` ids against `known_models` each tick, post additions (id, display name, date). Union-merge on write so a model temporarily missing from the API isn't re-announced later. Test hook: `/run?source=models&version=<model-id>&dry=1` force-announces one id (never touches KV; dry response includes the post text).
- **Model watch, OpenAI** (src/openai_news.ts): no API key, and openai.com pages are 403-blocked — the open RSS (`openai.com/news/rss.xml`, full history ~1k items) is both trigger and content. New guids vs `openai_news_seen` (max 8 LLM calls/tick), each classified by the LLM ("is this a model release?" — feed categories are inconsistent, don't trust them); positives post title+description+link. Guid marked seen right after processing (posted or rejected). Test hook: `/run?source=openai&version=<title substring>&dry=1` shows the classification verdict and post text.
- **Press-release enrichment** (src/models.ts): for each new non-dated alias, try `anthropic.com/news/<alias>` (verified pattern for point releases: claude-opus-4-8, claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4-1); on 404 fall back to `sitemap.xml` (NOT the `/news` index — it only shows recent posts) matching a `claude-*` slug with family token + major version, freshest `lastmod` wins (family launches use combined slugs: `claude-4`, `claude-fable-5-mythos-5`). Extract `<article>` text, LLM-summarize into bullets — the prompt bans generic "smarter/benchmarks" claims and demands announcement-specific oddities with concrete numbers. Enrichment failures are swallowed — the bare announcement still posts. anthropic.com 403s non-Mozilla user agents (`BOT_UA` in src/html.ts fixes it); OpenAI press pages are NOT fetchable at all (403 even with a browser UA).
- **Press images** (src/models.ts): article `<img>`s (hero skipped by `heroImage` class, first srcSet URL = `/_next/image` proxy; request with `Accept: image/webp...` — otherwise it serves AVIF which vision API rejects). Latest sonnet alias (cache `resolved_model_sonnet`) picks up to 3 by importance (charts with axes > number tables > rest). Posted as ONE message via `sendRichMessage` (Bot API 10.1+ rich messages): text paragraphs + `<tg-slideshow>` carousel with `tg://photo?id=` refs to attached bytes (worker uploads them itself — Telegram's fetcher fails anthropic.com's UA filter). In rich HTML newlines are real HTML: `\n\n` → `<p>`, `\n` → `<br/>`. On rich failure falls back to plain-text sendMessage (logged).
- **Channel descriptions** cross-reference sibling channels (set via `setChatDescription`; keep the "Bipozavr … Beep!" voice). Update all of them when a new channel is added.
- **Model selection** (src/summarize.ts): newest `claude-opus-*` alias from `/v1/models` (dated snapshots filtered out), cached in KV for a day; on a 400 from a new model the call retries on `FALLBACK_MODEL` (`claude-opus-4-8`) and pins it for the day. Don't hardcode model bumps — this is the whole point.
- **Post format** (src/telegram.ts): HTML parse mode; header is bold with the version linked to the changelog anchor (dots stripped: `#21212`); LLM bullets use backticks which `formatInline` converts to `<code>` *after* escaping; full notes go in `<blockquote expandable>` only if the message fits ~4000 chars **and** the notes have more lines than the summary has bullets (otherwise the quote just duplicates the bullets — bit us on single-item releases), else header link suffices. No verdict line, no emoji in the header (both removed by owner request).
- All user-facing text (posts, bot/channel descriptions) is **English**.

## Assets

Avatars are SVG sources in `.claude.local.temp/` (gitignored), rendered via headless Chrome (`--force-device-scale-factor=2`, opaque full-square background — transparent corners produce JPEG artifacts in Telegram). Uploads via bot API (`setMyProfilePhoto` / `setChatPhoto`) — use Python multipart; sandboxed curl can't read local files for `-F`. Show drafts to the owner before uploading anywhere.
