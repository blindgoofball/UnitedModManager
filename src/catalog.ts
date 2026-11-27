import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Where the mod list comes from. The app ships with a copy (dist/catalog/catalog.json), keeps the
 * newest copy it has downloaded, and checks GitHub for a newer one. Every copy is validated with
 * the same schemas the repository's checks use before it is trusted.
 */

export interface CatalogBundle {
  formatVersion: 1;
  /** When the catalog last changed (ISO 8601). The newer of two valid copies wins. */
  revision: string;
  generatedAt: string;
  index: ModSummary[];
  games: GameDef[];
  mods: ModManifest[];
}

/** Published by the repository's CI whenever the catalog changes on main. */
export const DEFAULT_CATALOG_URL = 'https://github.com/blindgoofball/UnitedModManager/releases/download/catalog/catalog.json';
const MAX_BYTES = 5 * 1024 * 1024;
const builtInDir = path.join(__dirname, 'catalog');

// ---------- validation ----------

let validators: { mod: (d: unknown) => boolean; game: (d: unknown) => boolean; errors: (which: 'mod' | 'game') => string } | undefined;

function getValidators() {
  if (validators) return validators;
  const ajv = new Ajv({ allErrors: true, discriminator: true });
  addFormats(ajv);
  const read = (f: string): object => JSON.parse(fs.readFileSync(path.join(builtInDir, f), 'utf8')) as object;
  const mod = ajv.compile(read('mod.schema.json'));
  const game = ajv.compile(read('game.schema.json'));
  const describe = (errs: typeof mod.errors): string => (errs ?? []).slice(0, 3).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
  validators = { mod, game, errors: (which) => describe(which === 'mod' ? mod.errors : game.errors) };
  return validators;
}

/** Throws with a plain-words reason if `raw` is not a catalog this version of the app can use. */
export function validateBundle(raw: unknown): CatalogBundle {
  if (!raw || typeof raw !== 'object') throw new Error('The mod list is not a valid file.');
  const b = raw as Partial<CatalogBundle>;
  if (b.formatVersion !== 1) throw new Error('The mod list is in a newer format than this version of the app understands. Update the app to see it.');
  if (typeof b.revision !== 'string' || Number.isNaN(Date.parse(b.revision))) throw new Error('The mod list has no valid date.');
  if (!Array.isArray(b.index) || !Array.isArray(b.games) || !Array.isArray(b.mods)) throw new Error('The mod list is incomplete.');

  const v = getValidators();
  const ids = new Set<string>();
  for (const m of b.mods) {
    if (!v.mod(m)) throw new Error(`A mod in the list is invalid (${(m as { id?: string })?.id ?? 'unknown'}): ${v.errors('mod')}`);
    if (ids.has(m.id)) throw new Error(`The mod list contains "${m.id}" twice.`);
    ids.add(m.id);
  }
  for (const g of b.games) {
    if (!v.game(g)) throw new Error(`A game in the list is invalid (${(g as { id?: string })?.id ?? 'unknown'}): ${v.errors('game')}`);
  }
  for (const m of b.mods) {
    for (const d of m.dependencies ?? []) if (!ids.has(d.id)) throw new Error(`${m.id} needs "${d.id}", which is missing from the list.`);
  }
  for (const i of b.index) {
    const ok = i && typeof i.id === 'string' && typeof i.name === 'string' && typeof i.game === 'string' && typeof i.gameId === 'string' &&
      typeof i.description === 'string' && typeof i.author === 'string' && Array.isArray(i.platforms) && ids.has(i.id);
    if (!ok) throw new Error('The mod list index does not match its mods.');
  }
  return b as CatalogBundle;
}

// ---------- state ----------

interface State {
  bundle: CatalogBundle;
  source: CatalogInfo['source'];
  checkedAt?: string;
  error?: string;
}

let state: State | undefined;
let builtIn: CatalogBundle | undefined;
let cacheFile: string | undefined;
let etag: string | undefined;

