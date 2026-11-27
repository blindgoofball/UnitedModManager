import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { catalogInfo, initCatalog, loadAllManifests, loadGames, loadIndex, loadManifest, modSchemaProblems, refreshCatalog, REPO_URL } from './catalog';
import { currentEnv } from './detect';
import { getRelease, getReleaseWithAssets } from './github';
import { applicableMethods, buildInstallPlan, buildRemovePlan, executeInstall, executeRemove, EngineDeps, InstallPlan, RemovePlan } from './install/engine';
import { tokenRoots } from './install/paths';
import { detectPresence } from './install/presence';
import { isConsoleProgram, runInConsoleWindow } from './install/run-installer';
import { readInstalled, upsertRecords, writeInstalled } from './installed';
import { getLibrary, resolveGames } from './library';
import { readSettings, writeSettings } from './settings';
import { buildSubmission, checkSubmission, githubNewFileUrl, SubmitDeps } from './submit';
import { computeStatus } from './updates';

const userData = (...p: string[]): string => path.join(app.getPath('userData'), ...p);
const settingsFile = (): string => userData('settings.json');
const installedFile = (): string => userData('installed.json');
const detectEnv = () => currentEnv(app.getPath('home'), app.getPath('appData'), app.getPath('documents'));
const platformName = (): Platform => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------- installing ----------

/** Starts an installer and waits for it. Installers that need administrator rights cannot be
 *  started directly; those are handed to the shell, which shows the Windows prompt, but then
 *  we cannot tell when they finish. */
async function runInstaller(file: string, args: string[]): Promise<{ exitCode: number | null; launchedOnly: boolean }> {
  // Text-mode installers need a console window of their own, or they quit immediately.
  if (isConsoleProgram(file)) {
    const exitCode = await runInConsoleWindow(file, args, { title: 'Installer', workDir: path.join(path.dirname(file), '.run') });
    return { exitCode, launchedOnly: false };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', cwd: path.dirname(file) });
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (!['EACCES', 'EPERM', 'UNKNOWN'].includes(err.code ?? '')) return reject(err);
      void shell.openPath(file).then((problem) => (problem ? reject(new Error(problem)) : resolve({ exitCode: null, launchedOnly: true })));
    });
    child.once('exit', (code) => resolve({ exitCode: code, launchedOnly: false }));
  });
}

const engineDeps = (): EngineDeps => ({
  env: detectEnv(),
  platform: platformName(),
  downloadsDir: userData('downloads'),
  backupsDir: userData('backups'),
  fetch,
  catalog: { manifest: loadManifest, release: getReleaseWithAssets },
  openExternal: (url) => shell.openExternal(url),
  runInstaller,
});

const pendingPlans = new Map<string, { plan: InstallPlan | RemovePlan; expires: number }>();
let installing = false;

function rememberPlan(plan: InstallPlan | RemovePlan): string {
  const now = Date.now();
  for (const [id, p] of pendingPlans) if (p.expires < now) pendingPlans.delete(id);
  const id = randomUUID();
  pendingPlans.set(id, { plan, expires: now + 30 * 60 * 1000 });
  return id;
}

