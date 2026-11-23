import { z } from 'zod';
import { useChat } from '../chat/state/chat-store';
import { currentPluginSession } from './use-plugin-pages';
import type { WorkbenchPluginSessionContext } from '@agentdeck/shared/plugins';

const DraftInput = z.strictObject({ text: z.string().max(60_000), revision: z.string().uuid() });
/** revision 绑定读到的会话与草稿；异步插件不能覆盖用户后续输入。 */
export function createPluginUiServices() {
  let snapshot: { text: string; conversationId: string; revision: string } | undefined;
  return {
    session: (): WorkbenchPluginSessionContext => currentPluginSession(),
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
