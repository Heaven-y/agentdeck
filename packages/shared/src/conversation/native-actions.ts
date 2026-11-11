import { z } from 'zod';
import { NativeSessionIdSchema } from './agents';
export const NativeActionSchema = z.enum(['rewind-files', 'revert-history']);
export type NativeAction = z.infer<typeof NativeActionSchema>;
export type NativeActionCandidate = { id: string; label: string };
export type NativeActionCatalog = {
  action: NativeAction;
  available: boolean;
  reason?: string;
  candidates: NativeActionCandidate[];
  revision: string;
};
export const NativeActionPreviewSchema = z.strictObject({
  action: NativeActionSchema,
  pointId: NativeSessionIdSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const NativeActionExecuteSchema = z.strictObject({ token: z.uuid(), confirmed: z.literal(true) });
export type NativeActionPreview = {
  token: string;
  action: NativeAction;
  pointId: string;
  files: string[];
  removesTurns?: number;
  expiresAt: number;
  notice: string;
};
export type NativeActionResult = { status: 'completed' | 'partial' | 'unknown'; message: string };
