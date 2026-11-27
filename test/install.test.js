// Install engine tests: a fake network and fake installer, real files in a temp folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { buildInstallPlan, executeInstall, buildRemovePlan, executeRemove } = require('../dist/install/engine.js');
const { expandInstallPath, globToRegExp } = require('../dist/install/paths.js');
const { computeStatus } = require('../dist/updates.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'umm-inst-'));
const zipOf = (files) => {
  const z = new AdmZip();
  for (const [name, text] of Object.entries(files)) z.addFile(name, Buffer.from(text));
  return z.toBuffer();
};

/** Builds a stored (uncompressed) zip byte by byte, so entry names are exactly what we say, even "../x". */
function rawZip(entries) {
  const zlib = require('node:zlib');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name);
    const d = Buffer.from(data);
    const crc = zlib.crc32(d);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, d);
    centrals.push(ch, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A world with one game folder, a fake web and a recording installer. */
function world(opts = {}) {
  const root = tmp();
  const game = path.join(root, 'Game');
  fs.mkdirSync(path.join(game, 'Mods'), { recursive: true });
  const web = new Map(); // url -> Buffer
  const opened = [];
  const ran = [];
  const manifests = {};
  const releases = {};
  const deps = {
    env: { platform: 'windows', home: path.join(root, 'home'), appData: path.join(root, 'home', 'AppData', 'Roaming'), localAppData: path.join(root, 'home', 'AppData', 'Local'), documents: path.join(root, 'home', 'Documents') },
    platform: 'windows',
    downloadsDir: path.join(root, 'downloads'),
    backupsDir: path.join(root, 'backups'),
    fetch: async (url) => {
      const body = web.get(String(url));
      if (!body) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    },
    catalog: {
      manifest: (id) => manifests[id] ?? null,
      release: async (m) => {
        if (!releases[m.id]) throw new Error('no release');
        return releases[m.id];
      },
    },
    openExternal: async (u) => void opened.push(u),
    runInstaller: async (file, args) => {
      ran.push({ file, args, content: fs.readFileSync(file) });
      return opts.runResult ?? { exitCode: 0, launchedOnly: false };
    },
    now: () => new Date('2026-01-02T03:04:05Z'),
  };
  const input = (modId, methodId, extra = {}) => ({ modId, methodId, gameId: 'g', gameName: 'Game', gamePath: game, ...extra });
  const addRelease = (modId, tag, assets) => {
    releases[modId] = { info: { modId, tag, version: tag.replace(/^v/, ''), date: '2026-01-01T00:00:00Z', url: 'x' }, assets };
  };
  return { root, game, web, opened, ran, manifests, deps, input, addRelease };
}

const baseManifest = (over) => ({
  id: 'mod-a', name: 'Mod A', summary: 's', authors: ['x'], game: { id: 'g', name: 'Game' }, platforms: ['windows', 'macos'],
  source: { type: 'github', repo: 'o/r' }, updates: { strategy: 'release-tag' }, methods: [], ...over,
});
const asset = (name, buf, extra = {}) => ({ name, size: buf.length, url: `https://dl.test/${name}`, updatedAt: '2026-01-01T00:00:00Z', ...extra });

test('installs a zip into Mods, verified by GitHub digest, and records what it created', async () => {
  const w = world();
  const zip = zipOf({ 'ModFolder/About/About.xml': '<a/>', 'ModFolder/readme.txt': 'hi' });
  w.web.set('https://dl.test/Mod.zip', zip);
  w.addRelease('mod-a', 'v1.2.0', [asset('Mod.zip', zip, { digest: `sha256:${sha(zip)}` })]);
  w.manifests['mod-a'] = baseManifest({
    methods: [{ id: 'manual', label: 'Manual', steps: [{ type: 'download', asset: 'Mod.zip', githubDigest: true }, { type: 'extract', to: '{game}/Mods' }] }],
  });
  const plan = await buildInstallPlan(w.input('mod-a', 'manual'), w.deps, []);
  const progress = [];
  const res = await executeInstall(plan, new Set(), w.deps, (p) => progress.push(p));
  assert.equal(res.ok, true, res.message);
  assert.equal(fs.readFileSync(path.join(w.game, 'Mods', 'ModFolder', 'About', 'About.xml'), 'utf8'), '<a/>');
  assert.equal(res.records.length, 1);
  assert.deepEqual(res.records[0].extracted, [{ baseDir: path.join(w.game, 'Mods'), roots: ['ModFolder'] }]);
  assert.equal(res.records[0].version, '1.2.0');
  assert.ok(progress.length >= 2, 'progress is reported');
  assert.equal(fs.existsSync(path.join(w.deps.downloadsDir, 'mod-a', 'Mod.zip')), false, 'archive is cleaned up');
});

test('a download that does not match its hash is deleted and nothing is installed', async () => {
  const w = world();
  const good = zipOf({ 'ModFolder/a.txt': 'good' });
  const evil = zipOf({ 'ModFolder/a.txt': 'tampered' });
  w.web.set('https://dl.test/Mod.zip', evil); // server serves something other than what the hash describes
  w.addRelease('mod-a', 'v1', [asset('Mod.zip', good, { digest: `sha256:${sha(good)}` })]);
  w.manifests['mod-a'] = baseManifest({
    methods: [{ id: 'm', label: 'M', steps: [{ type: 'download', asset: 'Mod.zip', githubDigest: true }, { type: 'extract', to: '{game}/Mods' }] }],
  });
  const plan = await buildInstallPlan(w.input('mod-a', 'm'), w.deps, []);
  const res = await executeInstall(plan, new Set(), w.deps, () => {});
  assert.equal(res.ok, false);
  assert.match(res.message, /hash/);
  assert.equal(fs.existsSync(path.join(w.game, 'Mods', 'ModFolder')), false);
  assert.equal(fs.existsSync(path.join(w.deps.downloadsDir, 'mod-a', 'Mod.zip')), false, 'bad file deleted');
  assert.equal(res.records, undefined);
});

test('an existing folder with the same name is moved to backups, not overwritten in place', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.game, 'Mods', 'ModFolder'));
  fs.writeFileSync(path.join(w.game, 'Mods', 'ModFolder', 'old.txt'), 'old');
  const zip = zipOf({ 'ModFolder/new.txt': 'new' });
  w.web.set('https://dl.test/Mod.zip', zip);
  w.addRelease('mod-a', 'v1', [asset('Mod.zip', zip, { digest: `sha256:${sha(zip)}` })]);
  w.manifests['mod-a'] = baseManifest({
    methods: [{ id: 'm', label: 'M', steps: [{ type: 'download', asset: 'Mod.zip', githubDigest: true }, { type: 'extract', to: '{game}/Mods' }] }],
  });
  const res = await executeInstall(await buildInstallPlan(w.input('mod-a', 'm'), w.deps, []), new Set(), w.deps, () => {});
  assert.equal(res.ok, true, res.message);
  assert.equal(fs.existsSync(path.join(w.game, 'Mods', 'ModFolder', 'old.txt')), false);
  assert.equal(fs.existsSync(path.join(w.game, 'Mods', 'ModFolder', 'new.txt')), true);
  const backups = fs.readdirSync(w.deps.backupsDir);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(w.deps.backupsDir, backups[0], 'ModFolder', 'old.txt'), 'utf8'), 'old');
});

