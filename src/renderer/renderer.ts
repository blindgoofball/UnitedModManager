// NOTE: this file must stay a plain script (no import/export). The sandboxed
// renderer has no CommonJS `exports`, so a compiled module would fail to load.
// Shared types live in ../types.d.ts as globals.

type ViewName = 'home' | 'library' | 'browse' | 'detail' | 'install';
type Child = Node | string | null | undefined | false;

interface ShowOptions {
  modId?: string;
  from?: ViewName;
  /** data-key of the control to focus once the view is ready (used when coming back). */
  focusKey?: string;
  /** data-key of the control that opened a detail page, so Back can return to it. */
  openerKey?: string;
  force?: boolean;
  /** For the install page: how to install, for which game version, or remove instead. */
  methodId?: string;
  gameVersion?: string;
  remove?: boolean;
  /** A short result to announce along with the page (for example "Folder set for RimWorld."). */
  message?: string;
}

const mainEl = document.getElementById('main') as HTMLElement;
const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('nav button[data-view]'));
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });

let current: { view: ViewName; from?: ViewName } = { view: 'home' };
let renderToken = 0; // lets a slow load be ignored if the user has already moved on
let catalog: ModSummary[] = [];
let updatesAvailable = 0;

// ---------- small helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, v);
  for (const c of children) if (c) e.append(c);
  return e;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function timeEl(iso: string): HTMLTimeElement {
  return el('time', { datetime: iso }, dateFormat.format(new Date(iso)));
}

function focusKey(key: string | undefined): boolean {
  if (!key) return false;
  const target = mainEl.querySelector<HTMLElement>(`[data-key="${key}"]`);
  target?.focus();
  return !!target;
}

function actionButton(label: string, key: string, onClick: () => void, ariaLabel?: string): HTMLButtonElement {
  const b = el('button', { type: 'button', class: 'action', 'data-key': key, 'aria-label': ariaLabel }, label);
  b.addEventListener('click', onClick);
  return b;
}

/** Replaces the page with a heading, a live status line and an empty body. */
function skeleton(title: string, before?: Node) {
  const h1 = el('h1', { tabindex: '-1' }, title);
  const status = el('p', { role: 'status', class: 'status' });
  const body = el('div');
  mainEl.replaceChildren(...(before ? [before] : []), h1, status, body);
  document.title = `${title} – United Mod Manager`;
  h1.focus();
  return { h1, status, body };
}

