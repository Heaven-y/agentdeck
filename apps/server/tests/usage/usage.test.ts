import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, unlink, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeUsageRecords } from '../../src/agents/claude/usage/records';
import { codexUsageCollector } from '../../src/agents/codex/usage/records';
import { antigravityUsageProvider, antigravityUsageRecords } from '../../src/agents/antigravity/usage/records';
import { cacheRate, usageRows, summarize, usageBuckets } from '../../src/usage/aggregate';
import { createUsageStore } from '../../src/usage/store';
import { readUsageLines } from '../../src/agents/common/usage/jsonl';
import type { UsageRecord, UsageQuery } from '@agentdeck/shared/usage';
import type { SessionSummary } from '@agentdeck/shared/conversation';
import { createUsageService } from '../../src/usage/service';
import { registerUsageRoutes } from '../../src/http/usage.routes';
import { estimate } from '../../src/usage/pricing';
import { resolveClaudeReadSource } from '../../src/agents/claude/history/read-source';

const roots: string[] = [];
const source = { agent: 'codex' as const, sessionId: 'root', projectId: 'project', dir: os.tmpdir() };
const at = '2026-11-26T01:00:00.000Z';
const row: UsageRecord = {
  id: 'one',
  agent: 'codex',
  sessionId: 'root',
  projectId: 'project',
  timestamp: Date.parse(at),
  model: 'demo',
  modelSource: 'configuration',
  source: 'fixture',
  tokens: { input: 20, cacheRead: 80, cacheWrite: 0, output: 10 },
  inputTotal: 100,
  outputFinal: true,
};
afterEach(async () => {
  for (const root of roots.splice(0)) {
    for (const file of ['usage.sqlite', 'source.jsonl']) await unlink(path.join(root, file)).catch(() => undefined);
    await rmdir(root);
  }
});
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-usage-'));
  roots.push(root);
  return root;
}

