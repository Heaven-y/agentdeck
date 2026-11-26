import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import {
  createAntigravitySubagents,
  createAntigravitySubagentMedia,
} from '../../../../src/agents/antigravity/history/subagents';
import { createAntigravitySessionManagement } from '../../../../src/agents/antigravity/management/management';
import { NativeTrajectoryMissing } from '../../../../src/agents/antigravity/management/management-rpc';
import { SessionError } from '../../../../src/agents/errors';

const dir = path.join(tmpdir(), 'agy-subagent-project');
const workspaceUris = [pathToFileURL(dir).href];
function trajectory(id: string, parent?: string, children: string[] = []) {
  return {
    cascadeId: id,
    metadata: {
      workspaceUris,
      parentConversationId: parent,
      rootConversationId: 'root',
      nestingDepth: parent ? (parent === 'root' ? 1 : 2) : 0,
    },
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
        status: 'CORTEX_STEP_STATUS_DONE',
        invokeSubagent: {
          subagents: children.map(() => ({ typeName: 'research', role: '阅读源码' })),
          results: children.map((conversationId) => ({ conversationId, workspaceUris })),
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: `${id}独立回复` },
      },
    ],
  };
}
function fixture() {
  const rows: Record<string, Record<string, unknown>> = {
    root: trajectory('root', undefined, ['child']),
    child: trajectory('child', 'root', ['nested']),
    nested: trajectory('nested', 'child'),
  };
  const read = createAntigravitySubagents(async (id, _dir, child) => ({
    trajectory: rows[child?.id ?? id]!,
    status: 'CASCADE_RUN_STATUS_IDLE',
  }));
  return { rows, read };
}
it('工作流代理按来源工具三向核对，Swarm已终止不误报完成，生成用量独立累计', async () => {
  const f = fixture();
  const block = (id: string) => ({ agent: { conversationId: id, title: '协作代理', subtitle: '示例角色' } });
  f.rows.root!.steps = [
    {
      type: 'CORTEX_STEP_TYPE_GENERIC',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { toolCall: { id: 'call-workflow', name: 'run_workflow' } },
      generic: {
        result: { stepRenderInfo: { contentBlocks: [{ step: { renderInfo: { contentBlocks: [block('child')] } } }] } },
      },
    },
  ];
  f.rows.child!.metadata = {
    workspaceUris,
    rootConversationId: 'root',
    sourceMetadata: {
      hideFromConversationList: true,
      tool: { conversationId: 'root', stepIndex: 0, toolCall: { id: 'call-workflow', name: 'run_workflow' } },
    },
  };
  f.rows.child!.steps = [];
  f.rows.child!.generatorMetadata = [
    { chatModel: { usage: { inputTokens: '20', outputTokens: '4', cacheReadTokens: '100' } } },
    { chatModel: { usage: { inputTokens: '30', outputTokens: '6', cacheReadTokens: '200' } } },
  ];
  expect(await f.read('root', dir, {})).toMatchObject({
    agentIds: ['child'],
    summaries: [
      { status: 'unknown', usage: { generations: 2, inputTokens: 50, outputTokens: 10, cachedInputTokens: 300 } },
    ],
  });
  f.rows.child!.steps = [{ type: 'CORTEX_STEP_TYPE_FINISH', status: 'CORTEX_STEP_STATUS_DONE' }];
  expect(await f.read('root', dir, {})).toMatchObject({ summaries: [{ status: 'completed' }] });
  const meta = f.rows.child!.metadata as Record<string, unknown>;
  meta.sourceMetadata = {
    hideFromConversationList: true,
    tool: { conversationId: 'other', toolCall: { id: 'call-workflow', name: 'run_workflow' } },
  };
  await expect(f.read('root', dir, { agentId: 'child' })).rejects.toMatchObject({ status: 404 });
  f.rows.child!.metadata = { workspaceUris, rootConversationId: 'root', parentConversationId: 'root', nestingDepth: 1 };
  f.rows.root!.steps = [
    {
      type: 'CORTEX_STEP_TYPE_GENERIC',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { toolCall: { id: 'call-swarm', name: 'swarm' } },
      generic: { result: { stepRenderInfo: { titlePrefix: 'Killed', contentBlocks: [block('child')] } } },
    },
  ];
  expect(await f.read('root', dir, {})).toMatchObject({ summaries: [{ status: 'cancelled' }] });
});
it('按invokeSubagent身份和元数据验证子轨迹，支持嵌套与独立内容', async () => {
  const { read } = fixture();
  expect(await read('root', dir, {})).toMatchObject({
    agentIds: ['child'],
    summaries: [{ role: '阅读源码', parentSessionId: 'root' }],
  });
  expect(await read('root', dir, { parentAgentId: 'child' })).toMatchObject({ agentIds: ['nested'] });
  const result = await read('root', dir, { parentAgentId: 'child', agentId: 'nested' });
  expect(result).toMatchObject({ parentAgentId: 'child' });
  expect(JSON.stringify(result)).toContain('nested独立回复');
  expect(JSON.stringify(result)).not.toContain('forkPoint');
});
it.each(['parentConversationId', 'rootConversationId', 'nestingDepth', 'workspaceUris'])(
  '拒绝不匹配子轨迹字段：%s',
  async (key) => {
    const { rows, read } = fixture();
    const metadata = rows.child!.metadata as Record<string, unknown>;
    metadata[key] =
      key === 'nestingDepth' ? 8 : key === 'workspaceUris' ? [pathToFileURL(path.join(dir, 'other')).href] : 'other';
    await expect(read('root', dir, { agentId: 'child' })).rejects.toMatchObject({ status: 404 });
  },
);
it('只读路径允许活动父子，删除和分叉继续拒绝内部或活动记录', async () => {
  const rows = { root: trajectory('root', undefined, ['child']), child: trajectory('child', 'root') };
  const writes: string[] = [];
  const service = createAntigravitySessionManagement({
    backend: async () => ({
      close: async () => {},
      request: async (method, input) => {
        if (method !== 'GetCascadeTrajectory') {
          writes.push(method);
          return {};
        }
        return { trajectory: rows[input.cascadeId as keyof typeof rows], status: 'CASCADE_RUN_STATUS_RUNNING' };
      },
    }),
  });
  const result = await service.readSubagentTrajectory!('root', dir, {
    id: 'child',
    parentId: 'root',
    rootId: 'root',
    depth: 1,
  });
  expect(result.trajectory.cascadeId).toBe('child');
  await expect(service.delete('child', dir)).rejects.toMatchObject({ code: 'unsupported_action' });
  await expect(service.fork('root', dir, {})).rejects.toMatchObject({ code: 'session_busy' });
  expect(writes).toEqual([]);
  await service.dispose();
});
it('独立图片仍绑定根会话，失败子轨迹不显示为完成，拒绝伪媒体ID', async () => {
  const { rows, read } = fixture();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=';
  rows.child!.steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { media: [{ mimeType: 'image/png', inlineData: png }] } },
    { type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', status: 'CORTEX_STEP_STATUS_ERROR' },
  ];
  expect(await read('root', dir, { agentId: 'child' })).toMatchObject({
    summary: { status: 'failed' },
    events: [
      { type: 'user_message', attachments: [{ locator: { sessionId: 'root', subagentId: 'child' } }] },
      { type: 'turn_end' },
    ],
  });
  const media = createAntigravitySubagentMedia(async (id, _dir, child) => ({ trajectory: rows[child?.id ?? id]! }));
  const locator = { sessionId: 'root', subagentId: 'child', messageId: '0', kind: 'user' as const, index: 0 };
  expect((await media('root', dir, locator)).data.toString('base64')).toBe(png);
  await expect(media('root', dir, { ...locator, subagentId: 'forged' })).rejects.toMatchObject({ status: 404 });
});
function formalSiblingReader(failure?: Error) {
  const rows: Record<string, Record<string, unknown>> = {
    root: trajectory('root', undefined, ['bad', 'child']),
    bad: trajectory('bad', 'wrong-parent'),
    child: trajectory('child', 'root', ['nested']),
    nested: trajectory('nested', 'child'),
  };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=';
  rows.nested!.steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { media: [{ mimeType: 'image/png', inlineData: png }] } },
  ];
  const service = createAntigravitySessionManagement({
    backend: async () => ({
      close: async () => {},
      request: async (_method, input) => {
        if (input.cascadeId === 'bad' && failure) throw failure;
        return { trajectory: rows[String(input.cascadeId)], status: 'CASCADE_RUN_STATUS_IDLE' };
      },
    }),
  });
  const native = service.readSubagentTrajectory!.bind(service);
  return {
    rows,
    read: createAntigravitySubagents(native),
    media: createAntigravitySubagentMedia(native),
    close: () => service.dispose(),
  };
}
it('正式AGY只读reader跳过失效兄弟，嵌套历史与图片仍沿有效链核实', async () => {
  const { rows, read, media, close } = formalSiblingReader();
  try {
    expect(await read('root', dir, {})).toMatchObject({ agentIds: ['child'] });
    expect(await read('root', dir, { agentId: 'nested', parentAgentId: 'child' })).toMatchObject({ agentId: 'nested' });
    await expect(read('root', dir, { agentId: 'bad' })).rejects.toMatchObject({ code: 'session_missing' });
    const locator = { sessionId: 'root', subagentId: 'nested', messageId: '0', index: 0, kind: 'user' as const };
    expect((await media('root', dir, locator)).mimeType).toBe('image/png');
    (rows.nested!.metadata as Record<string, unknown>).parentConversationId = 'forged';
    await expect(media('root', dir, locator)).rejects.toMatchObject({ code: 'session_missing' });
  } finally {
    await close();
  }
});
it('原生明确not_found只淘汰该兄弟，不能选中不存在记录', async () => {
  const { read, close } = formalSiblingReader(new NativeTrajectoryMissing());
  try {
    expect(await read('root', dir, { agentId: 'child' })).toMatchObject({ agentId: 'child' });
    await expect(read('root', dir, { agentId: 'bad' })).rejects.toMatchObject({ code: 'session_missing' });
  } finally {
    await close();
  }
});
it.each(['session_history_incomplete', 'session_runtime_failed', 'cancelled'])(
  'AGY兄弟%s仍使读取失败，禁止吞错',
  async (code) => {
    const failure =
      code === 'cancelled' ? new DOMException('合成取消', 'AbortError') : new SessionError(503, code, '合成失败');
    const { read, media, close } = formalSiblingReader(failure);
    try {
      await expect(read('root', dir, { agentId: 'child' })).rejects.toBe(failure);
      await expect(
        media('root', dir, { sessionId: 'root', subagentId: 'nested', messageId: '0', index: 0, kind: 'user' }),
      ).rejects.toBe(failure);
    } finally {
      await close();
    }
  },
);
