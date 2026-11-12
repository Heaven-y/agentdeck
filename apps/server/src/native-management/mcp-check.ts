import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { CodexClient } from '../agents/codex/client';
import { codexMcpControl } from '../agents/codex/mcp-control';
import { nativeClaudeQuery, createClaudeStream } from '../agents/claude/query';
import { claudeMcpControl } from '../agents/claude/mcp-control';
import type { McpContext } from './mcp-types';
import { NativeManagementError } from './errors';
export async function checkMcpConnection(context: McpContext, name: string, config: Record<string, unknown>) {
  const id = randomUUID();
  if (context.agent === 'antigravity') throw new NativeManagementError('unsupported_action');
  if (context.agent === 'codex') {
    const client = await CodexClient.start({ cwd: context.project?.dir ?? context.homeDir, env: context.env });
    try {
      await client.initialize();
      return {
        ...(await codexMcpControl(client, id, () => undefined).status(name)),
        canReconnect: false,
        canToggle: false,
      };
    } finally {
      await client.close();
    }
  }
  const stream = createClaudeStream();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 15_000);
  const query = nativeClaudeQuery({
    prompt: stream.prompt,
    options: {
      cwd: context.project?.dir ?? context.homeDir,
      env: context.env,
      abortController,
      settingSources: [],
      strictMcpConfig: true,
      settings: { disableAllHooks: true },
      mcpServers: { [name]: config },
      onElicitation: () => Promise.resolve({ action: 'cancel' }),
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: '连接检查不执行工具。' }),
    } as unknown as Options,
  });
  const consume = (async () => {
    for await (const _message of query) {
      /* 消费协议，不向模型发送输入。 */
    }
  })().catch(() => undefined);
  try {
    const control = claudeMcpControl(query, id);
    let status = await control.status(name);
    const deadline = Date.now() + 8_000;
    while (status.state === 'starting' && Date.now() < deadline && !abortController.signal.aborted) {
      await delay(100, undefined, { signal: abortController.signal });
      status = await control.status(name);
    }
    return { ...status, canReconnect: false, canToggle: false };
  } finally {
    clearTimeout(timer);
    stream.close();
    query.close();
    await consume;
  }
}
