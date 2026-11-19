import path from 'node:path';
import { assertDirectoryUnchanged, inspectDirectory, readConfigFile } from '../../../platform/files/safe-file';
import { resolveLocalCommand } from '../../../platform/process/executable';
import { NativeResourceError } from '../../common/configuration/errors';
import { NativeManagementError } from '../../../native-management/errors';
import {
  readNativeConfigSource,
  writeNativeConfigJson,
  type NativeConfigSource,
} from '../../../native-management/config';
import { verifiedSkillVersion } from '../../../native-management/version';
import {
  enabledState,
  nativeSkillPathKey,
  type NativeSkill,
  type SkillAdapter,
  type SkillContext,
  type SkillRecord,
  type SkillStateChange,
  type SkillVisibility,
} from '../../../native-management/skills/types';
import { resourcePathKey } from '../../common/configuration/resources';
import { discoverAntigravityCommands } from '../commands/commands';

async function readNative({ project, env, homeDir }: SkillContext): Promise<NativeSkill[]> {
  const entries = await discoverAntigravityCommands(project?.dir ?? homeDir, { env, homeDir });
  return entries
    .filter((entry) => entry.kind === 'skill')
    .map((entry) => {
      const file = entry.invocation?.kind === 'skill' ? entry.invocation.path : undefined;
      return {
        name: entry.name,
        path: file,
        // 命令的 available 反映斜杠调用；清单的 exclude 决定路径是否进入原生技能目录。
        enabled: file || entry.available ? true : undefined,
        origin: entry.name.includes(':') ? 'plugin' : undefined,
      };
    });
}

async function readManifests({ homeDir, project }: SkillContext) {
  const sources = [await readNativeConfigSource(path.join(homeDir, '.gemini/config/skills.json'), 'user')];
  if (project) sources.push(await readNativeConfigSource(path.join(project.dir, '.agents/skills.json'), 'project'));
  return sources;
}

/** 只给经核实的标准根分配清单，不用资源的展示作用域猜测写入位置。 */
function manifestScope({ homeDir, project }: SkillContext, file: string) {
  const root = resourcePathKey(path.dirname(path.dirname(file)));
  if (root === resourcePathKey(path.join(homeDir, '.gemini/config/skills'))) return 'user';
  if (project && root === resourcePathKey(path.join(project.dir, '.agents/skills'))) return 'project';
}

/** 复杂清单交给原生处理，表单只修改与目录名精确匹配的顶层排除项。 */
function simpleManifest({ data }: NativeConfigSource) {
  return (
    !data.inherits &&
    !data.entries &&
    (data.exclude === undefined ||
      (Array.isArray(data.exclude) && data.exclude.every((item) => typeof item === 'string' && /^[\w-]+$/.test(item))))
  );
}
function excludes(source: NativeConfigSource, selector: string) {
  return Array.isArray(source.data.exclude) && source.data.exclude.includes(selector);
}
const directoryName = (file: string) => path.basename(path.dirname(file));

async function skillFileExists(file: string) {
  const parents = await inspectDirectory(path.dirname(file));
  if (!parents) return false;
  const { revision } = await readConfigFile(file);
  await assertDirectoryUnchanged(parents);
  return revision !== 'missing';
}

function selectorFor(record: SkillRecord) {
  const file = record.file ?? record.nativeSkill?.path;
  return file ? directoryName(file) : record.entry.name;
}
function restrictConflicts(records: SkillRecord[]) {
  const counts = new Map<string, number>();
  for (const record of records) {
    const selector = selectorFor(record);
    counts.set(selector, (counts.get(selector) ?? 0) + 1);
  }
  for (const record of records) {
    if (counts.get(selectorFor(record))! < 2) continue;
    record.entry.actions.states = [];
    record.entry.actions.stateScopes = [];
    record.entry.unavailableReason ??= '存在同名来源，请从原生清单明确管理影响范围。';
  }
}

