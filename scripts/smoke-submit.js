// Drives the real "Submit a mod" page. READ ONLY: it never presses Copy, Save or Open GitHub.
//   node --check scripts/smoke-submit.js; npx electron scripts/smoke-submit.js <outFile> <emptyUserDataDir>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const outFile = process.argv[2];
const crash = (e) => {
  fs.writeFileSync(outFile + '.crash.txt', String((e && e.stack) || e));
  app.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
app.setPath('userData', process.argv[3]);
require('../dist/main.js');

async function drive() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const need = (sel) => {
    const e = $(sel);
    if (!e) throw new Error(`no element for ${sel}; page: ${$('main').innerText.slice(0, 300)}`);
    return e;
  };
  const set = (id, value) => (need('#' + id).value = value);
  const visible = (id) => !!$('#' + id) && !$('#' + id).closest('[hidden]');
  const describe = (e) => (!e ? null : `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} "${(e.getAttribute('aria-label') || e.innerText || '').trim().slice(0, 50)}"`);
  const out = {};

  await sleep(2500);
  need('nav button[data-view=submit]').click();
  await sleep(500);
  out.opened = { title: document.title, focus: describe(document.activeElement), navCurrent: [...document.querySelectorAll('nav button')].filter((b) => b.getAttribute('aria-current')).map((b) => b.innerText) };
  out.headings = [...document.querySelectorAll('main h1,main h2,main h3')].map((h) => `${h.tagName} ${h.textContent}`);
  // Every field must have a visible label that is wired to it.
  out.unlabelled = [...document.querySelectorAll('main input, main select, main textarea')].filter((c) => !c.labels || c.labels.length === 0).map((c) => c.id || c.name);
  out.gameOptions = [...document.querySelectorAll('#s-game option')].map((o) => o.textContent);

  // Which groups show for each kind of install?
  const groups = {};
  for (const [kind, radio] of [['zip', 's-i-zip'], ['installer', 's-i-installer'], ['workshop', 's-i-workshop']]) {
    need('#' + radio).click();
    groups[kind] = { repo: visible('s-repo'), installerAsset: visible('s-iasset'), zipAsset: visible('s-zasset'), workshop: visible('s-workshop') };
  }
  need('#s-i-installer').click(); // the hash options only exist inside the installer section
  need('#s-h-file').click();
  groups.hashFileShownForFileOption = visible('s-hashfile');
  need('#s-h-digest').click();
  groups.hashFileHiddenForDigest = !visible('s-hashfile');
  set('s-game', '');
  need('#s-game').dispatchEvent(new Event('change', { bubbles: true }));
  groups.newGameFieldShown = visible('s-newgame');
  out.groups = groups;
  set('s-game', 'rimworld');
  need('#s-game').dispatchEvent(new Event('change', { bubbles: true }));

  // 1) An empty form: plain-language problems, no file.
  need('#s-i-zip').click();
  need('[data-key="create"]').click();
  await sleep(1500);
  out.emptyForm = { status: $('main [role=status]').textContent, focus: describe(document.activeElement), problems: [...document.querySelectorAll('main h3 + ul li')].map((l) => l.textContent), hasJson: !!$('#s-json') };

  // 2) A real mod, checked against RimWorld Access's real GitHub release.
  set('s-name', 'Rim Check Demo');
  set('s-summary', 'A demonstration entry used to test the Submit page.');
  set('s-authors', 'Test Author');
  set('s-repo', 'aaronr7734/rimworld_access');
  set('s-tag', 'dev');
  set('s-zasset', 'RimWorldAccess-dev.zip');
  set('s-unpack', 'Mods');
  set('s-created', 'RimCheckDemo');
  need('[data-key="create"]').click();
  await sleep(5000);
  out.goodEntry = { status: $('main [role=status]').textContent, focus: describe(document.activeElement), headings: [...document.querySelectorAll('main h2,main h3')].map((h) => h.textContent).slice(-8), notes: [...document.querySelectorAll('main h3')].filter((h) => h.textContent === 'What was checked').map((h) => h.nextElementSibling.innerText), json: $('#s-json') && $('#s-json').value, buttons: [...document.querySelectorAll('main button.action')].map((b) => b.innerText) };

  // 3) Hand-edit the JSON so it breaks a rule, and check again.
  const area = need('#s-json');
  const edited = JSON.parse(area.value);
  edited.methods[0].steps[1].to = '{game}/../elsewhere';
  edited.uninstall = [{ type: 'delete', path: '{game}/mods/*.jar' }];
  area.value = JSON.stringify(edited, null, 2);
  need('[data-key="check-again"]').click();
  await sleep(2500);
  out.afterEdit = { status: $('main [role=status]').textContent, focus: describe(document.activeElement), problems: [...document.querySelectorAll('main h3 + ul li')].map((l) => l.textContent), jsonKept: $('#s-json').value.includes('elsewhere') };

  // 4) Not even JSON.
  $('#s-json').value = '{ "id": ';
  need('[data-key="check-again"]').click();
  await sleep(1500);
  out.notJson = { status: $('main [role=status]').textContent, problems: [...document.querySelectorAll('main h3 + ul li')].map((l) => l.textContent) };

  // 5) Leaving and coming back is not asked to keep anything; the page just rebuilds cleanly.
  need('nav button[data-view=home]').click();
  await sleep(800);
  need('nav button[data-view=submit]').click();
  await sleep(500);
  out.afterReturn = { name: $('#s-name').value, hasResult: !!$('#s-json') };
  return out;
}

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 1500));
  const win = BrowserWindow.getAllWindows()[0];
  let result;
  try {
    result = await win.webContents.executeJavaScript(`(${drive.toString()})()`);
  } catch (e) {
    result = { error: String(e) };
  }
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  app.quit();
});
