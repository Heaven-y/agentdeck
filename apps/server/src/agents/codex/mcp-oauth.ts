import { CodexClient } from './client';
import type { McpContext } from '../../native-management/mcp-types';
import type { McpOAuthSession } from '../../native-management/mcp-oauth';
/** 独立 app-server 只负责此次授权，关闭即取消原生等待；不关闭用户的对话实例。 */
export async function loginCodexMcp(context: McpContext, name: string, session: McpOAuthSession) {
  const client = await CodexClient.start({
    cwd: context.project?.dir ?? context.homeDir,
    env: context.env,
    signal: session.signal,
  });
  let loginId: string | undefined;
  const early: Record<string, unknown>[] = [];
  let finish!: (ok: boolean) => void;
  const completed = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const deliver = (params: Record<string, unknown>) => {
    if (params.name === name && params.loginId === loginId && params.threadId == null) finish(params.success === true);
  };
  client.onNotification = (method, params) => {
    if (method !== 'mcpServer/oauthLogin/completed') return;
    if (loginId) deliver(params);
    else if (early.length < 8) early.push(params);
  };
  void client.closed.then(() => finish(false));
  try {
    await client.initialize();
    const result = await client.request('mcpServer/oauth/login', { name, timeoutSecs: 120 });
    if (typeof result.loginId !== 'string' || typeof result.authorizationUrl !== 'string') throw new Error();
    loginId = result.loginId;
    session.authorize(result.authorizationUrl);
    early.forEach(deliver);
    if (!(await completed)) throw new Error();
  } finally {
    await client.close();
  }
}
