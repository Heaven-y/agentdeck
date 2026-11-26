import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { AntigravityMainAgents } from '@agentdeck/shared/conversation';
import { SessionError } from '../../errors';
import { startManagementBackend } from '../management/management-process';
import {
  managementObject as object,
  managementText as text,
  type ManagementBackend,
} from '../management/management-rpc';
import { assertDirectory } from '../management/trajectory-scope';

export async function nativeMainAgents(backend: ManagementBackend, dir: string) {
  const result = await backend.request('GetAgentScripts', { workspaceUris: [pathToFileURL(dir).href] }, 'page');
  if (!Array.isArray(result.agentCustomizations))
    throw new SessionError(503, 'main_agents_unavailable', '主代理列表读取失败，请重试。');
  return result.agentCustomizations.map(object).filter((entry) => {
    const agent = object(entry.agent);
    return text(agent.name) && agent.mainAgent !== false;
  });
}

export async function nativeMainAgentOverride(backend: ManagementBackend, dir: string, name: string) {
  if (!name) return {};
  const matching = (await nativeMainAgents(backend, dir)).filter((entry) => object(entry.agent).name === name);
  if (matching.length !== 1) throw new SessionError(400, 'main_agent_missing', '所选主代理已变化，请重新选择。');
  return object(matching[0]!.agent);
}

export async function readAntigravityMainAgents(
  dir: string,
  options: { env: NodeJS.ProcessEnv; sessionId?: string; signal?: AbortSignal },
): Promise<AntigravityMainAgents> {
  const home = (process.platform === 'win32' ? options.env.USERPROFILE : options.env.HOME) ?? homedir();
  const signal = AbortSignal.any([AbortSignal.timeout(15000), ...(options.signal ? [options.signal] : [])]);
  const backend = await startManagementBackend({
    cwd: dir,
    env: options.env,
    geminiDir: path.join(home, '.gemini'),
    signal,
  });
  try {
    const entries = (await nativeMainAgents(backend, dir)).map((entry) => ({
      name: text(object(entry.agent).name),
      description: text(object(entry.agent).description),
      scope: entry.isGlobal ? ('user' as const) : ('project' as const),
    }));
    if (!options.sessionId) return { entries };
    const { metadata } = await backend.request(
      'GetConversationMetadata',
      { conversationId: options.sessionId },
      'page',
    );
    await assertDirectory(object(metadata), dir);
    return { entries, current: text(object(object(metadata).agentScript).name) };
  } finally {
    await backend.close();
  }
}
