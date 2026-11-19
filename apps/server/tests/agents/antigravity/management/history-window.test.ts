import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { NativeHistoryPageTooLarge } from '../../../../src/agents/antigravity/management/history-stream';
import { readAntigravityHistoryWindow } from '../../../../src/agents/antigravity/management/history-window';
import type { ManagementRecord } from '../../../../src/agents/antigravity/management/management-rpc';

const dir = path.join(tmpdir(), 'agy-window-fixture');
const scope = { id: 'main', dir };
function fixture(total = 80, toolOutput = '') {
  let trajectory = 'record';
  const update = vi.fn((params: ManagementRecord): Promise<ManagementRecord> => {
    const { startIndex: start, endIndexExclusive: end } = params.initialStepsPageBounds as {
      startIndex: number;
      endIndexExclusive: number;
    };
    const indices = Array.from({ length: end - start }, (_, index) => start + index);
    return Promise.resolve({
      conversationId: 'main',
      trajectoryId: trajectory,
      status: 'CASCADE_RUN_STATUS_IDLE',
      mainTrajectoryUpdate: {
        metadata: { workspaceUris: [pathToFileURL(dir).href] },
        stepsUpdate: {
          pageBounds: { startIndex: start, endIndexExclusive: end },
          totalLength: total,
          steps: indices.map((index) => ({
            type: index % 10 ? 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' : 'CORTEX_STEP_TYPE_USER_INPUT',
            status: 'CORTEX_STEP_STATUS_DONE',
            ...(toolOutput && index % 10 ? { toolOutput } : {}),
          })),
          indices,
        },
      },
      turnsUpdate: { turns: Array.from({ length: total / 10 }, (_, n) => ({ startStepIndex: n * 10 })) },
    });
  });
  const request = vi.fn();
  const close = vi.fn(async () => {});
  return {
    backend: { request, close, readInitialUpdate: update },
    update,
    replace: () => (trajectory = 'other-record'),
  };
}

it('原生首读与相邻页只取整轮请求窗口，游标不可用于另一条轨迹', async () => {
  const f = fixture();
  const latest = await readAntigravityHistoryWindow(f.backend, scope);
  expect(latest.page).toMatchObject({ start: 50, before: expect.any(String) });
  expect(latest.trajectory.steps).toHaveLength(30);
  const previous = await readAntigravityHistoryWindow(f.backend, scope, latest.page.before);
  expect(previous.page.start).toBe(20);
  expect(previous.trajectory.steps).toHaveLength(30);
  expect(f.update.mock.calls.map(([params]) => params.initialStepsPageBounds)).toEqual([
    { startIndex: 0, endIndexExclusive: 0 },
    { startIndex: 50, endIndexExclusive: 80 },
    { startIndex: 0, endIndexExclusive: 0 },
    { startIndex: 20, endIndexExclusive: 50 },
  ]);
  expect(f.backend.request).not.toHaveBeenCalled();
  f.replace();
  await expect(readAntigravityHistoryWindow(f.backend, scope, latest.page.before)).rejects.toMatchObject({
    code: 'session_history_changed',
  });
});

it('总历史等效超过 64 MiB 时仍只请求小窗口，文件越大不改变分页步数', async () => {
  const total = 7200;
  const output = 'x'.repeat(16 * 1024);
  expect(total * 0.9 * Buffer.byteLength(output)).toBeGreaterThan(64 * 1024 * 1024);
  const f = fixture(total, output);
  const latest = await readAntigravityHistoryWindow(f.backend, scope);
  const previous = await readAntigravityHistoryWindow(f.backend, scope, latest.page.before);
  expect([latest.page.start, previous.page.start]).toEqual([7170, 7140]);
  expect(f.update.mock.calls.map(([params]) => params.initialStepsPageBounds)).toEqual([
    { startIndex: 0, endIndexExclusive: 0 },
    { startIndex: 7170, endIndexExclusive: 7200 },
    { startIndex: 0, endIndexExclusive: 0 },
    { startIndex: 7140, endIndexExclusive: 7170 },
  ]);
});

it('单步超过两种原生读取预算仍留下明确占位和较早游标；其他故障不伪造历史', async () => {
  const f = fixture();
  const fallback = f.update.getMockImplementation()!;
  f.update.mockImplementation(async (params) => {
    if ((params.initialStepsPageBounds as { endIndexExclusive: number }).endIndexExclusive > 0)
      throw new NativeHistoryPageTooLarge();
    return fallback(params);
  });
  const page = await readAntigravityHistoryWindow(f.backend, scope);
  expect(page.page).toMatchObject({ start: 79, before: expect.any(String) });
  expect(page.trajectory.steps).toEqual([{ type: 'AGENTDECK_HISTORY_STEP_OMITTED' }]);
  expect(f.update.mock.calls.length).toBeLessThan(20);
  f.update.mockImplementation(async (params) => ({ ...(await fallback(params)), conversationId: 'other' }));
  await expect(readAntigravityHistoryWindow(f.backend, scope)).rejects.toMatchObject({ code: 'session_missing' });
});

it('轮次目录缺失也用用户步骤约束最近三轮，补页核对相邻原生轮头', async () => {
  const f = fixture(50);
  const update = f.update.getMockImplementation()!;
  f.update.mockImplementation(async (params) => ({ ...(await update(params)), turnsUpdate: undefined }));
  const latest = await readAntigravityHistoryWindow(f.backend, scope);
  expect(latest.page.start).toBe(20);
  expect(latest.partialStart).toBe(false);
  const prior = await readAntigravityHistoryWindow(f.backend, scope, latest.page.before);
  expect(prior.page.start).toBe(0);
  expect(prior.partialEnd).toBe(false);
  expect(prior.trajectory.steps).toHaveLength(20);
});
