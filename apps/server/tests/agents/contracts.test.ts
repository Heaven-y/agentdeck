import { expectTypeOf, it } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeQuery } from '../../src/agents/claude/query';
import type { ClaudeSessionsApi } from '../../src/agents/claude/sessions';
import type { SessionProvider } from '../../src/agents/contracts';
import type { createSessionsService } from '../../src/sessions/service';
import type { TurnManagerDeps } from '../../src/chat/turn-manager';

it('固定SDK控制方法与原生会话管理均为必需契约', () => {
  type Controls = Pick<ClaudeQuery, 'close' | 'supportedCommands' | 'supportedModels' | 'getContextUsage'>;
  expectTypeOf<Controls>().toEqualTypeOf<Pick<Query, keyof Controls>>();
  type ClaudeManagement = Omit<ClaudeSessionsApi, 'listProject'>;
  expectTypeOf<ClaudeManagement>().toEqualTypeOf<Required<ClaudeManagement>>();
  type Management = Omit<SessionProvider, 'capabilities' | 'listProjects' | 'page' | 'subagents' | 'media'>;
  expectTypeOf<Management>().toEqualTypeOf<Required<Management>>();
  type Operations = Parameters<typeof createSessionsService>[1];
  expectTypeOf<Operations>().toEqualTypeOf<NonNullable<Operations>>();
});

it('运行器只有显式入口', () => {
  type Runners = Pick<TurnManagerDeps, 'runners'>;
  expectTypeOf<Runners>().toEqualTypeOf<Required<Runners>>();
  expectTypeOf<'runTurn' extends keyof TurnManagerDeps ? true : false>().toEqualTypeOf<false>();
});
