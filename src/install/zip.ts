import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import { isInside } from './paths';

const MAX_UNPACKED = 4 * 1024 ** 3;

/**
 * Unpacks a zip into `targetDir`. Every entry is checked first, so a hostile archive
 * (paths that climb out with "..", absolute paths, links, absurd sizes) is rejected
 * before anything is written. `beforeWrite` receives the top-level names that are
 * about to be created, so the caller can move aside anything already there.
 */
export async function extractZip(
  zipFile: string,
  targetDir: string,
  opts: { stripTopLevel?: boolean; beforeWrite?: (roots: string[]) => Promise<void> | void } = {},
): Promise<{ roots: string[]; fileCount: number }> {
  const zip = new AdmZip(zipFile);
  const items: { dest: string; entry: AdmZip.IZipEntry }[] = [];
  const roots = new Set<string>();
  let total = 0;
  let sharedTop: string | undefined;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const mode = (entry.attr >>> 16) & 0o170000;
    if (mode === 0o120000) throw new Error(`The archive contains a link ("${entry.entryName}"), which is not allowed.`);

    let segments = entry.entryName.replace(/\\/g, '/').split('/');
    if (opts.stripTopLevel) {
      if (segments.length < 2) throw new Error('The archive does not have a single top-level folder to remove.');
      sharedTop ??= segments[0];
      if (segments[0] !== sharedTop) throw new Error('The archive does not have a single top-level folder to remove.');
      segments = segments.slice(1);
    }
    if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\0') || /^[a-zA-Z]:/.test(s))) {
      throw new Error(`The archive contains an unsafe path ("${entry.entryName}").`);
    }
    const dest = path.join(targetDir, ...segments);
    if (!isInside(targetDir, dest)) throw new Error(`The archive contains an unsafe path ("${entry.entryName}").`);
    total += entry.header.size;
    if (total > MAX_UNPACKED) throw new Error('The archive unpacks to more than the allowed size.');
    roots.add(segments[0]);
    items.push({ dest, entry });
  }
  if (items.length === 0) throw new Error('The archive is empty.');

  const rootList = [...roots];
  await opts.beforeWrite?.(rootList);
  for (const { dest, entry } of items) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }
  return { roots: rootList, fileCount: items.length };
}