test('a zip with paths that climb out of the target is rejected before anything is written', async () => {
  const w = world();
  const zip = rawZip([{ name: 'ModFolder/ok.txt', data: 'ok' }, { name: '../evil.txt', data: 'evil' }]);
  assert.ok(new AdmZip(zip).getEntries().some((e) => e.entryName.includes('..')), 'fixture really contains a ".." path');
  w.web.set('https://dl.test/Mod.zip', zip);
  w.addRelease('mod-a', 'v1', [asset('Mod.zip', zip, { digest: `sha256:${sha(zip)}` })]);
  w.manifests['mod-a'] = baseManifest({
    methods: [{ id: 'm', label: 'M', steps: [{ type: 'download', asset: 'Mod.zip', githubDigest: true }, { type: 'extract', to: '{game}/Mods' }] }],
  });
  const res = await executeInstall(await buildInstallPlan(w.input('mod-a', 'm'), w.deps, []), new Set(), w.deps, () => {});
  assert.equal(res.ok, false);
  assert.match(res.message, /unsafe/);
  assert.equal(fs.existsSync(path.join(w.game, 'evil.txt')), false);
  assert.equal(fs.existsSync(path.join(w.game, 'Mods', 'ModFolder', 'ok.txt')), false, 'nothing partial is left behind');
});

