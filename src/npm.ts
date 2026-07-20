export async function fetchNpmLatest(pkg: string): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`);
  if (!res.ok) throw new Error(`npm fetch failed: ${res.status}`);
  const data = (await res.json()) as { version?: string };
  if (!data.version) throw new Error("npm response has no version");
  return data.version;
}
