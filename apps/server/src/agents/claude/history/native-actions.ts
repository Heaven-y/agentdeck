import { createHash } from 'node:crypto';
import type { NativeActionBackend, NativeActionState } from '../../common/interaction/native-actions';
import { createClaudeSessions } from './sessions';
import { claudeControl, createClaudeStream, nativeClaudeQuery, type ClaudeQuery } from '../run/query';
import { SessionError } from '../../errors';
import { record, text } from '../../common/interaction/user-interaction-fields';
const failure = () =>
  new SessionError(409, 'checkpoint_unavailable', '原生没有此位置可恢复的文件检查点，请选择其他位置。');

export function createClaudeRewindBackend(
  sessionId: string,
  directory: string,
  env?: NodeJS.ProcessEnv,
): NativeActionBackend {
  let query: ClaudeQuery | undefined,
    stream: ReturnType<typeof createClaudeStream> | undefined,
    consumer: Promise<void> | undefined;
  async function read(): Promise<NativeActionState> {
    const history = await createClaudeSessions().read(sessionId, directory);
    const candidates = history.events
      .filter((event) => event.type === 'user_message')
      .flatMap((event, index) =>
        event.nativeInputId ? [{ id: event.nativeInputId, label: `第 ${index + 1} 项用户输入之前` }] : [],
      )
      .slice(-128)
      .reverse();
    return { candidates, revision: createHash('sha256').update(JSON.stringify(history.events)).digest('hex') };
  }
  function ensure(): ClaudeQuery {
    if (query) return query;
    stream = createClaudeStream();
    query = nativeClaudeQuery({
      prompt: stream.prompt,
      options: {
        cwd: directory,
        env,
        resume: sessionId,
        enableFileCheckpointing: true,
        settingSources: ['user', 'project', 'local'],
      },
    });
    const active = query;
    consumer = (async () => {
      for await (const _message of active) {
        /* 控制进程不向模型发送输入，不把恢复事件回传成新消息。 */
      }
    })().catch(() => undefined);
    return query;
  }
  async function rewind(pointId: string, dryRun: boolean) {
    const native = ensure();
    if (!native.rewindFiles) throw failure();
    return record(await claudeControl(native.rewindFiles(pointId, { dryRun }), undefined, 15_000));
  }
  return {
    read,
    async inspect(pointId) {
      const value = await rewind(pointId, true);
      if (value.canRewind !== true || !Array.isArray(value.filesChanged)) throw failure();
      const files = value.filesChanged.map(text);
      if (files.some((file) => !file)) throw failure();
      return {
        files,
        signature: createHash('sha256')
          .update(JSON.stringify([files, value.insertions, value.deletions]))
          .digest('hex'),
      };
    },
    async execute(pointId) {
      const value = await rewind(pointId, false);
      if (value.canRewind !== true) throw failure();
      return typeof value.skippedLinks === 'number' && value.skippedLinks > 0
        ? { status: 'partial', message: '文件已回退，但部分链接文件未恢复。请检查这些文件。' }
        : { status: 'completed', message: '文件已回退，会话历史保留。' };
    },
    async close() {
      stream?.close();
      query?.close();
      if (consumer) await claudeControl(consumer, undefined, 5000).catch(() => undefined);
    },
  };
}
