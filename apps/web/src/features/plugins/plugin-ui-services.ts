import { z } from 'zod';
import { useChat, resumePluginConversation } from '../chat/state/chat-store';
import { conversationViews } from '../chat/state/conversations';
import { currentPluginSession } from './use-plugin-pages';
import type { WorkbenchPluginSessionContext } from '@agentdeck/shared/plugins';

const DraftInput = z.strictObject({ text: z.string().max(60_000), revision: z.string().uuid() });
const ResumeInput = z.strictObject({
  conversationId: z.string().uuid(),
  requestId: z.string().uuid(),
  text: z.string().trim().min(1).max(60_000),
});
const openedTabs = new Map(useChat.getState().tabIds.map((id) => [id, crypto.randomUUID()]));
useChat.subscribe((state, previous) => {
  if (state.tabIds === previous.tabIds) return;
  for (const id of openedTabs.keys()) if (!state.tabIds.includes(id)) openedTabs.delete(id);
  for (const id of state.tabIds) if (!openedTabs.has(id)) openedTabs.set(id, crypto.randomUUID());
});
/** revision 绑定读到的会话与草稿；异步插件不能覆盖用户后续输入。 */
export function createPluginUiServices() {
  let snapshot: { text: string; conversationId: string; revision: string } | undefined;
  const delivered = new Set<string>();
  return {
    session: (): WorkbenchPluginSessionContext => currentPluginSession(),
    sessions: (): WorkbenchPluginSessionContext[] => {
      const state = useChat.getState();
      return conversationViews(state)
        .filter((view) => state.tabIds.includes(view.conversationId))
        .map(({ conversationId, workspaceId, agent, sessionId, running }) => ({
          conversationId,
          openId: openedTabs.get(conversationId),
          workspaceId,
          agent,
          sessionId,
          running,
        }));
    },
    resume(input: unknown) {
      const value = ResumeInput.parse(input);
      const key = `${value.conversationId}:${value.requestId}`;
      if (delivered.has(key)) return { accepted: true };
      const accepted = resumePluginConversation(value);
      if (accepted) delivered.add(key);
      return { accepted };
    },
    readDraft(expectedConversation?: string) {
      const { draft, conversationId } = useChat.getState();
      if (expectedConversation && expectedConversation !== conversationId)
        throw new Error('会话已切换，请在目标会话中重新操作。');
      snapshot = { text: draft, conversationId, revision: crypto.randomUUID() };
      return { text: draft, conversationId, revision: snapshot.revision };
    },
    writeDraft(input: unknown) {
      const value = DraftInput.parse(input);
      const state = useChat.getState();
      if (
        !snapshot ||
        snapshot.revision !== value.revision ||
        snapshot.conversationId !== state.conversationId ||
        snapshot.text !== state.draft
      )
        throw new Error('输入框已变化，请重新读取后再修改。');
      state.setDraft(value.text);
      snapshot = undefined;
      return null;
    },
  };
}
export type PluginUiServices = ReturnType<typeof createPluginUiServices>;