it('Codex单响应去重，不累加快照和父历史；缓存写入不会再次增加输入总量', () => {
  const collector = codexUsageCollector(source);
  const visit = collector.visit;
  visit({ type: 'session_meta', payload: { id: 'root', model_provider: 'example' } });
  visit({ type: 'turn_context', payload: { model: 'demo' } });
  const payload = {
    thread_id: 'root',
    response_id: 'response',
    turn_id: 'turn',
    usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      cache_write_input_tokens: 60,
      output_tokens: 10,
      total_tokens: 110,
    },
  };
  visit({ type: 'token_usage_record', timestamp: at, payload });
  visit({ type: 'token_usage_record', timestamp: at, payload });
  visit({
    type: 'token_usage_record',
    timestamp: at,
    payload: { ...payload, thread_id: 'parent', response_id: 'inherited' },
  });
  visit({
    type: 'event_msg',
    timestamp: at,
    payload: { type: 'token_count', info: { total_token_usage: payload.usage } },
  });
  expect([...collector.records.values()]).toMatchObject([
    { tokens: { input: 0, cacheRead: 40, cacheWrite: 60, output: 10 }, inputTotal: 100 },
  ]);
  expect(collector.records.size).toBe(1);
});
it('Claude同API响应的多个块合并，未确认最终输出不混入总量和完整估价', () => {
  const message = {
    id: 'response',
    model: 'demo',
    usage: { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0, output_tokens: 1 },
  };
  const records = claudeUsageRecords(
    [
      { type: 'assistant', timestamp: at, message },
      { type: 'assistant', timestamp: at, message },
    ],
    { ...source, agent: 'claude' },
  );
  expect(records).toHaveLength(1);
  const summary = summarize(usageRows(records, []));
  expect(summary.tokens).toEqual({ input: 20, cacheRead: 80, cacheWrite: 0 });
  expect(summary.measured.output).toBe(0);
});
it('AGY多步骤关联只计一次生成，源身份不匹配的继承记录不加入', () => {
  const usage = { inputTokens: '100', outputTokens: '10', cacheReadTokens: '200' };
  const metadata = {
    createdAt: at,
    executionId: 'execution',
    sourceTrajectoryStepInfo: { cascadeId: 'root', metadataIndex: 0 },
  };
  const trajectory = {
    generatorMetadata: [
      {
        executionId: 'execution',
        stepIndices: [1, 2],
        chatModel: {
          usage,
          responseModel: 'demo',
          retryInfos: [{ usage }],
          streamingDuration: '0.5s',
          timeToFirstToken: '0.1s',
        },
      },
    ],
    usageSteps: [
      { index: 1, status: 'CORTEX_STEP_STATUS_DONE', metadata },
      { index: 2, status: 'CORTEX_STEP_STATUS_DONE', metadata },
    ],
  };
  const records = antigravityUsageRecords(trajectory, { ...source, agent: 'antigravity' });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    tokens: { input: 100, output: 10, cacheRead: 200 },
    durationMs: 500,
    firstTokenMs: 100,
  });
  expect(antigravityUsageRecords(trajectory, { ...source, sessionId: 'wrong' })).toEqual([]);
});
it('汇总缓存率用分子分母加总，价格按模型精确匹配', () => {
  const rows = usageRows(
    [
      row,
      {
        ...row,
        id: 'two',
        timestamp: row.timestamp + 1000,
        tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 2 },
        inputTotal: 10,
      },
      { ...row, id: 'three', model: 'other', timestamp: row.timestamp + 2000 },
    ],
    [{ agent: 'codex', model: 'demo', provider: '', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }],
  );
  expect(rows[1]?.cacheRate).toBe(0);
  expect(summarize(rows).cacheRate).toBeCloseTo(160 / 210);
  expect(rows[2]?.costUsd).toBeUndefined();
  const query: UsageQuery = { from: 0, to: Date.now(), bucket: 'day', offset: 0, timezoneOffset: -480 };
  expect(cacheRate({ cacheRead: 200 }, 100)).toBeUndefined();
  const partial = usageRows([{ ...row, tokens: { cacheRead: 80 }, inputTotal: 100 }], []);
  expect(usageBuckets(partial, query)[0]?.cacheRate).toBe(0.8);
  expect(usageBuckets(rows, query)[0]?.timestamp).toBe(Date.parse('2026-11-25T16:00:00Z'));
});
it('AGY只在父结果和子元数据全部核验后采集计量，拒绝的候选不进入索引', async () => {
  const dir = await directory(),
    uris = [pathToFileURL(dir).href];
  const provider = antigravityUsageProvider({
    delete: async () => {},
    fork: async () => ({ sessionId: 'unused' }),
    readUsageWindow: async () => ({ trajectory: {} }),
    readUsageTrajectory: async (_root, _dir, child) => {
      const id = child?.id ?? 'root';
      const metadata = {
        workspaceUris: uris,
        rootConversationId: 'root',
        ...(child ? { parentConversationId: 'root', nestingDepth: 1 } : {}),
      };
      if (!child)
        return {
          trajectory: {
            cascadeId: id,
            metadata,
            steps: [
              {
                type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
                invokeSubagent: {
                  results: [
                    { conversationId: 'good', workspaceUris: uris },
                    { conversationId: 'bad', workspaceUris: [pathToFileURL(path.join(dir, 'other')).href] },
                  ],
                },
              },
            ],
          },
        };
      return {
        trajectory: {
          cascadeId: id,
          metadata,
          steps: [],
          generatorMetadata: [{ executionId: id, stepIndices: [0], chatModel: { usage: { inputTokens: '10' } } }],
          usageSteps: [
            {
              index: 0,
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: at,
                executionId: id,
                sourceTrajectoryStepInfo: { cascadeId: id, metadataIndex: 0 },
              },
            },
          ],
        },
      };
    },
  });
  const scope = { ...source, agent: 'antigravity' as const, dir };
  const first = await provider.read(scope);
  const children = await provider.read(scope, first.nextCursor);
  expect(children.records.map((r) => r.childId)).toEqual(['good']);
  expect(children.nextCursor).not.toContain('antigravity:bad');
  const end = await provider.read(scope, children.nextCursor);
  expect(end.records).toEqual([]);
});
it('指标索引重复同步保持幂等、原生分支副本只计一次、读取结果不含正文', async () => {
  const root = await directory(),
    store = createUsageStore(root);
  await store.stage({ batch: 'batch', source: 'source', directory: root }, [row], true);
  await store.stage({ batch: 'batch', source: 'source', directory: root }, [row], true);
  await store.stage({ batch: 'batch', source: 'fork', directory: root }, [{ ...row, sessionId: 'fork' }], true);
  expect(
    await store.scan({ from: 0, to: Date.now(), projects: new Map([['project', root]]) }, async (rows) => {
      const result = [];
      for await (const row of rows) result.push(row);
      return result;
    }),
  ).toHaveLength(1);
  await store.stage({ batch: 'batch', source: 'source', directory: root }, [], true);
  expect(
    await store.scan({ from: 0, to: Date.now(), projects: new Map([['project', root]]) }, async (rows) => {
      const result = [];
      for await (const row of rows) result.push(row);
      return result;
    }),
  ).toHaveLength(1);
  const many = Array.from({ length: 1001 }, (_, i) => ({ ...row, id: `page-${i}` }));
  await store.stage({ batch: 'batch', source: 'many', directory: root }, many, true);
  const query = { from: 0, to: Date.now(), projects: new Map([['project', root]]) };
  const ids = await store.scan(query, async (rows) => {
    const ids = new Set();
    for await (const item of rows) ids.add(item.id);
    return ids;
  });
  expect(ids.size).toBe(1002);
  const controller = new AbortController();
  await expect(
    store.scan({ ...query, signal: controller.signal }, async (rows) => {
      for await (const _item of rows) controller.abort();
    }),
  ).rejects.toThrow();
  await store.savePrices([]);
  expect(await store.prices()).toEqual([]);
});
it('原生JSONL只处理完整行，取消不交付半条记录', async () => {
  const root = await directory(),
    file = path.join(root, 'source.jsonl');
  await writeFile(file, '{"type":"one"}\n{"type":"partial"');
  const seen: unknown[] = [];
  await readUsageLines(file, (v) => seen.push(v));
  expect(seen).toEqual([{ type: 'one' }]);
  await expect(readUsageLines(file, () => {}, AbortSignal.abort())).rejects.toThrow();
});

