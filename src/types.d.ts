// Ambient types shared by the main process, the preload script and the renderer.
// This file must stay a script (no import/export) so the renderer, which cannot use
// modules in the sandbox, can see these names too.

/** One row of the generated browse index (see scripts/build-catalog.js). */
interface ModSummary {
  id: string;
  name: string;
  gameId: string;
  game: string;
  description: string;
  author: string;
  platforms: string[];
}

/** The parts of a mod manifest the app reads. The full schema is catalog/schema/mod.schema.json. */
interface ModManifest {
  id: string;
  kind?: 'mod' | 'dependency';
  name: string;
  summary: string;
  description?: string;
  authors: string[];
  homepage?: string;
  license?: string;
  game: { id: string; name: string };
  gameVersions?: string[];
  platforms: string[];
  source: { type: 'github'; repo: string; tag?: string } | { type: 'workshop'; itemId: string };
  dependencies?: { id: string }[];
  methods: { id: string; label: string; recommended?: boolean; when?: StepWhen; steps: ModStep[] }[];
  afterInstall?: ModStep[];
  detect?: { method?: string; path: string }[];
  uninstall?: ModStep[];
  conflicts?: { note: string }[];
  updates: {
    strategy: 'release-tag' | 'asset-changed' | 'external';
    asset?: string;
    selfUpdating?: boolean;
    versionFrom?: { tag?: string };
  };
}

type Platform = 'windows' | 'macos' | 'linux';

interface StepWhen {
  version?: string;
  platform?: Platform;
  /** Only in uninstall steps: how the mod was installed. */
  method?: string;
}

/** One install step, as written in a manifest (see catalog/schema/mod.schema.json). */
type ModStep = { when?: StepWhen } & (
  | { type: 'download'; asset?: string; url?: string; sha256?: string; sha256Asset?: string; githubDigest?: boolean }
  | { type: 'extract'; file?: string; to: string; stripTopLevel?: boolean }
  | { type: 'run'; file?: string; path?: string; interactive?: boolean; args?: string[]; elevate?: boolean }
  | { type: 'copy'; from: { url: string }; to: string; backup?: boolean; ifExists?: 'overwrite' | 'skip' | 'ask' }
  | { type: 'open'; url: string }
  | { type: 'note'; text: string }
  | { type: 'delete'; path: string }
);

interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
  /** "sha256:<hex>" as recorded by GitHub, when it has one. */
  digest?: string;
  updatedAt?: string;
}

/** What the manager remembers about something it installed. */
interface InstallRecord {
  modId: string;
  gameId: string;
  methodId: string;
  gameVersion?: string;
  /** Version shown to the user (from the release tag). */
  version: string;
  tag?: string;
  assetName?: string;
  assetHash?: string;
  assetUpdatedAt?: string;
  installedAt: string;
  /** Folders we created files in, so we can remove exactly those. */
  extracted: { baseDir: string; roots: string[] }[];
  /** True when an installer was started but we cannot tell whether it finished. */
  launchedOnly?: boolean;
}

interface InstallPlanView {
  planId: string;
  kind: 'install' | 'remove';
  title: string;
  modName: string;
  steps: string[];
  warnings: string[];
  /** Things the plan leaves alone because they are already on the computer. */
  skipped: string[];
  confirmations: { id: string; text: string }[];
}

interface InstallResult {
  ok: boolean;
  message: string;
  notes: string[];
}

interface InstallProgress {
  planId: string;
  step: number;
  of: number;
  text: string;
  percent?: number;
}

interface InstallInfo {
  platformSupported: boolean;
  gameFound: boolean;
  gameName: string;
  gamePath?: string;
  methods: { id: string; label: string; recommended: boolean }[];
  installed?: {
    version: string;
    methodId: string;
    gameVersion?: string;
    status: UpdateStatus;
    latestVersion?: string;
    canRemove: boolean;
    /** False when the mod was found on disk but not installed by this manager. */
    tracked: boolean;
    /** For untracked mods: the install method it was recognised as (for example "Steam Workshop"). */
    foundVia?: string;
  };
}

/** Latest release information fetched from GitHub. */
interface ReleaseInfo {
  modId: string;
  tag: string;
  /** Mod version pulled out of the tag when the manifest says how, else the tag itself. */
  version: string;
  /** Game version pulled out of the tag, when the manifest says how. */
  gameVersion?: string;
  /** ISO 8601 date of the newest of the release and its assets. */
  date: string;
  url: string;
}

interface FeedItem extends ReleaseInfo {
  name: string;
  game: string;
}

