import * as path from 'path';
import { globToRegExp } from './install/paths';

/**
 * The "Submit a mod" page's brains: turn what a contributor typed into a mod file, and check it with
 * the same rules the repository's pull request check uses (catalog/checks.js is the one shared copy).
 */

interface ChecksModule {
  checkMod(m: ModManifest, ctx: { byId: Map<string, ModManifest> }): string[];
}
const checks = require(path.join(__dirname, 'catalog', 'checks.js')) as ChecksModule;

export interface SubmitDeps {
  /** What is in the catalog now. */
  mods: ModManifest[];
  games: GameDef[];
  /** Schema problems for one mod file, as short sentences. Empty means valid. */
  schemaProblems(mod: unknown): string[];
  /** Looks at the mod's latest GitHub release. Optional: without it the release is not checked. */
  release?(m: ModManifest): Promise<{ info: ReleaseInfo; assets: ReleaseAsset[] }>;
}

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');

const list = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Plain-words problems with the form itself, before any mod file exists. */
export function formProblems(f: SubmitForm, games: GameDef[]): string[] {
  const p: string[] = [];
  if (!f.name.trim()) p.push('Give the mod a name.');
  if (!f.summary.trim()) p.push('Write a short description of the mod.');
  else if (f.summary.trim().length > 300) p.push('The short description must be 300 characters or fewer. Put the rest in the longer description.');
  if (list(f.authors).length === 0) p.push('Say who made the mod. Separate several names with commas.');
  if (f.homepage.trim() && !/^https:\/\//i.test(f.homepage.trim())) p.push('The homepage must be a web address starting with https://.');
  if (f.gameChoice && !games.some((g) => g.id === f.gameChoice)) p.push('Choose a game from the list.');
  if (!f.gameChoice && !f.newGameName.trim()) p.push('Choose the game the mod is for, or type the name of a game that is not listed.');
  if (f.platforms.length === 0) p.push('Tick at least one operating system the mod works on.');

  if (f.install === 'workshop') {
    if (!/^\d+$/.test(f.workshopItemId.trim())) p.push('Type the Steam Workshop item number. It is the number at the end of the item\'s Steam address.');
  } else {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(f.repo.trim())) p.push('Type the GitHub repository as owner/name, for example Blindgoofball/United-Minecraft.');
    if (f.install === 'installer') {
      if (!f.installerAsset.trim()) p.push('Type the name of the installer file in the release.');
      if (f.hashSource === 'file' && !f.hashFile.trim()) p.push('Type the name of the hash file in the release, or choose to use the hash GitHub records.');
    } else if (!f.zipAsset.trim()) {
      p.push('Type the name of the zip file in the release.');
    }
  }
  return p;
}

