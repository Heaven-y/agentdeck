import { CodexError, type RecordValue } from './types';
import { list, record } from './types';
import type { CodexClient } from './client';

export function codexCollaboration(
  mode: 'default' | 'plan' | undefined,
  config: { model?: string; effort?: string },
): RecordValue {
  if (!mode) return {};
  if (!config.model) throw new CodexError('原生尚未确认模型，无法设置协作模式。');
  return {
    collaborationMode: {
      mode,
      settings: { model: config.model, reasoning_effort: config.effort ?? null, developer_instructions: null },
    },
  };
}
export function codexReviewTarget(instructions: string): RecordValue {
  if (Buffer.byteLength(instructions) > 65_536) throw new CodexError('审查说明过长，请缩短后重试。');
  return instructions.trim() ? { type: 'custom', instructions: instructions.trim() } : { type: 'uncommittedChanges' };
}
export async function verifyCodexMode(client: Pick<CodexClient, 'request'>, mode?: 'default' | 'plan'): Promise<void> {
  if (!mode) return;
  const result = await client.request('collaborationMode/list', {});
  if (!list(result.data).some((value) => record(value).mode === mode))
    throw new CodexError('当前原生版本未提供所选协作模式。');
}