function renderNav(): void {
  const active = current.view === 'detail' || current.view === 'install' ? current.from : current.view;
  for (const b of navButtons) {
    if (b.dataset.view === active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const lib = navButtons.find((b) => b.dataset.view === 'library');
  if (lib) {
    lib.replaceChildren('Library');
    // The space matters: without it a screen reader reads "Library1 update".
    if (updatesAvailable > 0) lib.append(' ', el('span', { class: 'badge' }, plural(updatesAvailable, 'update', 'updates')));
  }
}

function openDetail(modId: string, from: ViewName, openerKey: string): void {
  void show('detail', { modId, from, openerKey });
}

function detailButton(mod: { id: string; name: string }, from: ViewName): HTMLButtonElement {
  const key = `open-${mod.id}`;
  return actionButton('View details', key, () => openDetail(mod.id, from, key), `View details for ${mod.name}`);
}

// ---------- Home ----------

async function showHome(token: number, opts: ShowOptions): Promise<void> {
  const v = skeleton('Home');
  v.body.append(el('p', {}, 'The newest releases and updates for accessibility mods.'));
  v.status.textContent = 'Loading recent releases…';

  const feed = await window.umm.getFeed(opts.force === true).catch(() => null);
  if (token !== renderToken) return;

  v.body.append(el('h2', {}, 'Recent releases'));
  if (!feed || (feed.items.length === 0 && feed.failed > 0)) {
    v.status.textContent = 'Could not get release information. Check your internet connection and try again.';
  } else {
    v.status.textContent =
      feed.failed > 0
        ? `${plural(feed.items.length, 'release', 'releases')} shown. Release information for ${plural(feed.failed, 'mod', 'mods')} could not be loaded.`
        : `${plural(feed.items.length, 'release', 'releases')}, newest first.`;
    const list = el('ul', { class: 'cards' });
    for (const item of feed.items) {
      const gameNote = item.gameVersion ? `, for game version ${item.gameVersion}` : '';
      list.append(
        el(
          'li',
          {},
          el('h3', {}, item.name),
          el('p', { class: 'muted' }, item.game),
          el('p', {}, `Version ${item.version}${gameNote}`),
          el('p', {}, 'Released ', timeEl(item.date)),
          detailButton({ id: item.modId, name: item.name }, 'home'),
        ),
      );
    }
    v.body.append(list);
  }
  if (feed) v.body.append(el('p', { class: 'muted' }, catalogLine(feed.catalog)));
  v.body.append(actionButton('Refresh releases and mod list', 'refresh', () => void show('home', { force: true, focusKey: 'refresh' })));
  focusKey(opts.focusKey);
}

/** One plain sentence about which mod list is in use and whether GitHub could be reached. */
function catalogLine(c: CatalogInfo): string {
  const changed = dateFormat.format(new Date(c.revision));
  const base =
    c.source === 'github'
      ? `The mod list is up to date with GitHub (last changed ${changed}).`
      : c.source === 'cache'
        ? `The mod list was last downloaded from GitHub (last changed ${changed}).`
        : `The mod list is the copy that came with the app (last changed ${changed}).`;
  return c.error ? `${base} Could not check GitHub for a newer list: ${c.error}` : base;
}

/** Says something without changing the page, for results that belong to the whole app. */
function announce(text: string): void {
  const el = document.getElementById('announcer');
  if (!el) return;
  el.textContent = '';
  window.setTimeout(() => (el.textContent = text), 50); // a change is what gets read out
}

// ---------- Library ----------

function statusText(m: LibraryMod): string {
  if (m.status === 'update-available') return m.latestVersion ? `Update available: ${m.latestVersion}` : 'Update available';
  return m.status === 'up-to-date' ? 'Up to date' : 'Update status unknown';
}

async function showLibrary(token: number, opts: ShowOptions): Promise<void> {
  const v = skeleton('Library');
  v.status.textContent = 'Loading your library…';
  const lib = await window.umm.getLibrary().catch(() => null);
  if (token !== renderToken) return;
  if (!lib) {
    v.status.textContent = 'Could not load your library.';
    return;
  }
  updatesAvailable = lib.updatesAvailable;
  renderNav();

  const summary =
    lib.games.length === 0 ? 'No games found on this computer.' : `${plural(lib.games.length, 'game', 'games')} found on this computer.`;
  v.status.textContent = opts.message ? `${opts.message} ${summary}` : summary;

  const chooseFolder = async (game: { gameId: string; name: string }): Promise<void> => {
    const result = await window.umm.chooseGameFolder(game.gameId);
    if (result.canceled) return; // the user backed out; nothing changed and focus stays where it was
    if (!result.ok) {
      v.status.textContent = result.error ?? 'Could not use that folder.';
      return;
    }
    void show('library', { message: `Folder set for ${game.name}.`, focusKey: `choose-${game.gameId}` });
  };
  const chooseButton = (game: { gameId: string; name: string }, label: string): HTMLButtonElement =>
    actionButton(label, `choose-${game.gameId}`, () => void chooseFolder(game), `${label} for ${game.name}`);

  for (const game of lib.games) {
    const where = { steam: 'Found in Steam', 'known-folder': 'Found in its usual location', manual: 'A folder you chose' }[game.source];
    v.body.append(el('h2', {}, game.name), el('p', {}, `Folder: ${game.installPath}`), el('p', { class: 'muted' }, where));
    v.body.append(chooseButton(game, 'Choose a different folder'));
    if (game.source === 'manual') {
      v.body.append(
        actionButton(
          'Use automatic detection',
          `clear-${game.gameId}`,
          () => {
            void window.umm.clearGameFolder(game.gameId).then(() => show('library', { message: `Using automatic detection for ${game.name}.`, focusKey: `choose-${game.gameId}` }));
          },
          `Use automatic detection for ${game.name}`,
        ),
      );
    }

    v.body.append(el('h3', {}, 'Installed mods'));
    if (game.installed.length === 0) {
      v.body.append(el('p', {}, 'No mods installed for this game.'));
    } else {
      const list = el('ul', { class: 'cards' });
      for (const m of game.installed) {
        const card = el(
          'li',
          {},
          el('h4', {}, m.isDependency ? `${m.name} (needed by other mods)` : m.name),
          m.tracked
            ? el('p', {}, `Installed version ${m.installedVersion}`)
            : el('p', {}, `Found on your computer${m.foundVia ? ` (${m.foundVia})` : ''}. It was not installed by this app, so its updates are not tracked here.`),
          m.tracked ? el('p', {}, el('strong', {}, statusText(m))) : null,
          detailButton({ id: m.modId, name: m.name }, 'library'),
        );
        if (m.status === 'update-available') {
          const key = `update-${m.modId}`;
          card.append(
            actionButton('Update', key, () => void show('install', { modId: m.modId, from: 'library', methodId: m.methodId, gameVersion: m.gameVersion, openerKey: key }), `Update ${m.name}`),
          );
        }
        if (m.canRemove) {
          const key = `remove-${m.modId}`;
          card.append(actionButton('Remove', key, () => void show('install', { modId: m.modId, from: 'library', remove: true, openerKey: key }), `Remove ${m.name}`));
        }
        list.append(card);
      }
      v.body.append(list);
    }

    if (game.available.length > 0) {
      v.body.append(el('h3', {}, 'Available mods'));
      const list = el('ul', { class: 'cards' });
      for (const m of game.available) {
        list.append(el('li', {}, el('h4', {}, m.name), el('p', {}, m.description), detailButton(m, 'library')));
      }
      v.body.append(list);
    }
  }

  // Games that were not detected stay out of the list above; the user adds them here on purpose.
  v.body.append(el('h2', {}, 'Add a game'));
  if (lib.undetected.length === 0) {
    v.body.append(el('p', {}, 'Every game with mods in the catalog is already in your library.'));
  } else {
    const select = el('select', { id: 'add-game-select' });
    for (const g of lib.undetected) select.append(el('option', { value: g.gameId }, g.name));
    const add = actionButton('Choose folder…', 'add-game', () => {
      const game = lib.undetected.find((g) => g.gameId === select.value);
      if (game) void chooseFolder(game);
    });
    v.body.append(
      el('p', {}, 'Games that have mods but were not found on this computer. Pick one, then choose the folder it is installed in.'),
      el('label', { for: 'add-game-select' }, 'Game'),
      select,
      add,
    );
  }

  v.body.append(actionButton('Scan again', 'rescan', () => void show('library', { message: 'Scanned again.', focusKey: 'rescan' })));
  focusKey(opts.focusKey);
}

// ---------- Browse ----------

function modCard(m: ModSummary): HTMLLIElement {
  return el('li', {}, el('h3', {}, m.name), el('p', { class: 'muted' }, `${m.game} · by ${m.author}`), el('p', {}, m.description), detailButton(m, 'browse'));
}

async function showBrowse(token: number, opts: ShowOptions): Promise<void> {
  const v = skeleton('Browse');
  if (token !== renderToken) return;

  const search = el('input', { id: 'search', type: 'search', autocomplete: 'off' });
  const gameSelect = el('select', { id: 'game-filter' }, el('option', { value: '' }, 'All games'));
  const games = new Map(catalog.map((m) => [m.gameId, m.game]));
  for (const [id, name] of [...games].sort((a, b) => a[1].localeCompare(b[1]))) {
    gameSelect.append(el('option', { value: id }, name));
  }
  const results = el('ul', { class: 'cards' });
  v.body.append(
    el(
      'search',
      {},
      el('div', { class: 'controls' },
        el('div', {}, el('label', { for: 'search' }, 'Search mods'), search),
        el('div', {}, el('label', { for: 'game-filter' }, 'Game'), gameSelect),
      ),
    ),
    el('h2', {}, 'Mods'),
    results,
  );

  const sorted = [...catalog].sort((a, b) => a.name.localeCompare(b.name));
  let announceTimer: number | undefined;

  function update(announceSoon: boolean): void {
    const q = search.value.trim().toLowerCase();
    const game = gameSelect.value;
    const matches = sorted.filter(
      (m) => (!game || m.gameId === game) && (!q || [m.name, m.game, m.description, m.author].some((s) => s.toLowerCase().includes(q))),
    );
    results.replaceChildren(...matches.map(modCard));
    const text = matches.length === 0 ? 'No mods found.' : `${plural(matches.length, 'mod', 'mods')} found.`;
    window.clearTimeout(announceTimer);
    if (announceSoon) announceTimer = window.setTimeout(() => (v.status.textContent = text), 400); // wait for typing to pause
    else v.status.textContent = text;
  }

  search.addEventListener('input', () => update(true));
  gameSelect.addEventListener('change', () => update(false));
  update(false);
  if (!focusKey(opts.focusKey)) v.h1.focus();
}

// ---------- Mod details ----------

async function showDetail(token: number, opts: ShowOptions): Promise<void> {
  const from = opts.from ?? 'browse';
  const back = actionButton(`Back to ${from[0].toUpperCase()}${from.slice(1)}`, 'back', () => void show(from, { focusKey: opts.openerKey }));
  const summary = catalog.find((m) => m.id === opts.modId);
  const v = skeleton(summary?.name ?? 'Mod details', back);
  v.status.textContent = 'Loading details…';

  const detail = opts.modId ? await window.umm.getMod(opts.modId).catch(() => null) : null;
  if (token !== renderToken) return;
  if (!detail) {
    v.status.textContent = 'This mod could not be found.';
    return;
  }
  const m = detail.manifest;
  document.title = `${m.name} – United Mod Manager`;
  v.h1.textContent = m.name;
  v.status.textContent = '';

  const facts: [string, Child][] = [
    ['Game', m.game.name],
    ['Authors', m.authors.join(', ')],
    ['Platforms', m.platforms.map((p) => ({ windows: 'Windows', macos: 'macOS', linux: 'Linux' }[p] ?? p)).join(', ')],
  ];
  if (m.gameVersions) facts.push(['Game versions', m.gameVersions.join(', ')]);
  if (m.license) facts.push(['License', m.license]);
  if (detail.release) {
    const r = detail.release;
    facts.push(['Latest release', el('span', {}, `${r.version}${r.gameVersion ? ` for game version ${r.gameVersion}` : ''}, `, timeEl(r.date))]);
  } else if (detail.releaseError) {
    facts.push(['Latest release', 'Could not be loaded right now.']);
  }
  const dl = el('dl', { class: 'facts' });
  for (const [k, val] of facts) dl.append(el('dt', {}, k), el('dd', {}, val));

  v.body.append(el('p', {}, m.summary));
  if (m.description) v.body.append(el('p', {}, m.description));
  v.body.append(el('h2', {}, 'Details'), dl);

  installSection(v, detail, from, opts.openerKey);

  if (m.dependencies?.length) {
    v.body.append(el('h2', {}, 'Also installs'));
    const list = el('ul');
    for (const d of m.dependencies) list.append(el('li', {}, detail.dependencyNames[d.id] ?? d.id));
    v.body.append(list);
  }
  if (m.conflicts?.length) {
    v.body.append(el('h2', {}, 'Things to know'));
    const list = el('ul');
    for (const c of m.conflicts) list.append(el('li', {}, c.note));
    v.body.append(list);
  }
  if (m.homepage) {
    const url = m.homepage;
    v.body.append(actionButton('Open homepage in your browser', 'homepage', () => void window.umm.openExternal(url)));
  }
  focusKey(opts.focusKey);
}

function installSection(v: { status: HTMLElement; body: HTMLElement }, detail: ModDetail, from: ViewName, openerKey?: string): void {
  const m = detail.manifest;
  const info = detail.install;
  v.body.append(el('h2', {}, 'Install'));

  if (!info.platformSupported) {
    v.body.append(el('p', {}, `${m.name} is not available for this operating system.`));
    return;
  }
  if (!info.gameFound) {
    v.body.append(
      el('p', {}, `${info.gameName} was not found on this computer. Add it in the Library first.`),
      actionButton('Go to Library', 'goto-library', () => void show('library', { focusKey: 'add-game' })),
    );
    return;
  }

  v.body.append(el('p', { class: 'muted' }, `Game folder: ${info.gamePath}`));
  if (info.installed) {
    const i = info.installed;
    if (i.tracked) {
      const status = i.status === 'update-available' ? `Update available${i.latestVersion ? `: ${i.latestVersion}` : ''}` : i.status === 'up-to-date' ? 'Up to date' : 'Update status unknown';
      v.body.append(el('p', {}, el('strong', {}, `Installed: version ${i.version}. ${status}.`)));
    } else {
      v.body.append(
        el('p', {}, el('strong', {}, `Already on your computer${i.foundVia ? ` (${i.foundVia})` : ''}.`), ' It was not installed by this app, so its version and updates are not tracked here.'),
      );
    }
  }

  const defaultMethod =
    info.methods.find((x) => x.id === info.installed?.methodId)?.id ?? info.methods.find((x) => x.recommended)?.id ?? info.methods[0]?.id;
  const fieldset = el('fieldset', {}, el('legend', {}, 'How to install'));
  for (const method of info.methods) {
    const id = `method-${method.id}`;
    fieldset.append(
      el(
        'div',
        { class: 'option' },
        el('input', { type: 'radio', name: 'method', id, value: method.id, checked: method.id === defaultMethod ? 'checked' : undefined }),
        el('label', { for: id }, method.label + (method.recommended ? ' (recommended)' : '')),
      ),
    );
  }
  v.body.append(fieldset);

  let versionSelect: HTMLSelectElement | undefined;
  if (m.gameVersions) {
    versionSelect = el('select', { id: 'game-version' }, el('option', { value: '' }, 'Choose a version'));
    for (const gv of m.gameVersions) versionSelect.append(el('option', { value: gv, selected: gv === info.installed?.gameVersion ? 'selected' : undefined }, gv));
    v.body.append(el('label', { for: 'game-version' }, `Which ${info.gameName} version do you have?`), versionSelect);
  }

  v.body.append(
    actionButton(info.installed?.tracked ? 'Review reinstall' : 'Review install', 'review', () => {
      const methodId = fieldset.querySelector<HTMLInputElement>('input[name="method"]:checked')?.value;
      if (!methodId) {
        v.status.textContent = 'Choose how to install.';
        return;
      }
      if (versionSelect && !versionSelect.value) {
        v.status.textContent = 'Choose your game version first.';
        versionSelect.focus();
        return;
      }
      void show('install', { modId: m.id, from, methodId, gameVersion: versionSelect?.value || undefined, openerKey });
    }),
  );
  if (info.installed?.canRemove) {
    v.body.append(actionButton('Remove', 'remove', () => void show('install', { modId: m.id, from, remove: true, openerKey })));
  }
}

// ---------- Install / remove ----------

async function showInstall(token: number, opts: ShowOptions): Promise<void> {
  const modId = opts.modId ?? '';
  const from = opts.from ?? 'browse';
  let known = catalog.find((m) => m.id === modId)?.name ?? 'this mod'; // replaced by the real name once the plan loads
  const backToDetail = (): void => void show('detail', { modId, from, openerKey: opts.openerKey, focusKey: 'review' });
  const backButton = actionButton(`Back to ${known}`, 'back', backToDetail);
  const v = skeleton(opts.remove ? `Remove ${known}` : `Install ${known}`, backButton);
  v.status.textContent = 'Preparing…';

  const res = opts.remove ? await window.umm.planRemove(modId) : await window.umm.planInstall(modId, opts.methodId ?? '', opts.gameVersion);
  if (token !== renderToken) return;
  if (!res.ok) {
    v.status.textContent = res.error;
    return;
  }
  const plan = res.plan;
  known = plan.modName;
  backButton.textContent = `Back to ${known}`;
  v.h1.textContent = plan.title;
  document.title = `${plan.title} – United Mod Manager`;
  v.status.textContent = '';

  v.body.append(el('h2', {}, 'What will happen'));
  const steps = el('ol');
  for (const s of plan.steps) steps.append(el('li', {}, s));
  v.body.append(steps);

  if (plan.skipped.length > 0) {
    v.body.append(el('h2', {}, 'Already on your computer'));
    const list = el('ul');
    for (const s of plan.skipped) list.append(el('li', {}, s));
    v.body.append(list);
  }

  if (plan.warnings.length > 0) {
    v.body.append(el('h2', {}, 'Please note'));
    const list = el('ul');
    for (const w of plan.warnings) list.append(el('li', {}, w));
    v.body.append(list);
  }

  const boxes: { id: string; input: HTMLInputElement }[] = [];
  if (plan.confirmations.length > 0) {
    const set = el('fieldset', {}, el('legend', {}, 'Please confirm'));
    for (const c of plan.confirmations) {
      const id = `confirm-${c.id}`;
      const input = el('input', { type: 'checkbox', id });
      boxes.push({ id: c.id, input });
      set.append(el('div', { class: 'option' }, input, el('label', { for: id }, c.text)));
    }
    v.body.append(set);
  }

  const run = async (): Promise<void> => {
    const unticked = boxes.find((b) => !b.input.checked);
    if (unticked) {
      v.status.textContent = 'Tick the box to confirm, or choose Cancel.';
      unticked.input.focus();
      return;
    }
    const progress = el('p');
    v.body.replaceChildren(el('h2', {}, opts.remove ? 'Removing' : 'Installing'), progress);
    v.status.textContent = 'Starting…';

    let lastStep = 0;
    let lastBucket = -2;
    const stopListening = window.umm.onInstallProgress((p) => {
      if (p.planId !== plan.planId || token !== renderToken) return;
      // Announce each new step, and download progress only every quarter, so the screen reader is not flooded.
      const bucket = p.percent === undefined ? -1 : Math.floor(p.percent / 25);
      if (p.step === lastStep && bucket === lastBucket) return;
      lastStep = p.step;
      lastBucket = bucket;
      const text = `Step ${p.step} of ${p.of}: ${p.text}${p.percent !== undefined ? ` (${p.percent}%)` : ''}`;
      v.status.textContent = text;
      progress.textContent = text;
    });
    const result = await window.umm.runPlan(plan.planId, boxes.map((b) => b.id));
    stopListening();
    if (token !== renderToken) return; // the user moved on; the work itself still finished

    const heading = el('h2', { tabindex: '-1' }, result.ok ? 'Finished' : 'Something went wrong');
    v.status.textContent = '';
    v.body.replaceChildren(heading, el('p', {}, result.message));
    if (result.notes.length > 0) {
      v.body.append(el('h3', {}, 'Notes'));
      const list = el('ul');
      for (const n of result.notes) list.append(el('li', {}, n));
      v.body.append(list);
    }
    v.body.append(
      actionButton(`Back to ${known}`, 'back-to-mod', backToDetail),
      actionButton('Go to Library', 'goto-library', () => void show('library')),
    );
    heading.focus();
    void refreshUpdateCount();
  };

  v.body.append(actionButton(opts.remove ? 'Remove' : 'Install', 'go', () => void run()), actionButton('Cancel', 'cancel', backToDetail));
}

// ---------- navigation ----------

async function show(view: ViewName, opts: ShowOptions = {}): Promise<void> {
  const token = ++renderToken;
  current = { view, from: opts.from };
  renderNav();
  if (view === 'home') await showHome(token, opts);
  else if (view === 'library') await showLibrary(token, opts);
  else if (view === 'browse') await showBrowse(token, opts);
  else if (view === 'install') await showInstall(token, opts);
  else await showDetail(token, opts);
}

/** Refreshes the update count shown next to Library in the navigation. */
async function refreshUpdateCount(): Promise<void> {
  const lib = await window.umm.getLibrary().catch(() => null);
  if (!lib) return;
  updatesAvailable = lib.updatesAvailable;
  renderNav();
}

async function init(): Promise<void> {
  // Listen before anything else loads, so a newer mod list that arrives early is not missed.
  window.umm.onCatalogChanged(() => {
    void window.umm.listMods().then((mods) => {
      catalog = mods;
      announce('The mod list was updated. Open Browse to see it.');
    });
  });
  for (const b of navButtons) b.addEventListener('click', () => void show(b.dataset.view as ViewName));
  catalog = await window.umm.listMods();
  // Load the library once up front so the update count shows in the navigation.
  void refreshUpdateCount();
  await show('home');
}

void init();
