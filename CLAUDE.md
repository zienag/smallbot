# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cloudflare Worker (cron `*/15`) that watches release feeds and posts digests to Telegram channels as `@bipozavr_bot`. Sources (src/index.ts): Claude Code (CHANGELOG.md → `@claudecode_changelog`), Codex (GitHub Releases atom feed → `@codex_changelog`), a new-models watch → `@model_drops` (Anthropic `/v1/models` diff + OpenAI news RSS, LLM-classified), and two blog watches: Anthropic-verse (src/blogs.ts: claude.com/blog + anthropic.com/news + /engineering → `@anthropic_blogs`) and the full OpenAI news feed (src/openai_news.ts → `@openai_blogs`), each reposting everything with an LLM importance tier (major = pin, normal, minor = silent). A source whose chat-id var is unset is simply off. PLAN.md is the original design doc — partially stale (the verdict line was dropped from posts; the model is now auto-resolved, not a fixed constant).

## Commands

```sh
npm test                    # vitest — parser/format/version tests on a real changelog fixture
                            # no vitest config: it collects EVERY *.test.ts in the repo,
                            # including scratch files under .claude.local.temp/
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
curl -X POST "https://smallbot.zienag.workers.dev/run?version=2.1.209&dry=1" \
  -H "Authorization: Bearer $(security find-generic-password -s smallbot -a trigger-secret -w)"
```

`/run` is POST-only, auth via `Authorization: Bearer <TRIGGER_SECRET>` (never a query param — those end up in logs). Params: no `version` → normal pipeline (all sources); `version=X` → force-post one version (never touches KV); `source=claude|codex|models|openai|blog|openai_blog` → which source the forced version/id/title/url-substring belongs to; `dry=1|0` → override DRY_RUN. Dry responses carry the post text only for `blog`, `openai_blog` and `models`; for `claude`/`codex` the body is just `force-posted <source> <version> (dry)` and the post itself goes to `console.log` (i.e. `wrangler tail`). To iterate on digest wording, call the Anthropic API directly with the prompt from `src/summarize.ts` — much faster than a deploy-and-tail loop.

After `wrangler deploy` the old instance can keep serving `/run` for up to ~a minute — a "fix didn't work" verdict right after deploying is unreliable (bit us twice), re-check before debugging.

To re-trigger an already-seen model/news item for a real test: `wrangler kv key get/put --remote --namespace-id 2254c70148884faa8d27f6fd73e08e81` and remove the id from `known_models` / the guid from `openai_news_seen`. `--remote` is mandatory — without it wrangler hits an empty local simulator ("Value not found").

## Architecture invariants

