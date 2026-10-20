import { describe, expect, it } from 'vitest';

import { parseNumstatZ } from './observedGit';

describe('parseNumstatZ', () => {
  it('keeps a path that contains a tab whole, as git -z writes it unquoted', () => {
    // `git diff-tree -r -M -z --numstat`: "<ins>\t<del>\t<path>\0", or "<ins>\t<del>\t\0<old>\0<new>\0" for a rename.
    const stats = parseNumstatZ('3\t1\tsrc/odd\tname.ts\0' + '2\t0\t\0old.ts\0new.ts\0' + '-\t-\tlogo.png\0');

    expect(Object.fromEntries(stats)).toEqual({
      'src/odd\tname.ts': { insertions: 3, deletions: 1 },
      'new.ts': { insertions: 2, deletions: 0 },
      'logo.png': { insertions: null, deletions: null },
    });
  });
});
