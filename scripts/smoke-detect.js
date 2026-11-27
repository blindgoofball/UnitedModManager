// READ-ONLY check of what the app recognises on this computer. Starts the real app with an empty
// app-data folder (so nothing is "tracked"), opens review pages, and never presses Install/Remove.
//   node --check scripts/smoke-detect.js; npx electron scripts/smoke-detect.js <outFile> <emptyUserDataDir>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

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
  const click = (sel) => {
    const e = document.querySelector(sel);
    if (!e) throw new Error(`no element for ${sel}; page: ${document.querySelector('main').innerText.slice(0, 400)}`);
    e.click();
  };
  const text = () => document.querySelector('main').innerText;
  const out = {};
  await sleep(3000);
  click('nav button[data-view=library]');
  await sleep(3500);
  out.library = text();

  // Review removing each detected mod (read only: the review page is shown, nothing is pressed).
  for (const id of ['united-minecraft', 'rimworld-access', 'harmony-rimworld']) {
    click('nav button[data-view=library]');
    await sleep(2500);
    const btn = document.querySelector(`[data-key="remove-${id}"]`);
    if (!btn) {
      out[`remove ${id}`] = 'NO REMOVE BUTTON';
      continue;
    }
    btn.click();
    await sleep(1500);
    out[`remove ${id}`] = text();
  }

  // Installing RimWorld Access (manual, 1.7): Harmony is on this PC via Workshop, so it should be skipped.
  click('nav button[data-view=browse]');
  await sleep(500);
  click('[data-key="open-rimworld-access"]');
  await sleep(3000);
  out['rimworld-access detail'] = text();
  document.getElementById('method-manual').click();
  const v = document.getElementById('game-version');
  v.value = '1.7';
  v.dispatchEvent(new Event('change', { bubbles: true }));
  click('[data-key="review"]');
  await sleep(4000);
  out['install review rimworld-access'] = text();
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
