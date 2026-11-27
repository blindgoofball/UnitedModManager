import { globToRegExp } from './install/paths';
import type { ReleaseWithAssets } from './github';

/**
 * Is what the user installed still the latest? Which comparison is right depends on the
 * mod: a release tag for ordinary mods, the installer file itself for mods whose
 * installer updates the mod (the tag may change without the installer changing).
 */
export function computeStatus(
  record: InstallRecord,
  manifest: ModManifest,
  latest: ReleaseWithAssets | null,
): { status: UpdateStatus; latestVersion?: string } {
  if (!latest) return { status: 'unknown' };
  const latestVersion = latest.info.version;
  const u = manifest.updates;

  if (u.strategy === 'release-tag') {
    return { status: record.tag === latest.info.tag ? 'up-to-date' : 'update-available', latestVersion };
  }
  if (u.strategy === 'asset-changed' && u.asset) {
    const re = globToRegExp(u.asset);
    const asset = latest.assets.find((a) => re.test(a.name));
    if (!asset) return { status: 'unknown' };
    if (asset.digest && record.assetHash) {
      return { status: asset.digest.toLowerCase() === `sha256:${record.assetHash}` ? 'up-to-date' : 'update-available', latestVersion };
    }
    if (asset.updatedAt && record.assetUpdatedAt) {
      return { status: asset.updatedAt === record.assetUpdatedAt ? 'up-to-date' : 'update-available', latestVersion };
    }
  }
  return { status: 'unknown' };
}
