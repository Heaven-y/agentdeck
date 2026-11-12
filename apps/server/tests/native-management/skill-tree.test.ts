import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deleteSkillTree, SKILL_LIMITS, snapshotSkillTree } from '../../src/native-management/skill-tree';

vi.mock(import('node:fs/promises'), async (original) => {
  const actual = await original();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdeck-skill-delete-'));
  directories.push(root);
  const directory = path.join(root, 'demo');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'SKILL.md'), '# Demo');
  const { revision } = await snapshotSkillTree(directory);
  return { root, directory, revision };
}
it('删除隔离后的快照抛错时恢复原技能并保留外部更改', async () => {
  const { root, directory, revision } = await fixture();
  const { rename } = await vi.importActual<typeof fs>('node:fs/promises');
  const changed = Buffer.alloc(SKILL_LIMITS.fileBytes + 1, 65);
  vi.mocked(fs.rename).mockImplementationOnce(async (source, destination) => {
    await fs.writeFile(path.join(directory, 'SKILL.md'), changed);
    await rename(source, destination);
  });
  await expect(deleteSkillTree(directory, revision)).rejects.toMatchObject({ code: 'too_large' });
  expect(await fs.readFile(path.join(directory, 'SKILL.md'))).toEqual(changed);
  expect(await fs.readdir(root)).toEqual(['demo']);
});
it('恢复原位置已被占用时保留隔离内容并报告结果待核实', async () => {
  const { root, directory, revision } = await fixture();
  const { rename } = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.rename).mockImplementationOnce(async (source, destination) => {
    await rename(source, destination);
    await fs.writeFile(path.join(String(destination), 'SKILL.md'), 'changed');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'SKILL.md'), 'replacement');
  });
  await expect(deleteSkillTree(directory, revision)).rejects.toMatchObject({ code: 'result_unconfirmed' });
  expect(await fs.readFile(path.join(directory, 'SKILL.md'), 'utf8')).toBe('replacement');
  const quarantine = (await fs.readdir(root)).find((name) => name.startsWith('.deleted-'))!;
  expect(await fs.readFile(path.join(root, quarantine, 'SKILL.md'), 'utf8')).toBe('changed');
});