test('replacing an existing file needs confirmation, backs the old one up, and refuses without it', async () => {
  const w = world();
  const target = path.join(w.deps.env.home, 'AppData', 'LocalLow', 'Studio', 'Config', 'ModsConfig.xml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'MY MOD LIST');
  w.web.set('https://site.test/ModsConfig.xml', Buffer.from('NEW LIST'));
  w.manifests['mod-a'] = baseManifest({
    source: { type: 'workshop', itemId: '1' }, updates: { strategy: 'external' },
    methods: [{ id: 'm', label: 'M', steps: [{ type: 'open', url: 'steam://url/CommunityFilePage/1' }] }],
    afterInstall: [{ type: 'copy', from: { url: 'https://site.test/ModsConfig.xml' }, to: '{locallow}/Studio/Config/ModsConfig.xml', backup: true, ifExists: 'ask' }],
  });
  const plan = await buildInstallPlan(w.input('mod-a', 'm'), w.deps, []);
  assert.equal(plan.confirmations.length, 1);
  assert.match(plan.confirmations[0].text, /ModsConfig\.xml/);

  const refused = await executeInstall(plan, new Set(), w.deps, () => {});
  assert.equal(refused.ok, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'MY MOD LIST', 'untouched without confirmation');
  assert.deepEqual(w.opened, [], 'nothing at all ran');

  const ok = await executeInstall(plan, new Set([plan.confirmations[0].id]), w.deps, () => {});
  assert.equal(ok.ok, true, ok.message);
  assert.equal(fs.readFileSync(target, 'utf8'), 'NEW LIST');
  const backups = fs.readdirSync(w.deps.backupsDir);
  assert.equal(fs.readFileSync(path.join(w.deps.backupsDir, backups[0], 'ModsConfig.xml'), 'utf8'), 'MY MOD LIST');
  assert.equal(w.opened.length, 1, 'the Workshop page was opened');
  assert.equal(ok.records.length, 0, 'a Workshop install cannot be tracked, so no record');
});

test('copying to a new location needs no confirmation and creates missing folders', async () => {
  const w = world();
  w.web.set('https://site.test/x.xml', Buffer.from('X'));
  w.manifests['mod-a'] = baseManifest({
    source: { type: 'workshop', itemId: '1' }, updates: { strategy: 'external' },
    methods: [{ id: 'm', label: 'M', steps: [{ type: 'copy', from: { url: 'https://site.test/x.xml' }, to: '{game}/Config/x.xml', backup: true }] }],
  });
  const plan = await buildInstallPlan(w.input('mod-a', 'm'), w.deps, []);
  assert.equal(plan.confirmations.length, 0);
  assert.equal((await executeInstall(plan, new Set(), w.deps, () => {})).ok, true);
  assert.equal(fs.readFileSync(path.join(w.game, 'Config', 'x.xml'), 'utf8'), 'X');
});

test('runs a downloaded installer after verifying the hash file, and records its hash', async () => {
  const w = world();
  const exe = Buffer.from('MZ fake installer');
  w.web.set('https://dl.test/inst.exe', exe);
  w.web.set('https://dl.test/inst.exe.sha256', Buffer.from(`${sha(exe)}  inst.exe\n`));
  w.addRelease('mod-a', 'v2.3.0+mc1', [asset('inst.exe', exe), asset('inst.exe.sha256', Buffer.from('x'))]);
  w.manifests['mod-a'] = baseManifest({
    updates: { strategy: 'asset-changed', asset: 'inst.exe', selfUpdating: true },
    methods: [{ id: 'installer', label: 'I', steps: [{ type: 'download', asset: 'inst.exe', sha256Asset: 'inst.exe.sha256' }, { type: 'run', file: 'inst.exe', interactive: true }] }],
  });
  const plan = await buildInstallPlan(w.input('mod-a', 'installer'), w.deps, []);
  const res = await executeInstall(plan, new Set(), w.deps, () => {});
  assert.equal(res.ok, true, res.message);
  assert.equal(w.ran.length, 1);
  assert.deepEqual(w.ran[0].content, exe, 'the verified file is the one that ran');
  assert.equal(res.records[0].assetHash, sha(exe));
  assert.equal(res.records[0].assetName, 'inst.exe');
  assert.equal(fs.existsSync(path.join(w.deps.downloadsDir, 'mod-a', 'inst.exe')), true, 'installer is kept so it can be re-run');
});

test('a hash file that disagrees stops the installer from running', async () => {
  const w = world();
  const exe = Buffer.from('MZ real');
  w.web.set('https://dl.test/inst.exe', exe);
  w.web.set('https://dl.test/inst.exe.sha256', Buffer.from(`${'0'.repeat(64)}  inst.exe\n`));
  w.addRelease('mod-a', 'v1', [asset('inst.exe', exe), asset('inst.exe.sha256', Buffer.from('x'))]);
  w.manifests['mod-a'] = baseManifest({
    methods: [{ id: 'i', label: 'I', steps: [{ type: 'download', asset: 'inst.exe', sha256Asset: 'inst.exe.sha256' }, { type: 'run', file: 'inst.exe' }] }],
  });
  const res = await executeInstall(await buildInstallPlan(w.input('mod-a', 'i'), w.deps, []), new Set(), w.deps, () => {});
  assert.equal(res.ok, false);
  assert.equal(w.ran.length, 0, 'the installer must never run');
});

/** A mod whose zip contains an install script: unpack it, then run the script. */
function scriptWorld(runResult, scriptPath = '{game}/Mods/Mod/install.bat', files) {
  const w = world({ runResult });
  const zip = zipOf(files ?? { 'Mod/install.bat': '@echo off\r\nexit /b 0\r\n', 'Mod/data.txt': 'payload' });
  w.web.set('https://dl.test/Mod.zip', zip);
  w.addRelease('mod-a', 'v1.0.0', [asset('Mod.zip', zip, { digest: `sha256:${sha(zip)}` })]);
  w.manifests['mod-a'] = baseManifest({
    methods: [{ id: 'm', label: 'M', steps: [
      { type: 'download', asset: 'Mod.zip', githubDigest: true },
      { type: 'extract', to: '{game}/Mods' },
      { type: 'run', path: scriptPath, interactive: true },
    ] }],
  });
  return w;
}

test('a script from an unpacked archive is run after unpacking, and what it unpacked is recorded', async () => {
  const w = scriptWorld();
  const plan = await buildInstallPlan(w.input('mod-a', 'm'), w.deps, []);
  assert.match(plan.steps[2].text, /Run the script install\.bat from .*Mod\b/);
  const res = await executeInstall(plan, new Set(), w.deps, () => {});
  assert.equal(res.ok, true, res.message);
  assert.equal(w.ran.length, 1);
  assert.equal(w.ran[0].file, path.join(w.game, 'Mods', 'Mod', 'install.bat'));
  assert.equal(w.ran[0].content.toString(), '@echo off\r\nexit /b 0\r\n', 'it ran the unpacked copy, which existed when it started');
  assert.deepEqual(res.records[0].extracted, [{ baseDir: path.join(w.game, 'Mods'), roots: ['Mod'] }], 'so it can be removed later');
});

test('a script that fails is reported as a script, and nothing is recorded', async () => {
  let w = scriptWorld({ exitCode: 5, launchedOnly: false });
  let res = await executeInstall(await buildInstallPlan(w.input('mod-a', 'm'), w.deps, []), new Set(), w.deps, () => {});
  assert.equal(res.ok, false);
  assert.match(res.message, /The script closed with code 5/);
  assert.equal(res.records, undefined);

  w = scriptWorld({ exitCode: null, launchedOnly: false });
  res = await executeInstall(await buildInstallPlan(w.input('mod-a', 'm'), w.deps, []), new Set(), w.deps, () => {});
  assert.match(res.message, /script window was closed before it finished/);
});

test('a script path that is inside the unpack folder but NOT part of the archive is never run', async () => {
  // Something already on the computer at a path the manifest names must not be run just because it is nearby.
  const w = scriptWorld(undefined, '{game}/Mods/Other/old.bat');
  fs.mkdirSync(path.join(w.game, 'Mods', 'Other'), { recursive: true });
  fs.writeFileSync(path.join(w.game, 'Mods', 'Other', 'old.bat'), 'echo pre-existing');
  const plan = await buildInstallPlan(w.input('mod-a', 'm'), w.deps, []);
  const res = await executeInstall(plan, new Set(), w.deps, () => {});
  assert.equal(res.ok, false);
  assert.match(res.message, /not one of the files that were just unpacked/);
  assert.equal(w.ran.length, 0, 'the pre-existing script must not run');
});

test('a script listed in the archive but missing from it fails safely instead of running something else', async () => {
  const w = scriptWorld(undefined, '{game}/Mods/Mod/missing.bat');
  const res = await executeInstall(await buildInstallPlan(w.input('mod-a', 'm'), w.deps, []), new Set(), w.deps, () => {});
  assert.equal(res.ok, false);
  assert.equal(w.ran.length, 0);
});

test('unsafe run paths are refused when the plan is made', async () => {
  const cases = [
    ['{game}/elsewhere/install.bat', /not inside a folder that is unpacked earlier/],
    ['{game}/Mods/Mod/readme.txt', /only \.exe, \.bat, \.cmd and \.ps1/],
    ['{game}/Mods/Mod/run.vbs', /only \.exe, \.bat, \.cmd and \.ps1/],
    ['{game}/Mods/Mod/*.bat', /only \.exe, \.bat, \.cmd and \.ps1.*wildcards/],
    ['{game}/Mods/../install.bat', /outside|not inside/],
    ['{home}/install.bat', /not inside a folder that is unpacked earlier/],
  ];
  for (const [p, expected] of cases) {
    const w = scriptWorld(undefined, p);
    await assert.rejects(buildInstallPlan(w.input('mod-a', 'm'), w.deps, []), expected, p);
  }
  const both = scriptWorld();
  both.manifests['mod-a'].methods[0].steps[2].file = 'Mod.zip';
  await assert.rejects(buildInstallPlan(both.input('mod-a', 'm'), both.deps, []), /either "file" or "path"/);
});

test('a script cannot be run before anything is unpacked', async () => {
  const w = scriptWorld();
  w.manifests['mod-a'].methods[0].steps.splice(1, 1); // drop the unpack step
  await assert.rejects(buildInstallPlan(w.input('mod-a', 'm'), w.deps, []), /not inside a folder that is unpacked earlier/);
});

test('a failing installer is reported and not recorded; a shell-launched one is recorded as launched only', async () => {
  const exe = Buffer.from('MZ');
  const setup = (runResult) => {
    const w = world({ runResult });
    w.web.set('https://dl.test/inst.exe', exe);
    w.addRelease('mod-a', 'v1', [asset('inst.exe', exe, { digest: `sha256:${sha(exe)}` })]);
    w.manifests['mod-a'] = baseManifest({
      methods: [{ id: 'i', label: 'I', steps: [{ type: 'download', asset: 'inst.exe', githubDigest: true }, { type: 'run', file: 'inst.exe' }] }],
    });
    return w;
  };
  let w = setup({ exitCode: 5, launchedOnly: false });
  let res = await executeInstall(await buildInstallPlan(w.input('mod-a', 'i'), w.deps, []), new Set(), w.deps, () => {});
  assert.equal(res.ok, false);
  assert.match(res.message, /code 5/);
  assert.equal(res.records, undefined);

  w = setup({ exitCode: null, launchedOnly: true });
  res = await executeInstall(await buildInstallPlan(w.input('mod-a', 'i'), w.deps, []), new Set(), w.deps, () => {});
  assert.equal(res.ok, true);
  assert.equal(res.records[0].launchedOnly, true);
  assert.ok(res.notes.some((n) => /Finish it/.test(n)));
});

test('dependencies are installed first, and skipped when already installed', async () => {
  const w = world();
  const dz = zipOf({ 'Dep/a.txt': 'd' });
  const mz = zipOf({ 'Main/a.txt': 'm' });
  w.web.set('https://dl.test/Dep.zip', dz);
  w.web.set('https://dl.test/Main.zip', mz);
  w.addRelease('dep', 'v9', [asset('Dep.zip', dz, { digest: `sha256:${sha(dz)}` })]);
  w.addRelease('mod-a', 'v1', [asset('Main.zip', mz, { digest: `sha256:${sha(mz)}` })]);
  const steps = (a) => [{ type: 'download', asset: a, githubDigest: true }, { type: 'extract', to: '{game}/Mods' }];
  w.manifests.dep = baseManifest({ id: 'dep', kind: 'dependency', name: 'Dep', methods: [{ id: 'manual', label: 'M', steps: steps('Dep.zip') }] });
  w.manifests['mod-a'] = baseManifest({ dependencies: [{ id: 'dep' }], methods: [{ id: 'manual', label: 'M', steps: steps('Main.zip') }] });

  const plan = await buildInstallPlan(w.input('mod-a', 'manual'), w.deps, []);
  assert.deepEqual(plan.steps.map((s) => s.modId), ['dep', 'dep', 'mod-a', 'mod-a']);
  const res = await executeInstall(plan, new Set(), w.deps, () => {});
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(res.records.map((r) => r.modId).sort(), ['dep', 'mod-a']);

  const again = await buildInstallPlan(w.input('mod-a', 'manual'), w.deps, res.records);
  assert.deepEqual(again.steps.map((s) => s.modId), ['mod-a', 'mod-a'], 'installed dependency is not repeated');
});

test('the manifest\'s "things to know" show up as warnings on the plan', async () => {
  const w = world();
  w.manifests['mod-a'] = baseManifest({
    source: { type: 'workshop', itemId: '1' }, updates: { strategy: 'external' },
    methods: [{ id: 'm', label: 'M', steps: [{ type: 'note', text: 'hello' }] }],
    conflicts: [{ note: 'A leftover copy loads twice.' }],
  });
  const plan = await buildInstallPlan(w.input('mod-a', 'm'), w.deps, []);
  assert.ok(plan.warnings.includes('A leftover copy loads twice.'));
});

test('steps are chosen by platform and game version, and a needed version must be given', async () => {
  const w = world();
  w.manifests['mod-a'] = baseManifest({
    source: { type: 'workshop', itemId: '1' }, updates: { strategy: 'external' }, gameVersions: ['1.6', '1.7'],
    methods: [{ id: 'm', label: 'M', steps: [
      { type: 'note', text: 'for 1.6', when: { version: '1.6' } },
      { type: 'note', text: 'for 1.7', when: { version: '1.7' } },
      { type: 'note', text: 'mac only', when: { platform: 'macos' } },
      { type: 'note', text: 'always' },
    ] }],
  });
  await assert.rejects(buildInstallPlan(w.input('mod-a', 'm'), w.deps, []), /Choose which game version/);
  await assert.rejects(buildInstallPlan(w.input('mod-a', 'm', { gameVersion: '9.9' }), w.deps, []), /does not support/);
  const plan = await buildInstallPlan(w.input('mod-a', 'm', { gameVersion: '1.7' }), w.deps, []);
  assert.deepEqual(plan.notes, ['for 1.7', 'always']);
});

test('removing moves exactly the recorded folders to backup and nothing else', async () => {
  const w = world();
  const mods = path.join(w.game, 'Mods');
  fs.mkdirSync(path.join(mods, 'Mine'), { recursive: true });
  fs.writeFileSync(path.join(mods, 'Mine', 'a.txt'), 'a');
  fs.mkdirSync(path.join(mods, 'Other'));
  const record = { modId: 'mod-a', gameId: 'g', methodId: 'm', version: '1', installedAt: 'x', extracted: [{ baseDir: mods, roots: ['Mine'] }] };
  const manifest = baseManifest({}); // no uninstall list: falls back to what we recorded
  const input = (rec) => ({ manifest, record: rec, gameId: 'g', gameName: 'Game', gamePath: w.game });
  const res = await executeRemove(buildRemovePlan(input(record), w.deps), w.deps);
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(path.join(mods, 'Mine')), false);
  assert.equal(fs.existsSync(path.join(mods, 'Other')), true);
  assert.deepEqual(res.removed, { modId: 'mod-a', gameId: 'g' });
  for (const bad of ['..', '../Other', 'a/b', '', '.']) {
    assert.throws(() => buildRemovePlan(input({ ...record, extracted: [{ baseDir: mods, roots: [bad] }] }), w.deps), /damaged/, `root "${bad}" refused`);
  }
});