function noToggle(state: SkillVisibility['state'], unavailableReason?: string): SkillVisibility {
  return { state, states: [], scopes: [], unavailableReason };
}
function otherExcludes(sources: NativeConfigSource[], source: NativeConfigSource | undefined, selector: string) {
  return sources.some((item) => item !== source && excludes(item, selector));
}
function manifestChange(
  context: SkillContext,
  { file, scope, value }: SkillStateChange,
  sources: NativeConfigSource[],
) {
  const selector = directoryName(file);
  const source = sources.find((item) => item.scope === scope);
  if (
    !source ||
    scope !== manifestScope(context, file) ||
    !/^[\w-]+$/.test(selector) ||
    (value !== 'enabled' && value !== 'disabled') ||
    !sources.every(simpleManifest) ||
    otherExcludes(sources, source, selector)
  )
    throw new NativeManagementError('unsupported_action');
  return { source, selector, disabled: value === 'disabled' };
}
type ManifestChange = ReturnType<typeof manifestChange>;
type ManifestRevisions = Map<NativeConfigSource['scope'], string>;
function revisionsMatch(
  sources: NativeConfigSource[],
  expected: ManifestRevisions,
  skip?: NativeConfigSource['scope'],
) {
  return sources.every((item) => item.scope === skip || expected.get(item.scope) === item.revision);
}

async function matchesDirectory(
  after: NativeSkill[],
  { file, name, nativeSkill }: SkillStateChange,
  { selector, disabled }: ManifestChange,
) {
  const fileKey = resourcePathKey(file);
  const matches = after.filter((skill) => nativeSkillPathKey(skill.path) === fileKey);
  if (!disabled) return matches.length === 1 && matches[0]?.enabled === true && !matches[0].origin;
  // 命令目录按名称择一展示。同名换源或文件自行消失都不是排除生效的证据。
  if (
    matches.length ||
    after.some(
      (skill) => skill.name === (nativeSkill?.name ?? name) || (skill.path && directoryName(skill.path) === selector),
    )
  )
    return false;
  return skillFileExists(file);
}
function matchesWrittenManifest(manifests: NativeConfigSource[], target: ManifestChange, expected: ManifestRevisions) {
  const written = manifests.find((item) => item.scope === target.source.scope);
  return (
    !!written &&
    written.revision !== 'missing' &&
    simpleManifest(written) &&
    excludes(written, target.selector) === target.disabled &&
    revisionsMatch(manifests, expected, written.scope)
  );
}

export const antigravitySkills: SkillAdapter = {
  description: '标准目录的原生清单按目录名排除；其他自有技能只提供文件操作。',
  readNative,
  readConfig: readManifests,
  verifyVersion: (context) => verifiedSkillVersion(context, '1.5.3', (env) => resolveLocalCommand('agy', env)),
  localOrigin: (resource) => (resource.displayPath.startsWith('.agents/plugins/') ? 'plugin' : undefined),
  visibility({ context, file, nativeSkill, nativeAvailable, sources }) {
    if (!nativeAvailable) return noToggle('unknown');
    const nativeState = enabledState(nativeSkill);
    const scope = manifestScope(context, file);
    if (!scope) return noToggle(nativeState, '此目录未核实可用清单开关。');
    const selector = directoryName(file);
    if (!sources.every(simpleManifest) || !/^[\w-]+$/.test(selector))
      return noToggle(nativeState, '此技能受继承或路径过滤清单管理，请从原文入口编辑。');
    const source = sources.find((item) => item.scope === scope);
    const state = !nativeSkill && sources.some((item) => excludes(item, selector)) ? 'disabled' : nativeState;
    if (otherExcludes(sources, source, selector)) return noToggle(state, '此目录被其他作用域排除，请从原文入口处理。');
    if (!source || state === 'unknown') return noToggle(state);
    return { state, states: ['enabled', 'disabled'], scopes: [scope] };
  },
  restrictConflicts,
  async changeState(context, change, sources) {
    const target = manifestChange(context, change, sources);
    const { source, selector, disabled } = target;
    const expectedRevisions = new Map(sources.map((item) => [item.scope, item.revision]));
    if (!revisionsMatch(await readManifests(context), expectedRevisions))
      throw new NativeResourceError('revision_conflict');
    await writeNativeConfigJson(source, (config) => {
      const exclude = (config.exclude ?? []) as string[];
      config.exclude = disabled ? [...new Set([...exclude, selector])] : exclude.filter((item) => item !== selector);
    });
    const confirmed = await this.readNative(context)
      .then(
        async (after) =>
          matchesWrittenManifest(await readManifests(context), target, expectedRevisions) &&
          matchesDirectory(after, change, target),
      )
      .catch(() => false);
    if (!confirmed) throw new NativeManagementError('result_unconfirmed');
  },
};
