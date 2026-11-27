// The "Submit a mod" logic: forms become mod files, and are checked with the same rules as CI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cat = require('../dist/catalog.js');
const sub = require('../dist/submit.js');

cat._resetCatalogForTests();
cat.initCatalog(fs.mkdtempSync(path.join(os.tmpdir(), 'umm-sub-')));
const realMods = cat.loadAllManifests();
const realGames = cat.loadGames();

const deps = (over = {}) => ({ mods: [], games: realGames, schemaProblems: cat.modSchemaProblems, ...over });
const form = (over = {}) => ({
  name: 'Test Mod', id: '', summary: 'Makes the game playable.', description: '', authors: 'Someone', homepage: '', license: '',
  gameChoice: 'rimworld', newGameName: '', platforms: ['windows'], install: 'zip',
  repo: 'someone/test-mod', tag: '', workshopItemId: '',
  installerAsset: '', hashSource: 'digest', hashFile: '', interactive: true, selfUpdating: false, leftoverPath: '',
  zipAsset: 'TestMod.zip', unpackInto: 'Mods', createdFolder: 'TestMod', scriptPath: '', scriptInteractive: true,
  ...over,
});
const asset = (name, extra = {}) => ({ name, size: 1024, url: `https://x/${name}`, ...extra });
const release = (assets) => async () => ({ info: { modId: 'x', tag: 'v1.0.0', version: '1.0.0', date: 'd', url: 'u' }, assets });

test('slug turns names into ids', () => {
  assert.equal(sub.slug('My Cool Mod!'), 'my-cool-mod');
  assert.equal(sub.slug('  --Café  Racer--  '), 'cafe-racer');
  assert.equal(sub.slug('RimWorld Access'), 'rimworld-access');
  assert.equal(sub.slug('!!!'), '');
  assert.ok(sub.slug('x'.repeat(100)).length <= 64);
});

test('an installer entry matches what was written by hand for United Minecraft', async () => {
  const f = form({
    name: 'United Minecraft', gameChoice: 'minecraft-java', install: 'installer', repo: 'Blindgoofball/United-Minecraft',
    installerAsset: 'united-installer.exe', hashSource: 'file', hashFile: 'united-installer.exe.sha256', interactive: true, selfUpdating: true,
    leftoverPath: 'mods/united-minecraft-*.jar',
  });
  const r = await sub.buildSubmission(f, deps());
  assert.deepEqual(r.problems, []);
  const made = JSON.parse(r.json);
  const real = realMods.find((m) => m.id === 'united-minecraft');
  assert.equal(made.id, 'united-minecraft');
  assert.deepEqual(made.methods[0].steps, real.methods[0].steps, 'same download and run steps');
  assert.deepEqual(made.detect, real.detect);
  assert.deepEqual(made.uninstall[0], real.uninstall[0]);
  assert.equal(made.updates.strategy, real.updates.strategy);
  assert.equal(made.updates.asset, real.updates.asset);
  assert.equal(made.updates.selfUpdating, true);
});

test('a zip entry (pinned rolling tag) matches the shape of RimWorld Access', async () => {
  const r = await sub.buildSubmission(
    form({ name: 'Rim Thing', tag: 'dev', zipAsset: 'RimThing-dev.zip', unpackInto: 'Mods', createdFolder: 'RimThing' }),
    deps(),
  );
  assert.deepEqual(r.problems, []);
  const m = JSON.parse(r.json);
  assert.deepEqual(m.source, { type: 'github', repo: 'someone/test-mod', tag: 'dev' });
  assert.deepEqual(m.methods[0].steps, [{ type: 'download', asset: 'RimThing-dev.zip', githubDigest: true }, { type: 'extract', to: '{game}/Mods' }]);
  assert.deepEqual(m.updates, { strategy: 'asset-changed', asset: 'RimThing-dev.zip' });
  assert.deepEqual(m.detect, [{ method: 'manual', path: '{game}/Mods/RimThing' }]);
  assert.deepEqual(m.uninstall, [{ type: 'delete', path: '{game}/Mods/RimThing' }]);
});

