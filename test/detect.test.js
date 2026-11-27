// Detection tests build fake Steam libraries and home folders in a temp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSteamLibraries, findSteamGame, detectGames } = require('../dist/detect.js');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'umm-test-'));
}
function steamLibrary(root) {
  fs.mkdirSync(path.join(root, 'steamapps', 'common'), { recursive: true });
}
function manifest(root, appId, installdir) {
  fs.writeFileSync(
    path.join(root, 'steamapps', `appmanifest_${appId}.acf`),
    `"AppState"\n{\n\t"appid"\t"${appId}"\n\t"installdir"\t"${installdir}"\n}\n`,
  );
}
const esc = (p) => p.replace(/\\/g, '\\\\');

test('finds a game in a second Steam library listed in libraryfolders.vdf', () => {
  const main = temp();
  const second = temp();
  steamLibrary(main);
  steamLibrary(second);
  fs.writeFileSync(
    path.join(main, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t"${esc(main)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t"${esc(second)}"\n\t}\n}\n`,
  );
  manifest(second, '294100', 'RimWorld');
  fs.mkdirSync(path.join(second, 'steamapps', 'common', 'RimWorld'));

  const libs = readSteamLibraries(main);
  assert.equal(libs.length, 2);
  assert.equal(findSteamGame('294100', libs), path.join(second, 'steamapps', 'common', 'RimWorld'));
  assert.equal(findSteamGame('999999', libs), null);
});

test('reads the older libraryfolders format and skips libraries that no longer exist', () => {
  const main = temp();
  const second = temp();
  steamLibrary(main);
  steamLibrary(second);
  fs.writeFileSync(
    path.join(main, 'steamapps', 'libraryfolders.vdf'),
    `"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t"123"\n\t"1"\t"${esc(second)}"\n\t"2"\t"${esc(path.join(main, 'gone'))}"\n}\n`,
  );
  assert.equal(readSteamLibraries(main).length, 2);
});

test('survives a missing or corrupt libraryfolders file', () => {
  const main = temp();
  steamLibrary(main);
  assert.deepEqual(readSteamLibraries(main), [main]);
  fs.writeFileSync(path.join(main, 'steamapps', 'libraryfolders.vdf'), '"libraryfolders" { "0" {');
  assert.deepEqual(readSteamLibraries(main), [main]);
});

test('ignores a manifest whose installdir tries to leave steamapps/common', () => {
  const main = temp();
  steamLibrary(main);
  fs.mkdirSync(path.join(main, 'steamapps', 'evil'));
  for (const bad of ['..\\\\evil', '../evil', '..', '.', '']) {
    manifest(main, '1', bad);
    assert.equal(findSteamGame('1', [main]), null, `installdir "${bad}" must be refused`);
  }
});

test('returns null when the manifest exists but the game folder is gone', () => {
  const main = temp();
  steamLibrary(main);
  manifest(main, '5', 'Vanished');
  assert.equal(findSteamGame('5', [main]), null);
});

test('known-folder detection needs its marker, and only matches the current platform', async () => {
  const home = temp();
  const env = { platform: 'linux', home, appData: home, localAppData: home, documents: home };
  const def = {
    id: 'g',
    name: 'G',
    detect: { paths: [
      { platform: 'windows', path: '{home}/wrong-platform', marker: 'versions' },
      { platform: 'linux', path: '{home}/.game', marker: 'versions' },
    ] },
  };
  fs.mkdirSync(path.join(home, '.game'));
  fs.mkdirSync(path.join(home, 'wrong-platform', 'versions'), { recursive: true });
  assert.deepEqual(await detectGames([def], env), [], 'folder exists but marker is missing');

  fs.mkdirSync(path.join(home, '.game', 'versions'));
  const found = await detectGames([def], env);
  assert.equal(found.length, 1);
  assert.equal(found[0].source, 'known-folder');
  assert.equal(found[0].path, path.join(home, '.game'));
});
