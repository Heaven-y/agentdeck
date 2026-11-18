import type { ResourceContext } from '../../common/configuration/resources';
import { sameSessionDirectory } from '../../common/history/session-scope';
import { arrayResult } from '../../../native-management/plugins/plugin-utils';
import { string } from '../../../native-management/plugins/plugin-types';

/** Claude 列表跨项目返回安装记录；项目/个人项目项必须核对原生 projectPath。 */
export async function claudePluginRecords(context: ResourceContext, value: unknown) {
  const selected: Array<Record<string, unknown>> = [];
  for (const record of arrayResult(value)) {
    if (!['project', 'local'].includes(string(record.scope))) {
      selected.push(record);
      continue;
    }
    if (
      context.project &&
      typeof record.projectPath === 'string' &&
      (await sameSessionDirectory(context.project.dir, record.projectPath))
    )
      selected.push(record);
  }
  return selected;
}