test('a zip entry with no pinned tag follows release tags, and unpacking into the game folder works', async () => {
  const r = await sub.buildSubmission(form({ unpackInto: '', createdFolder: '' }), deps());
  assert.deepEqual(r.problems, []);
  const m = JSON.parse(r.json);
  assert.deepEqual(m.updates, { strategy: 'release-tag' });
  assert.equal(m.methods[0].steps[1].to, '{game}');
  assert.equal(m.detect, undefined, 'nothing to detect without a folder name');
});

test('a zip with an install script: the script runs after unpacking, and the entry passes the same rules as CI', async () => {
  const r = await sub.buildSubmission(form({ scriptPath: 'TestMod/install.bat', scriptInteractive: true }), deps());
  assert.deepEqual(r.problems, []);
  const steps = JSON.parse(r.json).methods[0].steps;
  assert.deepEqual(steps.map((s) => s.type), ['download', 'extract', 'run']);
  assert.deepEqual(steps[2], { type: 'run', path: '{game}/Mods/TestMod/install.bat', interactive: true });
  assert.equal(steps[0].githubDigest, true, 'the archive is verified before anything in it runs');

  // Backslashes, a leading slash and a script at the top of the unpack folder all come out right.
  const odd = JSON.parse((await sub.buildSubmission(form({ unpackInto: '', scriptPath: '\\setup.cmd', scriptInteractive: false }), deps())).json);
  assert.deepEqual(odd.methods[0].steps[2], { type: 'run', path: '{game}/setup.cmd', interactive: false });
});

test('a script in the form must be one exact script file that stays inside the unpack folder', async () => {
  for (const [bad, expected] of [['TestMod/payload.dll', /\.exe, \.bat, \.cmd or \.ps1/], ['TestMod/*.bat', /one exact file/], ['../install.bat', /cannot use "\.\."/]]) {
    const r = await sub.buildSubmission(form({ scriptPath: bad }), deps());
    assert.equal(r.json, '', `${bad} is stopped before a file is made`);
    assert.ok(r.problems.some((p) => expected.test(p)), `${bad}: ${r.problems.join(' | ')}`);
  }
});

test('a Steam Workshop entry gets detection and a way to remove it', async () => {
  const r = await sub.buildSubmission(form({ install: 'workshop', workshopItemId: '3750094441', repo: '' }), deps());
  assert.deepEqual(r.problems, []);
  const m = JSON.parse(r.json);
  assert.deepEqual(m.source, { type: 'workshop', itemId: '3750094441' });
  assert.deepEqual(m.detect, [{ method: 'workshop', path: '{workshop}/3750094441' }]);
  assert.equal(m.uninstall[0].url, 'steam://url/CommunityFilePage/3750094441');
  assert.deepEqual(m.updates, { strategy: 'external' });
});

test('a game that is not listed yet gets an id made from its name, and keeps its exact name', async () => {
  const r = await sub.buildSubmission(form({ gameChoice: '', newGameName: 'My Cool Game!' }), deps());
  assert.deepEqual(r.problems, []);
  assert.deepEqual(JSON.parse(r.json).game, { id: 'my-cool-game', name: 'My Cool Game!' });
});

test('form mistakes come back as plain sentences, not schema jargon', async () => {
  const empty = await sub.buildSubmission(
    form({ name: '', summary: '', authors: ' , ', gameChoice: '', newGameName: '', platforms: [], repo: 'not a repo', zipAsset: '' }),
    deps(),
  );
  assert.equal(empty.json, '');
  for (const expected of [/name/i, /short description/i, /who made/i, /choose the game/i, /operating system/i, /owner\/name/, /zip file/]) {
    assert.ok(empty.problems.some((p) => expected.test(p)), `mentions ${expected}`);
  }
  assert.ok(empty.problems.every((p) => !/instancePath|must have required/.test(p)));

  const odd = await sub.buildSubmission(form({ homepage: 'ftp://x', summary: 'x'.repeat(301), install: 'installer', installerAsset: '', hashSource: 'file', hashFile: '' }), deps());
  assert.ok(odd.problems.some((p) => /https/.test(p)));
  assert.ok(odd.problems.some((p) => /300/.test(p)));
  assert.ok(odd.problems.some((p) => /installer file/.test(p)));
  assert.ok(odd.problems.some((p) => /hash file/.test(p)));
});

