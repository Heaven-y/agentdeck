import type { SshConsoleDeps, SshConsoleService } from './types';
import { createConsoleAccess } from './access';
import { createConsoleFiles } from './files';
import { createConsoleTerminals } from './terminal/terminals';
import { createConsoleMetrics } from './monitoring/metrics';
import { createConsoleSlurm } from './jobs/slurm';
export type { SshConsoleDeps, SshConsoleService } from './types';

export function createSshConsoleService(deps: SshConsoleDeps): SshConsoleService {
  const access = createConsoleAccess(deps);
  const files = createConsoleFiles(deps.pool, access);
  const terminals = createConsoleTerminals(deps.pool, access);
  const metrics = createConsoleMetrics(deps.pool, access);
  const slurm = createConsoleSlurm(deps.pool, access);
  return {
    ...metrics,
    ...files,
    ...terminals,
    jobs: slurm.read,
    dispose() {
      terminals.dispose();
      slurm.dispose();
      access.dispose();
      metrics.dispose();
    },
  };
}
