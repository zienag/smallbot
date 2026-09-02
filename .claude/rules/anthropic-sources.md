---
paths:
  - "src/blogs.ts"
  - "src/models.ts"
  - "src/codex.ts"
  - "src/changelog.ts"
  - "src/html.ts"
  - "src/npm.ts"
---

# Anthropic-side sources

## Blog watch → `@anthropic_blogs` (src/blogs.ts)

claude.com/anthropic.com have NO RSS (checked: all feed URLs 404) — the server-rendered index pages (`claude.com/blog`, `anthropic.com/news`, `anthropic.com/engineering`, ~13-25 links each, newest first) are the trigger; new urls vs `anthropic_blog_seen`, max 5 posts/tick, seen written after a successful post. A post is a link under the index's prefix OR a dated card (an `<a>` with a `<time>` inside) wherever it points — anthropic.com/news lists launches in its featured card off-prefix (`/claude-fable-and-mythos-5-1`, missed on 2026-09-01) and feature pages (`/features/…`); only that index dates its cards, the other two rely on the prefix. The card's date is the second gate (`MAX_BLOG_AGE_MS`, 14 days): a dated card older than that — a feature page the index keeps showing, a backfill — is absorbed into the seen-set silently; undated prefix links pass, those indexes list only recent posts. The indexes are fetched conditionally (src/conditional.ts): claude.com/blog honours If-Modified-Since and answers 304, anthropic.com sends no validators and is re-read every tick (~650 KB, unavoidable — no ETag, no Range). Don't use sitemap `lastmod` for novelty — old pages get mass-touched (all 248 news pages on one day). Article text: `<article>`, else `<main>` (claude.com posts have no `<article>`; their JSON-LD has no articleBody either).

One LLM call per post returns bullets + tier (code slices to 4 regardless of what the LLM returns); tier drives delivery via `sendTiered`: major → pin (`pinChatMessage`, failure swallowed — the post already went out; pin notifications are always silent in channels), minor → `disable_notification`.

**Tier criteria** (owner-specified, in `TIER_CRITERIA`, shared with the OpenAI blog watch): major = new models, new *consumer* products (enterprise/B2B/API-platform launches are explicitly NOT major), and potential breaking news that could escape the AI bubble (security incidents, lawsuits); case studies/partnerships/policy = minor, posted silently rather than dropped.

## Model watch → `@model_drops` (src/models.ts)

Diff `/v1/models` ids against `known_models` each tick, post additions (id, display name, date). Union-merge on write so a model temporarily missing from the API isn't re-announced later. Test hook: `/run?source=models&version=<model-id>&dry=1` force-announces one id (never touches KV; dry response includes the post text).

**Press-release enrichment**: for each new non-dated alias, try `anthropic.com/news/<alias>` (verified pattern for point releases: claude-opus-4-8, claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4-1); on 404 fall back to `sitemap.xml` (NOT the `/news` index — it only shows recent posts) scanning both `/news/claude-*` and top-level `/claude-*` slugs (the Fable 5.1 launch is `/claude-fable-and-mythos-5-1`): the slug must carry the family token and the model's version *exactly* as a numeric run (`slugNamesVersion`: `5-1` ≠ `5` — on 2026-09-01 the 5.1 model matched the Fable 5 launch page and posted three-month-old facts), `/news/` beats top-level, then freshest `lastmod`; `/news/claude-<major>` is the family launch of a major without its own page (`claude-4`). Extract `<article>` text, LLM-summarize — the prompt bans generic "smarter/benchmarks" claims and demands announcement-specific oddities with concrete numbers; the digest is caption-tight (≤4 bullets — code slices regardless of what the LLM returns — target <400 chars, model names in plain text, `<code>` only on the API id line). Enrichment failures are swallowed — the bare announcement still posts. anthropic.com 403s non-Mozilla user agents (`BOT_UA` in src/html.ts fixes it); Anthropic press pages are the only ones fetched directly, openai.com pages never are (docs/openai-access.md).

**Press images**: article `<img>`s (hero skipped by `heroImage` class, first srcSet URL = `/_next/image` proxy; request with `Accept: image/webp...` — otherwise it serves AVIF which vision API rejects). The launch template introduced with Fable 5.1 (2026-09) has no raster charts at all: charts are CMS objects (`_type: "chart"`, CSV + axes in the RSC payload) rendered to inline SVG coloured by page CSS, the benchmark table is HTML, and the post goes out text-only. Rasterizing was researched and declined by the owner — a browser screenshot of the page needs scripts to defeat the draw-in animation and hidden tabs, an SVG re-render imitates their CSS, and drawing our own charts from the data needs a rasterizer the free plan's CPU cap will not carry. Don't reopen without new facts. Latest sonnet alias picks up to 3 by importance (charts with axes > number tables > rest). Posted as ONE classic album (`sendMediaGroup`, digest as the first photo's caption, limit 1024); worker uploads the bytes itself — Telegram's fetcher fails anthropic.com's UA filter. No photos / caption over limit / album error → plain-text sendMessage. Bot API 10.1 rich messages (`sendRichMessage` + `<tg-slideshow>`) were tried and rejected: they render as an "article"-style message the owner hated, and t.me web preview can't show them at all.

## Codex source → `@codex_changelog` (src/codex.ts)

GitHub Releases *atom feed*, not the REST API — anonymous API quota (60 req/h/IP) is always exhausted on Cloudflare's shared egress IPs. Both this feed and the Claude Code changelog carry an ETag, so an unchanged feed costs a 304 instead of a 600 KB download (src/conditional.ts). Stable releases are tags `rust-vX.Y.Z` exactly (parse the `<id>`, not `<title>` — titles are inconsistent); alphas and `python-v*` are skipped. Release body HTML is flattened to text for the LLM; no blockquote in posts (body is PR-link noise), header links to the release page.