test('a mod that is already in the catalog, or renames a game, is refused', async () => {
  const dup = await sub.buildSubmission(form({ name: 'United Minecraft', gameChoice: 'minecraft-java' }), deps({ mods: realMods }));
  assert.ok(dup.problems.some((p) => /already in the catalog/.test(p)));

  const text = JSON.stringify({ ...JSON.parse((await sub.buildSubmission(form(), deps())).json), game: { id: 'rimworld', name: 'Rimworld' } });
  const renamed = await sub.checkSubmission(text, deps());
  assert.ok(renamed.problems.some((p) => /called "RimWorld"/.test(p)));
});

test('the same rules as the pull request check apply: unsafe patterns and unverified executables are caught', async () => {
  const broad = await sub.buildSubmission(
    form({ install: 'installer', gameChoice: 'minecraft-java', installerAsset: 'inst.exe', leftoverPath: 'mods/*.jar' }),
    deps(),
  );
  assert.ok(broad.problems.some((p) => /wildcard needs at least 4 fixed characters/.test(p)), broad.problems.join(' | '));

  // Hand-edit away the hash, as someone editing the JSON might.
  const ok = JSON.parse((await sub.buildSubmission(form({ install: 'installer', gameChoice: 'minecraft-java', installerAsset: 'inst.exe' }), deps())).json);
  delete ok.methods[0].steps[0].githubDigest;
  const unhashed = await sub.checkSubmission(JSON.stringify(ok), deps());
  assert.ok(unhashed.problems.some((p) => /needs sha256, sha256Asset or githubDigest/.test(p)));
});

test('an unpack or copy destination that climbs out of its folder is refused', async () => {
  const ok = JSON.parse((await sub.buildSubmission(form(), deps())).json);
  ok.methods[0].steps[1].to = '{game}/../elsewhere';
  const r = await sub.checkSubmission(JSON.stringify(ok), deps());
  assert.ok(r.problems.some((p) => /contains "\.\.", which would leave its folder/.test(p)), r.problems.join(' | '));

  const copy = JSON.parse((await sub.buildSubmission(form(), deps())).json);
  copy.methods[0].steps.push({ type: 'copy', from: { url: 'https://x.test/a.xml' }, to: '{home}/../other/a.xml', backup: true });
  const c = await sub.checkSubmission(JSON.stringify(copy), deps());
  assert.ok(c.problems.some((p) => /leave its folder/.test(p)));
});

test('the shared rules for scripts inside archives: must follow a verified unpack, be a script type, and stay put', async () => {
  const withRun = async (mutate) => {
    const m = JSON.parse((await sub.buildSubmission(form(), deps())).json);
    m.methods[0].steps.push({ type: 'run', path: '{game}/Mods/TestMod/install.bat', interactive: true });
    mutate(m);
    return (await sub.checkSubmission(JSON.stringify(m), deps())).problems;
  };
  assert.deepEqual(await withRun(() => {}), [], 'the normal case is accepted');
  const run = (m) => m.methods[0].steps[2];

  assert.ok((await withRun((m) => delete m.methods[0].steps[0].githubDigest)).some((p) => /is run after unpacking, so the download it came from needs sha256/.test(p)));
  assert.ok((await withRun((m) => (run(m).path = '{game}/Elsewhere/install.bat'))).some((p) => /must be inside a folder that an earlier unpack step writes to/.test(p)));
  assert.ok((await withRun((m) => (run(m).path = '{game}/Mods/TestMod/payload.dll'))).some((p) => /only \.exe, \.bat, \.cmd and \.ps1/.test(p)));
  assert.ok((await withRun((m) => (run(m).path = '{game}/Mods/TestMod/*.bat'))).some((p) => /cannot use wildcards/.test(p)));
  assert.ok((await withRun((m) => (run(m).path = '{game}/Mods/TestMod/../../x.bat'))).some((p) => /contains "\.\."/.test(p)));
  assert.ok((await withRun((m) => (run(m).file = 'TestMod.zip'))).some((p) => /either "file" or "path", not both/.test(p)));
  // Running before unpacking is the same mistake as naming a folder nothing writes to.
  assert.ok((await withRun((m) => m.methods[0].steps.splice(1, 1))).some((p) => /must be inside a folder that an earlier unpack step writes to/.test(p)));
  // A step with neither file nor path is not valid at all.
  const neither = await withRun((m) => delete run(m).path);
  assert.ok(neither.length > 0);
});

