// 只读原生子线程夹具：未知方法明确失败，不接受模型消息或管理写入。
import { createInterface } from 'node:readline';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=';
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const imageData = () => (process.env.SUBAGENT_LARGE_PAGE ? 'a'.repeat(9 * 1024 * 1024) : png);
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
    if (message.method === 'initialized') return;
    let result: Record<string, unknown>;
    if (message.method === 'initialize') result = {};
    else if (message.method === 'thread/read') {
      const id = message.params?.threadId;
      result = {
        thread: {
          id,
          cwd: process.cwd(),
          source: id === 'root' ? 'cli' : { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } },
          parentThreadId: id === 'root' ? null : 'root',
          status: { type: 'idle' },
        },
      };
    } else if (message.method === 'thread/turns/list') {
      const id = message.params?.threadId;
      const image = imageData();
      const items =
        id === 'root'
          ? [{ id: 'activity', type: 'subAgentActivity', agentThreadId: 'child', kind: 'completed' }]
          : [
              { id: 'image', type: 'userMessage', content: [{ type: 'image', url: `data:image/png;base64,${image}` }] },
              { id: 'reply', type: 'agentMessage', text: '独立回复' },
            ];
      result = { data: [{ id: 'turn', status: 'completed', itemsView: 'full', items }], nextCursor: null };
    } else {
      write({ id: message.id, error: { code: -32601, message: '夹具禁止此方法' } });
      return;
    }
    write({ id: message.id, result });
  })
  .on('close', () => process.exit(0));
