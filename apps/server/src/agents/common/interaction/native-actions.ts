import type { NativeActionCandidate, NativeActionResult } from '@agentdeck/shared/conversation';
export type NativeActionState = { candidates: NativeActionCandidate[]; revision: string };
export type NativeActionInspection = { files: string[]; removesTurns?: number; signature: string };
export type NativeActionBackend = {
  read(): Promise<NativeActionState>;
  inspect(pointId: string): Promise<NativeActionInspection>;
  execute(pointId: string): Promise<NativeActionResult>;
  close(): Promise<void>;
};
