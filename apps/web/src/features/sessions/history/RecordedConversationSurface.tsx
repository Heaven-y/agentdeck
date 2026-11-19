import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ConversationSurface, type ConversationError, type ImageReader } from '../../conversation/ConversationSurface';
import { readNativeImage, unavailableImage, type NativeMediaSource } from '../../conversation/media/native-media';

const errorKey = ({ id, message }: ConversationError) => JSON.stringify([id, message]);

export function RecordedConversationSurface({ source, children }: { source?: NativeMediaSource; children: ReactNode }) {
  const [dismissedErrors, setDismissedErrors] = useState<ReadonlySet<string>>(() => new Set());
  const { workspaceId, agent, sessionId, subagentId } = source ?? {};
  const readImage = useCallback<ImageReader>(
    async (attachment, signal) => {
      if (attachment.kind !== 'native-image' || !workspaceId || !agent || !sessionId) throw new Error(unavailableImage);
      return readNativeImage({ workspaceId, agent, sessionId, subagentId }, attachment.locator, signal);
    },
    [workspaceId, agent, sessionId, subagentId],
  );
  const surface = useMemo(
    () => ({
      isErrorDismissed: (item: ConversationError) => dismissedErrors.has(errorKey(item)),
      readImage,
      dismissError: (item: ConversationError) => setDismissedErrors((items) => new Set(items).add(errorKey(item))),
    }),
    [dismissedErrors, readImage],
  );
  return <ConversationSurface.Provider value={surface}>{children}</ConversationSurface.Provider>;
}
