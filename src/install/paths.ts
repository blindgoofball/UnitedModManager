import * as fs from 'fs';
import * as path from 'path';
import type { DetectEnv } from '../detect';

/**
 * Steam keeps Workshop downloads at <library>/steamapps/workshop/content/<appid>, next to the
 * game's own folder in <library>/steamapps/common. Only known for games that live in Steam.
 */
export function workshopRoot(gamePath: string, steamAppId?: string): string | null {
  if (!steamAppId) return null;
  const common = path.dirname(gamePath);
  const steamapps = path.dirname(common);
  if (path.basename(common).toLowerCase() !== 'common' || path.basename(steamapps).toLowerCase() !== 'steamapps') return null;
  return path.join(steamapps, 'workshop', 'content', steamAppId);
}

/** The folders a manifest path may start from. */
export function tokenRoots(env: DetectEnv, gamePath: string, steamAppId?: string): Record<string, string> {
  const roots: Record<string, string> = {
    game: gamePath,
    home: env.home,
    appdata: env.appData,
    localappdata: env.localAppData,
    locallow: path.join(env.home, 'AppData', 'LocalLow'),
    documents: env.documents,
    appsupport: path.join(env.home, 'Library', 'Application Support'),
  };
  const workshop = workshopRoot(gamePath, steamAppId);
  if (workshop) roots.workshop = workshop;
  return roots;
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Turns "{game}/Mods" into a real path, refusing anything that climbs out of its token folder. */
export function expandInstallPath(p: string, roots: Record<string, string>): string {
  const m = /^\{(\w+)\}(?:\/(.*))?$/.exec(p);
  if (!m || !roots[m[1]]) throw new Error(`"${p}" is not a valid install location.`);
  const root = roots[m[1]];
  const full = path.resolve(root, ...(m[2] ?? '').split('/').filter(Boolean));
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`"${p}" points outside its folder.`);
  return full;
}

/**
 * Everything that exists at a manifest path. The last part may be a wildcard such as
 * "united-minecraft-*.jar". Returns [] when the path's token is unknown here (for example
 * {workshop} for a game that is not in Steam). A wildcard with too little fixed text before it
 * is refused, because it could match far more than the mod's own files.
 */
export function findPaths(p: string, roots: Record<string, string>): string[] {
  const m = /^\{(\w+)\}(?:\/(.*))?$/.exec(p);
  if (!m || !roots[m[1]]) return [];
  const segments = (m[2] ?? '').split('/').filter(Boolean);
  if (segments.length === 0) throw new Error(`"${p}" names a whole folder, not something inside it.`);
  const last = segments[segments.length - 1];
  if (segments.slice(0, -1).some((s) => /[*?]/.test(s))) throw new Error(`Wildcards are only allowed in the last part of "${p}".`);

  if (!/[*?]/.test(last)) {
    const full = expandInstallPath(p, roots);
    return fs.existsSync(full) ? [full] : [];
  }
  if (last.split(/[*?]/)[0].length < 4) throw new Error(`The pattern "${last}" is too broad to use safely.`);
  const parent = expandInstallPath(segments.length > 1 ? `{${m[1]}}/${segments.slice(0, -1).join('/')}` : `{${m[1]}}`, roots);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return [];
  const re = globToRegExp(last);
  return fs.readdirSync(parent).filter((n) => re.test(n)).map((n) => path.join(parent, n));
}

/** Simple glob: * matches any run of characters, ? matches one. Everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** A file name that is safe to use as one path segment. */
export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
}
