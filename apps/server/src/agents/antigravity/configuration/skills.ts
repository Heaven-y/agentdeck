import path from 'node:path';
import type { NativeSkillChangeInput } from '@agentdeck/shared/settings';
import { NativeManagementError } from '../../../native-management/errors';
import { readNativeConfigSource, writeNativeConfigJson } from '../../../native-management/config';
import type { NativeConfigSource } from '../../../native-management/config';
import type { SkillContext } from '../../../native-management/skills/types';

export async function antigravitySkillConfig(context: SkillContext) {
  const sources = [await readNativeConfigSource(path.join(context.homeDir, '.gemini/config/skills.json'), 'user')];
  if (context.project)
    sources.push(await readNativeConfigSource(path.join(context.project.dir, '.agents/skills.json'), 'project'));
  return sources;
}
/** 复杂继承、路径过滤及模式匹配交给原生；表单仅按安全枚举的目录身份修改顶层排除。 */
export function simpleSkillManifest(source: NativeConfigSource) {
  return (
    !source.data.inherits &&
    !source.data.entries &&
    (source.data.exclude === undefined ||
      (Array.isArray(source.data.exclude) &&
        source.data.exclude.every((item) => typeof item === 'string' && /^[\w-]+$/.test(item))))
  );
}
export function antigravitySkillState(selector: string, sources: NativeConfigSource[]) {
  return sources.some((source) => Array.isArray(source.data.exclude) && source.data.exclude.includes(selector))
    ? ('disabled' as const)
    : ('enabled' as const);
}
export async function changeAntigravitySkill(
  selector: string,
  input: NativeSkillChangeInput,
  sources: NativeConfigSource[],
) {
  const source = sources.find((item) => item.scope === input.scope);
  if (!source || !simpleSkillManifest(source) || !['enabled', 'disabled'].includes(input.value ?? ''))
    throw new NativeManagementError('unsupported_action');
  if (
    input.value === 'enabled' &&
    sources.some((item) => item !== source && Array.isArray(item.data.exclude) && item.data.exclude.includes(selector))
  )
    throw new NativeManagementError('unsupported_action');
  await writeNativeConfigJson(source, (config) => {
    const exclude = (config.exclude ?? []) as string[];
    config.exclude =
      input.value === 'disabled' ? [...new Set([...exclude, selector])] : exclude.filter((item) => item !== selector);
  });
}