/** A game laid out the way Steam does it, so {workshop} resolves. Workshop items live beside "common". */
function steamWorld() {
  const w = world();
  const steamapps = path.join(w.root, 'Steam', 'steamapps');
  const game = path.join(steamapps, 'common', 'Game');
  fs.mkdirSync(path.join(game, 'Mods'), { recursive: true });
  const workshop = (itemId) => path.join(steamapps, 'workshop', 'content', '123', itemId);
  return { ...w, game, workshop, input: (modId, methodId, extra = {}) => ({ modId, methodId, gameId: 'g', gameName: 'Game', gamePath: game, steamAppId: '123', ...extra }) };
}

test('a dependency already on the computer (Steam Workshop) is not installed again, and the plan says so', async () => {
  const w = steamWorld();
  fs.mkdirSync(w.workshop('777'), { recursive: true });
  const mz = zipOf({ 'Main/a.txt': 'm' });
  w.web.set('https://dl.test/Main.zip', mz);
  w.addRelease('mod-a', 'v1', [asset('Main.zip', mz, { digest: `sha256:${sha(mz)}` })]);
  const steps = (a) => [{ type: 'download', asset: a, githubDigest: true }, { type: 'extract', to: '{game}/Mods' }];
  w.manifests.dep = baseManifest({
    id: 'dep', kind: 'dependency', name: 'Dep',
    detect: [{ method: 'workshop', path: '{workshop}/777' }, { method: 'manual', path: '{game}/Mods/Dep' }],
    methods: [{ id: 'workshop', label: 'Steam Workshop', steps: [{ type: 'note', text: 'subscribe' }] }, { id: 'manual', label: 'Manual', steps: steps('Dep.zip') }],
  });
  w.manifests['mod-a'] = baseManifest({ dependencies: [{ id: 'dep' }], methods: [{ id: 'manual', label: 'M', steps: steps('Main.zip') }] });

  const plan = await buildInstallPlan(w.input('mod-a', 'manual'), w.deps, []);
  assert.deepEqual([...new Set(plan.steps.map((s) => s.modId))], ['mod-a'], 'dependency steps are left out');
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0], /Dep is already installed \(Steam Workshop\)/);

  // ...and when it is NOT on the computer, it is installed as usual.
  fs.rmSync(w.workshop('777'), { recursive: true });
  w.addRelease('dep', 'v9', [asset('Dep.zip', mz, { digest: `sha256:${sha(mz)}` })]);
  const again = await buildInstallPlan(w.input('mod-a', 'manual'), w.deps, []);
  assert.deepEqual([...new Set(again.steps.map((s) => s.modId))], ['dep', 'mod-a']);
  assert.deepEqual(again.skipped, []);
});

