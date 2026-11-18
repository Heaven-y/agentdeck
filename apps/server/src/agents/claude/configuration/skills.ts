import path from 'node:path';
import { opendir } from 'node:fs/promises';
import type { NativeSkillChangeInput, NativeSkillState } from '@agentdeck/shared/settings';
import { NativeManagementError } from '../../../native-management/errors';
import { readNativeConfigSource, writeNativeConfigJson } from '../../../native-management/config';
import type { NativeSkill, SkillContext } from '../../../native-management/skills/types';
import type { NativeConfigSource } from '../../../native-management/config';
import { resolveLocalCommand } from '../../../platform/process/executable';
import { runProcess } from '../../../platform/process/run';
import { inspectDirectory, readConfigFile } from '../../../platform/files/safe-file';
import { claudePluginRecords } from './plugin-records';

export const claudeSkillStates: NativeSkillState[] = ['inherit', 'on', 'name-only', 'user-invocable-only', 'off'];
export async function claudeSkillConfig(context: SkillContext) {
  const base = path.resolve(context.env.CLAUDE_CONFIG_DIR || path.join(context.homeDir, '.claude'));
  const sources = [await readNativeConfigSource(path.join(base, 'settings.json'), 'user')];
  if (context.project) {
    sources.push(await readNativeConfigSource(path.join(context.project.dir, '.claude/settings.json'), 'project'));
    sources.push(await readNativeConfigSource(path.join(context.project.dir, '.claude/settings.local.json'), 'local'));
  }
  return sources;
}
function overrides(source: NativeConfigSource) {
  const value = source.data.skillOverrides;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function claudeSkillState(name: string, sources: NativeConfigSource[]): NativeSkillState {
  let result: NativeSkillState = 'inherit';
  for (const source of sources) {
    const value = overrides(source)[name];
    if (typeof value === 'string' && claudeSkillStates.includes(value as NativeSkillState))
      result = value as NativeSkillState;
  }
  return result;
}
export async function changeClaudeSkill(name: string, input: NativeSkillChangeInput, sources: NativeConfigSource[]) {
  const source = sources.find((item) => item.scope === input.scope);
  if (!source || !input.value || !claudeSkillStates.includes(input.value))
    throw new NativeManagementError('unsupported_action');
  await writeNativeConfigJson(source, (config) => {
    if (
      config.skillOverrides !== undefined &&
      (!config.skillOverrides || typeof config.skillOverrides !== 'object' || Array.isArray(config.skillOverrides))
    )
      throw new NativeManagementError('unsupported_action');
    const values = Object.assign(Object.create(null) as Record<string, unknown>, overrides(source));
    if (input.value === 'inherit') delete values[name];
    else values[name] = input.value;
    config.skillOverrides = values;
  });
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
  if ((await readConfigFile(rootSkill)).revision !== 'missing')
    skills.push(pluginSkill(plugin, rootSkill, plugin.id.split('@')[0]!));
  const directory = path.join(plugin.installPath, 'skills');
  if (!(await inspectDirectory(directory))) return skills;
  const handle = await opendir(directory);
  let remaining = 4096;
  for await (const entry of handle) {
    if (--remaining < 0) throw new NativeManagementError('native_unavailable');
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name, 'SKILL.md');
    if (!(await inspectDirectory(path.dirname(file)))) continue;
    if ((await readConfigFile(file)).revision === 'missing') continue;
    skills.push(pluginSkill(plugin, file, `${plugin.id.split('@')[0]}:${entry.name}`));
  }
  return skills;
}
function pluginSkill(plugin: InstalledPlugin, file: string, name: string): NativeSkill {
  return {
    name,
    path: file,
    scope: plugin.scope,
    enabled: plugin.enabled,
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
export async function readClaudeInstalledSkills(context: SkillContext): Promise<NativeSkill[]> {
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
