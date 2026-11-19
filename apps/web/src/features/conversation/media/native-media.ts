import type { AgentKind, NativeMediaLocator } from '@agentdeck/shared/conversation';

export type NativeMediaSource = { workspaceId: string; agent: AgentKind; sessionId: string; subagentId?: string };
export const unavailableImage = '这张原生图片当前不可读取。';

/** 定位符只是会话内的消息坐标，不能把请求切到宿主之外的会话。 */
export async function readNativeImage(source: NativeMediaSource, locator: NativeMediaLocator, signal: AbortSignal) {
  if (source.sessionId !== locator.sessionId || source.subagentId !== locator.subagentId)
    throw new Error(unavailableImage);
  const query = new URLSearchParams({
    agent: source.agent,
    messageId: locator.messageId,
    index: String(locator.index),
    kind: locator.kind,
  });
  if (source.subagentId) query.set('subagentId', source.subagentId);
  if (source.agent === 'codex' && !source.subagentId && locator.turnId) query.set('turnId', locator.turnId);
  const url = `/api/workspaces/${encodeURIComponent(source.workspaceId)}/sessions/${encodeURIComponent(source.sessionId)}/media?${query}`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(unavailableImage);
  return response.blob();
}
