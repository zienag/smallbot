import { decodeHTML } from "entities";
import { type Validators, conditionalFetch } from "./conditional";
import { htmlToText } from "./html";
import { compareVersions } from "./version";

// The repo's CHANGELOG.md is a stub ("see releases"); the real source is GitHub
// Releases. Atom feed instead of the REST API: the API's anonymous quota is
// 60 req/h per IP, always exhausted on Cloudflare's shared egress IPs.
export const CODEX_RELEASES_ATOM_URL = "https://github.com/openai/codex/releases.atom";

export interface CodexRelease {
  version: string;
  url: string;
  notes: string;
}

/**
 * Stable CLI releases only: tags rust-vX.Y.Z with no suffix. Drops alphas
 * (rust-v...-alpha.N) and python-v* (a different artifact). The tag comes from
 * <id> — release <title>s are inconsistent. Result: newest first.
 */
export function parseReleasesAtom(xml: string): CodexRelease[] {
  const releases: CodexRelease[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const tag = entry.match(/<id>[^<]*\/([^/<]+)<\/id>/)?.[1];
    const url = entry.match(/<link rel="alternate"[^>]*href="([^"]+)"/)?.[1];
    const content = entry.match(/<content type="html">([\s\S]*?)<\/content>/)?.[1];
    if (!tag || !url || content === undefined) continue;
    const version = tag.match(/^rust-v(\d+\.\d+\.\d+)$/)?.[1];
    if (!version) continue;
    releases.push({ version, url, notes: htmlToText(decodeHTML(content)) });
  }
  return releases.sort((a, b) => compareVersions(b.version, a.version));
}

/** Null: unchanged since the last fully processed read (a 304). */
export async function fetchCodexReleases(validators?: Validators): Promise<CodexRelease[] | null> {
  const res = await conditionalFetch(CODEX_RELEASES_ATOM_URL, validators);
  if (!res) return null;
  if (!res.ok) throw new Error(`codex releases fetch failed: ${res.status}`);
  return parseReleasesAtom(await res.text());
}