async function planInstall(modId: string, methodId: string, gameVersion?: string): Promise<{ ok: true; plan: InstallPlanView } | { ok: false; error: string }> {
  try {
    const manifest = loadManifest(modId);
    if (!manifest) return { ok: false, error: 'That mod is not in the catalog.' };
    const def = loadGames().find((g) => g.id === manifest.game.id);
    const game = def && (await resolveGames(loadGames(), detectEnv(), settingsFile())).get(def.id);
    if (!def || !game) return { ok: false, error: `${manifest.game.name} was not found on this computer. Add it in the Library first.` };

    const plan = await buildInstallPlan(
      { modId, methodId, gameVersion, gameId: def.id, gameName: def.name, gamePath: game.path, steamAppId: def.detect.steam?.appId },
      engineDeps(),
      readInstalled(installedFile()),
    );
    return {
      ok: true,
      plan: {
        planId: rememberPlan(plan),
        kind: 'install',
        title: `Install ${manifest.name}`,
        modName: manifest.name,
        steps: plan.steps.map((s) => s.text),
        warnings: [...new Set(plan.warnings)],
        skipped: plan.skipped,
        confirmations: plan.confirmations,
      },
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Where a mod's game is on this computer, and the folders its manifest paths can start from. */
async function gameFor(manifest: ModManifest) {
  const defs = loadGames();
  const def = defs.find((g) => g.id === manifest.game.id);
  const game = def && (await resolveGames(defs, detectEnv(), settingsFile())).get(def.id);
  if (!def || !game) return null;
  return { def, game, roots: tokenRoots(detectEnv(), game.path, def.detect.steam?.appId) };
}

async function planRemove(modId: string): Promise<{ ok: true; plan: InstallPlanView } | { ok: false; error: string }> {
  try {
    const manifest = loadManifest(modId);
    if (!manifest) return { ok: false, error: 'That mod is not in the catalog.' };
    const ctx = await gameFor(manifest);
    if (!ctx) return { ok: false, error: `${manifest.game.name} was not found on this computer.` };

    const records = readInstalled(installedFile());
    const record = records.find((r) => r.modId === modId && r.gameId === ctx.def.id);
    if (!record && !detectPresence(manifest, ctx.roots)) return { ok: false, error: `${manifest.name} does not appear to be installed.` };

    const plan = buildRemovePlan(
      { manifest, record, gameId: ctx.def.id, gameName: ctx.def.name, gamePath: ctx.game.path, steamAppId: ctx.def.detect.steam?.appId },
      engineDeps(),
    );
    // Other mods on this computer that need this one would stop working.
    const dependents = loadAllManifests()
      .filter(
        (m) =>
          m.id !== modId &&
          m.game.id === manifest.game.id &&
          m.dependencies?.some((d) => d.id === modId) &&
          (records.some((r) => r.modId === m.id && r.gameId === ctx.def.id) || detectPresence(m, ctx.roots)),
      )
      .map((m) => m.name);
    const warnings = dependents.length > 0 ? [`${dependents.join(', ')} ${dependents.length === 1 ? 'needs' : 'need'} ${manifest.name} and will not work without it.`] : [];
    return {
      ok: true,
      plan: {
        planId: rememberPlan(plan),
        kind: 'remove',
        title: `Remove ${manifest.name}`,
        modName: manifest.name,
        steps: plan.steps.map((s) => s.text),
        warnings,
        skipped: [],
        confirmations: [],
      },
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

async function runPlan(sender: Electron.WebContents, planId: unknown, confirmed: unknown): Promise<InstallResult> {
  const entry = typeof planId === 'string' ? pendingPlans.get(planId) : undefined;
  if (!entry || typeof planId !== 'string') return { ok: false, message: 'This plan has expired. Go back and review it again.', notes: [] };
  if (installing) return { ok: false, message: 'Another install is still running.', notes: [] };
  installing = true;
  try {
    const ids = new Set(Array.isArray(confirmed) ? confirmed.filter((c): c is string => typeof c === 'string') : []);
    const onProgress = (p: { step: number; of: number; text: string; percent?: number }): void => {
      if (!sender.isDestroyed()) sender.send('install:progress', { planId, ...p } satisfies InstallProgress);
    };
    const deps = engineDeps();
    const result =
      entry.plan.kind === 'install' ? await executeInstall(entry.plan, ids, deps, onProgress) : await executeRemove(entry.plan, deps);
    if (result.ok) {
      let records = readInstalled(installedFile());
      if (result.records) records = upsertRecords(records, result.records);
      const gone = result.removed;
      if (gone) records = records.filter((r) => !(r.modId === gone.modId && r.gameId === gone.gameId));
      writeInstalled(installedFile(), records);
    }
    pendingPlans.delete(planId);
    return { ok: result.ok, message: result.message, notes: result.notes };
  } catch (e) {
    return { ok: false, message: errorText(e), notes: [] };
  } finally {
    installing = false;
  }
}

// ---------- catalog views ----------

/** Checks GitHub for a newer mod list and tells every window if one was found. Never throws. */
async function refreshCatalogAndNotify(): Promise<void> {
  const { changed } = await refreshCatalog(fetch);
  if (changed) for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('catalog:changed');
}

async function buildFeed(force: boolean): Promise<HomeFeed> {
  if (force) await refreshCatalogAndNotify();
  const targets = loadAllManifests().filter((m) => m.kind !== 'dependency' && m.source.type === 'github');
  const results = await Promise.allSettled(targets.map((m) => getRelease(m, force)));
  const items: FeedItem[] = [];
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push({ ...r.value, name: targets[i].name, game: targets[i].game.name });
    else failed++;
  });
  items.sort((a, b) => b.date.localeCompare(a.date));
  return { catalog: catalogInfo(), items, total: targets.length, failed };
}

async function buildDetail(id: string): Promise<ModDetail | null> {
  const manifest = loadManifest(id);
  if (!manifest) return null;
  const dependencyNames: Record<string, string> = {};
  for (const d of manifest.dependencies ?? []) dependencyNames[d.id] = loadManifest(d.id)?.name ?? d.id;

  let latest: Awaited<ReturnType<typeof getReleaseWithAssets>> | null = null;
  let releaseError: string | undefined;
  if (manifest.source.type === 'github') {
    try {
      latest = await getReleaseWithAssets(manifest);
    } catch (e) {
      releaseError = errorText(e);
    }
  }

  const platform = platformName();
  const ctx = await gameFor(manifest);
  const record = readInstalled(installedFile()).find((r) => r.modId === id && r.gameId === manifest.game.id);
  const present = ctx ? detectPresence(manifest, ctx.roots) : null;
  let installed: InstallInfo['installed'];
  if (record) {
    installed = {
      version: record.version,
      methodId: record.methodId,
      gameVersion: record.gameVersion,
      canRemove: record.extracted.length > 0 || !!manifest.uninstall?.length,
      tracked: true,
      ...computeStatus(record, manifest, latest),
    };
  } else if (present) {
    // On the computer, but not put there by this manager: we know it is there and how, not which version.
    installed = {
      version: 'unknown',
      methodId: present.method ?? '',
      status: 'unknown',
      canRemove: !!manifest.uninstall?.length,
      tracked: false,
      foundVia: manifest.methods.find((m) => m.id === present.method)?.label,
    };
  }
  const install: InstallInfo = {
    platformSupported: manifest.platforms.includes(platform),
    gameFound: !!ctx,
    gameName: manifest.game.name,
    gamePath: ctx?.game.path,
    methods: applicableMethods(manifest, platform),
    installed,
  };
  return { install, manifest, dependencyNames, release: latest?.info ?? null, releaseError };
}

// ---------- submitting a mod ----------

const MAX_SUBMISSION_CHARS = 200_000;
const submitDeps = (): SubmitDeps => ({
  mods: loadAllManifests(),
  games: loadGames(),
  schemaProblems: modSchemaProblems,
  release: getReleaseWithAssets,
});

/** Reads the form the window sent, keeping only the fields we know and only the right kinds of value. */
function toSubmitForm(raw: unknown): SubmitForm | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const s = (k: string): string => (typeof r[k] === 'string' ? (r[k] as string).slice(0, 2000) : '');
  const b = (k: string): boolean => r[k] === true;
  const platforms = Array.isArray(r.platforms) ? r.platforms.filter((p): p is Platform => p === 'windows' || p === 'macos' || p === 'linux') : [];
  const install = r.install === 'installer' || r.install === 'zip' || r.install === 'workshop' ? r.install : 'zip';
  return {
    name: s('name'), id: s('id'), summary: s('summary'), description: s('description'), authors: s('authors'), homepage: s('homepage'),
    license: s('license'), gameChoice: s('gameChoice'), newGameName: s('newGameName'), platforms, install, repo: s('repo'), tag: s('tag'),
    workshopItemId: s('workshopItemId'), installerAsset: s('installerAsset'), hashSource: r.hashSource === 'file' ? 'file' : 'digest',
    hashFile: s('hashFile'), interactive: b('interactive'), selfUpdating: b('selfUpdating'), leftoverPath: s('leftoverPath'),
    zipAsset: s('zipAsset'), unpackInto: s('unpackInto'), createdFolder: s('createdFolder'),
  };
}

const validSubmissionText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_SUBMISSION_CHARS;

/** Saving and sending are only offered for entries that pass every check, so a bad file never leaves the app. */
async function checkedSubmission(text: unknown): Promise<{ ok: true; text: string; id: string } | { ok: false; error: string }> {
  if (!validSubmissionText(text)) return { ok: false, error: 'There is no mod file to use.' };
  const result = await checkSubmission(text, submitDeps());
  if (result.problems.length > 0 || !result.id) return { ok: false, error: 'Fix the problems listed first, then try again.' };
  return { ok: true, text, id: result.id };
}

// ---------- window ----------

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 480,
    minHeight: 400,
    title: 'United Mod Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  // The window only ever shows our own page; links go to the user's browser instead.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Look for a newer mod list once the page is listening, so it does not miss the "changed" message.
  win.webContents.once('did-finish-load', () => void refreshCatalogAndNotify());
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('mods:list', () => loadIndex());
ipcMain.handle('mods:get', (_e, id: unknown) => (typeof id === 'string' ? buildDetail(id) : null));
ipcMain.handle('home:feed', (_e, force: unknown) => buildFeed(force === true));
ipcMain.handle('library:get', () =>
  getLibrary(loadIndex(), loadGames(), detectEnv(), settingsFile(), readInstalled(installedFile()), {
    manifest: loadManifest,
    manifests: loadAllManifests,
    release: getReleaseWithAssets,
  }),
);
ipcMain.handle('install:plan', (_e, modId: unknown, methodId: unknown, gameVersion: unknown) =>
  typeof modId === 'string' && typeof methodId === 'string'
    ? planInstall(modId, methodId, typeof gameVersion === 'string' ? gameVersion : undefined)
    : { ok: false, error: 'Invalid request.' },
);
ipcMain.handle('install:plan-remove', (_e, modId: unknown) => (typeof modId === 'string' ? planRemove(modId) : { ok: false, error: 'Invalid request.' }));
ipcMain.handle('install:run', (e, planId: unknown, confirmed: unknown) => runPlan(e.sender, planId, confirmed));
ipcMain.handle('submit:build', (_e, raw: unknown) => {
  const form = toSubmitForm(raw);
  return form ? buildSubmission(form, submitDeps()) : { json: '', problems: ['The form could not be read.'], notes: [] };
});
ipcMain.handle('submit:check', (_e, text: unknown) =>
  validSubmissionText(text) ? checkSubmission(text, submitDeps()) : { problems: ['There is no mod file to check.'], notes: [] },
);
ipcMain.handle('submit:copy', (_e, text: unknown): boolean => {
  if (!validSubmissionText(text)) return false;
  clipboard.writeText(text);
  return true;
});
ipcMain.handle('submit:save', async (e, text: unknown) => {
  const checked = await checkedSubmission(text);
  if (!checked.ok) return { ok: false, error: checked.error };
  const win = BrowserWindow.fromWebContents(e.sender);
  const options = { title: 'Save your mod file', defaultPath: `${checked.id}.json`, filters: [{ name: 'JSON file', extensions: ['json'] }] };
  const chosen = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(chosen.filePath, checked.text, 'utf8'); // no byte-order mark
    return { ok: true, path: chosen.filePath };
  } catch (err) {
    return { ok: false, error: `Could not save the file: ${errorText(err)}` };
  }
});
ipcMain.handle('submit:open-github', async (_e, text: unknown) => {
  const checked = await checkedSubmission(text);
  if (!checked.ok) return { ok: false, error: checked.error };
  const { url, prefilled } = githubNewFileUrl(REPO_URL, checked.id, checked.text);
  // Too long to carry in a link: put it on the clipboard so it can be pasted into the page that opens.
  if (!prefilled) clipboard.writeText(checked.text);
  await shell.openExternal(url);
  return { ok: true, prefilled };
});
ipcMain.handle('games:choose-folder', async (e, gameId: unknown): Promise<ChooseFolderResult> => {
  const def = loadGames().find((g) => g.id === gameId);
  if (!def) return { ok: false, error: 'Unknown game.' };
  const win = BrowserWindow.fromWebContents(e.sender);
  const options = { title: `Choose the ${def.name} folder`, properties: ['openDirectory' as const] };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  const chosen = result.filePaths[0];
  if (!fs.statSync(chosen).isDirectory()) return { ok: false, error: 'That is not a folder.' };
  const settings = readSettings(settingsFile());
  settings.manualGames[def.id] = chosen;
  writeSettings(settingsFile(), settings);
  return { ok: true };
});
ipcMain.handle('games:clear-folder', (_e, gameId: unknown): boolean => {
  if (typeof gameId !== 'string') return false;
  const settings = readSettings(settingsFile());
  if (!(gameId in settings.manualGames)) return false;
  delete settings.manualGames[gameId];
  writeSettings(settingsFile(), settings);
  return true;
});
ipcMain.handle('app:open-external', async (_e, url: unknown) => {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  await shell.openExternal(url);
  return true;
});

app.whenReady().then(() => {
  initCatalog(app.getPath('userData'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
