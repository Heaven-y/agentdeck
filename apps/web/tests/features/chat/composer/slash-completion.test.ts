import { describe, expect, it } from 'vitest';
import type { AgentCapability } from '@agentdeck/shared/conversation';
import { resumeArgument, resumeSuggestionMatches } from '../../../../src/features/chat/composer/resume-command';
import { matchesCapability, slashCompletion } from '../../../../src/features/chat/composer/slash-completion';

describe('原生命令补全', () => {
  it('只补全开头命令名，并保留已经输入的参数', () => {
    expect(slashCompletion('/', 1)).toEqual({ query: '', remainder: '' });
    expect(slashCompletion(' /ana 检查数据\n保留限制', 5)).toEqual({ query: 'ana', remainder: '检查数据\n保留限制' });
    expect(slashCompletion('/技能', 3)).toEqual({ query: '技能', remainder: '' });
  });

  it('路径、正文、参数区和非空选区不触发补全', () => {
    for (const text of ['/tmp/example.py', '请检查 /ana', '/ana 参数']) {
      expect(slashCompletion(text, text.length)).toBeUndefined();
    }
    expect(slashCompletion('/ana', 0)).toBeUndefined();
    expect(slashCompletion('/ana', 1, 4)).toBeUndefined();
  });

  it('按钮与输入补全共用名称、别名、描述和来源搜索', () => {
    const entry: AgentCapability = {
      id: 'skill-id',
      kind: 'skill',
      name: 'analyze',
      aliases: ['CHECK'],
      description: '检查数据',
      source: '工作区',
      available: true,
      requiresSession: false,
      supportsArguments: true,
    };
    for (const phrase of ['', 'ANA', 'check', '数据', '工作区']) expect(matchesCapability(entry, phrase)).toBe(true);
    expect(matchesCapability(entry, 'missing')).toBe(false);
  });
});

it('续聊只拦截当前 CLI 的完整命令词，别名的前缀只参与补全', () => {
  expect(resumeArgument('/resume', 'codex')).toBe('');
  expect(resumeArgument('/switch 分析记录', 'antigravity')?.trim()).toBe('分析记录');
  expect(resumeArgument('/conversation', 'claude')).toBeUndefined();
  expect(resumeArgument('/continue', 'claude')).toBe('');
  expect(resumeArgument('/continue', 'codex')).toBeUndefined();
  expect(resumeSuggestionMatches('con', 'antigravity')).toBe(true);
  expect(resumeArgument('/con', 'antigravity')).toBeUndefined();
  for (const text of ['请解释 /resume', '/resume/log', '/resume-notes'])
    expect(resumeArgument(text, 'antigravity')).toBeUndefined();
});
