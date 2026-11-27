# United Mod Manager

A manager for accessibility mods that make mainstream games playable for blind players. Search the
list, install a mod, and keep it up to date, without hunting through GitHub releases and separate
instructions for each one.

**Status: early development.** It runs on Windows and has been tried by hand with a small number of
mods. It is not packaged as an installer yet, so you run it from source (see below). Expect rough
edges, and please report them.

## What it does

- **Home**: the newest mod releases, with dates taken from GitHub.
- **Browse**: search the catalog, filter by game, and read about each mod.
- **Library**: the games found on your computer and the mods for them. Games are found through
  Steam or their usual folders. For anything else, you choose the folder yourself.
- **Install**: you review a plain-language list of exactly what will happen before anything runs.
  Downloads are checked against the hash the author published, files that would be replaced are
  backed up first, and installers that open their own window are supported.
- **Remove**: files are moved to a backup folder rather than erased.
- **Recognises what you already have**: mods that came from the Steam Workshop or that you copied
  in by hand are listed too, and dependencies you already have are not installed again.

It is built to work with screen readers: real headings, labelled controls, focus that moves to
the page heading when you change pages, and progress announced a step at a time.

## Supported mods so far

| Mod | Game |
| --- | --- |
| [United Minecraft](https://github.com/Blindgoofball/United-Minecraft) | Minecraft: Java Edition |
| [RimWorld Access](https://rimworldaccess.com/) | RimWorld |

Harmony, which RimWorld Access needs, is handled automatically as a dependency.

## Running it

You need [Node.js](https://nodejs.org/) 22 or newer.

```powershell
npm install
npm start
```

Other useful commands:

```powershell
npm test            # build, then run the automated tests
npm run catalog     # check every mod file in the catalog
```

`npm test` skips a few tests that briefly open real console windows. To include them, set
`UMM_WINDOW_TESTS=1` first.

## Adding a mod

The list of mods is a folder of small JSON files, one per mod, so adding one means adding one file.

1. Fork this repository.
2. Add `catalog/mods/<your-mod-id>.json`. The file name must match the `id` inside it. Copy an
   existing file from [catalog/mods](catalog/mods) as a starting point.
3. Run `npm run catalog`. It checks your file and tells you in plain words what is wrong.
4. Open a pull request.

A mod file describes where its releases come from, how to install it (a list of steps such as
download, unpack, run an installer), how to recognise it on a computer, and how to remove it.
The rules are in [catalog/schema/mod.schema.json](catalog/schema/mod.schema.json), and the reasoning
behind them is in [docs/schema-design.md](docs/schema-design.md).

Some things the checker insists on, to keep users safe:

- Anything that is downloaded and then run must be verified with a hash.
- Anything that could overwrite a user's file must make a backup first.
- Removal steps may only touch folders the manifest names, and a wildcard like `*.jar` is
  refused because it could match far more than the mod's own files.

A game does not need its own file. Its name is written in each mod's file. An optional file in
[catalog/games](catalog/games) adds details that help find the game automatically, such as its
Steam id.

## Project layout

| Folder | Contents |
| --- | --- |
| `catalog/` | Mod and game files, and the JSON Schemas that check them |
| `src/` | The app: main process, installer engine, and the window |
| `test/` | Automated tests |
| `scripts/` | Catalog checker, and scripts that drive the real app for manual checks |
| `docs/` | Design notes |

## Known limits

- Windows only for now. Some Mac and Linux paths are in the catalog but untested.
- Games are found through Steam or fixed folders. GOG and Epic copies need their folder chosen by hand.
- Installers that must run as administrator are not supported yet.
- The catalog ships inside the app, so it does not update on its own yet.

## License

[GNU General Public License v3.0](LICENSE).
