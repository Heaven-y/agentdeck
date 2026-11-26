import { UsageReadError } from '../agents/common/usage/contracts';
import { SessionError } from '../agents/errors';
import { randomUUID } from 'node:crypto';
import { AGENT_KINDS, type AgentKind, type SessionSummary } from '@agentdeck/shared/conversation';
import type { UsageQuery, UsageReport, UsageSyncStatus } from '@agentdeck/shared/usage';
import type { UsageProvider, UsageScope } from '../agents/common/usage/contracts';
import type { SessionsService } from '../sessions/service';
import type { WorkspaceStore } from '../workspaces/store';
import { createUsageStore } from './store';
import { officialPrices } from './pricing';
import { aggregateUsage } from './aggregate';

type Scan = {
  id: string;
  agentIndex: number;
  archived: boolean;
  cursor?: string;
  queue: SessionSummary[];
  source?: UsageScope;
  sourceCursor?: string;
  scanned: number;
  updated: number;
  errors: UsageSyncStatus['errors'];
};
export function createUsageService(deps: {
  configDir: string;
  providers: Record<AgentKind, UsageProvider>;
  sessions: Pick<SessionsService, 'page' | 'resolveReadScope'>;
  workspaces: Pick<WorkspaceStore, 'list' | 'get'>;
  acquireWorkspace?(id: string): () => void;
}) {
  const store = createUsageStore(deps.configDir);
  let scan: Scan | undefined,
    pending: Promise<void> | undefined,
    last: UsageSyncStatus = { running: false, scanned: 0, updated: 0, errors: [] };
  function status(): UsageSyncStatus {
    return scan
      ? { id: scan.id, running: true, scanned: scan.scanned, updated: scan.updated, errors: scan.errors }
      : last;
  }
  function failure(agent: AgentKind, error: unknown) {
    if (!scan!.errors.some((e) => e.agent === agent))
      scan!.errors.push({
        agent,
        message:
          error instanceof UsageReadError || error instanceof SessionError
            ? error.message
            : '部分原生记录未能同步，请稍后重试。',
      });
  }
  async function discover(signal?: AbortSignal) {
    const job = scan!,
      agent = AGENT_KINDS[job.agentIndex]!;
    try {
      const page = await deps.sessions.page(
        { agent, scope: job.archived ? 'archived' : 'active', reader: job.id, cursor: job.cursor },
        signal,
      );
      job.queue = page.items.filter((item) => item.projectId !== null);
      job.cursor = page.nextCursor;
    } catch (error) {
      signal?.throwIfAborted();
      failure(agent, error);
      job.cursor = undefined;
    }
    if (!job.cursor) {
      if (job.archived) {
        job.agentIndex++;
        job.archived = false;
      } else job.archived = true;
    }
  }
  function acquire(id: string) {
    return deps.acquireWorkspace ? deps.acquireWorkspace(id) : () => {};
  }
  async function readSource(signal?: AbortSignal) {
    const job = scan!,
      source = job.source!;
    const release = acquire(source.projectId);
    try {
      const current = await deps.workspaces.get(source.projectId);
      if (!current || current.dir !== source.projectDir) throw new UsageReadError('工作区目录已变化，请重新同步。');
      const page = await deps.providers[source.agent].read(source, job.sourceCursor, signal);
      signal?.throwIfAborted();
      const updated = await store.stage(
        {
          batch: job.id,
          source: JSON.stringify([source.agent, source.sessionId]),
          directory: source.projectDir ?? source.dir,
        },
        page.records,
        !page.nextCursor,
      );
      job.sourceCursor = page.nextCursor;
      if (page.nextCursor) return;
      job.updated += updated;
    } catch (error) {
      signal?.throwIfAborted();
      await store.discard(job.id, JSON.stringify([source.agent, source.sessionId]));
      failure(source.agent, error);
    } finally {
      release?.();
    }
    job.scanned++;
    job.source = undefined;
    job.sourceCursor = undefined;
  }
  async function selectSource(signal?: AbortSignal) {
    const item = scan!.queue[0];
    if (!item?.projectId) {
      scan!.queue.shift();
      return;
    }
    const project = await deps.workspaces.get(item.projectId);
    if (!project) {
      scan!.queue.shift();
      return;
    }
    try {
      const native = await deps.sessions.resolveReadScope(project, item.agent, item.sessionId, signal);
      scan!.source = {
        agent: item.agent,
        sessionId: item.sessionId,
        projectId: project.id,
        dir: native.dir,
        projectDir: project.dir,
      };
    } catch (error) {
      signal?.throwIfAborted();
      failure(item.agent, error);
      scan!.scanned++;
    }
    scan!.queue.shift();
  }
  function ensureScan(id?: string) {
    if (!scan) {
      if (id) return false;
      scan = {
        id: randomUUID(),
        agentIndex: 0,
        archived: false,
        queue: [],
        scanned: 0,
        updated: 0,
        errors: [],
      };
    }
    if (id && id !== scan.id) throw new Error('同步批次已变化，请重新同步。');
    return true;
  }
  async function step(signal?: AbortSignal) {
    if (!scan) return;
    if (!scan.source && !scan.queue.length && scan.agentIndex < AGENT_KINDS.length) await discover(signal);
    if (!scan.source) await selectSource(signal);
    if (scan.source) await readSource(signal);
    if (scan.agentIndex === AGENT_KINDS.length && !scan.queue.length && !scan.source) {
      await store.synced();
      last = { ...status(), id: undefined, running: false, lastSync: Date.now() };
      scan = undefined;
    }
  }
  return {
    savePrices: store.savePrices,
    async report(query: UsageQuery, signal?: AbortSignal): Promise<UsageReport> {
      const projects = new Map((await deps.workspaces.list()).map((p) => [p.id, p.dir]));
      const [prices, lastSync] = await Promise.all([store.prices(), store.lastSync()]);
      const aggregate = await store.scan({ from: query.from, to: query.to, projects, signal }, (records) =>
        aggregateUsage(records, query, prices),
      );
      return { ...aggregate, prices, officialPrices, sync: { ...status(), lastSync } };
    },
    async sync(id?: string, signal?: AbortSignal): Promise<UsageSyncStatus> {
      if (pending) {
        await pending;
        signal?.throwIfAborted();
        return status();
      }
      signal?.throwIfAborted();
      if (!ensureScan(id)) return last;
      pending = step(signal);
      try {
        await pending;
        return status();
      } finally {
        pending = undefined;
      }
    },
  };
}
