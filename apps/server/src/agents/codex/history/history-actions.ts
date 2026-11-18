import { createHash } from 'node:crypto';
import type { NativeActionBackend } from '../../common/interaction/native-actions';
import { CodexClient } from '../run/client';
import { checkedThread } from './sessions';
import { record, text, list, type CodexRuntimeOptions, type RecordValue } from '../run/types';
import { SessionError } from '../../errors';
const conflict = () =>
  new SessionError(409, 'history_action_unavailable', '原生会话正在运行、历史不完整或此位置没有可验证的用户回合。');
const revision = (turns: RecordValue[]) => createHash('sha256').update(JSON.stringify(turns)).digest('hex');
function editableTurns(thread: RecordValue): RecordValue[] {
  if (
    record(thread.status).type === 'active' ||
    thread.parentThreadId ||
    typeof thread.source !== 'string' ||
    !Array.isArray(thread.turns)
  )
    throw conflict();
  const turns = thread.turns.map(record);
  if (turns.some((turn) => !Array.isArray(turn.items) || (turn.itemsView && turn.itemsView !== 'full')))
    throw conflict();
  return turns;
}
function candidate(turn: RecordValue): boolean {
  const items = list(turn.items).map(record);
  return (
    !!text(turn.id) &&
    ['completed', 'failed', 'interrupted'].includes(text(turn.status)) &&
    items.some((item) => item.type === 'userMessage') &&
    !items.some((item) => ['enteredReviewMode', 'exitedReviewMode'].includes(text(item.type)))
  );
}
export async function createCodexHistoryBackend(
  sessionId: string,
  directory: string,
  options: CodexRuntimeOptions = {},
): Promise<NativeActionBackend> {
  const client = await CodexClient.start({ ...options, cwd: directory });
  try {
    await client.initialize();
  } catch (error) {
    await client.close();
    throw error;
  }
  async function load() {
    return editableTurns(await checkedThread(client, sessionId, directory, true));
  }
  let inspected: { pointId: string; revision: string } | undefined;
  return {
    async read() {
      const turns = await load();
      return {
        revision: revision(turns),
        candidates: turns
          .flatMap((turn, index) => (candidate(turn) ? [{ id: text(turn.id), label: `第 ${index + 1} 轮及之后` }] : []))
          .slice(-128)
          .reverse(),
      };
    },
    async inspect(pointId) {
      const turns = await load(),
        index = turns.findIndex((turn) => turn.id === pointId && candidate(turn));
      if (index < 0) throw conflict();
      inspected = { pointId, revision: revision(turns) };
      return {
        files: [],
        removesTurns: turns.length - index,
        signature: createHash('sha256')
          .update(JSON.stringify(turns.slice(index)))
          .digest('hex'),
      };
    },
    async execute(pointId) {
      if (inspected?.pointId !== pointId) throw conflict();
      // thread/read可读磁盘记录，但revert要求已载入当前app-server；resume不发送模型输入。
      await client.request('thread/resume', { threadId: sessionId, cwd: directory, excludeTurns: true });
      if (revision(await load()) !== inspected.revision) throw conflict();
      await client.request('thread/revert', { threadId: sessionId, beforeTurnId: pointId });
      const after = await load();
      if (after.some((turn) => turn.id === pointId))
        return { status: 'unknown', message: '原生未确认历史回退结果，请重新读取会话。' };
      return { status: 'completed', message: '原生会话历史已回退，工作区文件保留。' };
    },
    close: () => client.close(),
  };
}
