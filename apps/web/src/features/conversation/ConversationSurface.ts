import { createContext, useContext, type ComponentType } from 'react';
import type { MessageAttachment } from '@agentdeck/shared/conversation';
import type { ChatItem } from './model/conversation-events';

export type ConversationError = Extract<ChatItem, { kind: 'error' }>;
export type ConversationControl = Extract<
  ChatItem,
  { kind: 'permission' | 'interaction' | 'async-question' | 'fork-point' }
>;
export function isConversationControl(item: ChatItem): item is ConversationControl {
  return (
    item.kind === 'permission' ||
    item.kind === 'interaction' ||
    item.kind === 'async-question' ||
    item.kind === 'fork-point'
  );
}

export type ImageReader = (attachment: MessageAttachment, signal: AbortSignal) => Promise<Blob>;

type Surface = {
  Control?: ComponentType<{ item: ConversationControl }>;
  readImage?: ImageReader;
  dismissError?(item: ConversationError): void;
  isErrorDismissed?(item: ConversationError): boolean;
};

/** 共享展示不推断当前会话，也不读取实时对话状态；由宿主明确提供权限与来源。 */
export const ConversationSurface = createContext<Surface>({});
export const useConversationSurface = () => useContext(ConversationSurface);
