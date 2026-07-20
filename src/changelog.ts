export const CHANGELOG_URL =
  "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";

export interface Release {
  version: string;
  notes: string;
}

/** File order: newest versions first. */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  const re = /^## (\d+\.\d+\.\d+)[^\S\n]*$/gm;
  let match = re.exec(md);
  while (match) {
    const version = match[1];
    const start = match.index + match[0].length;
    const next = re.exec(md);
    const end = next ? next.index : md.length;
    releases.push({ version, notes: md.slice(start, end).trim() });
    match = next;
  }
  return releases;
}

export async function fetchChangelog(): Promise<Release[]> {
  const res = await fetch(CHANGELOG_URL);
  if (!res.ok) throw new Error(`changelog fetch failed: ${res.status}`);
  return parseChangelog(await res.text());
}
