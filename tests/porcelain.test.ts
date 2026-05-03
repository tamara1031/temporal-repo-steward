import { describe, expect, it } from 'vitest';
import { arraysEqual, diffPorcelain, filesFromPorcelain } from '../src/workflows/_internal/porcelain';

describe('porcelain workflow helpers', () => {
  it('extracts modified and added file paths from porcelain entries', () => {
    expect(filesFromPorcelain([' M src/periodic.ts', 'A  tests/porcelain.test.ts'])).toEqual([
      'src/periodic.ts',
      'tests/porcelain.test.ts',
    ]);
  });

  it('resolves rename entries to the destination path only', () => {
    expect(filesFromPorcelain(['R  old.ts -> new.ts'])).toEqual(['new.ts']);
  });

  it('ignores empty porcelain entries after the status prefix', () => {
    expect(filesFromPorcelain([' M ', '??'])).toEqual([]);
  });

  it('detects new and status-flag-changed entries in later snapshots', () => {
    expect(diffPorcelain([' M file.ts'], ['MM file.ts', 'A  added.ts'])).toEqual([
      'file.ts',
      'added.ts',
    ]);
  });

  it('returns no drift for unchanged status snapshots', () => {
    const entries = [' M file.ts', 'A  added.ts', 'R  old.ts -> new.ts'];

    expect(diffPorcelain(entries, [...entries])).toEqual([]);
    expect(arraysEqual(entries, [...entries])).toBe(true);
  });

  it('compares arrays by length, order, and entry value', () => {
    expect(arraysEqual(['A  one.ts'], ['A  one.ts'])).toBe(true);
    expect(arraysEqual(['A  one.ts'], ['A  one.ts', ' M two.ts'])).toBe(false);
    expect(arraysEqual(['A  one.ts', ' M two.ts'], [' M two.ts', 'A  one.ts'])).toBe(false);
  });
});
