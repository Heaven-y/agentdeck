import { AcpError, list, object, type AcpConnection, type AcpRecord } from './types';

export type AcpAuthentication = 'gemini-api-key' | 'oauth-personal';
export const ACCOUNT_ACP_AUTH: AcpAuthentication = 'oauth-personal';

export async function initializeAcp(
  client: AcpConnection,
  signal: AbortSignal,
  elicitation = false,
): Promise<AcpRecord> {
  const initialized = await client.request(
    'initialize',
    {
      protocolVersion: 1,
      clientInfo: { name: 'agentdeck', title: 'AgentDeck', version: '0.1.1' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...(elicitation ? { elicitation: { form: {}, url: {} } } : {}),
      },
    },
    { signal },
  );
  if (initialized.protocolVersion !== 1) throw new AcpError('unavailable', '当前 Antigravity CLI 版本不兼容。');
  return initialized;
}

export const hasAcpAuth = (initialized: AcpRecord, method: AcpAuthentication): boolean =>
  list(initialized.authMethods).some((value) => object(value).id === method);

export const acpPromptCapabilities = (initialized: AcpRecord): AcpRecord =>
  object(object(initialized.agentCapabilities).promptCapabilities);

export function canResumeAcp(initialized: AcpRecord): boolean {
  const resume = object(object(initialized.agentCapabilities).sessionCapabilities).resume;
  return !!resume && typeof resume === 'object' && !Array.isArray(resume);
}
