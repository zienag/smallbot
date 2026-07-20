import Anthropic from "@anthropic-ai/sdk";

// Known-good version: both the fallback and the API-surface baseline
// (adaptive thinking, structured outputs, no sampling params).
export const FALLBACK_MODEL = "claude-opus-4-8";

export interface Summary {
  bullets: string[];
}

/**
 * Freshest family alias from the model id list. Only aliases of the form
 * claude-<family>-N[-M...]; parts ≥1000 (dated snapshots) are dropped so that
 * claude-opus-4-5-20251101 doesn't win with "version" 20251101.
 */
export function pickLatestAlias(family: string, ids: string[]): string | null {
  const re = new RegExp(`^claude-${family}-(\\d+(?:-\\d+)*)$`);
  let best: { id: string; parts: number[] } | null = null;
  for (const id of ids) {
    const m = id.match(re);
    if (!m) continue;
    const parts = m[1].split("-").map(Number);
    if (parts.some((p) => p >= 1000)) continue;
    if (!best || compareParts(parts, best.parts) > 0) best = { id, parts };
  }
  return best?.id ?? null;
}

export function pickLatestOpus(ids: string[]): string | null {
  return pickLatestAlias("opus", ids);
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const MODEL_CACHE_KEY = "resolved_model";
const MODEL_CACHE_TTL_S = 86400; // re-check daily for a newer model

async function resolveModel(client: Anthropic, kv: KVNamespace, family: string): Promise<string> {
  const cacheKey = family === "opus" ? MODEL_CACHE_KEY : `resolved_model_${family}`;
  const cached = await kv.get(cacheKey);
  if (cached) return cached;
  try {
    const ids: string[] = [];
    for await (const model of client.models.list()) ids.push(model.id);
    const model = pickLatestAlias(family, ids) ?? FALLBACK_MODEL;
    await kv.put(cacheKey, model, { expirationTtl: MODEL_CACHE_TTL_S });
    return model;
  } catch (err) {
    console.log(`models.list failed, using ${FALLBACK_MODEL}: ${err}`);
    return FALLBACK_MODEL;
  }
}

const PROMPT = (product: string, version: string, notes: string) => `\
You are writing a short digest of a ${product} release for a Telegram channel \
whose readers are active daily users of ${product}.

Release version: ${version}

Release notes:
${notes}

Pick the 2-4 most important items for an active ${product} user (new \
capabilities and impactful fixes first; skip niche platform fixes). Each bullet \
is one short sentence. Wrap commands, flags, env vars, and other identifiers \
in backticks. Ignore auto-generated trailers like "Full Changelog" PR-link \
lists.`;

export async function summarize(
  apiKey: string,
  kv: KVNamespace,
  product: string,
  version: string,
  notes: string,
): Promise<Summary> {
  return summaryFromPrompt(apiKey, kv, PROMPT(product, version, notes));
}

const BULLETS_SCHEMA = {
  type: "object",
  properties: {
    bullets: { type: "array", items: { type: "string" } },
  },
  required: ["bullets"],
  additionalProperties: false,
};

export async function summaryFromPrompt(
  apiKey: string,
  kv: KVNamespace,
  prompt: string,
): Promise<Summary> {
  return structuredFromPrompt<Summary>(apiKey, kv, prompt, BULLETS_SCHEMA);
}

export async function structuredFromPrompt<T>(
  apiKey: string,
  kv: KVNamespace,
  prompt: string | Anthropic.ContentBlockParam[],
  schema: Record<string, unknown>,
  family = "opus",
): Promise<T> {
  const client = new Anthropic({ apiKey });
  const model = await resolveModel(client, kv, family);
  try {
    return await complete<T>(client, model, prompt, schema);
  } catch (err) {
    // A new version can break the call surface (like 4.6→4.7 removed
    // sampling params) — on 400, fall back to the known-good one.
    if (err instanceof Anthropic.BadRequestError && model !== FALLBACK_MODEL) {
      console.log(`${model} rejected the request (${err.message}), falling back to ${FALLBACK_MODEL}`);
      await kv.put(MODEL_CACHE_KEY, FALLBACK_MODEL, { expirationTtl: MODEL_CACHE_TTL_S });
      return await complete<T>(client, FALLBACK_MODEL, prompt, schema);
    }
    throw err;
  }
}

async function complete<T>(
  client: Anthropic,
  model: string,
  prompt: string | Anthropic.ContentBlockParam[],
  schema: Record<string, unknown>,
): Promise<T> {
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema },
    },
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text) throw new Error("no text block in model response");
  return JSON.parse(text.text) as T;
}