it('官方价自动分档、按记录日调价，未知写入时长只估已知分项，自定义可覆盖', () => {
  const usage = {
    ...row,
    model: 'gpt-6.2-sol',
    inputTotal: 300000,
    tokens: { input: 100000, cacheRead: 100000, cacheWrite: 100000, output: 1000 },
  };
  const partial = estimate(usage, []);
  expect(partial).toMatchObject({ priceSource: 'official', costPartial: true });
  expect(partial.costUsd).toBeCloseTo(0.435);
  expect(estimate({ ...usage, cacheWriteByTtl: { '30m': 50000, '12h': 50000 } }, []).costUsd).toBeCloseTo(1.185);
  const gemini = { ...row, model: 'gemini-4-carbon' };
  expect(estimate({ ...gemini, timestamp: Date.parse('2026-12-02') }, []).costUsd).toBeCloseTo(
    estimate(gemini, []).costUsd! * 2,
  );
  expect(estimate({ ...row, model: 'gpt-6' }, [])).toEqual({});
  const custom = [
    { agent: 'codex' as const, model: 'gpt-6.2-sol', provider: '', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  ];
  expect(estimate(usage, custom)).toMatchObject({ priceSource: 'custom', costUsd: 0.301, costPartial: false });
  expect(estimate({ ...row, model: 'gpt-5.6-sol', timestamp: Date.parse('2026-12-02') }, [])).toEqual({});
});

it('Claude只读短路径补救核验会话与目录，后续SDK使用同一定位方式', async () => {
  const dir = await directory();
  const info = { sessionId: 'root', cwd: dir, summary: '示例', lastModified: 1 };
  const lookup = vi.fn(async (_id: string, scoped?: string) => (scoped ? undefined : info));
  expect(await resolveClaudeReadSource('root', dir, lookup)).toEqual({ info, dir: undefined });
  await expect(resolveClaudeReadSource('other', dir, lookup)).rejects.toThrow();
  await expect(
    resolveClaudeReadSource('root', dir, async () => ({ ...info, cwd: path.join(dir, 'other') })),
  ).rejects.toThrow();
});

async function serviceFixture() {
  const dir = await directory();
  const project = { id: 'project', name: '示例', dir };
  const session: SessionSummary = {
    agent: 'codex',
    sessionId: 'root',
    projectId: project.id,
    title: '示例',
    updatedAt: at,
    running: false,
  };
  const read = vi.fn(async (_scope: unknown, cursor?: string, _signal?: AbortSignal) => ({
    records: [{ ...row, id: cursor ? 'two' : 'one' }],
    nextCursor: cursor ? undefined : 'next',
  }));
  const page = vi.fn(async (q: { agent: string; scope: string; cursor?: string }) => ({
    items: q.agent === 'codex' && q.scope === 'archived' ? [session] : [],
  }));
  const service = createUsageService({
    configDir: dir,
    workspaces: { list: async () => [project], get: async () => project },
    sessions: { page, resolveReadScope: async () => project },
    providers: {
      codex: { read },
      claude: { read: async () => ({ records: [] }) },
      antigravity: { read: async () => ({ records: [] }) },
    },
  });
  const query: UsageQuery = { from: 0, to: Date.now() + 86400000, offset: 0, bucket: 'day', timezoneOffset: 0 };
  return { service, project, read, page, query, store: createUsageStore(dir) };
}
async function finishSync(service: ReturnType<typeof createUsageService>, id?: string) {
  for (let i = 0; i < 30; i++) {
    const status = await service.sync(id);
    if (!status.running) return status;
    id = status.id;
  }
  throw new Error('同步没有结束');
}
it('归档来源分页完成才替换索引；取消可继续，失败保留旧值，目录变化隔离', async () => {
  const f = await serviceFixture();
  await f.store.stage(
    { batch: 'initial', source: JSON.stringify(['codex', 'root']), directory: f.project.dir },
    [row],
    true,
  );
  let status = await f.service.sync();
  while (!f.read.mock.calls.length) status = await f.service.sync(status.id);
  expect((await f.service.report(f.query)).total).toBe(1);
  await expect(f.service.sync(status.id, AbortSignal.abort())).rejects.toThrow();
  await finishSync(f.service, status.id);
  expect((await f.service.report(f.query)).total).toBe(2);
  expect(f.read.mock.calls[1]?.[1]).toBe('next');
  f.read.mockRejectedValueOnce(new Error('原生读取失败'));
  expect((await finishSync(f.service)).errors).toHaveLength(1);
  expect((await f.service.report(f.query)).total).toBe(2);
  f.project.dir = path.join(f.project.dir, 'changed');
  expect((await f.service.report(f.query)).total).toBe(0);
});
it('同步并发只推进一次来源页，HTTP校验筛选与单价并返回聚合', async () => {
  const f = await serviceFixture();
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  f.read.mockImplementationOnce(async () => {
    await gate;
    return { records: [row], nextCursor: undefined };
  });
  let status = await f.service.sync();
  while (!f.page.mock.calls.some(([q]) => q.agent === 'codex' && q.scope === 'active'))
    status = await f.service.sync(status.id);
  const first = f.service.sync(status.id);
  const second = f.service.sync(status.id);
  complete();
  await Promise.all([first, second]);
  expect(f.read).toHaveBeenCalledTimes(1);
  await finishSync(f.service, status.id);
  const app = Fastify();
  registerUsageRoutes(app, f.service);
  try {
    expect((await app.inject({ url: '/api/usage?from=2&to=1' })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'PUT', url: '/api/usage/prices', payload: { prices: [{ input: -1 }] } })).statusCode,
    ).toBe(400);
    const response = await app.inject({ url: `/api/usage?from=0&to=${f.query.to}` });
    expect(response.json()).toMatchObject({
      total: 1,
      summary: { count: 1 },
      agents: [
        { agent: 'claude', count: 0 },
        { agent: 'codex', count: 1 },
        { agent: 'antigravity', count: 0 },
      ],
    });
  } finally {
    await app.close();
  }
});