test('{workshop} is only available for games that live in Steam', async () => {
  const plain = world(); // game folder is not under steamapps/common
  plain.manifests.dep = baseManifest({ id: 'dep', detect: [{ path: '{workshop}/777' }], methods: [{ id: 'm', label: 'M', steps: [{ type: 'note', text: 'x' }] }] });
  plain.manifests['mod-a'] = baseManifest({ dependencies: [{ id: 'dep' }], methods: [{ id: 'm', label: 'M', steps: [{ type: 'note', text: 'y' }] }] });
  const plan = await buildInstallPlan(plain.input('mod-a', 'm', { steamAppId: '123' }), plain.deps, []);
  assert.deepEqual(plan.skipped, [], 'nothing can be detected, so nothing is skipped');
});

test('uninstall follows the way the mod was installed: delete a wildcard match, or send Workshop users to Steam', async () => {
  const w = steamWorld();
  w.manifests['mod-a'] = baseManifest({
    methods: [{ id: 'manual', label: 'Manual', steps: [{ type: 'note', text: 'x' }] }, { id: 'workshop', label: 'Steam Workshop', steps: [{ type: 'note', text: 'x' }] }],
    detect: [{ method: 'workshop', path: '{workshop}/555' }, { method: 'manual', path: '{game}/Mods/mod-a-*.jar' }],
    uninstall: [
      { when: { method: 'manual' }, type: 'delete', path: '{game}/Mods/mod-a-*.jar' },
      { when: { method: 'workshop' }, type: 'open', url: 'steam://url/CommunityFilePage/555' },
      { type: 'note', text: 'always shown' },
    ],
  });
  const manifest = w.manifests['mod-a'];
  const input = { manifest, gameId: 'g', gameName: 'Game', gamePath: w.game, steamAppId: '123' };

  // Manual: two matching files go to backup, an unrelated jar stays.
  fs.writeFileSync(path.join(w.game, 'Mods', 'mod-a-1.0-fabric.jar'), 'a');
  fs.writeFileSync(path.join(w.game, 'Mods', 'mod-a-1.0-neoforge.jar'), 'b');
  fs.writeFileSync(path.join(w.game, 'Mods', 'other-mod.jar'), 'c');
  const plan = buildRemovePlan(input, w.deps);
  assert.equal(plan.steps.filter((s) => s.step.type === 'delete').length, 1);
  assert.equal(plan.steps[0].targets.length, 2);
  const res = await executeRemove(plan, w.deps);
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(fs.readdirSync(path.join(w.game, 'Mods')), ['other-mod.jar']);
  assert.equal(w.opened.length, 0, 'the Steam page is for Workshop installs only');
  assert.ok(res.notes.includes('always shown'));

  // Workshop: nothing is deleted (Steam owns those files); the user is sent to Steam.
  fs.mkdirSync(w.workshop('555'), { recursive: true });
  const wsPlan = buildRemovePlan(input, w.deps);
  assert.deepEqual(wsPlan.steps.map((s) => s.step.type), ['open', 'note']);
  const wsRes = await executeRemove(wsPlan, w.deps);
  assert.equal(wsRes.ok, true);
  assert.deepEqual(w.opened, ['steam://url/CommunityFilePage/555']);
  assert.match(wsRes.message, /Nothing was moved/);
});

