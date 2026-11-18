import { ProductSettingsSchema, type ProductSettings } from '@agentdeck/shared/settings';

export type ProductSettingsDraft = {
  defaultAgent: ProductSettings['defaultAgent'];
  resourceInterval: string;
  resourceTimeout: string;
  spotlight?: ProductSettings['spotlight'];
  sessionLimit: string;
  widthPreset: ProductSettings['appearance']['width']['preset'];
  customWidth: string;
};
export const settingsDraft = (settings: ProductSettings): ProductSettingsDraft => ({
  defaultAgent: settings.defaultAgent,
  resourceInterval: String(settings.resources.intervalSeconds),
  resourceTimeout: String(settings.resources.timeoutSeconds),
  spotlight: settings.spotlight,
  sessionLimit: String(settings.appearance.sessionLimit),
  widthPreset: settings.appearance.width.preset,
  customWidth: String(settings.appearance.width.custom),
});
export function parseSettingsDraft(draft: ProductSettingsDraft) {
  return ProductSettingsSchema.safeParse({
    defaultAgent: draft.defaultAgent,
    spotlight: draft.spotlight,
    resources: { intervalSeconds: Number(draft.resourceInterval), timeoutSeconds: Number(draft.resourceTimeout) },
    appearance: {
      sessionLimit: Number(draft.sessionLimit),
      width: { preset: draft.widthPreset, custom: Number(draft.customWidth) },
    },
  });
}
const fieldPaths: Record<string, keyof ProductSettingsDraft> = {
  defaultAgent: 'defaultAgent',
  'resources.intervalSeconds': 'resourceInterval',
  'resources.timeoutSeconds': 'resourceTimeout',
  'appearance.sessionLimit': 'sessionLimit',
  'appearance.width.custom': 'customWidth',
};
export function draftErrors(draft: ProductSettingsDraft): Partial<Record<keyof ProductSettingsDraft, string>> {
  const result = parseSettingsDraft(draft);
  if (result.success) return {};
  const errors: Partial<Record<keyof ProductSettingsDraft, string>> = {};
  for (const issue of result.error.issues) {
    const field = fieldPaths[issue.path.slice(0, 2).join('.')];
    if (field) errors[field] = '请按字段提示填写有效值。';
  }
  return errors;
}
