// Drives the real app window and records what a screen reader user would meet:
// the heading, the focused control and the page text for each view.
//   npx electron scripts/smoke-main.js [outputFile]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// A crash in the main process normally opens a blocking error dialog. For a test run, record
// the error next to the results file and exit, so a failure is readable and never hangs.
const crashFile = (process.argv[2] || path.join(__dirname, '..', 'smoke-out.json')) + '.crash.txt';
const recordCrash = (e) => {
  fs.writeFileSync(crashFile, String((e && e.stack) || e));
  app.exit(1);
};
process.on('uncaughtException', recordCrash);
process.on('unhandledRejection', recordCrash);

// Optional second argument: use this folder for app data so the test never touches real settings.
if (process.argv[3]) app.setPath('userData', process.argv[3]);
// Optional third argument: pretend %APPDATA% is this empty folder, which hides the real
// Minecraft folder so the "not detected" paths can be exercised.
if (process.argv[4]) app.setPath('appData', process.argv[4]);

require('../dist/main.js'); // registers IPC handlers and opens the window

const outFile = process.argv[2] || path.join(__dirname, '..', 'smoke-out.json');

// Runs inside the page.
async function drive() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const describe = (e) =>
    !e ? null : `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} "${(e.getAttribute('aria-label') || e.innerText || e.value || '').trim().slice(0, 60)}"`;
  const snap = (label) => ({
    label,
    title: document.title,
    focus: describe(document.activeElement),
    nav: [...document.querySelectorAll('nav button')].map((b) => `${b.innerText}${b.getAttribute('aria-current') ? ' [current]' : ''}`),
    status: document.querySelector('main [role=status]')?.textContent,
    headings: [...document.querySelectorAll('main h1,main h2,main h3,main h4')].map((h) => `${h.tagName} ${h.textContent}`),
    text: document.querySelector('main').innerText,
  });
  const out = [];
  const click = (sel) => {
    const e = document.querySelector(sel);
    if (!e) throw new Error(`no element for ${sel}; so far recorded ${out.length} steps; page text: ${document.querySelector('main').innerText.slice(0, 300)}`);
    e.click();
  };

  await sleep(4000); // let the Home feed load from GitHub
  out.push(snap('home'));

  click('nav button[data-view=library]');
  await sleep(2500);
  out.push(snap('library'));
  out.push({ navBadge: document.querySelector('nav button[data-view=library]').innerText });

  out.push({
    label: 'library structure',
    headings: [...document.querySelectorAll('main h1,main h2,main h3')].map((h) => `${h.tagName} ${h.textContent}`),
    addSelect: document.getElementById('add-game-select') ? [...document.querySelectorAll('#add-game-select option')].map((o) => o.textContent) : null,
    addLabel: document.querySelector('label[for=add-game-select]')?.textContent ?? null,
  });

  // Manual folder handling: a settings file pre-set by the test gives Minecraft a chosen folder.
  if (document.querySelector('[data-key="clear-minecraft-java"]')) {
    click('[data-key="clear-minecraft-java"]');
    await sleep(1500);
    out.push({ ...snap('library after "Use automatic detection"'), text: undefined });
    out.push({ label: 'library text after clear', text: document.querySelector('main').innerText });
  }
  click('[data-key="rescan"]');
  await sleep(1500);
  out.push({ label: 'after Scan again', focus: describe(document.activeElement), status: document.querySelector('main [role=status]').textContent });

  click('nav button[data-view=browse]');
  await sleep(500);
  out.push(snap('browse'));

  const search = document.getElementById('search');
  search.value = 'rim';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(800);
  out.push(snap('browse, searched "rim"'));
  search.value = 'zzzz';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(800);
  out.push({ label: 'search with no match', status: document.querySelector('main [role=status]').textContent });
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  const select = document.getElementById('game-filter');
  select.value = 'minecraft-java';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(500);
  out.push({ label: 'game filter minecraft', status: document.querySelector('main [role=status]').textContent, cards: document.querySelectorAll('ul.cards > li').length });

  click('[data-key="open-united-minecraft"]');
  await sleep(3000);
  out.push(snap('detail united-minecraft'));
  click('[data-key="back"]');
  await sleep(600);
  out.push({ label: 'after Back', focus: describe(document.activeElement), title: document.title });

  // Install / remove flows, using records the test seeded in the scratch app-data folder.
  click('nav button[data-view=library]');
  await sleep(2500);
  out.push({ label: 'library with seeded records', nav: [...document.querySelectorAll('nav button')].map((b) => b.innerText), text: document.querySelector('main').innerText });
  click('[data-key="remove-harmony-rimworld"]');
  await sleep(1200);
  out.push(snap('remove review'));
  click('[data-key="go"]');
  await sleep(1500);
  out.push(snap('remove result'));
  click('[data-key="goto-library"]');
  await sleep(2500);
  out.push({ label: 'library after remove', text: document.querySelector('main').innerText });

  // Review (without running) an install for a real, detected game.
  click('nav button[data-view=browse]');
  await sleep(500);
  click('[data-key="open-rimworld-access"]');
  await sleep(3000);
  out.push({ label: 'rimworld-access install section', text: document.querySelector('main').innerText.split('Install')[1]?.slice(0, 600) });
  click('[data-key="review"]'); // no version chosen yet
  await sleep(300);
  out.push({ label: 'review without version', status: document.querySelector('main [role=status]').textContent, focus: describe(document.activeElement) });
  document.getElementById('method-manual').click();
  const versionSelect = document.getElementById('game-version');
  versionSelect.value = '1.7';
  versionSelect.dispatchEvent(new Event('change', { bubbles: true }));
  click('[data-key="review"]');
  await sleep(4000);
  out.push(snap('install review (not run)'));
  if (document.querySelector('[data-key="go"]')) {
    click('[data-key="go"]'); // if a confirmation is required, this must refuse
    await sleep(300);
    out.push({ label: 'install without ticking', status: document.querySelector('main [role=status]').textContent, focus: describe(document.activeElement), stillOnReview: !!document.querySelector('[data-key="go"]') });
  }
  click('[data-key="cancel"]');
  await sleep(2500);
  out.push({ label: 'after Cancel', title: document.title, focus: describe(document.activeElement) });

  // The dependency-bearing mod, reached from Home.
  click('nav button[data-view=home]');
  await sleep(1500);
  click('[data-key="open-rimworld-access"]');
  await sleep(3000);
  out.push(snap('detail rimworld-access'));
  return out;
}

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 1500));
  const win = BrowserWindow.getAllWindows()[0];
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => level >= 2 && errors.push(message));
  let result;
  try {
    result = await win.webContents.executeJavaScript(`(${drive.toString()})()`);
  } catch (e) {
    result = { error: String(e) };
  }
  if (result && result.error) {
    // Show where the page ended up, to make a failed run diagnosable.
    result.pageText = await win.webContents.executeJavaScript('document.querySelector("main").innerText').catch(() => null);
  }
  fs.writeFileSync(outFile, JSON.stringify({ errors, result }, null, 2));
  app.quit();
});
