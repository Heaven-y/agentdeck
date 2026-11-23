import path from 'node:path';
import { opendir } from 'node:fs/promises';
import type { NativeSkillState } from '@agentdeck/shared/settings';
import { verifiedSkillVersion } from '../../../native-management/version';
import { NativeManagementError } from '../../../native-management/errors';
import { readNativeConfigSource, writeNativeConfigJson } from '../../../native-management/config';
import type { NativeSkill, SkillAdapter, SkillContext } from '../../../native-management/skills/types';
import type { NativeConfigSource } from '../../../native-management/config';
import { resolveLocalCommand } from '../../../platform/process/executable';
import { runProcess } from '../../../platform/process/run';
import { inspectDirectory, readConfigFile } from '../../../platform/files/safe-file';
import { skillMetadata } from '../../../native-management/skills/skill-entries';
import { claudePluginRecords } from './plugin-records';

const claudeOverrides: NativeSkillState[] = ['on', 'name-only', 'user-invocable-only', 'off'];
const claudeSkillStates: NativeSkillState[] = ['inherit', ...claudeOverrides];
export async function claudeSkillConfig(context: SkillContext) {
  const base = path.resolve(context.env.CLAUDE_CONFIG_DIR || path.join(context.homeDir, '.claude'));
  const sources = [await readNativeConfigSource(path.join(base, 'settings.json'), 'user')];
  if (context.project) {
    sources.push(await readNativeConfigSource(path.join(context.project.dir, '.claude/settings.json'), 'project'));
    sources.push(await readNativeConfigSource(path.join(context.project.dir, '.claude/settings.local.json'), 'local'));
  }
  return sources;
}
function overrides(config: NativeConfigSource['data']): Record<string, unknown> | undefined {
  const value = config.skillOverrides;
  if (value === undefined) return {};
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function scopedState(name: string, values: ReturnType<typeof overrides>): NativeSkillState {
  if (!values) return 'unknown';
  if (!Object.hasOwn(values, name)) return 'inherit';
  return claudeOverrides.find((state) => state === values[name]) ?? 'unknown';
}
function claudeSkillState(states: NativeSkillState[]): NativeSkillState {
  if (!states.length || states.includes('unknown')) return 'unknown';
  let result: NativeSkillState = 'inherit';
  for (const value of states) if (value !== 'inherit') result = value;
  return result;
}

type InstalledPlugin = { id: string; installPath: string; scope: string; enabled: boolean };
function pluginRecords(value: unknown): InstalledPlugin[] {
  if (!Array.isArray(value) || value.length > 4096) throw new NativeManagementError('native_unavailable');
  const candidates: unknown[] = value;
  return candidates.filter((candidate): candidate is InstalledPlugin => {
    const item = candidate as Partial<InstalledPlugin> | null;
    return (
      !!item &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.installPath === 'string' &&
      path.isAbsolute(item.installPath) &&
      typeof item.scope === 'string' &&
      typeof item.enabled === 'boolean'
    );
  });
}
async function pluginSkills(plugin: InstalledPlugin): Promise<NativeSkill[]> {
  const skills: NativeSkill[] = [];
  if (!(await inspectDirectory(plugin.installPath))) return skills;
  const rootSkill = path.join(plugin.installPath, 'SKILL.md');
  const root = await readConfigFile(rootSkill);
  if (root.revision !== 'missing') skills.push(pluginSkill(plugin, rootSkill, plugin.id.split('@')[0]!, root.content));
  const directory = path.join(plugin.installPath, 'skills');
  if (!(await inspectDirectory(directory))) return skills;
  const handle = await opendir(directory);
  let remaining = 4096;
  for await (const entry of handle) {
    if (--remaining < 0) throw new NativeManagementError('native_unavailable');
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name, 'SKILL.md');
    if (!(await inspectDirectory(path.dirname(file)))) continue;
    const snapshot = await readConfigFile(file);
    if (snapshot.revision === 'missing') continue;
    skills.push(pluginSkill(plugin, file, `${plugin.id.split('@')[0]}:${entry.name}`, snapshot.content));
  }
  return skills;
}
function pluginSkill(plugin: InstalledPlugin, file: string, name: string, content: string): NativeSkill {
  return {
    name,
    description: skillMetadata(content, name).description,
    path: file,
    nativeScope: plugin.scope,
    scope: plugin.scope === 'user' || plugin.scope === 'project' || plugin.scope === 'local' ? plugin.scope : 'unknown',
    enabled: plugin.enabled,
    fileOnly: true,
    origin: 'plugin',
    source: plugin.id,
    ownerRoot: plugin.installPath,
  };
}
export async function claudeSkillsFromPlugins(value: unknown): Promise<NativeSkill[]> {
  const skills: NativeSkill[] = [];
  for (const plugin of pluginRecords(value)) {
    skills.push(...(await pluginSkills(plugin)));
    if (skills.length > 4096) throw new NativeManagementError('native_unavailable');
  }
  return skills;
}
/** 原生命令只列已安装插件，不查询市场、不加载插件，也不启动模型会话。 */
async function readClaudeInstalledSkills(context: SkillContext): Promise<NativeSkill[]> {
  const command = resolveLocalCommand('claude', context.env);
  const result = await runProcess(command.command, [...command.args, 'plugin', 'list', '--json'], {
    cwd: context.project?.dir ?? context.homeDir,
    env: context.env,
    timeoutMs: 15000,
    outputCap: 512 * 1024,
  });
  if (result.exitCode !== 0) throw new NativeManagementError('native_unavailable');
  return claudeSkillsFromPlugins(await claudePluginRecords(context, JSON.parse(result.stdout.toString('utf8'))));
}

export const claudeSkills: SkillAdapter = {
  readNative: readClaudeInstalledSkills,
  readConfig: claudeSkillConfig,
  verifyVersion: (context) => verifiedSkillVersion(context, [2, 1, 317], (env) => resolveLocalCommand('claude', env)),
  localOrigin: (resource) => (resource.displayPath.includes('/synced/') ? 'synced' : undefined),
  visibility({ name, sources }) {
    const stateByScope = Object.fromEntries(
      sources.map((source) => [source.scope, scopedState(name, overrides(source.data))]),
    );
    const canWrite = sources.length > 0 && sources.every((source) => overrides(source.data) !== undefined);
    return {
      state: claudeSkillState(Object.values(stateByScope)),
      stateByScope,
      states: canWrite ? claudeSkillStates : [],
      scopes: canWrite ? sources.map((source) => source.scope) : [],
      ...(sources.length > 0 && !canWrite && { unavailableReason: '技能可见性配置格式不受支持，请从原文入口修复。' }),
    };
  },
  async changeState(_context, { name, scope, value }, sources) {
    const source = sources.find((item) => item.scope === scope);
    if (!source || !claudeSkillStates.includes(value)) throw new NativeManagementError('unsupported_action');
    await writeNativeConfigJson(source, (config) => {
      const previous = overrides(config);
      if (!previous) throw new NativeManagementError('unsupported_action');
      const values = Object.assign(Object.create(null) as Record<string, unknown>, previous);
      if (value === 'inherit') delete values[name];
      else values[name] = value;
      config.skillOverrides = values;
    });
    // 只确认所选层的磁盘配置，不把它解释为覆盖托管策略后的会话生效值。
    const written = await readNativeConfigSource(source.file, scope).catch(() => undefined);
    if (!written || written.revision === 'missing' || scopedState(name, overrides(written.data)) !== value)
      throw new NativeManagementError('skill_state_unconfirmed');
  },
};
