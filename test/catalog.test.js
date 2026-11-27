// Catalog loading and refreshing, with a fake network and a temp app-data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cat = require('../dist/catalog.js');

const builtInFile = path.join(__dirname, '..', 'dist', 'catalog', 'catalog.json');
const builtIn = () => JSON.parse(fs.readFileSync(builtInFile, 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'umm-cat-'));
const URL = 'https://example.test/catalog.json';

/** A copy of the real catalog, made newer and with one extra mod. */
function newer(extra = true, revision) {
  const b = builtIn();
  b.revision = revision ?? new Date(Date.parse(b.revision) + 86_400_000).toISOString();
  if (extra) {
    const m = JSON.parse(JSON.stringify(b.mods.find((x) => x.id === 'united-minecraft')));
    m.id = 'extra-mod';
    m.name = 'Extra Mod';
    b.mods.push(m);
    const i = JSON.parse(JSON.stringify(b.index.find((x) => x.id === 'united-minecraft')));
    i.id = 'extra-mod';
    i.name = 'Extra Mod';
    b.index.push(i);
  }
  return b;
}
const respond = (body, init = {}) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });
const start = (dir = tmp()) => {
  cat._resetCatalogForTests();
  cat.initCatalog(dir);
  return dir;
};
const cacheFile = (dir) => path.join(dir, 'catalog-cache.json');

test('the catalog built into the app is valid and loads', () => {
  const dir = start();
  assert.ok(cat.loadIndex().length > 0);
  assert.equal(cat.catalogInfo().source, 'built-in');
  assert.ok(cat.loadManifest('united-minecraft'));
  assert.equal(cat.loadManifest('no-such-mod'), null);
  assert.ok(dir);
});

test('validation rejects a format it does not understand, with a message that says what to do', () => {
  const b = builtIn();
  b.formatVersion = 2;
  assert.throws(() => cat.validateBundle(b), /Update the app/);
});

test('validation rejects broken data instead of half using it', () => {
  const broken = (fn) => {
    const b = builtIn();
    fn(b);
    return b;
  };
  assert.throws(() => cat.validateBundle(null), /not a valid file/);
  assert.throws(() => cat.validateBundle(broken((b) => (b.revision = 'yesterday'))), /valid date/);
  assert.throws(() => cat.validateBundle(broken((b) => delete b.mods)), /incomplete/);
  assert.throws(() => cat.validateBundle(broken((b) => delete b.mods[0].summary)), /invalid/);
  assert.throws(() => cat.validateBundle(broken((b) => b.mods.push(b.mods[0]))), /twice/);
  assert.throws(() => cat.validateBundle(broken((b) => (b.mods[0].dependencies = [{ id: 'ghost' }]))), /missing from the list/);
  assert.throws(() => cat.validateBundle(broken((b) => (b.index[0].id = 'ghost'))), /does not match/);
  assert.throws(() => cat.validateBundle(broken((b) => (b.games[0].detect = { steam: { appId: 'abc' } }))), /invalid/);
  // A manifest asking for an unknown kind of step must not slip through.
  assert.throws(() => cat.validateBundle(broken((b) => b.mods[0].methods[0].steps.push({ type: 'format-disk' }))), /invalid/);
});

test('a downloaded copy is used on the next start when it is newer, and ignored when it is older or damaged', () => {
  let dir = start();
  fs.writeFileSync(cacheFile(dir), JSON.stringify({ etag: '"v1"', fetchedAt: '2026-01-01T00:00:00Z', bundle: newer() }));
  cat._resetCatalogForTests();
  cat.initCatalog(dir);
  assert.equal(cat.catalogInfo().source, 'cache');
  assert.ok(cat.loadManifest('extra-mod'));

  const older = newer(true, '2000-01-01T00:00:00.000Z');
  fs.writeFileSync(cacheFile(dir), JSON.stringify({ etag: '"v0"', bundle: older }));
  cat._resetCatalogForTests();
  cat.initCatalog(dir);
  assert.equal(cat.catalogInfo().source, 'built-in', 'an older cache does not override the app\'s own copy');
  assert.equal(cat.loadManifest('extra-mod'), null);

  for (const junk of ['{ not json', JSON.stringify({ bundle: { formatVersion: 1 } }), '']) {
    fs.writeFileSync(cacheFile(dir), junk);
    cat._resetCatalogForTests();
    cat.initCatalog(dir);
    assert.equal(cat.catalogInfo().source, 'built-in', `damaged cache ${JSON.stringify(junk.slice(0, 12))} is ignored`);
  }
});

