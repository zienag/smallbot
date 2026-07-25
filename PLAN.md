# smallbot — a Telegram channel with Claude Code releases

Cloudflare Worker on a cron trigger: watches Claude Code releases, makes an LLM digest and posts it to a Telegram channel. Serverless, no VPS.

> This is the original design doc, kept as a record of the starting point. Parts of it no longer match the code — the verdict line was dropped from posts, the model is auto-resolved instead of a fixed constant, `/run` is POST-only with bearer auth, and the bot now watches four more sources. CLAUDE.md is the current truth.

## Verified facts about the sources (2026-07-18)

- `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` — public, no token. Format: `## X.Y.Z` headings + bulleted lists, newest first, no dates.
- npm registry: `https://registry.npmjs.org/@anthropic-ai/claude-code/latest` (small response) → the `version` field = the `latest` dist-tag. npm sometimes has versions with NO changelog entry (the `next` dist-tag runs ahead). So **the changelog is the source of truth**, npm is only a guard that a version really shipped (post only versions ≤ npm latest).
- Big releases (e.g. 2.1.212) run to 50+ bullets, and the full notes do NOT fit the Telegram message limit (4096 characters). Anchor for a version: `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21212` (dots stripped).

## Project layout

```
wrangler.jsonc          # cron "*/15 * * * *", KV binding RELEASES, vars
package.json            # typescript, wrangler, @anthropic-ai/sdk, vitest
tsconfig.json
src/
  index.ts              # scheduled handler (the pipeline) + fetch handler (manual trigger)
  changelog.ts          # fetch + parse `## X.Y.Z` → [{version, notes}]
  npm.ts                # read npm latest
  summarize.ts          # Claude API: digest + verdict
  telegram.ts           # build the post + sendMessage (HTML parse mode)
  version.ts            # semver comparator (~10 lines, no dependencies)
test/changelog.test.ts  # parser against a saved real changelog fragment
```

## Pipeline (every cron tick)

1. Fetch the changelog, parse the versions.
2. Read `lastPosted` from KV (key `last_posted_version`).
3. Candidates: `> lastPosted` (semver) and `<= npm latest`.
4. Post in chronological order, at most 5 per run.
5. Per version: digest → post → **only after a successful post** write the version to KV. An error at any step aborts the loop (the next tick resumes from the same place). This is what gives idempotency and catch-up after downtime.
6. First run (empty KV): post only the newest version, don't post history.

## Digest via the Claude API

- Model `claude-opus-4-8` (owner's call: the best model, and cheap at these volumes, ~4-5¢ per release). The id is a constant in one place; the alternative `claude-fable-5` needs extra handling for `stop_reason: "refusal"` — not needed by default.
- SDK `@anthropic-ai/sdk` (fetch-based, works in Workers without node_compat).
- The prompt is in English and states the output language explicitly; it asks for the 2-4 most important items for an active Claude Code user plus a one-line verdict on whether the release is worth taking.
- The exact call (checked against current docs — prior SDK knowledge is out of date):

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const response = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 2048, // headroom for thinking
  thinking: { type: "adaptive" },          // budget_tokens is rejected on opus-4-8 (400)
  output_config: {
    effort: "medium",
    format: {                              // structured outputs; NOT output_format (deprecated)
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          bullets: { type: "array", items: { type: "string" } },
          verdict: { type: "string" },
        },
        required: ["bullets", "verdict"],
        additionalProperties: false,
      },
    },
  },
  messages: [{ role: "user", content: prompt }],
});
// the reply: response.content is an array of blocks; the JSON sits in the first block with type === "text"
const text = response.content.find((b) => b.type === "text").text;
const { bullets, verdict } = JSON.parse(text);
```

- Do NOT pass `temperature`/`top_p`/`top_k` (400 on opus-4-8). Catch errors by type (`Anthropic.RateLimitError` and friends); on any error, don't post and don't touch KV.

## Post format (Telegram, parse_mode: "HTML")

```
<b>Claude Code 2.1.212</b>

• item 1
• item 2

Verdict: …

<blockquote expandable>full notes</blockquote>   ← if the whole message is ≤ ~4000 chars
<a href="…CHANGELOG.md#21212">Full notes</a>     ← otherwise
```

- API: `POST https://api.telegram.org/bot<TOKEN>/sendMessage`, body `{chat_id, text, parse_mode: "HTML", link_preview_options: {is_disabled: true}}`.
- Escape `<`, `>`, `&` in the note text.

## Configuration

- Secrets (`wrangler secret put`): `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `TRIGGER_SECRET`.
- Vars (wrangler.jsonc): `TELEGRAM_CHAT_ID` (a channel `@username` works), `DRY_RUN` (`"1"` → build the post, log it, send nothing, leave KV alone).
- KV: `wrangler kv namespace create RELEASES`.
- Cloudflare token / wrangler login — the global `dev-creds` skill (Keychain).

## Manual trigger

Fetch handler: `GET /run?secret=<TRIGGER_SECRET>` — the same pipeline off schedule; `&version=X` force-posts a specific version; `&dry=1` overrides dry-run. Locally: `wrangler dev --test-scheduled` + `curl http://localhost:8787/__scheduled`.

## What's needed from the owner (ask when we get there)

1. A bot from BotFather → token.
2. A channel with the bot as admin, and its chat id.
3. An Anthropic API key (or take it from dev-creds).

Until then everything is developed under DRY_RUN.

## Verification

1. `vitest`: the changelog parser against a real saved fragment.
2. `wrangler dev --test-scheduled` with DRY_RUN=1: the log shows the assembled post for the newest release; the first run posts exactly one version.
3. Force-post a small and a large version (`/run?version=…&dry=1`) to check both formats (expandable quote vs link).
4. Once the bot and channel exist: deploy, one real post via the force trigger, then cron.

## Implementation rules

- Do NOT load the claude-api skill again — everything needed from it is already carried over here (the SDK call, the model, the parameter restrictions).
- Run git init at the start of implementation.
