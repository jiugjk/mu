import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectFile, saveProjectFile } from '../main/files.mjs';

test('preview confines real paths to the project and rejects credential files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kyrn-files-'));
  const outside = await mkdtemp(join(tmpdir(), 'kyrn-outside-'));
  try {
    await writeFile(join(root, 'main.ts'), 'hello');
    await writeFile(join(root, '.env'), 'PRIVATE');
    await writeFile(join(outside, 'other.ts'), 'outside');
    await symlink(join(outside, 'other.ts'), join(root, 'escape.ts'));
    assert.equal((await readProjectFile(root, 'main.ts')).text, 'hello');
    await assert.rejects(readProjectFile(root, '.env'));
    await assert.rejects(readProjectFile(root, 'escape.ts'));
    await assert.rejects(readProjectFile(root, join(outside, 'other.ts')));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test('saving refuses to overwrite an intervening agent edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kyrn-save-'));
  try {
    await writeFile(join(root, 'main.ts'), 'original');
    const file = await readProjectFile(root, 'main.ts');
    const saved = await saveProjectFile(root, file.path, 'user edit', file.revision);
    assert.equal(saved.text, 'user edit');
    await writeFile(join(root, 'main.ts'), 'agent edit');
    await assert.rejects(saveProjectFile(root, file.path, 'stale edit', saved.revision), /已被/);
    assert.equal((await readProjectFile(root, file.path)).text, 'agent edit');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