Pipeline per tick (src/index.ts), per feed source: fetch releases → candidates are versions `> <source>_last_posted_version` (KV) **and** `<= npm latest` (npm dist-tag guards against entries that aren't actually released: `@anthropic-ai/claude-code` / `@openai/codex`) → post oldest-first, max 5 per tick. Sources are isolated: one failing doesn't block the others.

- **KV is written only after a successful Telegram post.** An error aborts that source's loop; the next tick resumes from the same place. This is the idempotency/catch-up mechanism — don't reorder it.
- First run (empty KV) posts only the newest release, not history. Same for the model watch: first run seeds `known_models` silently.
- KV keys: `last_posted_version` (claude), `codex_last_posted_version`, `known_models` (JSON id array), `openai_news_seen` / `openai_blog_seen` (JSON guid arrays), `anthropic_blog_seen` (JSON url array), `resolved_model` / `resolved_model_sonnet` (24h TTL caches).
- **Codex source** (src/codex.ts): GitHub Releases *atom feed*, not the REST API — anonymous API quota (60 req/h/IP) is always exhausted on Cloudflare's shared egress IPs. Stable releases are tags `rust-vX.Y.Z` exactly (parse the `<id>`, not `<title>` — titles are inconsistent); alphas and `python-v*` are skipped. Release body HTML is flattened to text for the LLM; no blockquote in posts (body is PR-link noise), header links to the release page.
- **Model watch, Anthropic** (src/models.ts): diff `/v1/models` ids against `known_models` each tick, post additions (id, display name, date). Union-merge on write so a model temporarily missing from the API isn't re-announced later. Test hook: `/run?source=models&version=<model-id>&dry=1` force-announces one id (never touches KV; dry response includes the post text).
- **Model watch, OpenAI** (src/openai_news.ts): no API key, and openai.com pages are 403-blocked — the open RSS (`openai.com/news/rss.xml`, full history ~1k items) is both trigger and content. New guids vs `openai_news_seen` (max 8 LLM calls/tick), each classified by the LLM ("is this a model release?" — feed categories are inconsistent, don't trust them); positives post title+description+link. Guid marked seen right after processing (posted or rejected). Test hook: `/run?source=openai&version=<title substring>&dry=1` shows the classification verdict and post text.
- **Blog watch** (src/blogs.ts): claude.com/anthropic.com have NO RSS (checked: all feed URLs 404) — the server-rendered index pages (`claude.com/blog`, `anthropic.com/news`, `anthropic.com/engineering`, ~13-25 links each, newest first) are the trigger; new urls vs `anthropic_blog_seen`, max 5 posts/tick, seen written after a successful post. Don't use sitemap `lastmod` for novelty — old pages get mass-touched (all 248 news pages on one day). Article text: `<article>`, else `<main>` (claude.com posts have no `<article>`; their JSON-LD has no articleBody either). One LLM call per post returns bullets + tier (code slices to 4 regardless of what the LLM returns); tier drives delivery via `sendTiered`: major → pin (`pinChatMessage`, failure swallowed — the post already went out; pin notifications are always silent in channels), minor → `disable_notification`. Tier criteria (owner-specified, in `TIER_CRITERIA`, shared with the OpenAI blog watch): major = new models, new *consumer* products (enterprise/B2B/API-platform launches are explicitly NOT major), and potential breaking news that could escape the AI bubble (security incidents, lawsuits); case studies/partnerships/policy = minor, posted silently rather than dropped.
- **OpenAI blog watch** (src/openai_news.ts): same RSS as the model watch but its own seen-set (`openai_blog_seen`), reposts *every* item (title+description+link — pages are unfetchable), LLM assigns only the tier.
- **Press-release enrichment** (src/models.ts): for each new non-dated alias, try `anthropic.com/news/<alias>` (verified pattern for point releases: claude-opus-4-8, claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4-1); on 404 fall back to `sitemap.xml` (NOT the `/news` index — it only shows recent posts) matching a `claude-*` slug with family token + major version, freshest `lastmod` wins (family launches use combined slugs: `claude-4`, `claude-fable-5-mythos-5`). Extract `<article>` text, LLM-summarize — the prompt bans generic "smarter/benchmarks" claims and demands announcement-specific oddities with concrete numbers; the digest is caption-tight (≤4 bullets — code slices regardless of what the LLM returns — target <400 chars, model names in plain text, `<code>` only on the API id line). Enrichment failures are swallowed — the bare announcement still posts. anthropic.com 403s non-Mozilla user agents (`BOT_UA` in src/html.ts fixes it); OpenAI press pages are NOT fetchable at all (403 even with a browser UA).
- **Press images** (src/models.ts): article `<img>`s (hero skipped by `heroImage` class, first srcSet URL = `/_next/image` proxy; request with `Accept: image/webp...` — otherwise it serves AVIF which vision API rejects). Latest sonnet alias picks up to 3 by importance (charts with axes > number tables > rest). Posted as ONE classic album (`sendMediaGroup`, digest as the first photo's caption, limit 1024); worker uploads the bytes itself — Telegram's fetcher fails anthropic.com's UA filter. No photos / caption over limit / album error → plain-text sendMessage. Bot API 10.1 rich messages (`sendRichMessage` + `<tg-slideshow>`) were tried and rejected: they render as an "article"-style message the owner hated, and t.me web preview can't show them at all.
- **Channel descriptions** cross-reference sibling channels (set via `setChatDescription`; keep the "Bipozavr … Beep!" voice). Update all of them when a new channel is added.
- **Model selection** (src/summarize.ts): `pickLatestAlias(family)` takes the newest non-dated `claude-<family>-*` alias from `/v1/models`, cached in KV for a day (opus for text digests, sonnet for image picking); on a 400 from a new model the call retries on `FALLBACK_MODEL` (`claude-opus-4-8`) and pins it for the day. Don't hardcode model bumps — this is the whole point.
- **Post format** (src/telegram.ts): HTML parse mode; header is bold with the version linked to the changelog anchor (dots stripped: `#21212`); LLM bullets use backticks which `formatInline` converts to `<code>` *after* escaping; full notes go in `<blockquote expandable>` only if the message fits ~4000 chars **and** the notes have more lines than the summary has bullets (otherwise the quote just duplicates the bullets — bit us on single-item releases), else header link suffices. No verdict line, no emoji in the header (both removed by owner request).
- **Post format is owner-approved.** Don't deploy a change to how posts look; iterate by hand-sending drafts to the real channel via bot API (python multipart, no LLM calls, `[TEST X]` markers, delete after) and deploy only the approved variant. The bot can't read channel history, so a message id for `deleteMessage` comes from the public web view — `t.me/s/<channel>` carries `data-post="<channel>/<id>"`.
- All user-facing text (posts, bot/channel descriptions) is **English**. Code comments too — the owner explicitly banned Russian in the repo. Every prompt that generates post text must say so outright: dense English notes anchor the model by themselves, but a release whose notes are a single line (`- Bug fixes and reliability improvements`) leaves nothing to anchor on, and "Telegram channel" in the prompt then pulls it into Russian — 2.1.220 shipped that way.
- **Prompts are motivation, not rules** (owner's call; matches Anthropic's "give judgement, not rules" guidance for the Claude 5 generation). Explain why the channel exists and what the reader's day looks like; never prescribe bullet counts or enumerate what counts as important. Rules overfit whichever releases you happened to test on and break on the next shape — a cap of four made the model cram three facts into one bullet, a floor of two made it invent advice on an empty release, and neither survived a release of a different size. What works for the digest: nobody reads changelogs, the reader gives it ten seconds, the full changelog is one click away so completeness isn't the job, and an empty post reads as a glitch. Length then follows the release by itself (1 note item → 1 bullet, 109 → 9) and repeated runs agree.
- **Prompt iteration costs real money** (~2¢ per call; one debugging session burned ~$4 of the owner's balance on ~200 calls). Draft against three releases only — one huge, one mid, one bug-fixes-only — and show the owner the wording *before* spending calls on it. Run the wide 10-12 release sweep once, on the version you already believe in.

## Assets

Avatars are SVG sources in `.claude.local.temp/` (gitignored), rendered via headless Chrome (`--force-device-scale-factor=2`, opaque full-square background — transparent corners produce JPEG artifacts in Telegram). Uploads via bot API (`setMyProfilePhoto` / `setChatPhoto`) — use Python multipart; sandboxed curl can't read local files for `-F`. Show drafts to the owner before uploading anywhere. Blog-channel avatars use a "drop cap" layout (company logo as an old-book initial, gray text-line bars wrapping around) — don't redraw brand marks by hand, take the official SVGs (Claude spark: claude.com/favicon.svg; OpenAI blossom: saved as blossom-white.svg); keep content within the inscribed circle — Telegram crops avatars round.
