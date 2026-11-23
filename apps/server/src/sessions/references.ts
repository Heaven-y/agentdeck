import path from 'node:path';
import os from 'node:os';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  findSessionReferences,
  formatSessionReference,
  appendSessionReferenceContext,
  type AgentKind,
  type SessionLocation,
} from '@agentdeck/shared/conversation';
import { SessionError } from '../agents/errors';
import { claudeSessionRecordPath } from '../agents/claude/history/session-activity';
import { codexSessionRecordPath } from '../agents/codex/history/sessions';
import type { WorkspaceStore } from '../workspaces/store';
import type { SessionsService } from './service';

type Deps = {
  configDir: string;
  store: Pick<WorkspaceStore, 'get'>;
  sessions: Pick<SessionsService, 'assertBelongs'>;
  environment(agent: AgentKind): Promise<NodeJS.ProcessEnv>;
  agyHistoryScript?: string;
};
function agyReadCommand(deps: Deps, location: SessionLocation) {
  const script = deps.agyHistoryScript ?? fileURLToPath(new URL('./read-agy-history.ts', import.meta.url));
  const args = deps.agyHistoryScript ? [script] : ['--import', import.meta.resolve('tsx'), script];
  return {
    command: process.execPath,
    args: [
      ...args,
      '--config-dir',
      path.resolve(deps.configDir),
      '--workspace-id',
      location.workspaceId,
      '--session-id',
      location.sessionId,
    ],
    env: {
      HOME: os.homedir(),
      USERPROFILE: os.homedir(),
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  };
}
export function createSessionReferences(deps: Deps) {
  async function locate(location: SessionLocation, signal?: AbortSignal) {
    const workspace = await deps.store.get(location.workspaceId);
    if (!workspace) throw new SessionError(404, 'workspace_missing', '引用的工作区不存在。');
    const native = await deps.sessions.assertBelongs(workspace, location.agent, location.sessionId, signal);
    signal?.throwIfAborted();
    const env = await deps.environment(location.agent);
    let file: string;
    if (location.agent === 'claude')
      file = await claudeSessionRecordPath(location.sessionId, native.dir, env.CLAUDE_CONFIG_DIR);
    else if (location.agent === 'codex')
      file = await codexSessionRecordPath(location.sessionId, native.dir, { env, signal });
    else file = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations', `${location.sessionId}.db`);
    if (!path.isAbsolute(file) || !(await lstat(file)).isFile()) throw new Error('原生会话记录文件不存在。');
    return { file, cwd: native.dir };
  }
  return {
    async prepare(text: string, signal?: AbortSignal): Promise<string> {
      const unique = new Map(
        findSessionReferences(text).map(({ location }) => [formatSessionReference(location), location]),
      );
      if (!unique.size) return text;
      const instructions: string[] = [];
      for (const [reference, location] of unique) {
        signal?.throwIfAborted();
        try {
          const source = await locate(location, signal);
          const read =
            location.agent === 'antigravity'
              ? `原生记录是 SQLite / Protobuf，使用配套的只读原生历史读取入口，按命令描述传递参数与进程环境：${JSON.stringify(agyReadCommand(deps, location))}。默认读取最近内容；需要全文时加 --all，需要更早页时传 --before 返回的游标。`
              : '直接用原生文件或终端工具读取此 JSONL。按当前问题读取所需消息与工具记录；明确要求完整阅读时读完整文件。大文件可搜索或按行分段读取。';
          instructions.push(
            `${reference}\n原生记录：${JSON.stringify(source.file)}\n原会话目录：${JSON.stringify(source.cwd)}\n${read}`,
          );
        } catch (error) {
          signal?.throwIfAborted();
          const reason = error instanceof SessionError ? error.message : '无法定位此会话的原生记录。';
          instructions.push(`${reference}\n读取失败：${reason}`);
        }
      }
      return appendSessionReferenceContext(text, instructions);
    },
  };
}
