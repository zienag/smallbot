---
paths:
  - "src/openai_news.ts"
  - "src/openai_dev.ts"
  - "src/openai_models.ts"
  - "src/browser.ts"
  - "src/hn.ts"
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

## The feed's blind spot → `@openai_blogs` (src/hn.ts, `watchOpenAiHn`)

**The feed does not carry every article.** On 2026-09-03 the GPT-6 Astra launch went up at `openai.com/index/gpt-6-astra` and was listed nowhere a reader of the site's own surfaces could find it: not in `news/rss.xml` (two hours after launch, while the same day's safety overview and Daybreak posts were there), not in the `/backend/articles/` list the newsroom renders, not in any of the 36 sitemaps — only in the homepage's featured block, which is server-rendered HTML behind the challenge. Every earlier launch (GPT-5.5, GPT-5.6, Sora 2, Rosalind) had been in the feed, so nothing in the pipeline could have known. The channel had the YouTube video and the safety overview and not the announcement.

The input that does not depend on OpenAI's CMS is Hacker News: the Algolia index (`hn.algolia.com/api/v1/search_by_date`, public, no key) answers a `query=openai.com` search filtered to `points>=30` and `created_at_i>=` three days back in one request, and the launch was there at 890 points within the hour. Measured over two weeks of openai.com and anthropic.com submissions the bar let through four stories, all launches; customer stories, status pages and policy posts sit under ten points.

Rules, in `watchOpenAiHn`, which runs right after the blog watch on the OpenAI tick:

- Candidates are HN stories whose url is under `openai.com/index/` (`articleCandidates`: https, no query, no trailing slash, the `/xx-XX/` locale segment stripped — people submit what they see), one per page at its best score.
- Not in `openai_blog_seen` (shared with the blog watch; the HN watch has no seen-set of its own, and a page it posts is thereby known to the feed path, the YouTube companion check and the news list logic). The blog watch seeds that key; until it has, the HN watch posts nothing.
- **Not in the feed at all.** A page the feed carries is the blog watch's call, gates and verdicts included — the HN watch fills the feed's hole, it never overrules its age gate or the newsroom's list. Because the feed carries every page the site ever published, "absent from the feed" also excludes an old page resubmitted to HN; the feed is asked only once a tick has an unseen candidate.
- Two per tick, oldest submission first, `QUICK_ACTION_GAP_MS` between them. The page is rendered through the browser and its first heading is the post title (`markdownTitle`; HN's wording is the fallback — submitters shorten titles), then the same browser → `web_fetch` → title-only rungs as the blog watch.

The first real catch was the Astra launch itself, posted by the 22:05 tick on 2026-09-03, an hour after the deploy.

Test hook: `/run?source=openai_hn&version=<openai.com url, or an HN title/url substring>&dry=1` — reports the title the page gave, the rung, and both gates' verdicts (`seen=`, `feed=`).

## Developer blog → `@openai_blogs` (src/openai_dev.ts)

The other half of the channel, mirroring how the Anthropic channel carries company news and engineering together. developers.openai.com sits on Vercel with no bot protection and publishes a markdown twin of every page, so this source needs neither a browser nor a UA: `blog/llms.txt` is the index (`- [Title](url.md): description`), the `.md` twin is the content, seen-set `openai_dev_blog_seen` keyed by url, max 5/tick, same digest prompt and tier.

The index is alphabetical, not chronological — novelty comes from the seen-set alone, and the first run seeds silently. `developers.openai.com/rss.xml` exists but covers all 138 docs pages with the docs' own `pubDate`s, not the blog; don't use it. Its content never overlaps the news feed (checked: zero shared titles).

Test hook: `/run?source=openai_dev&version=<title substring>&dry=1`.

## Model watch → `@model_drops` (src/openai_models.ts)

The same shape as the Anthropic one — diff `api.openai.com/v1/models` ids against `openai_known_models`, union-merge on write, first run seeds silently. Needs `OPENAI_API_KEY` (unset = source off); the key only ever reads this list. `ft:*` ids are the project's own fine-tunes, not releases.

The news RSS is **enrichment only**: `findAnnouncement` matches a new id to the article that announced it and the post carries that digest (same browser → `web_fetch` → feed-only rungs as the blog channel, capped at 2 articles/post ≈ one browser action or 7.6¢ each). No article found → the bare id list still posts. The feed used to be the *trigger*, with an LLM answering "is this item a model release?" — on 2026-07-29 it announced an engineering retrospective about a three-week-old model (t.me/model_drops/32), reproducibly, because the only inputs are a title and one description sentence and both read like a launch. A fact does not get inferred; the diff is the trigger and no prompt wording substitutes for it.

**Matching rule**: OpenAI names the model at the *head* of a launch title (`Introducing GPT-5.5`, `GPT-5.6: Frontier intelligence…`, `Previewing GPT-5.6 Sol`) and mid-title everywhere else (`How GPT-5.6 fuses…`), so the id must lead. Two boundaries matter: a right boundary keeps `gpt-5` off "GPT-5.5 System Card", and rejecting a capitalized continuation keeps `gpt-5.6` off "Previewing GPT-5.6 **Sol**" so it lands on the family launch instead. Variants that never get their own post (sol/terra/luna) fall back to progressively shorter id prefixes; when no title names the model or its family plainly, the capitalized-continuation rule is dropped and a sibling's launch stands in — GPT-6 launched as "GPT-6 Astra" with no plain GPT-6 post, and on 2026-09-22 `gpt-6-sol`/`gpt-6-luna` posted bare because of that. Titles write the model with a non-breaking hyphen (U+2011) about a third of the time; it is normalized before matching. System cards are skipped, oldest match wins among items up to 45 days old by `<pubDate>` (by date, not count: the newsroom's rate swings between one and six posts a day, and a count of 40 had already dropped the 19-day-old GPT-6 launch that day). The pattern cannot read a name the newsroom spells its own way (`gpt-image-2.5-*` vs "Introducing ChatGPT Images 2.5") or a launch that puts the model mid-title ("Build more natural voice experiences with GPT‑Live‑1 in the API"), so when it finds nothing, `pickAnnouncement` asks sonnet: the same 45-day candidates, numbered, and the answer is a number or 0 — it chooses among real posts, it cannot invent one, and the tick status says `picked by model`. This is enrichment, not the trigger, which is why an LLM is allowed here where the "is this a release?" question was not: a wrong pick attaches the wrong article to a true announcement, it never invents an announcement. Checked on the 2026-09-22 feed: all three misses above resolved to their launch posts and an id that exists nowhere (`gpt-7-nova`) got 0. One sonnet call per unmatched id, under a cent, a few times a month.

Test hook: `/run?source=openai&version=<model id>&dry=1` — shows which article the id matched, which rung ran, and the post text.
