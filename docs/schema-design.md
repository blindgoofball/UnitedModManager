# Mod manifest schema: design draft (v1)

Status: IMPLEMENTED as schema v1. The authoritative definition is
`catalog/schema/mod.schema.json`, validated by `scripts/build-catalog.js`
(`npm run catalog`). The two example manifests below are older drafts; the real
ones are in `catalog/mods/`. Decisions made with the project owner:

- Game version is picked by the user (declared as `gameVersions`), never detected.
  This keeps the app free of per-game code.
- Workshop-only mods are listed: `source` can be `{ "type": "workshop", "itemId": "..." }`.
- RimWorld Access's settings file replaces the user's `ModsConfig.xml` (confirmed
  from experience), so every `copy` step must back up or skip, and the manifest
  warns the user first. The validator enforces the backup rule.
- Game files are optional and not needed for submissions.

## Edge cases the schema must handle

From United Minecraft (checked against its v2.3.0 release):

1. Interactive installer that updates the mod and the game by itself.
2. Release tag mixes mod version and game version (`v2.3.0+mc26.3`).
3. Several assets per release (installer, Fabric jar, NeoForge jar, hash file).
4. Hash published as a separate `.sha256` asset.

From RimWorld Access (installation page, as relayed by a subagent; the
ModsConfig overwrite behavior below is NOT confirmed by the page):

5. Two install routes: Steam Workshop (recommended) and manual zip.
6. Workshop install cannot be done silently; the user must click Subscribe in Steam.
7. A required dependency (Harmony) with its own Workshop id and its own GitHub releases.
8. Files go to `<game>/Mods`, and that path differs per platform and game version
   (macOS 1.6 uses a path inside the .app bundle).
9. A follow-up file step outside the game folder: a version-specific
   `ModsConfig.xml` goes into the user's config folder (`LocalLow\...` on Windows).
   Replacing that file may wipe the user's other mod activations, so it needs a
   backup and a confirmation, or a smarter merge.
10. Two supported game versions (1.6, 1.7 beta) needing different files.
11. Download URL points at a rolling `dev` tag, not a versioned release, so
    "newer version" cannot be detected from the tag. Compare the asset instead.
12. Switching routes leaves a stale copy that can load instead of, or twice with,
    the new one. Needs a conflict warning.
13. Linux is not documented at all, so platform support must be explicit.

## Decisions

### One file per mod; games are inline, with an optional games file
A mod file carries `game: { id, name }`. A contributor adds one file, never two.
CI checks that every mod using the same game `id` gives the same `name`, which
catches typos like `minecraft` vs `minecraft-java`.

Per-game data that mods should not repeat (Steam app id, executable name, how to
read the game version, default folders) lives in an OPTIONAL
`catalog/games/<id>.json`, added by a maintainer or by a contributor who wants
auto-detection. Without it the app falls back to asking the user for the game
folder. So a new game never blocks a mod submission.

### Install is an ordered list of steps, not a fixed "install type"
Instead of `extract` / `installer` / `extract-and-run` enums, a method is a list
of steps from a small vocabulary. New combinations need no app changes.

| Step | Purpose |
|---|---|
| `download` | Fetch a release asset (glob match) or a URL; verify hash. |
| `extract` | Unpack an archive to a folder; optional `stripTopLevel`. |
| `run` | Launch an executable; `interactive` or with `args`; may need `elevate`. |
| `copy` | Place a downloaded file at a path; `backup` and `ifExists` rules. |
| `open` | Hand a URL to the OS (Steam Workshop page, `steam://...`). |
| `note` | Text shown to the user for things we cannot automate. |

A mod lists one or more `methods` (RimWorld Access has two). Each method can
restrict itself by `platforms` and `when` conditions, and can be `recommended`.

### Paths use tokens, never raw paths
`{game}` (detected or chosen game folder), `{home}`, `{appdata}`,
`{localappdata}`, `{locallow}`, `{documents}`. Anything outside `{game}` must be
declared so the UI can tell the user which files will be touched.

### Updates are a strategy, not an assumption
`updates.strategy` is one of:
- `release-tag`: compare the latest release tag (with optional `versionFrom` regex
  to pull the mod version out of tags like `v2.3.0+mc26.3`).
- `asset-changed`: compare the asset's hash or timestamp. Used by United Minecraft
  (re-download only when the installer changes) and RimWorld Access (`dev` tag).
- `external`: Workshop or self-updating; the manager only reports, never updates.
Plus `selfUpdating: true` when the installer maintains the mod itself.

### Dependencies are catalog entries
Harmony is its own small manifest (`kind: "dependency"`, hidden from browsing).
Mods reference it by id, so it is installed or flagged once and shared.

### Integrity
A `download` step can verify with an inline `sha256`, a sidecar asset
(`sha256Asset`), or GitHub's own asset digest. One of these is required for any
step that leads to running or executing a file.

### Patterns are globs, not regexes
Contributors should write `united-installer.exe` or `*-fabric.jar`, not escaped
regexes. (The earlier draft used regexes; that was a mistake.)

## Draft: United Minecraft

