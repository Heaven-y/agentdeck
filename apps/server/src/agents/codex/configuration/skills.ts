import path from 'node:path';
import { CodexClient } from '../run/client';
import { readNativeSkills } from '../capabilities';
import { resolveCodexCommand } from '../run/launch';
import { CodexError, record, text, type CodexRuntimeOptions, type RecordValue } from '../run/types';
import { NativeResourceError } from '../../common/configuration/errors';
import { readNativeConfigSource } from '../../../native-management/config';
import { NativeManagementError } from '../../../native-management/errors';
import { verifiedSkillVersion } from '../../../native-management/version';
import {
  enabledState,
  nativeSkillPathKey,
  type NativeSkill,
  type SkillAdapter,
} from '../../../native-management/skills/types';

function skillOrigin(raw: RecordValue, scope: string): NativeSkill['origin'] {
  if (typeof raw.pluginId === 'string' || record(raw.source).type === 'plugin' || scope === 'plugin') return 'plugin';
  if (scope === 'admin') return 'managed';
  if (scope === 'system') return 'builtin';
}
function skillScope(scope: string): NativeSkill['scope'] {
  if (scope === 'repo') return 'project';
  return scope === 'user' || scope === 'admin' || scope === 'system' ? scope : 'unknown';
}
function nativeSkill(raw: RecordValue): NativeSkill {
  const scope = text(raw.scope);
  const file = text(raw.path);
  return {
    name: text(raw.name),
    path: nativeSkillPathKey(file) ? file : undefined,
    nativeScope: scope,
    scope: skillScope(scope),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    origin: skillOrigin(raw, scope),
  };
}
function writable(skill: NativeSkill | undefined): skill is NativeSkill & { path: string; enabled: boolean } {
  return (
    !!skill &&
    !!nativeSkillPathKey(skill.path) &&
    !skill.origin &&
    (skill.scope === 'user' || skill.scope === 'project') &&
    typeof skill.enabled === 'boolean'
  );
}
function sameTarget(expected: NativeSkill, current: NativeSkill) {
  return current.path === expected.path && current.name === expected.name && current.scope === expected.scope;
}
function confirmedWrite(before: NativeSkill, after: NativeSkill | undefined, enabled: boolean, result: RecordValue) {
  return (
    result.effectiveEnabled === enabled && writable(after) && sameTarget(before, after) && after.enabled === enabled
  );
}
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
  async function list(client: SkillClient, cwd: string) {
    const { skills } = await readNativeSkills(client as CodexClient, cwd);
    return skills.map(nativeSkill);
  }
  return {
    read: (cwd: string) => use(cwd, (client) => list(client, cwd)),
    write: (cwd: string, skillPath: string, enabled: boolean, expected?: NativeSkill) =>
      use(cwd, async (client) => {
        const key = nativeSkillPathKey(skillPath);
        if (!key) throw new NativeManagementError('unsupported_action');
        const readTarget = async () => {
          const matches = (await list(client, cwd)).filter((skill) => nativeSkillPathKey(skill.path) === key);
          return matches.length === 1 ? matches[0] : undefined;
        };
        const before = await readTarget().catch(() => {
          throw new NativeManagementError('native_unavailable');
        });
        if (!writable(before) || before.path !== skillPath) throw new NativeManagementError('unsupported_action');
        if (expected && (!sameTarget(expected, before) || expected.enabled !== before.enabled))
          throw new NativeResourceError('revision_conflict');
        const result = await client.request('skills/config/write', { path: before.path, enabled }).catch((error) => {
          if (error instanceof CodexError && error.nativeRejected) throw error;
          throw new NativeManagementError('result_unconfirmed');
        });
        const after = await readTarget().catch(() => undefined);
        if (!confirmedWrite(before, after, enabled, result)) throw new NativeManagementError('result_unconfirmed');
      }),
  };
}

export const codexSkills: SkillAdapter = {
  description: '启停按原生技能文件路径保存到 Codex 用户配置；项目可信状态仍由 Codex 决定。',
  readNative: ({ env, project, homeDir }) => createCodexSkills({ env }).read(project?.dir ?? homeDir),
  async readConfig({ env, project, homeDir }) {
    const sources = [
      await readNativeConfigSource(path.join(env.CODEX_HOME || path.join(homeDir, '.codex'), 'config.toml'), 'user'),
    ];
    if (project) sources.push(await readNativeConfigSource(path.join(project.dir, '.codex/config.toml'), 'project'));
    return sources;
  },
  verifyVersion: (context) => verifiedSkillVersion(context, '0.166.0', (env) => resolveCodexCommand({ env })),
  visibility({ nativeSkill, sources }) {
    const canWrite = writable(nativeSkill) && sources.some((source) => source.scope === 'user');
    return {
      state: enabledState(nativeSkill),
      states: canWrite ? ['enabled', 'disabled'] : [],
      scopes: canWrite ? ['user'] : [],
    };
  },
  async changeState({ env, project, homeDir }, { nativeSkill, scope, value }) {
    if (!writable(nativeSkill) || scope !== 'user' || (value !== 'enabled' && value !== 'disabled'))
      throw new NativeManagementError('unsupported_action');
    await createCodexSkills({ env }).write(project?.dir ?? homeDir, nativeSkill.path, value === 'enabled', nativeSkill);
  },
};
