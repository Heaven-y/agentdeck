import type { AgentKind } from '../agents';
import type { AgentModel } from './capabilities';

export type NativeInteractionFeature = 'images' | 'documents' | 'questions' | 'forms' | 'steer' | 'subagents';
export type NativeRuntimePath = 'claude-sdk' | 'codex-app-server' | 'antigravity-headless' | 'antigravity-acp';
export type NativeFeatureAvailability = {
  /** 原生支持与工作台接入分开，未知不能当作不支持或已接入。 */
  support: 'supported' | 'unsupported' | 'unknown';
  available: boolean;
  reason?: string;
  limits?: {
    mimeTypes?: string[];
    maxCount?: number;
    maxBytes?: number;
    documentModes?: Array<'text-context' | 'file-reference' | 'native-document'>;
  };
};
export type NativeInteractionFeatures = Record<NativeInteractionFeature, NativeFeatureAvailability>;

/** 只由实际适配器提供；目录缓存、模型名和协议字段存在均不能代替运行证据。 */
export type NativeFeatureEvidence = {
  runtime: NativeRuntimePath;
  cliVersion?: string;
  sdkVersion?: string;
  handshake: 'confirmed' | 'unknown' | 'failed';
  protocolVersion?: number;
  acpCapabilities?: { image?: boolean; embeddedContext?: boolean };
  /** 非审计基线版本，以及 ACP 尚未验证的操作，须另有逐项运行证据。 */
  verifiedFeatures?: readonly NativeInteractionFeature[];
  /** 工作台已完成的接入；声明原生支持不会自动填入此表。 */
  implemented?: readonly NativeInteractionFeature[];
};

const FEATURE_NAMES: NativeInteractionFeature[] = ['images', 'documents', 'questions', 'forms', 'steer', 'subagents'];
const RUNTIME_AGENT: Record<NativeRuntimePath, AgentKind> = {
  'claude-sdk': 'claude',
  'codex-app-server': 'codex',
  'antigravity-headless': 'antigravity',
  'antigravity-acp': 'antigravity',
};
const AUDITED_VERSION: Record<AgentKind, string> = { claude: '2.1.317', codex: '0.166.0', antigravity: '1.5.3' };
const AUDITED_SDK_VERSION = '0.3.286';
const BASELINE_SUPPORT: Record<NativeRuntimePath, readonly NativeInteractionFeature[]> = {
  'claude-sdk': ['images', 'documents', 'questions', 'forms', 'subagents'],
  'codex-app-server': FEATURE_NAMES,
  'antigravity-headless': [],
  'antigravity-acp': [],
};

function unavailable(support: NativeFeatureAvailability['support'], reason: string): NativeFeatureAvailability {
  return { support, available: false, reason };
}

function unknownFeatures(): NativeInteractionFeatures {
  return Object.fromEntries(
    FEATURE_NAMES.map((name) => [name, unavailable('unknown', '尚未取得当前原生运行路径的能力证据。')]),
  ) as NativeInteractionFeatures;
}

function initialFeatures(runtime?: NativeRuntimePath): NativeInteractionFeatures {
  const features = unknownFeatures();
  if (runtime === 'antigravity-headless') {
    for (const name of ['images', 'questions', 'forms', 'steer'] as const)
      features[name] = unavailable('unsupported', 'AGY headless 没有此原生交互通道，不能借用 ACP 能力。');
  }
  return features;
}

function versionParts(version?: string): number[] | undefined {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return;
  const parts = version.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

function atLeast(version: string | undefined, baseline: string): boolean {
  const parts = versionParts(version);
  if (!parts) return false;
  const minimum = baseline.split('.').map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (parts[i]! > minimum[i]!) return true;
    if (parts[i]! < minimum[i]!) return false;
  }
  return true;
}

function versionVerified(agent: AgentKind, evidence: NativeFeatureEvidence, name: NativeInteractionFeature): boolean {
  if (!atLeast(evidence.cliVersion, AUDITED_VERSION[agent])) return false;
  if (agent === 'claude' && !atLeast(evidence.sdkVersion, AUDITED_SDK_VERSION)) return false;
  const audited =
    evidence.cliVersion === AUDITED_VERSION[agent] &&
    (agent !== 'claude' || evidence.sdkVersion === AUDITED_SDK_VERSION);
  // 更新版本可逐项确认，不凭“版本更高”推断兼容，也不编造支持上限。
  return audited || evidence.verifiedFeatures?.includes(name) === true;
}

