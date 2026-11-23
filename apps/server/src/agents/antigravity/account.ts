import type { AntigravityAccount } from '@agentdeck/shared/settings';
import { z } from 'zod';
import { resolveLocalCommand } from '../../platform/process/executable';
import { startManagementBackend } from './management/management-process';
import { withAntigravityDiscoveryProfile } from './models/discovery-profile';
import { readAntigravityConnection } from './models/model-catalog';
import { antigravityAccountReadEnvironment } from './run/process-environment';

const AccountStatus = z.object({
  userStatus: z.object({ email: z.email().max(254), isAdc: z.literal(false).optional() }),
});

export function antigravityAccountFromStatus(value: unknown): AntigravityAccount {
  const status = AccountStatus.safeParse(value);
  return status.success ? { email: status.data.userStatus.email } : {};
}

/** 仅从原生状态读取邮箱，不主动调用 authenticate 或读取凭据。 */
export async function readAntigravityAccount({
  env = process.env,
  signal: request,
}: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<AntigravityAccount> {
  const deadline = AbortSignal.timeout(12_000);
  const signal = request ? AbortSignal.any([request, deadline]) : deadline;
  try {
    if (signal.aborted || (await readAntigravityConnection({ env })) !== 'account') return {};
    const command = resolveLocalCommand('agy', env);
    const account = await withAntigravityDiscoveryProfile(
      {},
      antigravityAccountReadEnvironment(env),
      async (profile) => {
        const backend = await startManagementBackend({
          cwd: profile.root,
          env: profile.env,
          geminiDir: profile.gemini,
          command,
          signal,
          waitForSessionList: true,
        });
        try {
          return antigravityAccountFromStatus(await backend.request('GetUserStatus', {}, 'page'));
        } finally {
          await backend.close();
        }
      },
    );
    return account.email && !signal.aborted && (await readAntigravityConnection({ env })) === 'account' ? account : {};
  } catch {
    return {};
  }
}
