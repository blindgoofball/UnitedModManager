import * as fs from 'fs';
import * as path from 'path';

export function readInstalled(file: string): InstallRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is InstallRecord => !!r && typeof r.modId === 'string' && typeof r.gameId === 'string' && Array.isArray(r.extracted),
    );
  } catch {
    return []; // first run or a damaged file
  }
}

export function writeInstalled(file: string, records: InstallRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, file);
}

/** Replaces any earlier record for the same mod and game, then adds the new ones. */
export function upsertRecords(existing: InstallRecord[], added: InstallRecord[]): InstallRecord[] {
  const same = (a: InstallRecord, b: InstallRecord): boolean => a.modId === b.modId && a.gameId === b.gameId;
  return [...existing.filter((e) => !added.some((a) => same(a, e))), ...added];
}
