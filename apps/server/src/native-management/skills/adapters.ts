import type { AgentKind } from '@agentdeck/shared/conversation';
import { antigravitySkills } from '../../agents/antigravity/configuration/skills';
import { claudeSkills } from '../../agents/claude/configuration/skills';
import { codexSkills } from '../../agents/codex/configuration/skills';
import type { SkillAdapter } from './types';

export const skillAdapters: Record<AgentKind, SkillAdapter> = {
  claude: claudeSkills,
  codex: codexSkills,
  antigravity: antigravitySkills,
};
