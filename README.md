# United Mod Manager

A manager for accessibility mods that make mainstream games playable for blind players. Search the
list, install a mod, and keep it up to date, without hunting through GitHub releases and separate
instructions for each one.

**Status: early development.** It runs on Windows and has been tried by hand with a small number of
mods. It is not packaged as an installer yet, so you run it from source (see below). Expect rough
edges, and please report them.

## What it does

- **Home**: the newest mod releases, with dates taken from GitHub. The mod list itself is also
  downloaded from this repository, so new mods appear without updating the app. It works offline
  too, using the last list it downloaded.
- **Browse**: search the catalog, filter by game, and read about each mod.
- **Library**: the games found on your computer and the mods for them. Games are found through
  Steam or their usual folders. For anything else, you choose the folder yourself.
- **Install**: you review a plain-language list of exactly what will happen before anything runs.
  Downloads are checked against the hash the author published, files that would be replaced are
  backed up first, and installers that open their own window are supported.
- **Remove**: files are moved to a backup folder rather than erased.
- **Submit a mod**: know a mod that is missing? A guided form writes the catalog entry for you and
  helps you send it, so you do not need to know the file format.
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

**The easy way:** open **Submit a mod** in the app. Answer a few questions about the mod, and the app
writes the catalog entry, checks it with the same rules as the automatic check below (including that
the files you named really exist in the GitHub release), and helps you send it: copy it, save it as
a file, or open GitHub with the file already filled in so you can follow its prompts to a pull request.

**By hand:** the list of mods is a folder of small JSON files, one per mod, so adding one means
adding one file.

1. Fork this repository.
2. Add `catalog/mods/<your-mod-id>.json`. The file name must match the `id` inside it. Copy an
   existing file from [catalog/mods](catalog/mods) as a starting point.
3. Run `npm run catalog`. It checks your file and tells you in plain words what is wrong.
4. Open a pull request. Automatic checks run on it, and any problem shows up on your file.

Once your change is merged, a new mod list is published automatically, and the app picks it up
the next time it starts. Nobody has to release a new version of the app to add a mod.

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
- The app only checks for a new mod list when it starts and when you press Refresh on Home.

## License

[GNU General Public License v3.0](LICENSE).