test('refresh downloads a newer list, switches to it, and saves it for next time', async () => {
  const dir = start();
  const result = await cat.refreshCatalog(respond(newer(), { headers: { etag: '"abc"' } }), URL);
  assert.equal(result.changed, true);
  assert.equal(cat.catalogInfo().source, 'github');
  assert.ok(cat.loadManifest('extra-mod'));
  assert.equal(cat.catalogInfo().error, undefined);
  const saved = JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8'));
  assert.equal(saved.etag, '"abc"');
  assert.ok(saved.bundle.mods.some((m) => m.id === 'extra-mod'));
});

test('refresh asks "has it changed?" with the saved ETag, and a 304 keeps everything as it was', async () => {
  const dir = start();
  await cat.refreshCatalog(respond(newer(), { headers: { etag: '"abc"' } }), URL);
  cat._resetCatalogForTests();
  cat.initCatalog(dir); // next launch: loads the cache
  let sent;
  const result = await cat.refreshCatalog(async (_url, init) => {
    sent = init.headers['If-None-Match'];
    return new Response(null, { status: 304 });
  }, URL);
  assert.equal(sent, '"abc"');
  assert.equal(result.changed, false);
  assert.equal(cat.catalogInfo().source, 'github');
  assert.ok(cat.loadManifest('extra-mod'));
});

test('offline or a server error keeps the current list and records why', async () => {
  start();
  const before = cat.loadIndex().length;
  let r = await cat.refreshCatalog(async () => { throw new TypeError('fetch failed'); }, URL);
  assert.equal(r.changed, false);
  assert.match(cat.catalogInfo().error, /fetch failed/);
  r = await cat.refreshCatalog(respond('nope', { status: 404 }), URL);
  assert.equal(r.changed, false);
  assert.match(cat.catalogInfo().error, /404/);
  assert.equal(cat.loadIndex().length, before);
  assert.equal(cat.catalogInfo().source, 'built-in');
});

test('a bad download is rejected, the list in use is untouched, and the saved copy is not overwritten', async () => {
  const dir = start();
  await cat.refreshCatalog(respond(newer(), { headers: { etag: '"good"' } }), URL);
  const savedBefore = fs.readFileSync(cacheFile(dir), 'utf8');

  const broken = newer(true, new Date(Date.now() + 86_400_000 * 5).toISOString());
  delete broken.mods[0].summary;
  const r = await cat.refreshCatalog(respond(broken, { headers: { etag: '"bad"' } }), URL);
  assert.equal(r.changed, false);
  assert.match(cat.catalogInfo().error, /invalid/);
  assert.equal(fs.readFileSync(cacheFile(dir), 'utf8'), savedBefore);

  const tooNew = newer();
  tooNew.formatVersion = 2;
  await cat.refreshCatalog(respond(tooNew), URL);
  assert.match(cat.catalogInfo().error, /Update the app/);

  await cat.refreshCatalog(respond('<html>captive portal</html>'), URL);
  assert.ok(cat.catalogInfo().error, 'a page that is not JSON is rejected too');
  assert.ok(cat.loadManifest('extra-mod'), 'the good list is still the one in use');
});

test('a downloaded list that is older than the app\'s own copy is not used', async () => {
  start();
  const r = await cat.refreshCatalog(respond(newer(true, '2000-01-01T00:00:00.000Z')), URL);
  assert.equal(r.changed, false);
  assert.equal(cat.catalogInfo().source, 'built-in');
  assert.equal(cat.loadManifest('extra-mod'), null);
});

test('it refuses to fetch the list over an insecure address', async () => {
  start();
  let called = false;
  const r = await cat.refreshCatalog(async () => { called = true; return new Response('{}'); }, 'http://example.test/catalog.json');
  assert.equal(called, false);
  assert.equal(r.changed, false);
  assert.match(cat.catalogInfo().error, /not secure/);
});
