import * as fs from 'fs';
import * as path from 'path';
import type { DetectEnv } from '../detect';
import { downloadFile } from './download';
import { expandInstallPath, findPaths, globToRegExp, isInside, safeName, tokenRoots } from './paths';
import { detectPresence } from './presence';
import { extractZip } from './zip';

// ---------- dependencies the engine needs (real ones in main.ts, fakes in tests) ----------

export interface EngineDeps {
  env: DetectEnv;
  platform: Platform;
  downloadsDir: string;
  backupsDir: string;
  fetch: typeof fetch;
  catalog: {
    manifest(id: string): ModManifest | null;
    release(m: ModManifest): Promise<{ info: ReleaseInfo; assets: ReleaseAsset[] }>;
  };
  openExternal(url: string): Promise<void>;
  /** Starts an installer. `launchedOnly` means we handed it to the shell and cannot see it finish. */
  runInstaller(file: string, args: string[]): Promise<{ exitCode: number | null; launchedOnly: boolean }>;
  allowHttp?: boolean;
  now?: () => Date;
}

export interface PlannedStep {
  modId: string;
  step: ModStep;
  text: string;
  asset?: ReleaseAsset;
  hashAsset?: ReleaseAsset;
  target?: string;
  confirmId?: string;
}

export interface InstallPlan {
  kind: 'install';
  modId: string;
  modName: string;
  gameId: string;
  gameName: string;
  gamePath: string;
  methodIds: Record<string, string>;
  gameVersion?: string;
  steps: PlannedStep[];
  confirmations: { id: string; text: string }[];
  warnings: string[];
  skipped: string[];
  notes: string[];
  releases: Record<string, ReleaseInfo>;
}

export interface RemoveStep {
  text: string;
  step: ModStep;
  /** For delete steps: what exists right now and will be moved to backup. */
  targets: string[];
}

export interface RemovePlan {
  kind: 'remove';
  modId: string;
  gameId: string;
  modName: string;
  gameName: string;
  steps: RemoveStep[];
}

export interface EngineResult extends InstallResult {
  records?: InstallRecord[];
  removed?: { modId: string; gameId: string };
}

export type ProgressFn = (p: { step: number; of: number; text: string; percent?: number }) => void;

// ---------- small helpers ----------

const PLATFORM_NAMES: Record<Platform, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const whenApplies = (when: StepWhen | undefined, platform: Platform, version?: string): boolean =>
  (!when?.platform || when.platform === platform) && (!when?.version || when.version === version);

const methodApplies = (m: ModManifest['methods'][number], platform: Platform): boolean => !m.when?.platform || m.when.platform === platform;

export function applicableMethods(manifest: ModManifest, platform: Platform): { id: string; label: string; recommended: boolean }[] {
  return manifest.methods.filter((m) => methodApplies(m, platform)).map((m) => ({ id: m.id, label: m.label, recommended: !!m.recommended }));
}

function backupStamp(deps: EngineDeps): string {
  return (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
}

/** Moves a file or folder out of the game into the app's backup area. Returns where it went. */
function moveToBackup(src: string, label: string, deps: EngineDeps): string {
  const dir = path.join(deps.backupsDir, `${backupStamp(deps)}-${safeName(label)}`);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(src));
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.cpSync(src, dest, { recursive: true }); // renaming across drives fails; copy then remove
    fs.rmSync(src, { recursive: true, force: true });
  }
  return dest;
}

function copyToBackup(src: string, label: string, deps: EngineDeps): string {
  const dir = path.join(deps.backupsDir, `${backupStamp(deps)}-${safeName(label)}`);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(src));
  fs.copyFileSync(src, dest);
  return dest;
}

// ---------- planning ----------

export interface PlanInput {
  modId: string;
  methodId: string;
  gameVersion?: string;
  gameId: string;
  gameName: string;
  gamePath: string;
  /** Steam's id for the game, when it has one; lets manifests use {workshop}. */
  steamAppId?: string;
}

