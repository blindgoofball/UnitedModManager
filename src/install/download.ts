import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface DownloadOptions {
  onProgress?: (received: number, total?: number) => void;
  /** Tests serve files from a local http server; real use is https only. */
  allowHttp?: boolean;
  maxBytes?: number;
}

/** Downloads to `dest` (via a .part file) and returns the SHA-256 of what arrived. */
export async function downloadFile(
  fetchFn: typeof fetch,
  url: string,
  dest: string,
  opts: DownloadOptions = {},
): Promise<{ sha256: string; size: number }> {
  const secure = (u: string): boolean => u.startsWith('https://') || (!!opts.allowHttp && u.startsWith('http://'));
  if (!secure(url)) throw new Error(`Refusing to download over an insecure connection: ${url}`);

  const res = await fetchFn(url, {
    headers: { 'User-Agent': 'UnitedModManager' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!res.ok || !res.body) throw new Error(`The server answered ${res.status} for ${url}`);
  if (res.url && !secure(res.url)) throw new Error('The download was redirected to an insecure address.');

  const total = Number(res.headers.get('content-length')) || undefined;
  const max = opts.maxBytes ?? 2 * 1024 ** 3;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const hash = crypto.createHash('sha256');
  let received = 0;
  const handle = await fs.promises.open(part, 'w');
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      if (received > max) throw new Error('The download is larger than the allowed limit.');
      hash.update(chunk);
      await handle.write(chunk);
      opts.onProgress?.(received, total);
    }
  } catch (e) {
    await handle.close();
    await fs.promises.rm(part, { force: true });
    throw e;
  }
  await handle.close();
  await fs.promises.rename(part, dest);
  return { sha256: hash.digest('hex'), size: received };
}
