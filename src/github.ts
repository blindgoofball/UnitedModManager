// Fetches release information straight from GitHub. Only the repository name from
// the public catalog is sent; nothing about the user.
const TTL_MS = 10 * 60 * 1000;

export interface ReleaseWithAssets {
  info: ReleaseInfo;
  assets: ReleaseAsset[];
}

const cache = new Map<string, { at: number; value: ReleaseWithAssets }>();

interface GithubRelease {
  tag_name: string;
  html_url: string;
  published_at: string | null;
  assets?: { name: string; size: number; browser_download_url: string; digest?: string | null; updated_at: string }[];
}

function describeTag(m: ModManifest, tag: string): { version: string; gameVersion?: string } {
  const pattern = m.updates.versionFrom?.tag;
  if (pattern) {
    try {
      const groups = new RegExp(pattern).exec(tag)?.groups;
      if (groups?.mod) return { version: groups.mod, gameVersion: groups.game };
    } catch {
      // A bad pattern is caught by the catalog build; fall through to the raw tag.
    }
  }
  return { version: tag.replace(/^v(?=\d)/, '') };
}

export async function getReleaseWithAssets(m: ModManifest, force = false): Promise<ReleaseWithAssets> {
  if (m.source.type !== 'github') throw new Error(`${m.id} has no GitHub source`);
  const cached = cache.get(m.id);
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const { repo, tag } = m.source;
  const which = tag ? `tags/${encodeURIComponent(tag)}` : 'latest';
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/${which}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'UnitedModManager' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${repo}`);
  const r = (await res.json()) as GithubRelease;

  // A rolling tag like "dev" keeps its original publish date while its files change,
  // so the newest of the release and its assets is the honest "last updated" date.
  const dates = [r.published_at, ...(r.assets ?? []).map((a) => a.updated_at)].filter((d): d is string => !!d);
  dates.sort();
  const date = dates[dates.length - 1];
  if (!date) throw new Error(`${repo} has no release date`);

  const value: ReleaseWithAssets = {
    info: { modId: m.id, tag: r.tag_name, date, url: r.html_url, ...describeTag(m, r.tag_name) },
    assets: (r.assets ?? []).map((a) => ({
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
      digest: a.digest ?? undefined,
      updatedAt: a.updated_at,
    })),
  };
  cache.set(m.id, { at: Date.now(), value });
  return value;
}

export async function getRelease(m: ModManifest, force = false): Promise<ReleaseInfo> {
  return (await getReleaseWithAssets(m, force)).info;
}