test('broken JSON and schema errors are reported clearly', async () => {
  const bad = await sub.checkSubmission('{ "id": ', deps());
  assert.match(bad.problems[0], /not valid JSON/);
  const valid = JSON.parse((await sub.buildSubmission(form(), deps())).json);
  delete valid.summary;
  valid.surprise = 1;
  const r = await sub.checkSubmission(JSON.stringify(valid), deps());
  assert.ok(r.problems.some((p) => /missing "summary"/.test(p)), r.problems.join(' | '));
  assert.ok(r.problems.some((p) => /unknown property "surprise"/.test(p)));
  // A file saved by Notepad starts with a byte-order mark; that must not count as an error.
  const withBom = await sub.checkSubmission('﻿' + (await sub.buildSubmission(form(), deps())).json, deps());
  assert.deepEqual(withBom.problems, []);
});

test('the real GitHub release is checked: missing, ambiguous and unhashed files are problems, a network failure is only a note', async () => {
  const f = form({ zipAsset: 'TestMod.zip' });
  const fine = await sub.buildSubmission(f, deps({ release: release([asset('TestMod.zip', { digest: 'sha256:abc' })]) }));
  assert.deepEqual(fine.problems, []);
  assert.ok(fine.notes.some((n) => /Found TestMod\.zip in release v1\.0\.0/.test(n)));

  const missing = await sub.buildSubmission(f, deps({ release: release([asset('Other.zip'), asset('notes.txt')]) }));
  assert.ok(missing.problems.some((p) => /no file matching "TestMod\.zip".*Other\.zip, notes\.txt/.test(p)), missing.problems.join(' | '));

  const ambiguous = await sub.buildSubmission(form({ zipAsset: 'TestMod-*.zip' }), deps({ release: release([asset('TestMod-a.zip', { digest: 'sha256:1' }), asset('TestMod-b.zip', { digest: 'sha256:2' })]) }));
  assert.ok(ambiguous.problems.some((p) => /matches 2 files/.test(p)));

  const nodigest = await sub.buildSubmission(f, deps({ release: release([asset('TestMod.zip')]) }));
  assert.ok(nodigest.problems.some((p) => /no recorded hash/.test(p)));

  const hashFileMissing = await sub.buildSubmission(
    form({ install: 'installer', gameChoice: 'minecraft-java', installerAsset: 'inst.exe', hashSource: 'file', hashFile: 'inst.exe.sha256' }),
    deps({ release: release([asset('inst.exe')]) }),
  );
  assert.ok(hashFileMissing.problems.some((p) => /hash file "inst\.exe\.sha256" is not in the latest release/.test(p)));

  const offline = await sub.buildSubmission(f, deps({ release: async () => { throw new Error('offline'); } }));
  assert.deepEqual(offline.problems, [], 'being offline must not block a submission');
  assert.ok(offline.notes.some((n) => /Could not check the release/.test(n)));
});

test('the GitHub link carries the file name and contents, and falls back when it would be too long', () => {
  const repo = 'https://github.com/o/r';
  const json = '{\n  "id": "x",\n  "summary": "a & b = c; é"\n}\n';
  const short = sub.githubNewFileUrl(repo, 'x', json);
  assert.equal(short.prefilled, true);
  const u = new URL(short.url);
  assert.equal(u.origin + u.pathname, 'https://github.com/o/r/new/main/catalog/mods');
  assert.equal(u.searchParams.get('filename'), 'x.json');
  assert.equal(u.searchParams.get('value'), json, 'contents survive encoding exactly');

  const long = sub.githubNewFileUrl(repo, 'x', 'a'.repeat(9000));
  assert.equal(long.prefilled, false);
  assert.ok(!long.url.includes('value='));
  assert.ok(long.url.length < 200);
});
