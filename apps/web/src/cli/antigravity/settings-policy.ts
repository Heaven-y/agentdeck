import type { ModelSettingField } from '@agentdeck/shared/settings';
import type { ModelSettingsDraft } from '../shared/settings-types';
const connectionFields = ['baseUrl', 'apiKey', 'displayName', 'contextWindow'];
const orchestratorFields = ['orchestratorPlanner', 'orchestratorExecutor'];
export function antigravitySettingsFields(fields: ModelSettingField[], draft: ModelSettingsDraft) {
  const connection = draft.modelProvider ?? fields.find((field) => field.key === 'modelProvider')?.value;
  return fields.filter(
    (field) =>
      (connection === 'gemini' || !connectionFields.includes(field.key)) &&
      (connection === '' || !orchestratorFields.includes(field.key)),
  );
}
export function clearAntigravityConnection(draft: ModelSettingsDraft, field: string) {
  if (field === 'modelProvider') for (const key of [...connectionFields, ...orchestratorFields]) delete draft[key];
}