function acpSupport(name: NativeInteractionFeature, evidence: NativeFeatureEvidence): NativeFeatureAvailability {
  const advertised =
    name === 'images'
      ? evidence.acpCapabilities?.image
      : name === 'documents'
        ? evidence.acpCapabilities?.embeddedContext
        : undefined;
  if (advertised === false) return unavailable('unsupported', '当前 ACP 握手明确不支持此输入。');
  if (advertised === true || evidence.verifiedFeatures?.includes(name))
    return { support: 'supported', available: false };
  return unavailable('unknown', '当前 ACP 尚未逐项验证此交互。');
}

function nativeSupport(name: NativeInteractionFeature, evidence: NativeFeatureEvidence): NativeFeatureAvailability {
  if (evidence.runtime === 'antigravity-acp') return acpSupport(name, evidence);
  if (BASELINE_SUPPORT[evidence.runtime].includes(name) || evidence.verifiedFeatures?.includes(name))
    return { support: 'supported', available: false };
  return unavailable('unknown', '当前运行路径尚未逐项核实此交互。');
}

function featureLimits(
  name: NativeInteractionFeature,
  runtime: NativeRuntimePath,
): NativeFeatureAvailability['limits'] {
  if (name === 'images')
    return {
      mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxCount: 4,
      maxBytes: 5 * 1024 * 1024,
    };
  if (name === 'documents')
    return {
      documentModes:
        runtime === 'claude-sdk'
          ? ['text-context', 'native-document']
          : runtime === 'antigravity-acp'
            ? ['file-reference']
            : ['file-reference'],
    };
  return undefined;
}

function runtimeVerified(evidence: NativeFeatureEvidence): boolean {
  return (
    evidence.handshake === 'confirmed' && (evidence.runtime !== 'antigravity-acp' || evidence.protocolVersion === 1)
  );
}

function resolvedFeature(name: NativeInteractionFeature, evidence: NativeFeatureEvidence): NativeFeatureAvailability {
  const feature = nativeSupport(name, evidence);
  if (feature.support !== 'supported') return feature;
  feature.available = evidence.implemented?.includes(name) === true;
  feature.reason = feature.available ? undefined : '原生支持已核实，工作台尚未接入此交互。';
  feature.limits = featureLimits(name, evidence.runtime);
  return feature;
}

/** 文本对话不依赖本契约。新交互必须同时通过路径、版本、握手与实现检查。 */
export function nativeFeaturesFor(agent: AgentKind, evidence?: NativeFeatureEvidence): NativeInteractionFeatures {
  if (!evidence || RUNTIME_AGENT[evidence.runtime] !== agent) return unknownFeatures();
  const features = initialFeatures(evidence.runtime);
  if (!runtimeVerified(evidence)) return features;
  for (const name of FEATURE_NAMES) {
    if (features[name].support === 'unsupported' || !versionVerified(agent, evidence, name)) continue;
    features[name] = resolvedFeature(name, evidence);
  }
  return features;
}

/** 模型元数据只能收紧当前路径的能力；缺少 features 的旧目录始终保守。 */
export function featuresForModel(features?: NativeInteractionFeatures, model?: AgentModel): NativeInteractionFeatures {
  const result = features ? structuredClone(features) : unknownFeatures();
  if (!model?.inputModalities) return result;
  if (!model.inputModalities.includes('image'))
    result.images = { ...result.images, available: false, reason: '当前模型明确未声明图片输入。' };
  if (!model.inputModalities.includes('document') && result.documents.limits?.documentModes) {
    // 文本上下文与文件引用仍由原生工具处理，不冒称模型直接读取原始文档。
    result.documents.limits.documentModes = result.documents.limits.documentModes.filter(
      (mode) => mode !== 'native-document',
    );
    if (!result.documents.limits.documentModes.length) {
      result.documents.available = false;
      result.documents.reason = '当前模型明确未声明原生文档输入。';
    }
  }
  return result;
}
