// Validates catalog/mods/*.json against catalog/schema/mod.schema.json, runs the
// cross-file checks a schema can't express, then writes the browse index and a
// copy of the full manifests to dist/catalog/. Exits 1 on any problem, so the
// same command is the CI check for submitted mods.
//
//   node scripts/build-catalog.js [catalogDir] [--check]
//
// --check validates only and writes nothing.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { checkMod, describeAjvError } = require('../catalog/checks.js'); // shared with the app's Submit page

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const catalogDir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(root, 'catalog'));
const modsDir = path.join(catalogDir, 'mods');
const gamesDir = path.join(catalogDir, 'games'); // optional, maintainer-added detection data
const outDir = path.join(root, 'dist', 'catalog');

const errors = [];
const fail = (where, msg) => errors.push({ where, msg });

const schema = JSON.parse(fs.readFileSync(path.join(root, 'catalog', 'schema', 'mod.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, discriminator: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const validateGame = ajv.compile(JSON.parse(fs.readFileSync(path.join(root, 'catalog', 'schema', 'game.schema.json'), 'utf8')));

function readJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      // Windows editors often save a UTF-8 byte-order mark; JSON.parse rejects it.
      const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, '');
      items.push({ file, data: JSON.parse(text) });
    } catch (e) {
      fail(`${path.basename(dir)}/${file}`, `invalid JSON (${e.message})`);
    }
  }
  return items;
}

const mods = [];
for (const { file, data: m } of readJsonDir(modsDir)) {
  const where = `mods/${file}`;
  if (!validate(m)) {
    for (const e of validate.errors) fail(where, describeAjvError(e));
    continue;
  }
  mods.push({ where, file, m });
}

// Optional games files must agree with the mods that use them.
const gameFiles = new Map();
for (const { file, data } of readJsonDir(gamesDir)) {
  if (!validateGame(data)) {
    for (const e of validateGame.errors) fail(`games/${file}`, describeAjvError(e));
    continue;
  }
  if (data.id + '.json' !== file) fail(`games/${file}`, `id "${data.id}" must match the file name`);
  gameFiles.set(data.id, { file, data });
}

const byId = new Map();
const gameNames = new Map(); // game id -> { name, firstMod }
for (const { where, file, m } of mods) {
  if (m.id + '.json' !== file) fail(where, `id "${m.id}" must match the file name`);
  if (byId.has(m.id)) fail(where, `duplicate id "${m.id}"`);
  byId.set(m.id, m);

  const seenName = gameNames.get(m.game.id);
  if (!seenName) gameNames.set(m.game.id, { name: m.game.name, firstMod: m.id });
  else if (seenName.name !== m.game.name) {
    fail(where, `game "${m.game.id}" is named "${m.game.name}" here but "${seenName.name}" in ${seenName.firstMod}`);
  }
  const gf = gameFiles.get(m.game.id);
  if (gf && gf.data.name !== m.game.name) {
    fail(where, `game "${m.game.id}" is named "${m.game.name}" here but "${gf.data.name}" in games/${gf.file}`);
  }
}

// Everything about a single mod (hashes, backups, safe delete paths, dependencies, update info).
for (const { where, m } of mods) {
  for (const msg of checkMod(m, { byId })) fail(where, msg);
}

if (errors.length) {
  console.error(`Catalog has ${errors.length} problem(s):\n` + errors.map((e) => `  ${e.where}: ${e.msg}`).join('\n'));
  if (process.env.GITHUB_ACTIONS === 'true') {
    // GitHub shows these as annotations on the file in the pull request, so a contributor sees the
    // problem next to their change without opening the log.
    const escape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    for (const e of errors) {
      const file = /^(mods|games)\//.test(e.where) ? `catalog/${e.where}` : 'catalog';
      console.error(`::error file=${escape(file).replace(/,/g, '%2C')},title=Catalog check::${escape(e.msg)}`);
    }
  }
  process.exit(1);
}

const browsable = mods.filter(({ m }) => m.kind !== 'dependency');
const index = browsable.map(({ m }) => ({
  id: m.id,
  name: m.name,
  gameId: m.game.id,
  game: m.game.name,
  platforms: m.platforms,
  description: m.summary,
  author: m.authors.join(', '),
}));

// Every game that has at least one listed mod, with detection data when a games file exists.
const games = [...new Map(browsable.map(({ m }) => [m.game.id, m.game.name]))].map(([id, name]) => ({
  schemaVersion: 1,
  id,
  name,
  detect: gameFiles.get(id)?.data.detect ?? {},
}));

/** When the catalog last changed. Lets the app tell which of two copies is newer. */
function revision() {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', 'catalog'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return new Date(out).toISOString();
  } catch {
    // Not a git checkout (or no git installed): fall back to the build time.
  }
  return new Date().toISOString();
}

if (!checkOnly) {
  // One self-contained file: the app downloads exactly this, and ships a copy of it as its fallback.
  const bundle = {
    formatVersion: 1,
    revision: revision(),
    generatedAt: new Date().toISOString(),
    index,
    games,
    mods: mods.map(({ m }) => m).sort((a, b) => a.id.localeCompare(b.id)),
  };
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'catalog.json'), JSON.stringify(bundle));
  // The app re-checks what it downloads against the same schemas, and its Submit page against the same rules.
  for (const f of ['mod.schema.json', 'game.schema.json']) fs.copyFileSync(path.join(root, 'catalog', 'schema', f), path.join(outDir, f));
  fs.copyFileSync(path.join(root, 'catalog', 'checks.js'), path.join(outDir, 'checks.js'));
}
console.log(
  `Catalog OK: ${browsable.length} mod(s) listed, ${mods.length - browsable.length} dependency, ${gameNames.size} game(s)` +
    (checkOnly ? ' (check only).' : '.'),
);
