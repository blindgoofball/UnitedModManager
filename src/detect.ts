import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { parseVdf, VdfValue } from './vdf';

const execFileAsync = promisify(execFile);

export interface DetectEnv {
  platform: 'windows' | 'macos' | 'linux';
  home: string;
  appData: string;
  localAppData: string;
  documents: string;
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const exists = (p: string): boolean => fs.existsSync(p);

/** The path with its real capitalisation. Windows registry and Steam files often give it all lower case. */
const canonical = (p: string): string => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};

function expandTokens(p: string, env: DetectEnv): string {
  const tokens: Record<string, string> = {
    home: env.home,
    appdata: env.appData,
    localappdata: env.localAppData,
    locallow: path.join(env.home, 'AppData', 'LocalLow'),
    documents: env.documents,
  };
  return path.normalize(p.replace(/^\{(\w+)\}/, (_m, t: string) => tokens[t] ?? `{${t}}`));
}

// ---------- Steam ----------

async function regQuery(key: string, value: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', key, '/v', value], { windowsHide: true, timeout: 5000 });
    return /REG_SZ\s+(.+?)\s*$/m.exec(stdout)?.[1] ?? null;
  } catch {
    return null; // key not present, or reg unavailable
  }
}

export async function findSteamRoot(env: DetectEnv): Promise<string | null> {
  const candidates: string[] = [];
  if (env.platform === 'windows') {
    const user = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
    const machine = await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath');
    for (const c of [user, machine]) if (c) candidates.push(c);
  } else if (env.platform === 'macos') {
    candidates.push(path.join(env.home, 'Library', 'Application Support', 'Steam'));
  } else {
    candidates.push(path.join(env.home, '.steam', 'steam'), path.join(env.home, '.local', 'share', 'Steam'));
  }
  for (const c of candidates) {
    const root = path.normalize(c);
    if (isDir(path.join(root, 'steamapps'))) return root;
  }
  return null;
}

export function readSteamLibraries(root: string): string[] {
  const libs = new Set<string>([root]);
  try {
    const vdf = parseVdf(fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
    const folders = vdf.libraryfolders ?? vdf.LibraryFolders;
    if (folders && typeof folders === 'object') {
      for (const [key, value] of Object.entries(folders as { [k: string]: VdfValue })) {
        if (!/^\d+$/.test(key)) continue; // skip entries like "TimeNextStatsReport"
        // Newer Steam: "0" { "path" "..." }. Older Steam: "1" "D:\\Library".
        const p = typeof value === 'string' ? value : typeof value.path === 'string' ? value.path : null;
        if (p) libs.add(path.normalize(p));
      }
    }
  } catch {
    // No or unreadable libraryfolders file: the main Steam folder alone is still searched.
  }
  return [...libs].filter((l) => isDir(path.join(l, 'steamapps')));
}

export function findSteamGame(appId: string, libraries: string[]): string | null {
  for (const lib of libraries) {
    const manifest = path.join(lib, 'steamapps', `appmanifest_${appId}.acf`);
    if (!exists(manifest)) continue;
    try {
      const installdir = (parseVdf(fs.readFileSync(manifest, 'utf8')).AppState as { [k: string]: VdfValue }).installdir;
      // The folder name comes from a file, so refuse anything that could leave steamapps/common.
      if (typeof installdir !== 'string' || !installdir || /[\\/]|^\.\.?$/.test(installdir)) continue;
      const dir = path.join(lib, 'steamapps', 'common', installdir);
      if (isDir(dir)) return dir;
    } catch {
      // A corrupt manifest means we can't use this library for this game.
    }
  }
  return null;
}

// ---------- everything together ----------

export async function detectGames(defs: GameDef[], env: DetectEnv): Promise<DetectedGame[]> {
  const found: DetectedGame[] = [];
  let libraries: string[] | undefined; // looked up once, and only if a game needs Steam

  for (const def of defs) {
    const steam = def.detect.steam;
    if (steam) {
      if (!libraries) {
        const root = await findSteamRoot(env);
        libraries = root ? readSteamLibraries(root) : [];
      }
      const dir = findSteamGame(steam.appId, libraries);
      if (dir) {
        found.push({ gameId: def.id, path: canonical(dir), source: 'steam' });
        continue;
      }
    }
    for (const p of def.detect.paths ?? []) {
      if (p.platform !== env.platform) continue;
      const dir = expandTokens(p.path, env);
      if (isDir(dir) && (!p.marker || exists(path.join(dir, p.marker)))) {
        found.push({ gameId: def.id, path: dir, source: 'known-folder' });
        break;
      }
    }
  }
  return found;
}

export function currentEnv(home: string, appData: string, documents: string): DetectEnv {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  return { platform, home, appData, localAppData: process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), documents };
}
