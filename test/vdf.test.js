// Run with: npm test   (builds first, then uses Node's built-in test runner)
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVdf } = require('../dist/vdf.js');

test('parses a real-shaped libraryfolders file with escaped Windows paths', () => {
  const v = parseVdf(`"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"
\t\t"apps"
\t\t{
\t\t\t"294100"\t\t"123456"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"D:\\\\SteamLibrary"
\t}
}`);
  assert.equal(v.libraryfolders['0'].path, 'C:\\Program Files (x86)\\Steam');
  assert.equal(v.libraryfolders['1'].path, 'D:\\SteamLibrary');
  assert.equal(v.libraryfolders['0'].apps['294100'], '123456');
});

test('parses an appmanifest', () => {
  const v = parseVdf('"AppState"\n{\n\t"appid"\t"294100"\n\t"installdir"\t"RimWorld"\n}\n');
  assert.equal(v.AppState.installdir, 'RimWorld');
});

test('handles comments, escaped quotes and a missing trailing newline', () => {
  const v = parseVdf('// comment\n"a" { "b" "say \\"hi\\"" }');
  assert.equal(v.a.b, 'say "hi"');
});

test('rejects malformed input instead of returning garbage', () => {
  assert.throws(() => parseVdf('"a" { "b" "c"'));
  assert.throws(() => parseVdf('"a" "unterminated'));
  assert.throws(() => parseVdf('}'));
});
