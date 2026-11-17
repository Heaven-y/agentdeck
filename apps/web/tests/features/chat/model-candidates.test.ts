import { expect, it } from 'vitest';
import { matchingModels, modelCandidates, visibilityCandidates } from '../../../src/features/chat/model-candidates';
import { modelDisplay } from '../../../src/cli/shared/model-identity';

const models = ['one', 'two', 'new'].map((id) => ({ id, label: id }));
it('只列选中范围，保留当前模型身份且不自动纳入刷新后的新型号', () => {
  expect(modelCandidates(models, 'two', ['one']).map((model) => model.id)).toEqual(['two', 'one']);
  expect(modelCandidates(models, '', []).map((model) => model.id)).toEqual([]);
  expect(modelCandidates(models, '', undefined)).toEqual(models);
  expect(modelCandidates(models, 'manual', ['one']).map((model) => model.id)).toEqual(['manual', 'one']);
});

const native = { id: 'gemini-example-high', label: 'Gemini Example (High)' };
const alias = { id: 'configured', label: native.label, modelId: native.label };

it('AGY 合并原生型号与明确对应的配置名称，保留当前身份和两种检索入口', () => {
  for (const current of [alias.id, alias.modelId, native.id]) {
    const candidates = modelCandidates([native, alias], current, undefined, 'antigravity');
    expect(candidates.map((model) => model.id)).toEqual([current === native.id ? native.id : alias.id]);
    expect(matchingModels(candidates, native.id)).toHaveLength(1);
    expect(matchingModels(candidates, native.label)).toHaveLength(1);
  }
  expect(modelCandidates([native, alias], alias.id, [native.id], 'antigravity').map((model) => model.id)).toEqual([
    alias.id,
  ]);
  expect(modelCandidates([native, alias], '', [alias.id], 'antigravity').map((model) => model.id)).toEqual([alias.id]);
  expect(modelCandidates([native, alias], '', [], 'antigravity')).toEqual([]);
});

it('同名但底层型号不同、多个配置入口及其他 CLI 均不误合并', () => {
  const unrelated = { ...alias, modelId: 'different-model' };
  const ambiguous = [native, alias, { ...alias, id: 'other-config' }];
  expect(modelCandidates([native, unrelated], alias.id, undefined, 'antigravity')).toHaveLength(2);
  expect(modelCandidates(ambiguous, alias.id, undefined, 'antigravity')).toHaveLength(3);
  for (const catalog of [ambiguous, ambiguous.slice(1)]) {
    expect(modelCandidates(catalog, native.label, [alias.id], 'antigravity').map((model) => model.id)).toEqual([
      native.label,
      alias.id,
    ]);
  }
  expect(modelCandidates([native, alias], alias.id, undefined, 'claude')).toHaveLength(2);
  expect(modelCandidates([native, alias], alias.id, undefined, 'codex')).toHaveLength(2);
});

it('AGY 旧会话以显示名记录当前模型时，保留原始发送值并合并已确认的目录身份', () => {
  const catalog = [native, { ...alias, modelId: native.id }];
  for (const visible of [undefined, [native.id], [alias.id], []]) {
    const candidates = modelCandidates(catalog, native.label, visible, 'antigravity');
    expect(candidates.map((model) => model.id)).toEqual([native.label]);
    expect(matchingModels(candidates, native.id)).toHaveLength(1);
  }
});

it('AGY 缓存含显示名条目和多个配置入口时，当前原生名称不重复列出且保持发送身份', () => {
  const named = { id: native.label, label: native.label };
  const other = { id: 'gemini-other-high', label: 'Gemini Other (High)' };
  const catalog = [
    native,
    named,
    alias,
    { ...alias, id: 'window-config', modelId: native.id },
    { ...alias, id: 'saved-config', modelId: native.id },
    other,
  ];
  for (const current of [native.label, native.id]) {
    const candidates = modelCandidates(catalog, current, [native.id, other.id], 'antigravity');
    expect(candidates.map((model) => modelDisplay(model.id, model))).toEqual([native.id, other.id]);
    expect(candidates[0]!.id).toBe(current);
    expect(matchingModels(candidates, native.label)).toHaveLength(1);
    expect(matchingModels(candidates, native.id)).toHaveLength(1);
  }
  const all = modelCandidates(catalog, named.id, undefined, 'antigravity');
  expect(all.map((model) => model.id)).toEqual([named.id, alias.id, 'window-config', 'saved-config', other.id]);
  expect(all[0]!.modelId).toBe(native.id);
  const reversed = [named, native, ...catalog.slice(2)];
  expect(visibilityCandidates('antigravity', reversed).map((model) => model.id)).toEqual([
    native.id,
    alias.id,
    'window-config',
    'saved-config',
    other.id,
  ]);
});

it('相同名称的两个原生型号仍分别显示，不把未确认的名称关系合并', () => {
  const other = { id: 'different-native', label: native.label };
  expect(modelCandidates([native, other], native.id, undefined, 'antigravity').map((model) => model.id)).toEqual([
    native.id,
    other.id,
  ]);
});
