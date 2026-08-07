# Operating the worker

## `/run`

POST-only, auth via `Authorization: Bearer <TRIGGER_SECRET>` (never a query param — those end up in logs).

| param | effect |
|---|---|
| *(none)* | normal pipeline, all sources except status |
| `version=X` | force-post one version (never touches KV) |
| `source=claude\|codex\|models\|openai\|blog\|openai_blog\|openai_dev\|status` | which source the forced version/id/title/url-substring belongs to |
| `only=status` | run just the status tick (what the `*/5` cron does) |
| `dry=1\|0` | override `DRY_RUN` |

A dry run exercises the full pipeline including a real LLM call, posts nothing, and doesn't touch `last_posted_version`:

```sh
curl -X POST "https://smallbot.zienag.workers.dev/run?version=2.1.209&dry=1" \
  -H "Authorization: Bearer $(security find-generic-password -s smallbot -a trigger-secret -w)"
```

Dry responses carry the post text for every source except `claude`/`codex`, where the body is just `force-posted <source> <version> (dry)` and the post itself goes to `console.log` (i.e. `wrangler tail`).

## Deploy traps

**After `wrangler deploy` the old instance can keep serving `/run` for up to ~a minute** — a "fix didn't work" verdict right after deploying is unreliable (bit us twice), re-check before debugging.

**A newly added cron trigger can register but never fire.** The `*/5` cron added on 2026-07-27 was listed by the `/schedules` API yet produced zero invocations for a full day (per-minute GraphQL `workersInvocationsAdaptive` showed only `*/15` ticks), then came alive after the next day's redeploy re-put the schedule set. After adding a cron, don't trust the deploy output or the schedules listing — verify a real tick: `npx wrangler tail smallbot --format json` across a matching minute, or the per-minute GraphQL query.

**`--remote` needs `CLOUDFLARE_API_TOKEN` exported** or it dies on expired auth, and it authenticates `/run` against the **`.dev.vars` `TRIGGER_SECRET`**, which is not the Keychain one — reading the wrong one gets a bare `forbidden`.

## KV by hand

To re-trigger an already-seen model/news item for a real test:

```sh
npx wrangler kv key get/put --remote --namespace-id 2254c70148884faa8d27f6fd73e08e81 <key>
```

Remove the entry from the relevant seen-set (`known_models`, `openai_known_models`, `openai_blog_seen`, …). `--remote` is mandatory — without it wrangler hits an empty local simulator ("Value not found"). Prefer the `/run?source=…&version=…&dry=1` hooks — they render the same post without touching KV or the channel.
