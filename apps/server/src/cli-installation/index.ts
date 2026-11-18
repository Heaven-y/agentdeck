import type { CliInstallationBackend } from './types';
import { protectedMutation } from './transaction/protection';
import { transactNpm } from './npm/npm-transaction';
import { nativeProtectionPaths, cleanupNativeHistory } from './native/native-installation';
import { assertInstallationIdle } from './transaction/occupancy';
import type { BackendOptions } from './backend-support';
import { inspectInstallation } from './discovery/discovery';
import { latestRelease } from './discovery/catalog';
import { executeInstallation } from './installer';
import { checkedInstallation, installationContext } from './discovery/installation-context';

export { BackendError } from './backend-support';
export type { BackendOptions } from './backend-support';

export function createCliInstallationBackend(options: BackendOptions = {}): CliInstallationBackend {
  const context = installationContext(options);
  return {
    inspect: (agent, signal) => inspectInstallation(context, agent, signal),
    latest: (installation, signal) => latestRelease(context, installation, signal),
    async transact(installation, version, signal, verify) {
      const op = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
      const current = await checkedInstallation(context, installation, op);
      if (current.npm)
        return transactNpm(context, current, {
          version,
          signal: op,
          recheck: async () => {
            await checkedInstallation(context, current, op);
          },
          verify,
        });
      const paths = await nativeProtectionPaths(context, current, version);
      if (paths.length) await assertInstallationIdle(context, paths, op);
      op.throwIfAborted();
      const notice = await protectedMutation(
        paths,
        async () => {
          await executeInstallation(context, current, version, op);
          await verify();
        },
        async () => {
          await checkedInstallation(context, current, op);
          op.throwIfAborted();
        },
      );
      try {
        await cleanupNativeHistory(context, current);
      } catch {
        return 'CLI 已验证可用，部分旧文件仍被占用，可在之后清理。';
      }
      return notice;
    },
  };
}