export async function buildInstallPlan(input: PlanInput, deps: EngineDeps, records: InstallRecord[]): Promise<InstallPlan> {
  const mod = deps.catalog.manifest(input.modId);
  if (!mod) throw new Error('That mod is not in the catalog.');
  if (!mod.platforms.includes(deps.platform)) throw new Error(`${mod.name} is not available for ${PLATFORM_NAMES[deps.platform]}.`);
  if (mod.gameVersions) {
    if (!input.gameVersion) throw new Error('Choose which game version you have.');
    if (!mod.gameVersions.includes(input.gameVersion)) throw new Error(`${mod.name} does not support game version ${input.gameVersion}.`);
  }

  const roots = tokenRoots(deps.env, input.gamePath, input.steamAppId);
  const plan: InstallPlan = {
    kind: 'install',
    modId: mod.id,
    modName: mod.name,
    gameId: input.gameId,
    gameName: input.gameName,
    gamePath: input.gamePath,
    methodIds: {},
    gameVersion: input.gameVersion,
    steps: [],
    confirmations: [],
    warnings: [],
    skipped: [],
    notes: [],
    releases: {},
  };

  // The manifest's own "things to know" belong on the review page, where the decision is made.
  for (const c of mod.conflicts ?? []) plan.warnings.push(c.note);

  // Dependencies come first, unless they are already installed for this game.
  const groups: { manifest: ModManifest; wantedMethod?: string; version?: string }[] = [];
  for (const d of mod.dependencies ?? []) {
    const dep = deps.catalog.manifest(d.id);
    if (!dep) throw new Error(`${mod.name} needs "${d.id}", which is not in the catalog.`);
    if (records.some((r) => r.modId === dep.id && r.gameId === input.gameId)) continue;
    // Something already on the computer counts too, whether the manager or the user put it there.
    const have = detectPresence(dep, roots);
    if (have) {
      const how = dep.methods.find((x) => x.id === have.method)?.label;
      plan.skipped.push(`${dep.name} is already installed${how ? ` (${how})` : ''}, so it will not be installed again.`);
      continue;
    }
    groups.push({ manifest: dep, wantedMethod: input.methodId, version: dep.gameVersions?.includes(input.gameVersion ?? '') ? input.gameVersion : undefined });
  }
  groups.push({ manifest: mod, wantedMethod: input.methodId, version: input.gameVersion });

  const releaseCache = new Map<string, Awaited<ReturnType<EngineDeps['catalog']['release']>>>();
  const releaseOf = async (m: ModManifest) => {
    let r = releaseCache.get(m.id);
    if (!r) {
      r = await deps.catalog.release(m);
      releaseCache.set(m.id, r);
      plan.releases[m.id] = r.info;
    }
    return r;
  };

  for (const { manifest, wantedMethod, version } of groups) {
    const isMain = manifest.id === mod.id;
    const applicable = manifest.methods.filter((m) => methodApplies(m, deps.platform) && whenApplies({ version: m.when?.version }, deps.platform, version));
    const method = applicable.find((m) => m.id === wantedMethod) ?? (isMain ? undefined : applicable.find((m) => m.recommended) ?? applicable[0]);
    if (!method) throw new Error(isMain ? 'That way of installing is not available here.' : `${manifest.name} has no way to install on this computer.`);
    plan.methodIds[manifest.id] = method.id;

    const steps = [...method.steps, ...(manifest.afterInstall ?? [])].filter((s) => whenApplies(s.when, deps.platform, version));
    if (steps.length === 0) throw new Error(`${manifest.name} has no steps for ${PLATFORM_NAMES[deps.platform]}${version ? ` with game version ${version}` : ''}.`);

    const downloaded = new Map<string, true>();
    const unpackTargets: string[] = []; // folders this method unpacks into, so a script can be required to live in one
    let lastName: string | undefined;
    for (const step of steps) {
      const planned: PlannedStep = { modId: manifest.id, step, text: '' };
      switch (step.type) {
        case 'download': {
          let name: string;
          if (step.asset) {
            const { assets } = await releaseOf(manifest);
            const re = globToRegExp(step.asset);
            const hits = assets.filter((a) => re.test(a.name));
            if (hits.length !== 1) throw new Error(`Expected one release file matching "${step.asset}" for ${manifest.name}, found ${hits.length}.`);
            planned.asset = hits[0];
            name = hits[0].name;
            if (step.sha256Asset) {
              const hre = globToRegExp(step.sha256Asset);
              planned.hashAsset = assets.find((a) => hre.test(a.name));
              if (!planned.hashAsset) throw new Error(`The hash file "${step.sha256Asset}" is missing from ${manifest.name}'s release.`);
            }
            if (step.githubDigest && !planned.asset.digest) throw new Error(`GitHub has no recorded hash for ${name}, so it cannot be verified.`);
          } else {
            const url = new URL(step.url as string);
            name = path.basename(url.pathname) || 'download';
          }
          const verified = !!(step.sha256 || step.sha256Asset || step.githubDigest);
          if (!verified) plan.warnings.push(`${name} cannot be checked against a known hash.`);
          downloaded.set(name, true);
          lastName = name;
          planned.text = `Download ${name}${planned.asset ? ` (${formatSize(planned.asset.size)})` : ''}${verified ? ' and check it against its published hash' : ''}`;
          break;
        }
        case 'extract': {
          const file = step.file ?? lastName;
          if (!file || !downloaded.has(file)) throw new Error(`${manifest.name}: an unpack step has nothing to unpack.`);
          if (!/\.zip$/i.test(file)) throw new Error(`${file} is not a .zip file, which is the only archive type supported so far.`);
          planned.target = expandInstallPath(step.to, roots);
          unpackTargets.push(planned.target);
          planned.text = `Unpack ${file} into ${planned.target}. Any existing copy of the same folders is moved to a backup first`;
          break;
        }
        case 'run': {
          if (deps.platform !== 'windows') throw new Error('Running installers is only supported on Windows so far.');
          if (step.elevate) throw new Error('Installers that must run as administrator are not supported yet.');
          if (step.path) {
            // A script from an archive this method unpacks. Only .exe/.bat/.cmd/.ps1, never a wildcard,
            // and only inside a folder an earlier step of this method unpacks into.
            if (step.file) throw new Error(`${manifest.name}: a run step takes either "file" or "path", not both.`);
            const script = expandInstallPath(step.path, roots);
            if (!/\.(exe|bat|cmd|ps1)$/i.test(script) || /[*?]/.test(script)) {
              throw new Error(`${manifest.name}: only .exe, .bat, .cmd and .ps1 files can be run, and not with wildcards.`);
            }
            if (!unpackTargets.some((t) => isInside(t, script))) {
              throw new Error(`${manifest.name}: the script "${step.path}" is not inside a folder that is unpacked earlier.`);
            }
            planned.target = script;
            planned.text = step.interactive
              ? `Run the script ${path.basename(script)} from ${path.dirname(script)}. It opens its own window, and you answer its questions there`
              : `Run the script ${path.basename(script)} from ${path.dirname(script)}`;
            break;
          }
          if (!step.file || !downloaded.has(step.file)) throw new Error(`${manifest.name}: run step "${step.file ?? ''}" was not downloaded first.`);
          planned.text = step.interactive
            ? `Start ${step.file}. It opens its own window, and you finish the installation there`
            : `Run ${step.file}`;
          break;
        }
        case 'copy': {
          planned.target = expandInstallPath(step.to, roots);
          const mode = step.ifExists ?? 'ask';
          const exists = fs.existsSync(planned.target);
          const host = new URL(step.from.url).host;
          plan.warnings.push(`The file from ${host} cannot be checked against a known hash.`);
          if (exists && mode === 'skip') {
            planned.text = `Leave your existing ${path.basename(planned.target)} as it is`;
          } else {
            if (exists) {
              planned.confirmId = `replace-${plan.steps.length}`;
              plan.confirmations.push({
                id: planned.confirmId,
                text: `Replace your existing file ${planned.target}. A copy is saved first.`,
              });
            }
            planned.text = `${exists ? 'Replace' : 'Create'} ${planned.target} with a file from ${host}${exists && step.backup ? ' (your current file is backed up first)' : ''}`;
          }
          break;
        }
        case 'open': {
          const u = new URL(step.url);
          if (u.protocol !== 'https:' && u.protocol !== 'steam:') throw new Error(`Cannot open "${step.url}".`);
          planned.text = u.protocol === 'steam:' ? `Open the Steam page for ${manifest.name}` : `Open ${step.url} in your browser`;
          break;
        }
        case 'note':
          plan.notes.push(step.text);
          planned.text = `Note: ${step.text}`;
          break;
        case 'delete':
          throw new Error(`${manifest.name}: "delete" steps are only allowed in the uninstall list.`);
      }
      plan.steps.push(planned);
    }
  }
  return plan;
}