function readBundleFile(file: string): { bundle: CatalogBundle; etag?: string; fetchedAt?: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { bundle?: unknown; etag?: string; fetchedAt?: string } & Record<string, unknown>;
    // The cache file wraps the bundle; the built-in file is the bundle itself.
    const wrapped = raw.bundle !== undefined;
    return { bundle: validateBundle(wrapped ? raw.bundle : raw), etag: wrapped ? raw.etag : undefined, fetchedAt: wrapped ? raw.fetchedAt : undefined };
  } catch {
    return null;
  }
}

/** Loads the built-in copy and any downloaded copy, and uses whichever is newer. Call once at startup. */
export function initCatalog(userDataDir: string): void {
  const built = readBundleFile(path.join(builtInDir, 'catalog.json'));
  if (!built) throw new Error('The mod list that comes with the app is missing or damaged. Reinstall the app.');
  builtIn = built.bundle;
  cacheFile = path.join(userDataDir, 'catalog-cache.json');

  const cached = readBundleFile(cacheFile); // a damaged cache is simply ignored
  if (cached && cached.bundle.revision >= built.bundle.revision) {
    etag = cached.etag;
    state = { bundle: cached.bundle, source: 'cache', checkedAt: cached.fetchedAt };
  } else {
    etag = undefined;
    state = { bundle: built.bundle, source: 'built-in' };
  }
}

function current(): State {
  if (!state) throw new Error('The catalog was used before it was loaded.');
  return state;
}

export const loadIndex = (): ModSummary[] => current().bundle.index;
export const loadGames = (): GameDef[] => current().bundle.games;
export const loadAllManifests = (): ModManifest[] => current().bundle.mods;
export function loadManifest(id: string): ModManifest | null {
  return current().bundle.mods.find((m) => m.id === id) ?? null;
}

export function catalogInfo(): CatalogInfo {
  const s = current();
  return { source: s.source, revision: s.bundle.revision, checkedAt: s.checkedAt, error: s.error };
}

// ---------- refreshing ----------

/**
 * Asks GitHub for a newer mod list. Never throws: on any problem the current list stays in use and
 * the reason is recorded for display. Returns whether the list in use changed.
 */
export async function refreshCatalog(fetchFn: typeof fetch, url: string = process.env.UMM_CATALOG_URL ?? DEFAULT_CATALOG_URL): Promise<{ changed: boolean }> {
  const s = current();
  try {
    if (!url.startsWith('https://') && !process.env.UMM_CATALOG_URL) throw new Error('The mod list address is not secure.');
    const headers: Record<string, string> = { 'User-Agent': 'UnitedModManager' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetchFn(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(10_000) });

    if (res.status === 304) {
      s.checkedAt = new Date().toISOString();
      s.error = undefined;
      if (s.source === 'cache') s.source = 'github';
      return { changed: false };
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    if (res.url && !res.url.startsWith('https://') && !process.env.UMM_CATALOG_URL) throw new Error('The download was redirected to an insecure address.');
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('The mod list is larger than expected.');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('The mod list is larger than expected.');

    const bundle = validateBundle(JSON.parse(text));
    const fetchedAt = new Date().toISOString();
    s.checkedAt = fetchedAt;
    s.error = undefined;

    // Keep a copy for next time, even if the app's own copy happens to be newer right now.
    etag = res.headers.get('etag') ?? undefined;
    if (cacheFile) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ etag, fetchedAt, bundle }));
      fs.renameSync(tmp, cacheFile);
    }
    if (builtIn && bundle.revision < builtIn.revision) {
      return { changed: false }; // the downloaded list is older than the one in the app
    }
    const changed = bundle.revision !== s.bundle.revision;
    s.bundle = bundle;
    s.source = 'github';
    return { changed };
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    return { changed: false };
  }
}

/** For tests: forget everything. */
export function _resetCatalogForTests(): void {
  state = undefined;
  builtIn = undefined;
  cacheFile = undefined;
  etag = undefined;
}
