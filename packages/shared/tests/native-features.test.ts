import { describe, expect, it } from 'vitest';
import { featuresForModel, nativeFeaturesFor, type AgentCapabilities } from '../src/conversation';

describe('原生交互能力边界', () => {
  it('旧能力缓存缺少 features 时不能启用新交互', () => {
    const cached: AgentCapabilities = { agent: 'claude', entries: [], models: [], warnings: [] };
    expect(Object.values(featuresForModel(cached.features)).every((feature) => !feature.available)).toBe(true);
  });

  it('区分 AGY headless 与完成握手的 ACP，握手不能代表工作台已接入', () => {
    const headless = nativeFeaturesFor('antigravity', {
      runtime: 'antigravity-headless',
      cliVersion: '1.5.3',
      handshake: 'confirmed',
      implemented: ['images'],
    });
    expect(headless.images).toMatchObject({ support: 'unsupported', available: false });
    const acp = nativeFeaturesFor('antigravity', {
      runtime: 'antigravity-acp',
      cliVersion: '1.5.3',
      handshake: 'confirmed',
      protocolVersion: 1,
      acpCapabilities: { image: true, embeddedContext: true },
    });
    expect(acp.images).toMatchObject({ support: 'supported', available: false });
    expect(acp.documents).toMatchObject({ support: 'supported', available: false });
    expect(acp.questions).toMatchObject({ support: 'unknown', available: false });
  });

  it.each(['unknown', 'failed'] as const)('握手%s时即使有已知版本与实现标记仍保守禁用', (handshake) => {
    const features = nativeFeaturesFor('codex', {
      runtime: 'codex-app-server',
      cliVersion: '0.166.0',
      handshake,
      implemented: ['images', 'steer'],
    });
    expect(Object.values(features).every((feature) => feature.support === 'unknown' && !feature.available)).toBe(true);
  });

  it('路径、版本与协议不明不能借用另一适配器的证据', () => {
    expect(
      nativeFeaturesFor('claude', {
        runtime: 'codex-app-server',
        cliVersion: '0.166.0',
        handshake: 'confirmed',
        implemented: ['images'],
      }).images.available,
    ).toBe(false);
    expect(
      nativeFeaturesFor('antigravity', {
        runtime: 'antigravity-acp',
        cliVersion: '1.5.3',
        handshake: 'confirmed',
        protocolVersion: 2,
        acpCapabilities: { image: true },
        implemented: ['images'],
      }).images.support,
    ).toBe('unknown');
    expect(
      nativeFeaturesFor('claude', {
        runtime: 'claude-sdk',
        handshake: 'confirmed',
        implemented: ['images'],
      }).images.support,
    ).toBe('unknown');
  });

  it('已核实 Claude SDK 可声明支持，只有实现完成的功能可以启用', () => {
    const features = nativeFeaturesFor('claude', {
      runtime: 'claude-sdk',
      cliVersion: '2.1.317',
      sdkVersion: '0.3.286',
      handshake: 'confirmed',
      implemented: ['images'],
    });
    expect(features.images).toMatchObject({ support: 'supported', available: true });
    expect(features.questions).toMatchObject({ support: 'supported', available: false });
    expect(features.subagents.available).toBe(false);
    expect(features.images.limits?.mimeTypes).toContain('image/png');
  });

  it('较新版本须逐项核实运行能力，不能仅凭版本号开启，也不一律拒绝', () => {
    const evidence = {
      runtime: 'codex-app-server' as const,
      cliVersion: '0.167.0',
      handshake: 'confirmed' as const,
      implemented: ['images', 'steer'] as const,
    };
    expect(nativeFeaturesFor('codex', evidence).images.available).toBe(false);
    const verified = nativeFeaturesFor('codex', { ...evidence, verifiedFeatures: ['images'] });
    expect(verified.images.available).toBe(true);
    expect(verified.steer.available).toBe(false);
    expect(nativeFeaturesFor('codex', { ...evidence, cliVersion: 'unknown' }).images.support).toBe('unknown');
  });

  it('Claude 引导调度边界未经逐项验证，不能仅凭 SDK 输入流支持就启用', () => {
    const evidence = {
      runtime: 'claude-sdk' as const,
      cliVersion: '2.1.317',
      sdkVersion: '0.3.286',
      handshake: 'confirmed' as const,
      implemented: ['steer'] as const,
    };
    expect(nativeFeaturesFor('claude', evidence).steer).toMatchObject({ support: 'unknown', available: false });
    expect(nativeFeaturesFor('claude', { ...evidence, verifiedFeatures: ['steer'] }).steer.available).toBe(true);
  });

  it('headless 保留独立核实的文件引用与子代理读取，不能据此开启 ACP 原生直通', () => {
    const features = nativeFeaturesFor('antigravity', {
      runtime: 'antigravity-headless',
      cliVersion: '1.5.3',
      handshake: 'confirmed',
      verifiedFeatures: ['subagents', 'documents', 'images'],
      implemented: ['subagents', 'documents', 'images'],
    });
    expect(features.subagents).toMatchObject({ support: 'supported', available: true });
    expect(features.documents).toMatchObject({ available: true, limits: { documentModes: ['file-reference'] } });
    expect(features.images).toMatchObject({ support: 'unsupported', available: false });
  });

  it('ACP 显式否定输入能力时，即使提供实现及验证标记也不能开启', () => {
    const features = nativeFeaturesFor('antigravity', {
      runtime: 'antigravity-acp',
      cliVersion: '1.5.3',
      handshake: 'confirmed',
      protocolVersion: 1,
      acpCapabilities: { image: false, embeddedContext: false },
      implemented: ['images', 'documents'],
      verifiedFeatures: ['images', 'documents'],
    });
    expect(features.images).toMatchObject({ support: 'unsupported', available: false });
    expect(features.documents).toMatchObject({ support: 'unsupported', available: false });
  });

  it('文本模型保留文件引用及文本上下文，不能把原生文档内容块视为已支持', () => {
    const model = { id: 'text', label: '文本', inputModalities: ['text'] };
    const claude = nativeFeaturesFor('claude', {
      runtime: 'claude-sdk',
      cliVersion: '2.1.317',
      sdkVersion: '0.3.286',
      handshake: 'confirmed',
      implemented: ['documents'],
    });
    const limited = featuresForModel(claude, model);
    expect(limited.documents).toMatchObject({ available: true, limits: { documentModes: ['text-context'] } });
    expect(claude.documents.limits?.documentModes).toContain('native-document');
    const codex = nativeFeaturesFor('codex', {
      runtime: 'codex-app-server',
      cliVersion: '0.166.0',
      handshake: 'confirmed',
      implemented: ['documents'],
    });
    expect(featuresForModel(codex, model).documents).toMatchObject({
      available: true,
      limits: { documentModes: ['file-reference'] },
    });
  });

  it('模型明确输入限制优先，未知或图片模型不能反向开启协议未接入的功能', () => {
    const features = nativeFeaturesFor('codex', {
      runtime: 'codex-app-server',
      cliVersion: '0.166.0',
      handshake: 'confirmed',
      implemented: ['images', 'documents'],
    });
    expect(featuresForModel(features, { id: 'text', label: '文本', inputModalities: ['text'] }).images.available).toBe(
      false,
    );
    expect(featuresForModel(features, { id: 'empty', label: '无输入', inputModalities: [] }).images.available).toBe(
      false,
    );
    expect(
      featuresForModel(features, { id: 'image', label: '图片', inputModalities: ['text', 'image'] }).images.available,
    ).toBe(true);
    expect(
      featuresForModel(undefined, { id: 'image', label: '图片', inputModalities: ['image'] }).images.available,
    ).toBe(false);
    expect(features.images.available).toBe(true);
  });
});
