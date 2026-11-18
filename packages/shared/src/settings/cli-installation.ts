import { z } from 'zod';
import type { AgentKind } from '../conversation/agents';

export const CLI_INSTALL_RELEASE_TTL_MS = 15 * 60_000;

export const CliInstallInputSchema = z.strictObject({
  action: z.enum(['install', 'update', 'repair']),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CliInstallInput = z.infer<typeof CliInstallInputSchema>;
export type CliInstallSource = 'npm' | 'native' | 'unknown' | 'missing';
export type CliInstallPhase =
  'idle' | 'checking' | 'installing' | 'updating' | 'repairing' | 'verifying' | 'succeeded' | 'failed';
export type CliInstallationStatus = {
  agent: AgentKind;
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  source: CliInstallSource;
  updateAvailable: boolean;
  canInstall: boolean;
  canUpdate: boolean;
  canRepair?: boolean;
  checkedAt: number | null;
  revision: string;
  phase: CliInstallPhase;
  operationId: string | null;
  message: string | null;
  guideUrl: string;
};
