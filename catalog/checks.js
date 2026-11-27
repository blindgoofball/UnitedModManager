// The rules every mod file must follow beyond what the JSON Schema can say.
//
// One copy, used twice: by scripts/build-catalog.js (which CI runs on every pull request) and by
// the app's "Submit a mod" page, so a contributor sees exactly the problems CI would report.
// Plain CommonJS on purpose, so a Node script and the compiled app can both load it.

const EXECUTABLE = /\.(exe|msi|bat|cmd|ps1|sh|jar)$/i;

/** Why a path pattern is too risky to delete or match, or null if it is fine. */
function unsafePattern(p) {
  const rest = (p.match(/^\{\w+\}\/?(.*)$/) || [])[1] || '';
  const segments = rest.split('/').filter(Boolean);
  if (segments.length === 0) return 'it names a whole folder root, not something inside it';
  if (segments.some((s) => s === '..')) return 'it contains ".."';
  if (segments.slice(0, -1).some((s) => /[*?]/.test(s))) return 'wildcards are only allowed in the last part';
  const last = segments[segments.length - 1];
  if (/[*?]/.test(last) && last.split(/[*?]/)[0].length < 4) return 'a wildcard needs at least 4 fixed characters before it';
  return null;
}

/** A schema error as a short sentence that names the field. */
function describeAjvError(e) {
  const p = e.instancePath || '(root)';
  if (e.keyword === 'additionalProperties') return `${p}: unknown property "${e.params.additionalProperty}"`;
  if (e.keyword === 'required') return `${p}: missing "${e.params.missingProperty}"`;
  return `${p}: ${e.message}`;
}

const allSteps = (m) => [...m.methods.flatMap((x) => x.steps), ...(m.afterInstall || [])];

/**
 * Problems with one mod that has already passed the schema. `byId` maps every mod id in the
 * catalog (including this one) to its manifest, for checking dependencies.
 * Returns plain-language messages; an empty list means the mod is fine.
 */
function checkMod(m, { byId }) {
  const problems = [];
  const fail = (msg) => problems.push(msg);
  const steps = allSteps(m);

  // Versions used in `when` must be declared, and platforms must be supported.
  const conds = [...m.methods.map((x) => x.when), ...steps.map((s) => s.when)].filter(Boolean);
  for (const c of conds) {
    if (c.version && !(m.gameVersions || []).includes(c.version)) {
      fail(`"when.version" is "${c.version}" but it is not listed in gameVersions`);
    }
    if (c.platform && !m.platforms.includes(c.platform)) {
      fail(`"when.platform" is "${c.platform}" but the mod does not list that platform`);
    }
  }

  // Anything downloaded and then run must be integrity-checked.
  for (const method of m.methods) {
    const downloads = new Map();
    for (const s of method.steps) {
      if (s.type === 'download') {
        if (s.asset && m.source.type !== 'github') fail(`method "${method.id}": "asset" downloads need a github source`);
        downloads.set(s.asset || s.url, s);
      }
      if (s.type === 'run') {
        const d = [...downloads.entries()].find(([name]) => name === s.file || name.endsWith('/' + s.file));
        if (!d) fail(`method "${method.id}": run step "${s.file}" has no matching download step`);
        else if (!d[1].sha256 && !d[1].sha256Asset && !d[1].githubDigest) {
          fail(`method "${method.id}": "${s.file}" is run after download, so the download needs sha256, sha256Asset or githubDigest`);
        }
      }
    }
  }
  for (const s of steps) {
    if (s.type === 'download' && s.asset && EXECUTABLE.test(s.asset) && !s.sha256 && !s.sha256Asset && !s.githubDigest) {
      fail(`download "${s.asset}" is an executable type and needs sha256, sha256Asset or githubDigest`);
    }
    if ((s.type === 'extract' || s.type === 'copy') && /(^|\/)\.\.(\/|$)/.test(s.to)) {
      fail(`path "${s.to}" contains "..", which would leave its folder`);
    }
    if (s.type === 'copy' && s.to && !s.backup && s.ifExists !== 'skip') {
      fail(`copy to "${s.to}" can overwrite a user file, so it needs "backup": true (or ifExists "skip")`);
    }
  }

  // detect / uninstall rules must point at real methods and be safe to act on.
  const methodIds = new Set(m.methods.map((x) => x.id));
  for (const rule of m.detect || []) {
    if (rule.method && !methodIds.has(rule.method)) fail(`detect rule names method "${rule.method}", which this mod does not have`);
    const bad = unsafePattern(rule.path);
    if (bad) fail(`detect path "${rule.path}": ${bad}`);
  }
  for (const s of m.uninstall || []) {
    if (s.when && s.when.method && !methodIds.has(s.when.method)) {
      fail(`uninstall step names method "${s.when.method}", which this mod does not have`);
    }
    if (s.type === 'delete') {
      const bad = unsafePattern(s.path);
      if (bad) fail(`delete path "${s.path}": ${bad}`);
    }
  }
  for (const s of steps) {
    if (s.when && s.when.method) fail('"when.method" is only allowed in uninstall steps');
  }

  // Dependencies must exist.
  for (const d of m.dependencies || []) {
    const dep = byId.get(d.id);
    if (!dep) fail(`dependency "${d.id}" is not in the catalog`);
    else if (dep.game.id !== m.game.id) fail(`dependency "${d.id}" is for a different game`);
    if (d.id === m.id) fail('a mod cannot depend on itself');
  }

  // Update strategy needs matching information.
  const u = m.updates;
  if (u.strategy === 'asset-changed' && !u.asset) fail('updates.asset is required for asset-changed');
  if ((u.strategy === 'asset-changed' || u.strategy === 'release-tag') && m.source.type !== 'github') {
    fail(`updates.strategy "${u.strategy}" needs a github source`);
  }
  if (u.versionFrom && u.versionFrom.tag) {
    try { new RegExp(u.versionFrom.tag); } catch (e) { fail(`updates.versionFrom.tag is not a valid regex (${e.message})`); }
  }
  if (m.kind === 'dependency' && (m.dependencies || []).length) fail('dependencies of dependencies are not supported yet');

  return problems;
}

module.exports = { checkMod, unsafePattern, describeAjvError };
