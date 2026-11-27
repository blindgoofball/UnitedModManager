// Exercises the install engine against the REAL catalog and REAL GitHub downloads, inside a
// throwaway fake game folder. Installers are recorded, never launched. Needs internet.
//   node scripts/integration-real.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildInstallPlan, executeInstall, buildRemovePlan, executeRemove } = require('../dist/install/engine.js');
const { getReleaseWithAssets } = require('../dist/github.js');

const catalogDir = path.join(__dirname, '..', 'dist', 'catalog', 'mods');
const manifest = (id) => {
  const f = path.join(catalogDir, `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umm-real-'));
const game = path.join(root, 'FakeRimWorld');
fs.mkdirSync(path.join(game, 'Mods'), { recursive: true });
const ran = [];
const deps = {
  env: { platform: 'windows', home: path.join(root, 'home'), appData: path.join(root, 'home', 'AppData', 'Roaming'), localAppData: path.join(root, 'home', 'AppData', 'Local'), documents: path.join(root, 'home', 'Documents') },
  platform: 'windows',
  downloadsDir: path.join(root, 'downloads'),
  backupsDir: path.join(root, 'backups'),
  fetch,
  catalog: { manifest, release: getReleaseWithAssets },
  openExternal: async (u) => console.log('   [would open]', u),
  runInstaller: async (file, args) => {
    ran.push(file);
    console.log('   [would run installer]', path.basename(file), `(${fs.statSync(file).size} bytes) args=${JSON.stringify(args)}`);
    return { exitCode: 0, launchedOnly: false };
  },
};

async function step(title, fn) {
  console.log(`\n== ${title}`);
  try {
    await fn();
  } catch (e) {
    console.log('   FAILED:', e.message);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('Scratch folder:', root);
  let records = [];

  await step('United Minecraft: download + verify the real installer, do not launch it', async () => {
    const plan = await buildInstallPlan({ modId: 'united-minecraft', methodId: 'installer', gameId: 'minecraft-java', gameName: 'Minecraft', gamePath: path.join(root, 'FakeMinecraft') }, deps, []);
    plan.steps.forEach((s, i) => console.log(`   ${i + 1}. ${s.text}`));
    const res = await executeInstall(plan, new Set(), deps, (p) => p.percent === 100 && console.log('   downloaded 100%'));
    console.log('   result:', res.ok ? 'OK' : 'FAILED', '-', res.message);
    if (!res.ok) throw new Error(res.message);
    const r = res.records[0];
    console.log('   record:', { version: r.version, tag: r.tag, assetName: r.assetName, assetHash: r.assetHash?.slice(0, 16) + '…' });
    if (ran.length !== 1) throw new Error('installer runner was not called exactly once');
  });

  await step('RimWorld Access (manual method, game 1.7) + Harmony dependency into the fake game folder', async () => {
    const plan = await buildInstallPlan({ modId: 'rimworld-access', methodId: 'manual', gameVersion: '1.7', gameId: 'rimworld', gameName: 'RimWorld', gamePath: game }, deps, []);
    plan.steps.forEach((s, i) => console.log(`   ${i + 1}. ${s.text}`));
    console.log('   confirmations:', plan.confirmations.length, '| warnings:', plan.warnings);
    const res = await executeInstall(plan, new Set(plan.confirmations.map((c) => c.id)), deps, () => {});
    console.log('   result:', res.ok ? 'OK' : 'FAILED', '-', res.message);
    res.notes.forEach((n) => console.log('   note:', n));
    if (!res.ok) throw new Error(res.message);
    records = res.records;
    for (const r of records) console.log('   record:', r.modId, r.version, JSON.stringify(r.extracted.map((e) => e.roots)));
    const about = (name) => fs.existsSync(path.join(game, 'Mods', name, 'About', 'About.xml'));
    console.log('   Mods/RimWorldAccess/About/About.xml exists:', about('RimWorldAccess'));
    console.log('   Mods/HarmonyMod/About/About.xml exists:', about('HarmonyMod'));
    const cfg = path.join(deps.env.home, 'AppData', 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios', 'Config', 'ModsConfig.xml');
    console.log('   ModsConfig.xml placed:', fs.existsSync(cfg), fs.existsSync(cfg) ? `(${fs.statSync(cfg).size} bytes)` : '');
    if (!about('RimWorldAccess') || !about('HarmonyMod')) throw new Error('expected mod folders are missing');
  });

  await step('Reinstalling RimWorld Access moves the old copy to backup, Harmony is not repeated', async () => {
    const plan = await buildInstallPlan({ modId: 'rimworld-access', methodId: 'manual', gameVersion: '1.7', gameId: 'rimworld', gameName: 'RimWorld', gamePath: game }, deps, records);
    console.log('   plan has', plan.steps.length, 'steps; mods involved:', [...new Set(plan.steps.map((s) => s.modId))].join(', '));
    console.log('   confirmations (existing ModsConfig.xml should now need one):', plan.confirmations.map((c) => c.text));
    const res = await executeInstall(plan, new Set(plan.confirmations.map((c) => c.id)), deps, () => {});
    console.log('   result:', res.ok ? 'OK' : 'FAILED', '-', res.message);
    res.notes.forEach((n) => console.log('   note:', n));
    if (!res.ok) throw new Error(res.message);
  });

  await step('Remove Harmony: folder goes to backup', async () => {
    const rec = records.find((r) => r.modId === 'harmony-rimworld');
    const res = executeRemove(buildRemovePlan(rec, 'Harmony (RimWorld)', 'RimWorld'), deps);
    console.log('   result:', res.ok ? 'OK' : 'FAILED', '-', res.message);
    console.log('   Mods now contains:', fs.readdirSync(path.join(game, 'Mods')).join(', '));
  });

  console.log('\nExit code', process.exitCode ?? 0);
  fs.rmSync(root, { recursive: true, force: true });
})();
