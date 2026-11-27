import * as fs from 'fs';
import * as path from 'path';

export interface Settings {
  /** gameId -> folder the user chose by hand. */
  manualGames: Record<string, string>;
}

export function readSettings(file: string): Settings {
  const empty: Settings = { manualGames: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>;
    const manual: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.manualGames ?? {})) if (typeof v === 'string') manual[k] = v;
    return { manualGames: manual };
  } catch {
    return empty; // first run, or a damaged file: start clean rather than crash
  }
}

export function writeSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write to a temp file and rename, so a crash can't leave half a settings file.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
}
