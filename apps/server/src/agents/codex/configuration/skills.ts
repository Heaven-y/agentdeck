import path from 'node:path';
import { CodexClient } from '../run/client';
import { readNativeSkills } from '../capabilities';
import type { CodexRuntimeOptions } from '../run/types';
import { record, text } from '../run/types';
import { NativeManagementError } from '../../../native-management/errors';
import type { NativeSkill } from '../../../native-management/skills/types';

export type SkillClient = Pick<CodexClient, 'request' | 'initialize' | 'close'>;
export function createCodexSkills(
  options: CodexRuntimeOptions = {},
  start: (cwd: string) => Promise<SkillClient> = (cwd) => CodexClient.start({ ...options, cwd }),
) {
  async function use<T>(cwd: string, operation: (client: SkillClient) => Promise<T>) {
    const client = await start(cwd);
    try {
      await client.initialize();
      return await operation(client);
    } finally {
      await client.close();
    }
  }
  return {
    read: (cwd: string): Promise<NativeSkill[]> =>
      use(cwd, async (client) => {
        const { skills } = await readNativeSkills(client as CodexClient, cwd);
        return skills.map((skill) => ({
          name: text(skill.name),
          path: text(skill.path),
          scope: text(skill.scope),
          enabled: skill.enabled === true,
          ...(typeof skill.pluginId === 'string' || record(skill.source).type === 'plugin'
            ? { origin: 'plugin' as const }
            : {}),
        }));
      }),
    write: (cwd: string, skillPath: string, enabled: boolean) =>
      use(cwd, async (client) => {
        if (!path.isAbsolute(skillPath)) throw new NativeManagementError('unsupported_action');
        const { skills } = await readNativeSkills(client as CodexClient, cwd);
        if (
          skills.filter(
            (skill) =>
              skill.path === skillPath &&
              typeof skill.pluginId !== 'string' &&
              !['admin', 'system'].includes(text(skill.scope)),
          ).length !== 1
        )
          throw new NativeManagementError('unsupported_action');
        const result = await client.request('skills/config/write', { path: skillPath, enabled });
        const after = await readNativeSkills(client as CodexClient, cwd);
        if (
          result.effectiveEnabled !== enabled ||
          after.skills.filter((skill) => skill.path === skillPath && skill.enabled === enabled).length !== 1
        )
          throw new NativeManagementError('result_unconfirmed');
      }),
  };
}
