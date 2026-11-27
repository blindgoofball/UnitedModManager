// These open real (briefly visible) console windows, so they only run when asked:
//   $env:UMM_WINDOW_TESTS = "1"; node --test test/run-installer.test.js
// Every test has a timeout, so a window that fails to close makes the test fail rather than hang.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isConsoleProgram, runInConsoleWindow } = require('../dist/install/run-installer.js');

const windows = process.platform === 'win32';
const windowTests = windows && process.env.UMM_WINDOW_TESTS === '1';
const sys = (name) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
const work = () => fs.mkdtempSync(path.join(os.tmpdir(), 'umm-run-'));
const opts = (dir) => ({ title: 'Test', workDir: dir ?? work(), pauseAtEnd: false });
const T = { timeout: 30_000 };

test('tells console programs from windowed ones by their PE header', { skip: !windows }, () => {
  assert.equal(isConsoleProgram(sys('whoami.exe')), true);
  assert.equal(isConsoleProgram(sys('notepad.exe')), false);
  assert.equal(isConsoleProgram(__filename), false, 'not an executable at all');
  assert.equal(isConsoleProgram(path.join(os.tmpdir(), 'does-not-exist.exe')), false);
});

test('runs a console program in its own window and returns exit code 0', { ...T, skip: !windowTests }, async () => {
  assert.equal(await runInConsoleWindow(sys('whoami.exe'), [], opts()), 0);
});

test('returns the real non-zero exit code of the program', { ...T, skip: !windowTests }, async () => {
  // findstr with no arguments prints its usage and exits with code 2.
  assert.equal(await runInConsoleWindow(sys('findstr.exe'), [], opts()), 2);
});

test('passes arguments through intact, including one with a space', { ...T, skip: !windowTests }, async () => {
  // node exits 7 only if the second argument arrives as exactly "a b".
  const script = "process.exit(process.argv[1] === 'a b' ? 7 : 1)";
  assert.equal(await runInConsoleWindow(process.execPath, ['-e', script, 'a b'], opts()), 7);
});

test('works when the folder path has a percent sign and spaces', { ...T, skip: !windowTests }, async () => {
  const dir = path.join(work(), 'a 100% odd folder');
  assert.equal(await runInConsoleWindow(sys('whoami.exe'), [], opts(dir)), 0);
});

test('refuses an argument that cannot be passed safely', { skip: !windows }, async () => {
  await assert.rejects(runInConsoleWindow(sys('whoami.exe'), ['bad"arg'], opts()), /cannot be passed safely/);
});
