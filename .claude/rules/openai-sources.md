---
paths:
  - "src/openai_news.ts"
  - "src/openai_dev.ts"
  - "src/openai_models.ts"
  - "src/browser.ts"
---

# OpenAI sources

## News feed → `@openai_blogs` (src/openai_news.ts)

Same RSS as the model watch but its own seen-set (`openai_blog_seen`).

**The feed is not the newsroom and it is not append-only** — it is every page the site ever published (1104 entries against the newsroom's 542), and on 2026-07-31 OpenAI backfilled the case pages of its 2024-2025 "Disrupting malicious uses of AI" reports, which the channel posted nineteen of in half an hour because seen-set membership was the only novelty signal. Two gates now stand between the feed and a post:

- **Age**: `isRecent`, 14 days off `<pubDate>` (undated counts as stale — all 1104 entries carry one); anything older is absorbed into the seen-set silently, so a backfill of any shape is stopped, not just this one.
- **The news list**: `fetchNewsListSlugs` reads what openai.com/news itself renders, from the endpoint its "Load more" button calls, and only listed articles post — this is what keeps out the case pages and the customer stories, neither of which the newsroom shows. Asked only when a tick has a candidate (once or twice a day), never every tick, because frequent requests are what arm the challenge. Its own three rungs and the pinned `locale`/`categories` parameters are in docs/openai-access.md; when no rung answers, the feed's `<category>` stands in (present ⇒ listed) and unlisted items are left out of the seen-set so nothing is suppressed permanently. An "unlisted" verdict is held per guid in `openai_unlisted` for `UNLISTED_RECHECK_MS` (6h): before that, five unlisted case pages kept the tick asking the list every 15 minutes for a fortnight — the request rate the rule above exists to avoid. An unreachable list holds nothing, so it is re-asked next tick.

Reading the list through the browser rung **spends the quick-action slot**, so the post loop waits `QUICK_ACTION_GAP_MS` before its first digest when `via === "browser"` — without that the first article of the tick answers 429 and falls to the 7.6¢ rung.

The RSS carries only a one-sentence `<description>` (no `content:encoded`), and the article page itself is behind a Cloudflare JS challenge, so the text comes from a real browser: `quickAction("markdown")` on the `BROWSER` binding (src/browser.ts — no client library, just the binding and a compatibility date ≥ 2026-03-24), then the same digest prompt as the Anthropic blog watch. Three rungs, each a fallback for the one above, reported by the dry hook and the tick status as `via=`: `browser` (free), `web_fetch` (the model fetches the page itself — `digestArticleByUrl`, ~7.6¢), `feed only` (title+description, tier from `classifyTier`). A post always goes out; only its depth degrades.

The free plan allows **one quick action per 10 seconds**, so the post loop sleeps `QUICK_ACTION_GAP_MS` between items. **Don't replace the browser with a plain fetch** — measured, it holds for minutes and then 403s for ~10 hours; that and the rest of the evidence is in docs/openai-access.md.

## Developer blog → `@openai_blogs` (src/openai_dev.ts)

The other half of the channel, mirroring how the Anthropic channel carries company news and engineering together. developers.openai.com sits on Vercel with no bot protection and publishes a markdown twin of every page, so this source needs neither a browser nor a UA: `blog/llms.txt` is the index (`- [Title](url.md): description`), the `.md` twin is the content, seen-set `openai_dev_blog_seen` keyed by url, max 5/tick, same digest prompt and tier.

The index is alphabetical, not chronological — novelty comes from the seen-set alone, and the first run seeds silently. `developers.openai.com/rss.xml` exists but covers all 138 docs pages with the docs' own `pubDate`s, not the blog; don't use it. Its content never overlaps the news feed (checked: zero shared titles).

Test hook: `/run?source=openai_dev&version=<title substring>&dry=1`.

## Model watch → `@model_drops` (src/openai_models.ts)

The same shape as the Anthropic one — diff `api.openai.com/v1/models` ids against `openai_known_models`, union-merge on write, first run seeds silently. Needs `OPENAI_API_KEY` (unset = source off); the key only ever reads this list. `ft:*` ids are the project's own fine-tunes, not releases.

The news RSS is **enrichment only**: `findAnnouncement` matches a new id to the article that announced it and the post carries that digest (same browser → `web_fetch` → feed-only rungs as the blog channel, capped at 2 articles/post ≈ one browser action or 7.6¢ each). No article found → the bare id list still posts. The feed used to be the *trigger*, with an LLM answering "is this item a model release?" — on 2026-07-29 it announced an engineering retrospective about a three-week-old model (t.me/model_drops/32), reproducibly, because the only inputs are a title and one description sentence and both read like a launch. A fact does not get inferred; the diff is the trigger and no prompt wording substitutes for it.

**Matching rule**: OpenAI names the model at the *head* of a launch title (`Introducing GPT-5.5`, `GPT-5.6: Frontier intelligence…`, `Previewing GPT-5.6 Sol`) and mid-title everywhere else (`How GPT-5.6 fuses…`), so the id must lead. Two boundaries matter: a right boundary keeps `gpt-5` off "GPT-5.5 System Card", and rejecting a capitalized continuation keeps `gpt-5.6` off "Previewing GPT-5.6 **Sol**" so it lands on the family launch instead. Variants that never get their own post (sol/terra/luna) fall back to progressively shorter id prefixes. System cards are skipped, oldest match in the newest 40 feed items wins (~30 days; a preview from 34 days back is already out of reach, which is fine — enrichment, not the trigger).

Test hook: `/run?source=openai&version=<model id>&dry=1` — shows which article the id matched, which rung ran, and the post text.