test('a delete pattern that is too broad is refused, so a bad manifest cannot wipe a mods folder', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.game, 'Mods', 'precious.jar'), 'x');
  for (const bad of ['{game}/Mods/*.jar', '{game}/Mods/*', '{game}/Mods/a*', '{game}/*/x.jar', '{game}']) {
    const manifest = baseManifest({ uninstall: [{ type: 'delete', path: bad }] });
    assert.throws(() => buildRemovePlan({ manifest, gameId: 'g', gameName: 'G', gamePath: w.game }, w.deps), /too broad|whole folder|only allowed in the last/, bad);
  }
  assert.equal(fs.existsSync(path.join(w.game, 'Mods', 'precious.jar')), true);
});

test('install locations cannot escape their folder; globs behave', () => {
  const roots = { game: path.join(os.tmpdir(), 'game') };
  assert.equal(expandInstallPath('{game}/Mods', roots), path.join(roots.game, 'Mods'));
  assert.throws(() => expandInstallPath('{game}/../x', roots), /outside/);
  assert.throws(() => expandInstallPath('{nope}/x', roots), /valid/);
  assert.throws(() => expandInstallPath('/etc/passwd', roots), /valid/);
  assert.ok(globToRegExp('*-fabric.jar').test('mod-2.0+x-fabric.jar'));
  assert.ok(!globToRegExp('mod.zip').test('modXzip'), 'dots are literal');
  assert.ok(globToRegExp('MOD.ZIP').test('mod.zip'), 'case-insensitive');
});

