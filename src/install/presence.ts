import { findPaths } from './paths';

/**
 * Is this mod already on the computer, however it got there? The first `detect` rule whose
 * path exists wins, and its `method` says how the mod was installed (for example "workshop").
 */
export function detectPresence(m: ModManifest, roots: Record<string, string>): { method?: string; paths: string[] } | null {
  for (const rule of m.detect ?? []) {
    try {
      const paths = findPaths(rule.path, roots);
      if (paths.length > 0) return { method: rule.method, paths };
    } catch {
      // A bad rule is caught when the catalog is built; here it simply finds nothing.
    }
  }
  return null;
}
