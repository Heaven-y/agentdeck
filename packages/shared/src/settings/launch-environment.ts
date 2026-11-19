import { z } from 'zod';
import type { AgentKind } from '../conversation/agents';

export const ANTIGRAVITY_PROXY_VARIABLES = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'] as const;
export function isAntigravityProxyVariable(name: string): boolean {
  return ANTIGRAVITY_PROXY_VARIABLES.some((variable) => variable === name);
}

export const AntigravityProxyInputSchema = z.strictObject({
  revision: z.string().regex(/^(missing|[a-f0-9]{64})$/),
  address: z.string().trim().max(4096),
});
export type AntigravityProxyInput = z.infer<typeof AntigravityProxyInputSchema>;
/** 只返回代理端点，不回显代理用户名和密码。 */
export type AntigravityProxyDocument = { revision: string; address: string };

export const LaunchVariableModeSchema = z.enum(['inherit', 'set', 'disabled']);
export const LaunchEnvironmentInputSchema = z.strictObject({
  revision: z.string().regex(/^(missing|[a-f0-9]{64})$/),
  variables: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(80),
        mode: LaunchVariableModeSchema,
        value: z
          .string()
          .min(1)
          .max(4096)
          .regex(/^[^\r\n\0]+$/)
          .optional(),
      }),
    )
    .max(16),
});
export type LaunchEnvironmentInput = z.infer<typeof LaunchEnvironmentInputSchema>;
export const LaunchSecretInputSchema = z.strictObject({
  revision: z.string().regex(/^(missing|[a-f0-9]{64})$/),
  name: z.string().min(1).max(80),
});
export type LaunchSecretInput = z.infer<typeof LaunchSecretInputSchema>;
export type LaunchVariableMode = z.infer<typeof LaunchVariableModeSchema>;
export type LaunchEnvironmentDocument = {
  agent: AgentKind;
  revision: string;
  encryptionAvailable: boolean;
  note: string;
  variables: Array<{
    name: string;
    label: string;
    sensitive: boolean;
    mode: LaunchVariableMode;
    source: 'inherited' | 'configured' | 'disabled' | 'unset';
    hasValue: boolean;
  }>;
};