test('update status: by tag, by installer digest, and unknown when nothing can be compared', () => {
  const rel = (tag, assets) => ({ info: { modId: 'm', tag, version: tag, date: 'd', url: 'u' }, assets });
  const byTag = baseManifest({ updates: { strategy: 'release-tag' } });
  assert.equal(computeStatus({ tag: 'v1' }, byTag, rel('v1', [])).status, 'up-to-date');
  assert.equal(computeStatus({ tag: 'v1' }, byTag, rel('v2', [])).status, 'update-available');
  const byAsset = baseManifest({ updates: { strategy: 'asset-changed', asset: 'i.exe' } });
  const a = (digest, updatedAt) => [{ name: 'i.exe', size: 1, url: 'u', digest, updatedAt }];
  assert.equal(computeStatus({ assetHash: 'aa' }, byAsset, rel('v9', a('sha256:aa'))).status, 'up-to-date', 'new tag, same installer: no update');
  assert.equal(computeStatus({ assetHash: 'aa' }, byAsset, rel('v9', a('sha256:bb'))).status, 'update-available');
  assert.equal(computeStatus({ assetUpdatedAt: 't1' }, byAsset, rel('v9', a(undefined, 't1'))).status, 'up-to-date', 'falls back to timestamps');
  assert.equal(computeStatus({}, byAsset, rel('v9', a(undefined, 't1'))).status, 'unknown');
  assert.equal(computeStatus({ tag: 'v1' }, byTag, null).status, 'unknown');
  assert.equal(computeStatus({}, baseManifest({ updates: { strategy: 'external' } }), rel('v1', [])).status, 'unknown');
});