interface CatalogInfo {
  /** Where the mod list in use came from. */
  source: 'built-in' | 'cache' | 'github';
  revision: string;
  /** When GitHub was last asked successfully. */
  checkedAt?: string;
  /** Why the last attempt to get a newer list failed, if it did. */
  error?: string;
}

interface HomeFeed {
  catalog: CatalogInfo;
  items: FeedItem[];
  /** How many mods we tried to check, and how many of those failed. */
  total: number;
  failed: number;
}

interface ModDetail {
  install: InstallInfo;
  manifest: ModManifest;
  dependencyNames: Record<string, string>;
  release: ReleaseInfo | null;
  releaseError?: string;
}

type UpdateStatus = 'up-to-date' | 'update-available' | 'unknown';

interface LibraryMod {
  modId: string;
  name: string;
  installedVersion: string;
  latestVersion?: string;
  status: UpdateStatus;
  isDependency: boolean;
  canRemove: boolean;
  methodId: string;
  gameVersion?: string;
  /** False when found on disk but not installed by this manager. */
  tracked: boolean;
  foundVia?: string;
}

/** A game and how to find it, from catalog/games.json (built from the mods and optional games files). */
interface GameDef {
  id: string;
  name: string;
  detect: {
    steam?: { appId: string };
    paths?: { platform: 'windows' | 'macos' | 'linux'; path: string; marker?: string }[];
  };
}

type GameSource = 'steam' | 'known-folder' | 'manual';

interface DetectedGame {
  gameId: string;
  path: string;
  source: GameSource;
}

interface LibraryGame {
  gameId: string;
  name: string;
  installPath: string;
  source: GameSource;
  installed: LibraryMod[];
  available: ModSummary[];
}

interface LibraryData {
  /** Games found on this computer. */
  games: LibraryGame[];
  /** Games that have mods but were not found; the user can point at a folder. */
  undetected: { gameId: string; name: string }[];
  updatesAvailable: number;
}

interface ChooseFolderResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
}

/** What the "Submit a mod" page collects. Everything is text from form fields. */
interface SubmitForm {
  name: string;
  id: string;
  summary: string;
  description: string;
  authors: string;
  homepage: string;
  license: string;
  /** An existing game's id, or "" for a game that is not in the catalog yet. */
  gameChoice: string;
  newGameName: string;
  platforms: Platform[];
  install: 'installer' | 'zip' | 'workshop';
  repo: string;
  tag: string;
  workshopItemId: string;
  installerAsset: string;
  hashSource: 'digest' | 'file';
  hashFile: string;
  interactive: boolean;
  selfUpdating: boolean;
  /** A file the installer leaves inside the game folder, such as mods/my-mod-*.jar. */
  leftoverPath: string;
  zipAsset: string;
  /** Folder inside the game folder to unpack into, such as Mods. Empty means the game folder itself. */
  unpackInto: string;
  /** Name of the folder the zip creates. */
  createdFolder: string;
  /** A script to run after unpacking, as a path inside the unpack folder, such as MyMod/install.bat. */
  scriptPath: string;
  scriptInteractive: boolean;
}

interface SubmitCheckResult {
  /** Things that must be fixed before this can be submitted. */
  problems: string[];
  /** Helpful facts, such as the release files that were found. */
  notes: string[];
  id?: string;
}

interface SubmitBuildResult extends SubmitCheckResult {
  json: string;
}

interface UmmApi {
  listMods(): Promise<ModSummary[]>;
  getMod(id: string): Promise<ModDetail | null>;
  getFeed(force: boolean): Promise<HomeFeed>;
  getLibrary(): Promise<LibraryData>;
  chooseGameFolder(gameId: string): Promise<ChooseFolderResult>;
  clearGameFolder(gameId: string): Promise<boolean>;
  planInstall(modId: string, methodId: string, gameVersion?: string): Promise<{ ok: true; plan: InstallPlanView } | { ok: false; error: string }>;
  planRemove(modId: string): Promise<{ ok: true; plan: InstallPlanView } | { ok: false; error: string }>;
  runPlan(planId: string, confirmedIds: string[]): Promise<InstallResult>;
  /** Returns a function that stops listening. */
  onInstallProgress(listener: (p: InstallProgress) => void): () => void;
  buildSubmission(form: SubmitForm): Promise<SubmitBuildResult>;
  checkSubmission(json: string): Promise<SubmitCheckResult>;
  copySubmission(json: string): Promise<boolean>;
  saveSubmission(json: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  openSubmissionOnGithub(json: string): Promise<{ ok: boolean; prefilled?: boolean; error?: string }>;
  /** Called when a newer mod list has been downloaded and is now in use. */
  onCatalogChanged(listener: () => void): () => void;
  openExternal(url: string): Promise<boolean>;
}

interface Window {
  umm: UmmApi;
}
