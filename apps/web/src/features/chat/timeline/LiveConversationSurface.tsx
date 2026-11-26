import { useCallback, useMemo, type ReactNode } from 'react';
import {
  ConversationSurface,
  type ConversationControl,
  type ConversationError,
  type ImageReader,
} from '../../conversation/ConversationSurface';
import { readNativeImage, unavailableImage } from '../../conversation/media/native-media';
import { useChat } from '../state/chat-store';
import { AsyncQuestionCard } from '../interactions/AsyncQuestionCard';
import { InteractionCard } from '../interactions/InteractionCard';
import { PermissionCard } from '../interactions/PermissionCard';
import { SessionForkPoint } from '../references/SessionForkPoint';
import { attachmentApi } from '../composer/attachment-api';
import { useFilePreview } from '../files/file-preview-store';
import type { FileLocation } from '../../conversation/files/file-links';

function LiveControl({ item }: { item: ConversationControl }) {
  switch (item.kind) {
    case 'async-question':
      return <AsyncQuestionCard item={item} />;
    case 'interaction':
      return <InteractionCard item={item} />;
    case 'permission':
      return <PermissionCard item={item} />;
    case 'fork-point':
      return <SessionForkPoint pointId={item.pointId} />;
  }
}

export function LiveConversationSurface({ children }: { children: ReactNode }) {
  const conversationId = useChat((s) => s.conversationId);
  const workspaceId = useChat((s) => s.workspaceId);
  const agent = useChat((s) => s.agent);
  const sessionId = useChat((s) => s.sessionId);
  const connection = useChat((s) => s.connection);
  const identity = useChat((s) => s.attachmentIdentity)();
  const token = identity?.token;
  const instanceId = identity?.instanceId;
  const readImage = useCallback<ImageReader>(
    async (attachment, signal) => {
      if (attachment.kind === 'native-image') {
        if (!workspaceId || !sessionId) throw new Error(unavailableImage);
        return readNativeImage({ workspaceId, agent, sessionId }, attachment.locator, signal);
      }
      if (!workspaceId || connection !== 'open' || !token || !instanceId) throw new Error('请等待连接恢复后查看图片。');
      return attachmentApi.preview(
        { workspaceId, agent, conversationId, sessionId },
        { token, instanceId },
        attachment,
        signal,
      );
    },
    [workspaceId, agent, sessionId, conversationId, connection, token, instanceId],
  );
  const surface = useMemo(
    () => ({
      Control: LiveControl,
      readImage,
      openFile: workspaceId
        ? (location: FileLocation) => {
            useChat.getState().inspectItem();
            useFilePreview.getState().open({ ...location, workspaceId, conversationId });
          }
        : undefined,
      dismissError: (item: ConversationError) => useChat.getState().dismissNotice(item.id, conversationId),
    }),
    [readImage, conversationId, workspaceId],
  );
  return <ConversationSurface.Provider value={surface}>{children}</ConversationSurface.Provider>;
}