```json
{
  "schemaVersion": 1,
  "id": "united-minecraft",
  "name": "United Minecraft",
  "summary": "Full accessibility for blind players in Minecraft (Fabric and NeoForge).",
  "authors": ["Blindgoofball"],
  "homepage": "https://github.com/Blindgoofball/United-Minecraft",
  "license": "GPL-3.0",
  "game": { "id": "minecraft-java", "name": "Minecraft: Java Edition" },
  "platforms": ["windows"],
  "source": { "type": "github", "repo": "Blindgoofball/United-Minecraft" },
  "methods": [
    {
      "id": "installer",
      "label": "Installer (handles game and mod updates itself)",
      "recommended": true,
      "steps": [
        { "type": "download", "asset": "united-installer.exe", "sha256Asset": "united-installer.exe.sha256" },
        { "type": "run", "file": "united-installer.exe", "interactive": true }
      ]
    }
  ],
  "updates": {
    "strategy": "asset-changed",
    "asset": "united-installer.exe",
    "selfUpdating": true,
    "versionFrom": { "tag": "^v(?<mod>[\\d.]+)\\+mc(?<game>[\\d.]+)$" }
  }
}
```

## Draft: RimWorld Access

```json
{
  "schemaVersion": 1,
  "id": "rimworld-access",
  "name": "RimWorld Access",
  "summary": "Screen reader accessibility for RimWorld.",
  "game": { "id": "rimworld", "name": "RimWorld" },
  "platforms": ["windows", "macos"],
  "source": { "type": "github", "repo": "aaronr7734/rimworld_access", "tag": "dev" },
  "dependencies": [{ "id": "harmony-rimworld" }],
  "methods": [
    {
      "id": "workshop",
      "label": "Steam Workshop (recommended)",
      "recommended": true,
      "steps": [
        { "type": "open", "url": "steam://url/CommunityFilePage/3750094441" },
        { "type": "note", "text": "Click Subscribe, then choose Subscribe to All so Harmony is included." }
      ]
    },
    {
      "id": "manual",
      "label": "Manual install (no Steam, or you manage files yourself)",
      "steps": [
        { "type": "download", "asset": "RimWorldAccess-dev.zip" },
        { "type": "extract", "to": "{game}/Mods", "stripTopLevel": false }
      ]
    }
  ],
  "afterInstall": [
    {
      "when": { "game": "rimworld", "version": "1.6" },
      "type": "copy",
      "from": { "url": "https://rimworldaccess.com/files/ModsConfig.xml" },
      "to": "{locallow}/Ludeon Studios/RimWorld by Ludeon Studios/Config/ModsConfig.xml",
      "backup": true,
      "ifExists": "ask"
    }
  ],
  "conflicts": [
    { "note": "A leftover manual copy in Mods loads instead of the Workshop copy. Remove it first." }
  ],
  "updates": { "strategy": "asset-changed", "asset": "RimWorldAccess-dev.zip" }
}
```

(The macOS path, the 1.7 variant of the config step and the Harmony manifest are
left out of the example for brevity. The Workshop `steam://` URL is untested.)

## Detecting and removing mods (added after the first install tests)

The manager used to know only what it had installed itself. Real computers are messier: on the
project owner's machine Harmony came from the Steam Workshop, RimWorld Access was a manual copy,
and United Minecraft's installer put a jar in `.minecraft/mods`.

- **`detect`**: a list of `{ method, path }` rules. The first path that exists means "this mod is
  here", and `method` says how it was installed. Used to skip dependencies that are already
  present, and to list mods in the Library that the manager did not install (shown as "found on
  your computer", with no version or update tracking).
- **`{workshop}` token**: the game's Steam Workshop folder, found next to its install folder
  (`steamapps/workshop/content/<appid>`). Only available for games that live in Steam.
- **`uninstall`**: steps using `delete` (moves to a backup folder, never erases), `open` and `note`.
  A step's `when.method` limits it to mods installed that way, so RimWorld Access can delete its
  folder when installed by hand and send you to Steam when it came from the Workshop.
  Without an `uninstall` list the manager falls back to removing exactly the folders it unpacked.
- **Safety rules, enforced when the catalog is built and again when removing**: a delete path must
  be inside a known folder, a wildcard is allowed only in the last part, and it needs at least four
  fixed characters before it (so `*.jar` is refused). Removing warns when another installed mod
  needs the one being removed.

## Running a script from an unpacked archive

Many mods ship a zip with an install script inside. A `run` step can name either a downloaded file
(`file`) or a script inside a folder an earlier step unpacked (`path`), never both. Because that runs
code from an archive, it is held to the same standard as running a downloaded installer:

- The archive's download must be verified (`sha256`, `sha256Asset` or `githubDigest`).
- The path must sit inside a folder that an earlier `extract` step of the same method writes to.
- Only `.exe`, `.bat`, `.cmd` and `.ps1` files can run, with no wildcards and no `..`.
- When it runs, the script must be one of the files that were just unpacked from that archive, so a
  file that was already on the computer at that path is never run.
- Scripts start in their own folder and get a console window of their own. A `.bat`/`.cmd` is started
  with `call`, and a `.ps1` through PowerShell with its execution policy bypassed for that one file.

Known limit: if the script fails, the files it came with stay where they were unpacked (nothing is
recorded as installed). There is no automatic rollback yet, and no way yet to run a script when removing.

## Still open

1. **ModsConfig.xml merging.** For now it is replace-with-backup-and-confirm.
   A smarter merge would need game-specific code, which we are avoiding.
2. **Platforms.** `platforms` is required. A mod whose platform support is unknown
   has to guess; consider an "unverified" marker later.
3. **RimWorld Access build: resolved.** It follows the rolling `dev` tag, as the
   project owner confirmed. The older versioned `v1.1.0` release is ignored.
4. **Windows-only paths and Steam detection** are not in the schema yet; that is
   app work (finding `{game}`).
5. **Dependencies of dependencies** are rejected by the validator for now.