export interface RemoveInput {
  manifest: ModManifest;
  gameId: string;
  gameName: string;
  gamePath: string;
  steamAppId?: string;
  /** What we recorded when we installed it, if we did. */
  record?: InstallRecord;
}

/** The method the mod was installed with: from our own record if we have one, else from what is on disk. */
export function installedMethod(manifest: ModManifest, roots: Record<string, string>, record?: InstallRecord): string | undefined {
  return record?.methodId ?? detectPresence(manifest, roots)?.method;
}

/**
 * Builds the steps to remove a mod. The manifest's own `uninstall` list wins, filtered to the
 * way the mod was installed. Without one, we fall back to removing exactly the folders we
 * recorded when we unpacked it.
 */
export function buildRemovePlan(input: RemoveInput, deps: Pick<EngineDeps, 'env' | 'platform'>): RemovePlan {
  const { manifest, record } = input;
  const roots = tokenRoots(deps.env, input.gamePath, input.steamAppId);
  const method = installedMethod(manifest, roots, record);
  const steps: RemoveStep[] = [];

  /** A manifest path as the user would read it, for example C:\...\mods\united-minecraft-*.jar */
  const shown = (p: string): string => {
    const i = p.lastIndexOf('/');
    if (i < 0) return p;
    try {
      return path.join(expandInstallPath(p.slice(0, i), roots), p.slice(i + 1));
    } catch {
      return p;
    }
  };
  const describeDelete = (targets: string[], pattern: string): string =>
    targets.length > 0 ? `Move ${targets.join(' and ')} to a backup folder` : `Nothing to move: nothing was found at ${pattern}`;

  if (manifest.uninstall && manifest.uninstall.length > 0) {
    for (const step of manifest.uninstall) {
      if (step.when?.platform && step.when.platform !== deps.platform) continue;
      if (step.when?.method && step.when.method !== method) continue;
      if (step.type === 'delete') {
        const targets = findPaths(step.path, roots);
        steps.push({ text: describeDelete(targets, shown(step.path)), step, targets });
      } else if (step.type === 'open') {
        const u = new URL(step.url);
        if (u.protocol !== 'https:' && u.protocol !== 'steam:') throw new Error(`Cannot open "${step.url}".`);
        steps.push({ text: u.protocol === 'steam:' ? `Open the Steam page for ${manifest.name}` : `Open ${step.url} in your browser`, step, targets: [] });
      } else if (step.type === 'note') {
        steps.push({ text: `Note: ${step.text}`, step, targets: [] });
      } else {
        throw new Error(`${manifest.name}: a "${step.type}" step is not allowed when removing.`);
      }
    }
  } else if (record && record.extracted.length > 0) {
    for (const group of record.extracted) {
      for (const root of group.roots) {
        const target = path.join(group.baseDir, root);
        // Only ever remove things inside the folder we recorded, one level down.
        if (!root || root.includes('/') || root.includes('\\') || root === '.' || root === '..' || !isInside(group.baseDir, target)) {
          throw new Error('The saved install information looks damaged, so nothing was removed.');
        }
        steps.push({ text: describeDelete(fs.existsSync(target) ? [target] : [], target), step: { type: 'delete', path: target }, targets: fs.existsSync(target) ? [target] : [] });
      }
    }
  }
  if (steps.length === 0) throw new Error(`${manifest.name} has no removal steps for the way it was installed, so it has to be removed by hand.`);
  return { kind: 'remove', modId: manifest.id, gameId: input.gameId, modName: manifest.name, gameName: input.gameName, steps };
}

