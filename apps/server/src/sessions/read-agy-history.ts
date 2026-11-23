import path from 'node:path';
import { stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { NativeSessionIdSchema, type SessionHistoryPage } from '@agentdeck/shared/conversation';
import { createWorkspaceStore } from '../workspaces/store';
import { createLaunchEnvironment } from '../settings/launch-environment';
import { createSessionsService } from './service';
import { createAntigravitySessions } from '../agents/antigravity/history/sessions';
import { createAntigravitySessionManagement } from '../agents/antigravity/management/management';
import { SessionError } from '../agents/errors';

async function printPages(
  read: (before?: string) => Promise<SessionHistoryPage>,
  options: { before?: string; all?: boolean },
) {
  const visible = new Set([
    'user_message',
    'text',
    'tool_call',
    'tool_result',
    'activity',
    'input_attachments',
    'async_question',
    'interaction_request',
    'interaction_resolved',
    'error',
    'turn_end',
  ]);
  const visited = new Set<string>();
  let before = options.before;
  do {
    const result = await read(before);
    process.stdout.write(
      `${JSON.stringify({
        sessionId: result.session.sessionId,
        page: result.page,
        events: result.events.filter((event) => visible.has(event.type)),
      })}\n`,
    );
    before = result.page?.before;
    if (before && visited.has(before)) throw new Error('原生历史返回了重复游标，读取已停止。');
    if (before) visited.add(before);
  } while (options.all && before);
}

async function main() {
  const { values } = parseArgs({
    options: {
      'config-dir': { type: 'string' },
      'workspace-id': { type: 'string' },
      'session-id': { type: 'string' },
      before: { type: 'string' },
      all: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(
      '读取 AGY 原生历史，不保存副本。参数：--config-dir <目录> --workspace-id <项目> --session-id <会话> [--before <游标>] [--all]。默认返回最近一页；--all 从新到旧输出全部页，每页内按原生时序排列。\n',
    );
    return;
  }
  if (!values['config-dir'] || !path.isAbsolute(values['config-dir'])) throw new Error('需要绝对配置目录。');
  const workspaceId = NativeSessionIdSchema.parse(values['workspace-id']);
  const sessionId = NativeSessionIdSchema.parse(values['session-id']);
  const configDir = values['config-dir'];
  const store = createWorkspaceStore({ configDir, dirExists: async (dir) => (await stat(dir)).isDirectory() });
  const workspace = await store.get(workspaceId);
  if (!workspace) throw new SessionError(404, 'workspace_missing', '引用的工作区不存在。');
  const environment = createLaunchEnvironment({ configDir });
  const management = createAntigravitySessionManagement({ environment: () => environment.resolve('antigravity') });
  const sessions = createSessionsService(
    { antigravity: createAntigravitySessions({ management, preserveToolContent: true }) },
    {
      projects: () => store.list(),
      withIdleSession: () => Promise.reject(new Error('此入口只读取原生历史。')),
    },
  );
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await printPages(
      (before) => sessions.readHistoryPage(workspace, { agent: 'antigravity', sessionId }, before, controller.signal),
      values,
    );
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await management.dispose();
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof SessionError ? error.message : 'AGY 原生历史读取失败。'}\n`);
  process.exitCode = 1;
});
