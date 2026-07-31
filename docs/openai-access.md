# Reading openai.com from the worker

Why the OpenAI blog watch reads article pages through a browser instead of
fetching them, and what was measured to settle that. CLAUDE.md points here from
the OpenAI blog watch bullet.

## Which list is the news list

`news/rss.xml` is not the newsroom. It carries **every** page the site has ever
published — 1104 entries against the newsroom's 542 — and it is not append-only:
on 2026-07-31 OpenAI backfilled the case pages of its old "Disrupting malicious
uses of AI" reports, dated 2024 and 2025, and the channel posted nineteen of
them in half an hour. Two kinds of page live in the feed but not in the
newsroom: those case pages (44 of them) and the customer stories (102, "How X
uses Codex"). Neither carries a `<category>`, which is the feed's own tell.

The newsroom's list comes from the endpoint its "Load more" button calls:

```
openai.com/backend/articles/?locale=en-US
  &pageQueries=[{"pageTypes":["Article"],"categories":[…]}]
  &limit=30&skip=0&sort=new
```

JSON, Contentful-backed: `slug` (`index/<slug>`, what the feed link ends with),
`title`, `publicationDate`, `categories`, `seoFields.metaDescription`. `search=`
queries the whole set — `search=disrupting` returns 5 items, all the umbrella
reports, no case page among them.

Two parameters matter. **`locale`** decides the language of the titles and
follows the caller's IP when unset, so it is pinned to `en-US` — from Moscow the
page itself redirects to `/ru-RU/` and answers in Russian. **`categories`** is
the page's own list, copied verbatim; note `global-affairs-news-listed` rather
than plain `global-affairs`, which is how the site keeps some policy posts out
of the newsroom while the feed shows them all as "Global Affairs".

The endpoint is behind the same challenge as everything else here (no UA → 403
`cf-mitigated: challenge`, a real Chrome UA → 200) and it flaps from the worker
the way the article pages do: two force-runs minutes apart answered
`list=unreachable`, the next one `via=fetch`. So it cannot be the trigger. The
feed stays the trigger and the list is asked only when a tick has something to
post — once or twice a day, far short of what armed the block below.

Three rungs, reported as `via=` by the dry hook and the tick status, the same
shape as the digest's own ladder:

1. **plain fetch** with a real Chrome UA — free, and answers more often than the
   article pages do.
2. **the browser** — `quickAction("markdown")` on the same URL. It solves the
   challenge, and the JSON comes back fenced inside the markdown, so the parser
   digs out the first `{` … last `}`. One quick action, once or twice a day.
   **It spends the tick's quick-action slot**, so whoever runs next waits out
   `QUICK_ACTION_GAP_MS` — measured: back to back, the second call answers
   `429 {"code":2001,"message":"Rate limit exceeded"}`, and in a tick that
   would be the first article's digest silently dropping to the 7.6¢ rung.
   Both the post loop and the dry hook pace themselves off `via === "browser"`,
   and pay nothing when the plain fetch answered.
3. **the feed's own `<category>`** — present ⇒ listed. Free and never blocked.
   It agrees with the list on every edge checked, including the posts in neither
   ("Launching Sora responsibly", "Spring Update", "Stargate Infrastructure");
   the two part only on the non-listed Global Affairs posts, which this rung
   lets through.

An unreachable list decides nothing permanently: unlisted items are not written
to the seen-set, so the next tick reconsiders them, and the age gate absorbs
them a fortnight later.

## What is in the way

Article pages (`openai.com/index/<slug>`) sit behind a Cloudflare **JS
challenge**: the response is 403 with `cf-mitigated: challenge`. A client that
cannot run the challenge script never gets in, however good its headers — this
is not an IP-reputation problem and not a User-Agent problem.

Not an OpenAI policy either. `robots.txt` is `Allow: /`, and the developer half
of the company is deliberately machine-readable: developers.openai.com and
cookbook.openai.com sit on Vercel, answer any UA, and publish an `llms.txt` with
a markdown twin of every page. The challenge is one WAF setting in front of the
marketing hosts — openai.com, platform.openai.com, help.openai.com.

Never challenged, on any host: `news/rss.xml`, `robots.txt`, `sitemap.xml`.
That is why the feed worked all along.

## What was measured

| Attempt | Result |
|---|---|
| No UA, or `Accept: */*` alone, or `BOT_UA` (the literal "bot" in it) | 403 instantly |
| Real Chrome UA + full `sec-ch-*` set | 200 — for a while (see below) |
| `RSC: 1` (Next.js payload, `text/x-component`, ~282KB) | 200 in a good window, 403 in a bad one |
| Browser Run `quickAction("markdown")` | 200, ~13KB markdown, ~4s |
| Anthropic API `web_fetch` | 200, ~8.6s |
| r.jina.ai, web.archive.org | 429 "Per IP rate limit exceeded" — worker egress is shared account-wide |
| fivefilters full-text-rss | 0 chars extracted |
| Wayback snapshots | missing for some posts hours after publication |

**A plain fetch does not hold.** With a real Chrome UA, 17 fetches 30s apart all
returned the article; the 18th got the challenge, and it stayed blocked for
**~10 hours** — 0 of 12 probes at the cron's own 15-minute cadence, 40 quiet
minutes changed nothing, still 403 five hours after the last request. Across 17
hours of observation the page was reachable for one ~10-minute window. Probing
appears to keep the block armed, so back off entirely rather than retry.

**The browser passes even mid-block.** Measured inside an active block, in a
single request: our fetch 403 while `quickAction("markdown")` returned the
article. Same Cloudflare egress, so what is checked is solving the challenge,
not the IP.

## Why each rung is where it is

1. **`quickAction("markdown")`** (src/browser.ts) — free, ~4s, no client
   library: the binding plus a compatibility date ≥ 2026-03-24 is the whole
   requirement. Free plan allows **one quick action per 10 seconds** (firing two
   back to back returns `2001 Rate limit exceeded`) and 10 minutes of browser
   time a day, which is ~150 pages.
2. **`web_fetch` through the Anthropic API** — works because their fetcher is a
   signed agent Cloudflare verifies. ~7.6¢ a post, since the page lands in the
   request's input tokens. Details below.
3. **The feed's own sentence** — what the channel had before any of this.

`@cloudflare/puppeteer` was the other working candidate and lost on the
dependency (680KB, plus `nodejs_compat` and one new browser per 20s), not on
capability — `quickAction` does the same job with neither.

Two-step variants do not pay: having Haiku fetch and re-emit the article costs
2¢ (output tokens are 5× input) and the digest still costs 3.5¢ — 5.5¢ against
7.6¢ for one Opus call, for an extra round trip and ~34s.

## `web_fetch` mechanics

`structuredFromPrompt(..., webFetch = true)` sends `web_fetch_20250910` behind
the `web-fetch-2025-09-10` beta header, capped at `max_content_tokens: 8000`.

- Use the dated tool, **not** `web_fetch_20260209`: the newer one runs code
  execution to filter the page and cost **21¢** against 7.6¢ for the same
  article.
- It composes with structured outputs.
- The call **must** verify a `web_fetch_tool_result` block came back. On a fetch
  failure the model still owes the schema and will happily invent bullets from
  the title.

## The standards-track answer, for later

Cloudflare verifies **signed agents** — Web Bot Auth, HTTP Message Signatures
(RFC 9421): an Ed25519 key, a `Signature-Agent` header, a key directory at
`/.well-known/http-message-signatures-directory`. That is how Anthropic's
fetcher gets through, and hosting the directory on a worker is easy. The catch
is registration: the key must be submitted through Cloudflare's bot submission
form and accepted, so it is not a same-day option. Worth revisiting if the
browser path ever becomes a problem.