// ---------- executing ----------

interface Downloaded {
  name: string;
  file: string;
  sha256: string;
  asset?: ReleaseAsset;
}

async function expectedHash(ps: PlannedStep, deps: EngineDeps): Promise<string | null> {
  const step = ps.step;
  if (step.type !== 'download') return null;
  if (step.sha256) return step.sha256.toLowerCase();
  if (step.githubDigest && ps.asset?.digest) return ps.asset.digest.replace(/^sha256:/i, '').toLowerCase();
  if (step.sha256Asset && ps.hashAsset) {
    const res = await deps.fetch(ps.hashAsset.url, { headers: { 'User-Agent': 'UnitedModManager' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Could not get the hash file (${res.status}).`);
    const text = (await res.text()).slice(0, 10_000);
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
      if (m && m[2] === ps.asset?.name) return m[1].toLowerCase();
    }
    const all = [...new Set(text.match(/\b[0-9a-f]{64}\b/gi)?.map((h) => h.toLowerCase()))];
    if (all.length === 1) return all[0];
    throw new Error('Could not read a hash from the hash file.');
  }
  return null;
}

export async function executeInstall(
  plan: InstallPlan,
  confirmed: Set<string>,
  deps: EngineDeps,
  onProgress: ProgressFn,
): Promise<EngineResult> {
  for (const c of plan.confirmations) {
    if (!confirmed.has(c.id)) return { ok: false, message: 'A required confirmation was not given, so nothing was changed.', notes: [] };
  }

  const downloads = new Map<string, Downloaded>(); // by lower-case file name
  const perMod = new Map<string, { extracted: InstallRecord['extracted']; downloads: Downloaded[]; ran: boolean; launchedOnly: boolean }>();
  const state = (modId: string) => {
    let s = perMod.get(modId);
    if (!s) perMod.set(modId, (s = { extracted: [], downloads: [], ran: false, launchedOnly: false }));
    return s;
  };
  const notes: string[] = [];
  const total = plan.steps.length;

  for (let i = 0; i < total; i++) {
    const ps = plan.steps[i];
    const step = ps.step;
    const report = (percent?: number) => onProgress({ step: i + 1, of: total, text: ps.text, percent });
    report();
    try {
      switch (step.type) {
        case 'download': {
          const url = ps.asset?.url ?? (step.url as string);
          const name = ps.asset?.name ?? (path.basename(new URL(url).pathname) || 'download');
          const dest = path.join(deps.downloadsDir, safeName(ps.modId), safeName(name));
          const { sha256 } = await downloadFile(deps.fetch, url, dest, {
            allowHttp: deps.allowHttp,
            onProgress: (got, size) => report(size ? Math.floor((got / size) * 100) : undefined),
          });
          const expected = await expectedHash(ps, deps);
          if (expected && expected !== sha256) {
            fs.rmSync(dest, { force: true });
            throw new Error(`${name} did not match its published hash, so it was deleted and nothing was installed.`);
          }
          const d: Downloaded = { name, file: dest, sha256, asset: ps.asset };
          downloads.set(`${ps.modId}:${name.toLowerCase()}`, d);
          state(ps.modId).downloads.push(d);
          break;
        }
        case 'extract': {
          const name = step.file ?? state(ps.modId).downloads.at(-1)?.name;
          const d = name ? downloads.get(`${ps.modId}:${name.toLowerCase()}`) : undefined;
          if (!d || !ps.target) throw new Error('Nothing was downloaded to unpack.');
          const target = ps.target;
          const result = await extractZip(d.file, target, {
            stripTopLevel: step.stripTopLevel,
            beforeWrite: (roots) => {
              for (const root of roots) {
                const existing = path.join(target, root);
                if (fs.existsSync(existing)) {
                  moveToBackup(existing, `${ps.modId}-${root}`, deps);
                  notes.push(`An existing "${root}" was moved to a backup folder in ${deps.backupsDir}.`);
                }
              }
            },
          });
          state(ps.modId).extracted.push({ baseDir: target, roots: result.roots });
          fs.rmSync(d.file, { force: true }); // the files are in place; the archive is not needed
          break;
        }
        case 'run': {
          let toRun: string;
          const what = step.path ? 'script' : 'installer';
          if (step.path) {
            toRun = ps.target as string;
            // Run only what this install has just unpacked, never a file that was already on the computer.
            const justMade = state(ps.modId).extracted.some((g) =>
              g.roots.some((root) => {
                const made = path.join(g.baseDir, root);
                return toRun === made || isInside(made, toRun);
              }),
            );
            if (!justMade) throw new Error('The script is not one of the files that were just unpacked, so it was not run.');
            if (!fs.existsSync(toRun)) throw new Error('The script was not found after unpacking.');
          } else {
            const d = downloads.get(`${ps.modId}:${(step.file ?? '').toLowerCase()}`);
            if (!d) throw new Error(`${step.file} was not downloaded.`);
            toRun = d.file;
          }
          const r = await deps.runInstaller(toRun, step.args ?? []);
          if (!r.launchedOnly && r.exitCode !== 0) {
            throw new Error(
              r.exitCode === null
                ? `The ${what} window was closed before it finished. Nothing was recorded as installed.`
                : `The ${what} closed with code ${r.exitCode}, so it may not have finished. Nothing was recorded as installed.`,
            );
          }
          state(ps.modId).ran = true;
          state(ps.modId).launchedOnly = r.launchedOnly;
          if (r.launchedOnly) notes.push('The installer was started. Finish it in its own window.');
          break;
        }
        case 'copy': {
          const target = ps.target as string;
          const exists = fs.existsSync(target);
          if (exists && (step.ifExists ?? 'ask') === 'skip') break;
          if (exists && !(ps.confirmId && confirmed.has(ps.confirmId))) {
            throw new Error(`${target} appeared since you reviewed the plan, so it was left alone.`);
          }
          const temp = path.join(deps.downloadsDir, safeName(ps.modId), `${safeName(path.basename(target))}.new`);
          await downloadFile(deps.fetch, step.from.url, temp, { allowHttp: deps.allowHttp });
          if (exists && step.backup) {
            const saved = copyToBackup(target, `${ps.modId}-${path.basename(target)}`, deps);
            notes.push(`Your previous ${path.basename(target)} was saved to ${saved}.`);
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(temp, target);
          break;
        }
        case 'open':
          await deps.openExternal(step.url);
          break;
        case 'note':
          notes.push(step.text);
          break;
        case 'delete':
          throw new Error('Delete steps are not part of an install.');
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { ok: false, message: `Step ${i + 1} of ${total} failed: ${why}`, notes };
    }
  }

  // Build the records. Only things we can actually track (unpacked files, or an installer) get one.
  const records: InstallRecord[] = [];
  for (const [modId, s] of perMod) {
    if (s.extracted.length === 0 && !s.ran) continue;
    const manifest = deps.catalog.manifest(modId);
    const watched = manifest?.updates.asset ? globToRegExp(manifest.updates.asset) : undefined;
    const main = s.downloads.find((d) => watched?.test(d.name)) ?? s.downloads[0];
    const release = plan.releases[modId];
    records.push({
      modId,
      gameId: plan.gameId,
      methodId: plan.methodIds[modId],
      gameVersion: plan.gameVersion,
      version: release?.version ?? 'unknown',
      tag: release?.tag,
      assetName: main?.name,
      assetHash: main?.sha256,
      assetUpdatedAt: main?.asset?.updatedAt,
      installedAt: (deps.now?.() ?? new Date()).toISOString(),
      extracted: s.extracted,
      launchedOnly: s.launchedOnly || undefined,
    });
  }
  const only = plan.steps.every((p) => p.step.type === 'open' || p.step.type === 'note');
  return {
    ok: true,
    message: only ? 'Done. Follow the notes below to finish.' : `${plan.modName} is installed.`,
    notes: [...new Set([...notes, ...plan.notes])],
    records,
  };
}

export async function executeRemove(plan: RemovePlan, deps: EngineDeps): Promise<EngineResult> {
  const notes: string[] = [];
  let moved = 0;
  try {
    for (const s of plan.steps) {
      if (s.step.type === 'delete') {
        for (const target of s.targets) {
          if (!fs.existsSync(target)) continue; // already gone since the plan was made
          const saved = moveToBackup(target, `${plan.modId}-${path.basename(target)}`, deps);
          moved++;
          notes.push(`${path.basename(target)} was moved to ${saved}. You can delete that backup once you are sure.`);
        }
      } else if (s.step.type === 'open') {
        await deps.openExternal(s.step.url);
      } else if (s.step.type === 'note') {
        notes.push(s.step.text);
      }
    }
  } catch (e) {
    return { ok: false, message: `Could not remove ${plan.modName}: ${e instanceof Error ? e.message : String(e)}`, notes };
  }
  // With nothing moved the mod may not be gone yet (Steam holds Workshop files until you unsubscribe), so say what happened.
  const message = moved > 0 ? `${plan.modName} was removed.` : `Nothing was moved. Follow the notes below to finish removing ${plan.modName}.`;
  return { ok: true, message, notes, removed: { modId: plan.modId, gameId: plan.gameId } };
}
