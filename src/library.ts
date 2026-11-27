import * as fs from 'fs';
import { detectGames, DetectEnv } from './detect';
import { tokenRoots } from './install/paths';
import { detectPresence } from './install/presence';
import type { ReleaseWithAssets } from './github';
import { readSettings } from './settings';
import { computeStatus } from './updates';

/** Where each game is: a folder the user chose by hand wins over automatic detection. */
export async function resolveGames(defs: GameDef[], env: DetectEnv, settingsFile: string): Promise<Map<string, DetectedGame>> {
  const found = new Map((await detectGames(defs, env)).map((d) => [d.gameId, d]));
  const manual = readSettings(settingsFile).manualGames;
  for (const def of defs) {
    const p = manual[def.id];
    if (p && fs.existsSync(p)) found.set(def.id, { gameId: def.id, path: p, source: 'manual' });
  }
  return found;
}

export interface LibraryCatalog {
  manifest(id: string): ModManifest | null;
  manifests(): ModManifest[];
  release(m: ModManifest): Promise<ReleaseWithAssets>;
}

/** The games on this computer that have mods in the catalog, with what is installed for each. */
export async function getLibrary(
  index: ModSummary[],
  defs: GameDef[],
  env: DetectEnv,
  settingsFile: string,
  records: InstallRecord[],
  catalog: LibraryCatalog,
): Promise<LibraryData> {
  const detected = await resolveGames(defs, env, settingsFile);
  const games: LibraryGame[] = [];
  const undetected: { gameId: string; name: string }[] = [];

  for (const def of defs) {
    const found = detected.get(def.id);
    if (!found) {
      undetected.push({ gameId: def.id, name: def.name });
      continue;
    }

    const installed: LibraryMod[] = [];
    // 1. Things this manager installed.
    for (const r of records.filter((x) => x.gameId === def.id)) {
      const manifest = catalog.manifest(r.modId);
      if (!manifest) continue; // removed from the catalog since it was installed
      const latest = await catalog.release(manifest).catch(() => null);
      installed.push({
        modId: r.modId,
        name: manifest.name,
        installedVersion: r.version,
        ...computeStatus(r, manifest, latest),
        isDependency: manifest.kind === 'dependency',
        canRemove: r.extracted.length > 0 || !!manifest.uninstall?.length,
        methodId: r.methodId,
        gameVersion: r.gameVersion,
        tracked: true,
      });
    }
    // 2. Things already on the computer that the manager did not install (Steam Workshop, manual copies).
    const roots = tokenRoots(env, found.path, def.detect.steam?.appId);
    for (const manifest of catalog.manifests()) {
      if (manifest.game.id !== def.id || installed.some((i) => i.modId === manifest.id)) continue;
      const present = detectPresence(manifest, roots);
      if (!present) continue;
      installed.push({
        modId: manifest.id,
        name: manifest.name,
        installedVersion: 'unknown',
        status: 'unknown',
        isDependency: manifest.kind === 'dependency',
        canRemove: !!manifest.uninstall?.length,
        methodId: present.method ?? '',
        tracked: false,
        foundVia: manifest.methods.find((m) => m.id === present.method)?.label,
      });
    }
    installed.sort((a, b) => Number(a.isDependency) - Number(b.isDependency) || a.name.localeCompare(b.name));

    const installedIds = new Set(installed.map((i) => i.modId));
    games.push({
      gameId: def.id,
      name: def.name,
      installPath: found.path,
      source: found.source,
      installed,
      available: index.filter((m) => m.gameId === def.id && !installedIds.has(m.id)),
    });
  }
  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
  games.sort(byName);
  undetected.sort(byName);
  const updatesAvailable = games.reduce((n, g) => n + g.installed.filter((m) => m.status === 'update-available').length, 0);
  return { games, undetected, updatesAvailable };
}
