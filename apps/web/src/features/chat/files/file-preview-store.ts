import { create } from 'zustand';
import type { FileLocation } from '../../conversation/files/file-links';

export type FilePreviewTarget = FileLocation & { workspaceId: string; conversationId: string };
export const useFilePreview = create<{
  target?: FilePreviewTarget;
  open(target: FilePreviewTarget): void;
  close(): void;
}>((set) => ({
  open: (target) => set({ target }),
  close: () => set({ target: undefined }),
}));