function relativeInGame(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Builds the mod file for a form that has already passed `formProblems`. */
export function buildManifest(f: SubmitForm, games: GameDef[]): Record<string, unknown> {
  const existing = games.find((g) => g.id === f.gameChoice);
  const game = existing ? { id: existing.id, name: existing.name } : { id: slug(f.newGameName), name: f.newGameName.trim() };
  const m: Record<string, unknown> = {
    schemaVersion: 1,
    id: slug(f.id.trim() || f.name),
    name: f.name.trim(),
    summary: f.summary.trim(),
    authors: list(f.authors),
  };
  if (f.description.trim()) m.description = f.description.trim();
  if (f.homepage.trim()) m.homepage = f.homepage.trim();
  if (f.license.trim()) m.license = f.license.trim();
  m.game = game;
  m.platforms = f.platforms;

  if (f.install === 'workshop') {
    const item = f.workshopItemId.trim();
    const url = `steam://url/CommunityFilePage/${item}`;
    m.source = { type: 'workshop', itemId: item };
    m.methods = [
      {
        id: 'workshop',
        label: 'Steam Workshop',
        recommended: true,
        steps: [
          { type: 'open', url },
          { type: 'note', text: 'Click Subscribe on the Steam page. The mod downloads the next time the game starts.' },
        ],
      },
    ];
    m.detect = [{ method: 'workshop', path: `{workshop}/${item}` }];
    m.uninstall = [
      { type: 'open', url },
      { type: 'note', text: 'Steam owns the files of Workshop mods. Unsubscribe on the Steam page that opens, and Steam removes them.' },
    ];
    m.updates = { strategy: 'external' };
    return m;
  }

  const source: Record<string, string> = { type: 'github', repo: f.repo.trim() };
  if (f.tag.trim()) source.tag = f.tag.trim();
  m.source = source;

  if (f.install === 'installer') {
    const asset = f.installerAsset.trim();
    const download: Record<string, unknown> = { type: 'download', asset };
    if (f.hashSource === 'file') download.sha256Asset = f.hashFile.trim();
    else download.githubDigest = true;
    m.methods = [
      {
        id: 'installer',
        label: f.selfUpdating ? 'Installer that also keeps the mod up to date' : 'Installer',
        recommended: true,
        steps: [download, { type: 'run', file: asset, interactive: f.interactive }],
      },
    ];
    const updates: Record<string, unknown> = { strategy: 'asset-changed', asset };
    if (f.selfUpdating) updates.selfUpdating = true;
    m.updates = updates;

    const left = relativeInGame(f.leftoverPath);
    if (left) {
      m.detect = [{ method: 'installer', path: `{game}/${left}` }];
      m.uninstall = [{ type: 'delete', path: `{game}/${left}` }];
    }
    return m;
  }

  // zip
  const into = relativeInGame(f.unpackInto);
  const target = into ? `{game}/${into}` : '{game}';
  m.methods = [
    {
      id: 'manual',
      label: 'Manual install',
      recommended: true,
      steps: [{ type: 'download', asset: f.zipAsset.trim(), githubDigest: true }, { type: 'extract', to: target }],
    },
  ];
  m.updates = f.tag.trim() ? { strategy: 'asset-changed', asset: f.zipAsset.trim() } : { strategy: 'release-tag' };
  const folder = relativeInGame(f.createdFolder);
  if (folder) {
    const where = `${target}/${folder}`;
    m.detect = [{ method: 'manual', path: where }];
    m.uninstall = [{ type: 'delete', path: where }];
  }
  return m;
}

/** Checks mod-file text exactly as the pull request check would, plus a look at the real GitHub release. */
export async function checkSubmission(text: string, deps: SubmitDeps): Promise<SubmitCheckResult> {
  const notes: string[] = [];
  let m: ModManifest;
  try {
    m = JSON.parse(text.replace(/^﻿/, '')) as ModManifest;
  } catch (e) {
    return { problems: [`This is not valid JSON: ${e instanceof Error ? e.message : String(e)}`], notes };
  }
  const schema = deps.schemaProblems(m);
  if (schema.length > 0) return { problems: schema, notes, id: typeof m?.id === 'string' ? m.id : undefined };

  const problems: string[] = [];
  if (deps.mods.some((x) => x.id === m.id)) {
    problems.push(`A mod with the id "${m.id}" is already in the catalog. To change that mod, edit its file instead of submitting a new one.`);
  }
  const knownGame = deps.games.find((g) => g.id === m.game.id);
  if (knownGame && knownGame.name !== m.game.name) {
    problems.push(`The game "${m.game.id}" is called "${knownGame.name}" in the catalog. Use that exact name.`);
  }
  const byId = new Map(deps.mods.map((x) => [x.id, x] as const));
  byId.set(m.id, m);
  problems.push(...checks.checkMod(m, { byId }));

  // Does the release really contain what the entry says it does?
  if (m.source.type === 'github' && deps.release) {
    try {
      const { info, assets } = await deps.release(m);
      const names = assets.map((a) => a.name);
      const wanted = new Set<string>();
      for (const method of m.methods) {
        for (const s of method.steps) {
          if (s.type !== 'download' || !s.asset) continue;
          const re = globToRegExp(s.asset);
          const hits = assets.filter((a) => re.test(a.name));
          if (hits.length === 0) problems.push(`The latest release (${info.tag}) has no file matching "${s.asset}". Files in that release: ${names.join(', ') || 'none'}.`);
          else if (hits.length > 1) problems.push(`"${s.asset}" matches ${hits.length} files in the release (${hits.map((h) => h.name).join(', ')}). Make the name more specific.`);
          else {
            wanted.add(hits[0].name);
            notes.push(`Found ${hits[0].name} in release ${info.tag}.`);
            if (s.githubDigest && !hits[0].digest) problems.push(`GitHub has no recorded hash for ${hits[0].name}, so it cannot be checked that way. Publish a hash file with the release and use that instead.`);
          }
          if (s.sha256Asset) {
            const hre = globToRegExp(s.sha256Asset);
            if (!assets.some((a) => hre.test(a.name))) problems.push(`The hash file "${s.sha256Asset}" is not in the latest release.`);
          }
        }
      }
    } catch (e) {
      notes.push(`Could not check the release on GitHub (${e instanceof Error ? e.message : String(e)}). The entry may still be fine.`);
    }
  }
  return { problems, notes, id: m.id };
}

export async function buildSubmission(f: SubmitForm, deps: SubmitDeps): Promise<SubmitBuildResult> {
  const early = formProblems(f, deps.games);
  if (early.length > 0) return { json: '', problems: early, notes: [] };
  const json = JSON.stringify(buildManifest(f, deps.games), null, 2) + '\n';
  return { json, ...(await checkSubmission(json, deps)) };
}

/** The GitHub address that opens "create a new file" with the contents filled in. */
export function githubNewFileUrl(repoUrl: string, id: string, json: string): { url: string; prefilled: boolean } {
  const base = `${repoUrl}/new/main/catalog/mods`;
  const full = `${base}?filename=${encodeURIComponent(`${id}.json`)}&value=${encodeURIComponent(json)}`;
  // Very long addresses are refused by web servers, so past a safe size the person pastes the contents themselves.
  if (full.length <= 7000) return { url: full, prefilled: true };
  return { url: `${base}?filename=${encodeURIComponent(`${id}.json`)}`, prefilled: false };
}
