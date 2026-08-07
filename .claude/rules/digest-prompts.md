---
paths:
  - "src/summarize.ts"
---

# Digests, prompts, model selection

## Prompts are motivation, not rules

Owner's call; matches Anthropic's "give judgement, not rules" guidance for the Claude 5 generation. Explain why the channel exists and what the reader's day looks like; never prescribe bullet counts or enumerate what counts as important.

Rules overfit whichever releases you happened to test on and break on the next shape — a cap of four made the model cram three facts into one bullet, a floor of two made it invent advice on an empty release, and neither survived a release of a different size. What works for the digest: nobody reads changelogs, the reader gives it ten seconds, the full changelog is one click away so completeness isn't the job, and an empty post reads as a glitch. Length then follows the release by itself (1 note item → 1 bullet, 109 → 9) and repeated runs agree.

Every prompt that generates post text must state the output language outright: dense English notes anchor the model on their own, but a release whose notes are a single line (`- Bug fixes and reliability improvements`) leaves nothing to anchor on, and then "Telegram channel" in the prompt is enough to drift the output into another language. 2.1.220 shipped that way.

## Prompt iteration costs real money

~2¢ per call; one debugging session burned ~$4 of the owner's balance on ~200 calls. Draft against three releases only — one huge, one mid, one bug-fixes-only — and show the owner the wording *before* spending calls on it. Run the wide 10-12 release sweep once, on the version you already believe in.

To iterate on digest wording, call the Anthropic API directly with the prompt from this file — much faster than a deploy-and-tail loop.

## How a prompt change is measured

By hand so far, one throwaway python script per round — worth turning into a real harness. Regex the prompt template out of src/summarize.ts so you exercise exactly what ships, fill it from the live CHANGELOG.md, fan the calls out through a thread pool, and print the shape — bullet count and total characters against the number of note items — before reading any text. Run one input two or three times: identical inputs disagreeing on length means the wording decides nothing.

What a bad prompt looks like: several facts crammed into one bullet (something is capping it), filler on a release with nothing in it (something is demanding a minimum), and phrases lifted verbatim out of the prompt into the output (delete that phrase rather than forbidding the output).

## Model selection

`pickLatestAlias(family)` takes the newest non-dated `claude-<family>-*` alias from `/v1/models`, cached in KV for a day (opus for text digests, sonnet for image picking); on a 400 from a new model the call retries on `FALLBACK_MODEL` (`claude-opus-4-8`) and pins it for the day. Don't hardcode model bumps — this is the whole point.

## `web_fetch` via the Anthropic API

`structuredFromPrompt(..., webFetch = true)`: `web_fetch_20250910` behind the `web-fetch-2025-09-10` beta header, capped at `max_content_tokens: 8000`. Use the dated tool, not `web_fetch_20260209` — the newer one runs code execution to filter the page and cost **21¢** against 7.6¢ for the same article. It composes with structured outputs. The call **must** verify a `web_fetch_tool_result` block came back: on a fetch failure the model still owes the schema and will happily invent bullets from the title.
