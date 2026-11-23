import type { WorkbenchPluginEvent, WorkbenchPluginSessionContext } from '@agentdeck/shared/plugins';
import type { ChatState } from '../chat/state/chat-state';

function sessions(state: ChatState) {
  return new Map([state, ...Object.values(state.background)].map((view) => [view.conversationId, view]));
}
const context = (view: WorkbenchPluginSessionContext): WorkbenchPluginSessionContext => ({
  conversationId: view.conversationId,
  workspaceId: view.workspaceId,
  agent: view.agent,
  sessionId: view.sessionId,
  running: view.running,
});
/** 当前与后台会话使用同一份状态；切页本身不会伪造轮次开始或结束。 */
export function pluginEvents(state: ChatState, previous: ChatState): WorkbenchPluginEvent[] {
  const events: WorkbenchPluginEvent[] = [];
  if (
    state.conversationId !== previous.conversationId ||
    state.workspaceId !== previous.workspaceId ||
    state.agent !== previous.agent ||
    state.sessionId !== previous.sessionId
  )
    events.push({ name: 'context.changed', session: context(state) });
  const before = sessions(previous);
  for (const [id, view] of sessions(state)) {
    const prior = before.get(id);
    if (prior && prior.running !== view.running)
      events.push({ name: view.running ? 'turn.started' : 'turn.completed', session: context(view) });
  }
  return events;
}
