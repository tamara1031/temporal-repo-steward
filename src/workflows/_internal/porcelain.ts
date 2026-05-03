export function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Files mentioned in `git status --porcelain` lines (after the 2-char status
 * prefix, ignoring the optional " -> " in renames).
 */
export function filesFromPorcelain(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const path = e.slice(3);
    if (!path) continue;
    const rename = path.split(' -> ');
    out.push(rename[rename.length - 1]);
  }
  return out;
}

/**
 * Porcelain entries present in `after` but not in `before`; the workflow
 * uses this to revert reviewer drift. Comparing full porcelain lines (status
 * flag + path) catches both new files AND status-flag changes on existing
 * files (e.g. ` M` -> `MM` when a reviewer edited an already-modified file).
 */
export function diffPorcelain(before: readonly string[], after: readonly string[]): string[] {
  const beforeSet = new Set(before);
  const drifted: string[] = [];
  for (const e of after) {
    if (!beforeSet.has(e)) {
      const path = filesFromPorcelain([e])[0];
      if (path) drifted.push(path);
    }
  }
  return drifted;
}
