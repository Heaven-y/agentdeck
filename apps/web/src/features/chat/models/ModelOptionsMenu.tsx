import { AGENT_LABELS } from '../../../cli/shared/labels';
import { MenuChoice as Choice, modelMenuItemClass as itemClass } from '../../../ui/fields/MenuChoice';
import { ClaudeContextChoices } from '../../../cli/claude/ContextChoices';
import { ApiError } from '../../../lib/http';
import { projectsKeys } from '../../projects/api';
import { Menu, MenuButton, MenuGroup, MenuItem, MenuProvider, MenuSeparator, useMenuStore } from '@ariakit/react';
import { Brain, ChevronDown, ChevronRight, Gauge, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AGENT_KINDS, type AgentCapabilities, type AgentKind } from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';

import { ProjectManageDialog } from '../../projects/ProjectManageDialog';
import { buttonClass } from '../../../ui/styles';
import { agentUnavailable, useEnvironment } from '../../settings/environment/use-environment';
import { sessionActionKey, useChat } from '../state/chat-store';
import { useAgentCapabilities } from '../controls/use-agent-capabilities';
import { AgentIcon } from '../../../ui/BrandIcons';
import { nativeCapabilitiesGeneration } from '../../../cli/shared/capability-cache';
import { OfficialUsageDialog, useOfficialUsage } from './OfficialUsageDialog';
import { ManualModelDialog } from './ManualModelDialog';
import { modelVisibilityKey } from '../../../cli/shared/model-visibility';
import { findModel, modelDisplay } from '../../../cli/shared/model-identity';
import { ANTIGRAVITY_CONNECTION_LABELS } from '../../../cli/antigravity/model-policy';
import { configuredModelEffort, modelEfforts } from '../../../cli/model-capabilities';
import { ModelCandidateLabel } from './ModelCandidateLabel';
import { ModelSearchDialog } from './ModelSearchDialog';
import { currentModelCandidate, modelCandidates, type ModelOrigin } from '../../../cli/shared/model-candidates';

const menuClass =
  'z-50 max-h-[min(440px,var(--popover-available-height))] w-72 overflow-y-auto rounded-2xl border border-border bg-card p-1 text-foreground shadow-lg';
const triggerClass = `${buttonClass('ghost')} min-h-7 min-w-0 gap-1 rounded-lg px-2 text-[13px]`;

function CatalogStatus({ catalog }: { catalog: ReturnType<typeof useAgentCapabilities> }) {
  if (catalog.isFetching && !catalog.data?.models.length)
    return (
      <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
        正在加载模型…
      </p>
    );
  if (catalog.isError)
    return (
      <p role="alert" className="px-3 py-2 text-xs leading-5 text-warning">
        {catalog.error instanceof ApiError ? catalog.error.message : '暂时无法读取模型。'}
      </p>
    );
  const warning = catalogWarning(catalog.data);
  if (warning) return <p className="px-3 py-1 text-xs leading-5 text-warning">{warning}</p>;
  return null;
}
function catalogWarning(data?: AgentCapabilities) {
  if (data?.agent === 'antigravity' && !data.antigravityConnection)
    return data.modelWarning || '无法确认当前的 AGY 连接方式，请核对原生配置。';
  return data?.discovered ? (data.modelWarning ?? data.warnings[0]) : undefined;
}
function useModelVisibility(catalog?: AgentCapabilities) {
  return useChat((state) => {
    const key = modelVisibilityKey(state.agent, catalog?.antigravityConnection);
    return key ? state.defaults.modelVisibility?.[key] : undefined;
  });
}
function ModelVisibilityNotice({ hidden }: { hidden: number }) {
  if (hidden < 1) return null;
  return (
    <p role="status" className="px-3 py-2 text-xs leading-5 text-muted-foreground">
      已按保存的显示范围筛选，还有 {hidden} 个模型未显示。到设置 → 模型 → 当前 CLI
      的「对话菜单中的模型」恢复全部模型，再保存配置。
    </p>
  );
}
function RefreshModels({ catalog, disabled }: { catalog: ReturnType<typeof useAgentCapabilities>; disabled: boolean }) {
  return (
    <MenuItem
      className={itemClass}
      disabled={disabled || catalog.isFetching}
      hideOnClick={false}
      onClick={catalog.refresh}
      title="重新读取模型"
    >
      <RefreshCw aria-hidden className={`size-3.5 ${catalog.isFetching ? 'motion-safe:animate-spin' : ''}`} />
      {catalog.isError || catalog.data?.modelWarning ? '重试' : '刷新模型列表'}
    </MenuItem>
  );
}

type CatalogProps = { disabled: boolean; catalog: ReturnType<typeof useAgentCapabilities> };
function inheritedModel(
  native?: string,
  actual?: string,
  configured?: string,
  runtime?: { agent: AgentKind; running: boolean },
) {
  const fallback = native || actual || configured || '';
  if (runtime?.agent === 'antigravity') return (runtime.running && actual) || configured || fallback;
  return fallback;
}

function modelOrigin(input: {
  agent: AgentKind;
  model: string;
  running: boolean;
  actual?: string;
  native?: string;
  configured?: string;
}): ModelOrigin {
  if (input.agent !== 'antigravity' || input.model) return 'selection';
  if (input.running && input.actual) return 'native';
  return !input.configured && (input.native || input.actual) ? 'native' : 'selection';
}

function modelMetadata(id: string, agent: AgentKind, origin: ModelOrigin, catalog?: AgentCapabilities) {
  const candidate = currentModelCandidate(catalog?.models ?? [], id, agent, origin);
  const capabilityId = origin === 'native' ? (candidate?.id ?? '') : id;
  return {
    selected: candidate?.id,
    capabilityId,
    label: modelDisplay(origin === 'native' ? (candidate?.id ?? id) : id, candidate),
  };
}

function useModelPresentation(model: string, catalog: AgentCapabilities | undefined, fetching: boolean) {
  const agent = useChat((state) => state.agent);
  const actual = useChat((state) => state.actualModel);
  const running = useChat((state) => state.running);
  const native = useChat((state) => {
    if (!state.workspaceId || !state.sessionId) return undefined;
    return state.sessionModels[sessionActionKey(state.workspaceId, { agent: state.agent, sessionId: state.sessionId })]
      ?.nativeModel;
  });
  const reading = useChat((state) => state.loadingHistory);
  const historical = useChat((state) => !!state.sessionId);
  // 下一轮配置与上一轮实际报告分开；没有配置证据时才以最近报告说明会话。
  const configured = catalog?.defaultModel;
  const inherited = inheritedModel(native, actual, configured, { agent, running });
  const id = model || inherited;
  const origin = modelOrigin({ agent, model, running, actual, native, configured });
  const metadata = modelMetadata(id, agent, origin, catalog);
  return {
    id,
    origin,
    ...metadata,
    loading: !id && (reading || fetching),
    // 旧会话未报告原生强度，不能用新会话的目录默认冒充其有效值。
    defaultEffort: historical ? undefined : configuredModelEffort(agent, metadata.capabilityId, catalog),
  };
}
function effortLabel(effort?: string) {
  return effort === 'auto' ? '自动' : effort || '';
}
function ExtendedContextLabel({ label }: { label: string }) {
  if (!/\[1m\]$/i.test(label)) return null;
  return (
    <span className="shrink-0 rounded bg-muted px-1 text-[10px] leading-4" title="模型使用 [1m] 参数">
      1M
    </span>
  );
}
function ModelButtonContent({ agent, label, loading }: { agent: AgentKind; label: string; loading: boolean }) {
  return (
    <>
      <AgentIcon agent={agent} className="size-3.5 shrink-0" />
      {label && <span className="truncate">{label}</span>}
      {loading && <LoaderCircle aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />}
      <ExtendedContextLabel label={label} />
      <ChevronDown aria-hidden className="size-3.5 shrink-0" />
    </>
  );
}
function AgentChoices({ disabled }: { disabled: boolean }) {
  const agent = useChat((state) => state.agent);
  const historical = useChat((state) => !!state.sessionId);
  const setAgent = useChat((state) => state.setAgent);
  const environment = useEnvironment();
  return (
    <>
      <MenuGroup aria-label="CLI" className="flex items-center gap-1 px-2 py-1">
        {AGENT_KINDS.map((kind) => (
          <MenuItem
            key={kind}
            role="menuitemradio"
            aria-checked={agent === kind}
            aria-label={AGENT_LABELS[kind]}
            title={AGENT_LABELS[kind]}
            disabled={disabled || historical}
            onClick={() => setAgent(kind)}
            className="flex size-9 cursor-pointer items-center justify-center rounded-lg outline-none data-active-item:ring-1 data-active-item:ring-border-strong aria-checked:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
          >
            <AgentIcon agent={kind} className="size-4" />
          </MenuItem>
        ))}
      </MenuGroup>
      {agentUnavailable(environment.data, agent) && (
        <p role="status" className="px-3 py-2 text-xs leading-5 text-warning">
          当前 Agent 不可用，请在设置中检查。
        </p>
      )}
      <MenuSeparator className="my-1 border-t border-border" />
    </>
  );
}
function ModelActions({ disabled, model, onManual }: { disabled: boolean; model: string; onManual(): void }) {
  const setModel = useChat((state) => state.setModel);
  return (
    <MenuProvider placement="right-start">
      <MenuButton className={itemClass}>
        <span className="flex-1">更多模型操作</span>
        <ChevronRight aria-hidden className="size-3.5" />
      </MenuButton>
      <Menu portal unmountOnHide gutter={8} aria-label="更多模型操作" className={menuClass}>
        <MenuItem className={itemClass} disabled={disabled || !model} onClick={() => setModel('')}>
          重置模型
        </MenuItem>
        <MenuSeparator className="my-1 border-t border-border" />
        <MenuItem className={itemClass} disabled={disabled} onClick={onManual}>
          手动填写模型
        </MenuItem>
      </Menu>
    </MenuProvider>
  );
}
function modelHeading(connection?: AgentCapabilities['antigravityConnection']) {
  return connection ? `模型 · ${ANTIGRAVITY_CONNECTION_LABELS[connection]}` : '模型';
}
function ModelChoices({
  disabled,
  catalog,
  model,
  currentModel,
  selectedModel,
  origin,
  onManual,
  onSearch,
  onRepair,
}: CatalogProps & {
  model: string;
  currentModel: string;
  selectedModel?: string;
  origin: 'native' | 'selection';
  onManual(): void;
  onSearch(): void;
  onRepair(): void;
}) {
  const setModel = useChat((state) => state.setModel);
  const agent = useChat((state) => state.agent);
  const effort = useChat((state) => state.reasoningEfforts[state.agent]);
  const setEffort = useChat((state) => state.setReasoningEffort);
  const models = catalog.data?.models ?? [];
  const visible = useModelVisibility(catalog.data);
  const candidates = modelCandidates(models, currentModel, visible, { agent, origin });
  const connection = catalog.data?.antigravityConnection;
  const modelTitle = modelHeading(connection);
  const hidden = visible
    ? modelCandidates(models, currentModel, undefined, { agent, origin }).length - candidates.length
    : 0;
  return (
    <>
      <MenuGroup aria-label="可选模型">
        <p className="px-3 py-2 text-xs text-muted-foreground">{modelTitle}</p>
        {candidates.slice(0, 20).map((candidate) => (
          <Choice
            key={candidate.id}
            checked={selectedModel === candidate.id}
            disabled={disabled}
            choose={() => setModel(candidate.id)}
          >
            <ModelCandidateLabel model={candidate} />
          </Choice>
        ))}
      </MenuGroup>
      {candidates.length > 20 && (
        <MenuItem className={itemClass} disabled={disabled} onClick={onSearch}>
          搜索可见模型
        </MenuItem>
      )}
      <CatalogStatus catalog={catalog} />
      <ModelVisibilityNotice hidden={hidden} />
      {agent === 'claude' && (
        <ClaudeContextChoices
          disabled={disabled}
          model={currentModel}
          models={models}
          choose={(id) => {
            setModel(id);
            setEffort(effort);
          }}
        />
      )}
      <MenuSeparator className="my-1 border-t border-border" />
      {catalog.error instanceof ApiError && catalog.error.code === 'workspace_directory_unavailable' ? (
        <MenuItem className={itemClass} disabled={disabled} onClick={onRepair}>
          更换工作区目录
        </MenuItem>
      ) : (
        <RefreshModels catalog={catalog} disabled={disabled} />
      )}
      <ModelActions disabled={disabled} model={model} onManual={onManual} />
    </>
  );
}
function EffortChoices({
  disabled,
  efforts,
  effort,
  defaultEffort,
}: {
  disabled: boolean;
  efforts: string[];
  effort: string;
  defaultEffort?: string;
}) {
  const setEffort = useChat((state) => state.setReasoningEffort);
  return (
    <>
      <p className="px-3 py-2 text-xs text-muted-foreground">推理强度</p>
      {efforts.map((value) => (
        <Choice
          key={value}
          checked={(effort || defaultEffort) === value}
          disabled={disabled}
          choose={() => setEffort(value)}
        >
          {effortLabel(value)}
        </Choice>
      ))}
      {effort && (
        <>
          <MenuSeparator className="my-1 border-t border-border" />
          <MenuItem className={itemClass} disabled={disabled} onClick={() => setEffort('')}>
            重置强度
          </MenuItem>
        </>
      )}
    </>
  );
}

function EffortControls({
  disabled,
  catalog,
  model,
  defaultEffort,
  store,
}: CatalogProps & { model: string; defaultEffort?: string; store: ReturnType<typeof useMenuStore> }) {
  const agent = useChat((state) => state.agent);
  const effort = useChat((state) => state.reasoningEfforts[state.agent]);
  const setEffort = useChat((state) => state.setReasoningEffort);
  const models = catalog.data?.models ?? [];
  const unsupported = findModel(models, model)?.reasoningEfforts?.length === 0;
  const efforts = modelEfforts(agent, model, models);
  useEffect(() => {
    if (!unsupported) return;
    store.setOpen(false);
    if (!disabled && effort) setEffort('');
  }, [unsupported, disabled, effort, setEffort, store]);
  if (unsupported) return null;
  return (
    <>
      <MenuButton
        store={store}
        render={<button type="button" />}
        aria-label="推理强度"
        disabled={disabled}
        className={`${triggerClass} max-w-36`}
        title="选择推理强度"
      >
        {effort || defaultEffort ? (
          <span className="truncate">{effortLabel(effort || defaultEffort)}</span>
        ) : (
          <Brain aria-hidden className="size-3.5" />
        )}
        <ChevronDown aria-hidden className="size-3.5 shrink-0" />
      </MenuButton>
      <Menu store={store} portal unmountOnHide gutter={8} aria-label="推理强度菜单" className={menuClass}>
        <EffortChoices
          disabled={modelChoicesDisabled(disabled, catalog)}
          efforts={efforts}
          effort={effort}
          defaultEffort={defaultEffort}
        />
        {!efforts.length && <CatalogStatus catalog={catalog} />}
      </Menu>
    </>
  );
}

/** 模型菜单只表达下一轮选择，不把候选或覆盖值冒充实际模型报告。 */
function setModelMenuOpen(open: boolean, setOpen: (open: boolean) => void, catalog: CatalogProps['catalog']) {
  // 另一个窗口可能切了 AGY 连接；旧目录只向本机复核，不强制重新发现或读取额度。
  if (open && hasAntigravitySnapshot(catalog)) void catalog.refetch();
  setOpen(open);
}

function hasAntigravitySnapshot(catalog: CatalogProps['catalog']) {
  return catalog.data?.agent === 'antigravity';
}

function modelChoicesDisabled(disabled: boolean, catalog: CatalogProps['catalog']) {
  return disabled || (hasAntigravitySnapshot(catalog) && catalog.isRefetching);
}

function useMenuOfficialUsage(agent: AgentKind, catalog?: AgentCapabilities) {
  const workspace = useChat((state) => state.workspaceId);
  const available = agent === 'antigravity' && catalog?.antigravityConnection === 'account';
  const scope = available ? JSON.stringify([workspace, nativeCapabilitiesGeneration(agent)]) : undefined;
  return { available, ...useOfficialUsage(scope) };
}

export function ModelOptionsMenu({ disabled }: { disabled: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = () => {
    setSearchOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const [repairProject, setRepairProject] = useState<Workspace>();
  const client = useQueryClient();
  const agent = useChat((state) => state.agent);
  const model = useChat((state) => state.modelOverrides[state.agent]);
  // 选中会话即读本地缓存；只有首次打开菜单且无缓存时才向 CLI 发现。
  const catalog = useAgentCapabilities(true, modelOpen || effortOpen);
  const modelMenu = useMenuStore({
    open: modelOpen,
    setOpen: (open) => setModelMenuOpen(open, setModelOpen, catalog),
    placement: 'top-end',
  });
  const effortMenu = useMenuStore({
    open: effortOpen,
    setOpen: (open) => setModelMenuOpen(open, setEffortOpen, catalog),
    placement: 'top-end',
  });
  const usage = useMenuOfficialUsage(agent, catalog.data);
  const presentation = useModelPresentation(model, catalog.data, catalog.isFetching);
  const setModel = useChat((state) => state.setModel);
  const models = catalog.data?.models ?? [];
  const visible = useModelVisibility(catalog.data);
  return (
    <>
      <MenuButton
        store={modelMenu}
        ref={trigger}
        render={<button type="button" />}
        aria-label="模型选项"
        aria-busy={presentation.loading}
        disabled={disabled}
        className={`${triggerClass} max-w-64`}
        title={[AGENT_LABELS[agent], presentation.label].filter(Boolean).join(' · ')}
      >
        <ModelButtonContent agent={agent} label={presentation.label} loading={presentation.loading} />
      </MenuButton>
      <EffortControls
        store={effortMenu}
        disabled={disabled}
        catalog={catalog}
        model={presentation.capabilityId}
        defaultEffort={presentation.defaultEffort}
      />
      <Menu store={modelMenu} portal unmountOnHide gutter={8} aria-label="模型选项菜单" className={menuClass}>
        <AgentChoices disabled={disabled} />
        {usage.available && (
          <MenuItem className={itemClass} disabled={modelChoicesDisabled(disabled, catalog)} onClick={usage.read}>
            <Gauge aria-hidden className="size-3.5" />
            查看官方额度
          </MenuItem>
        )}
        <ModelChoices
          disabled={modelChoicesDisabled(disabled, catalog)}
          catalog={catalog}
          model={model}
          currentModel={presentation.id}
          selectedModel={presentation.selected}
          origin={presentation.origin}
          onManual={() => setManual(true)}
          onSearch={() => setSearchOpen(true)}
          onRepair={() => {
            const project = client
              .getQueryData<Workspace[]>(projectsKeys.workspaces)
              ?.find((entry) => entry.id === useChat.getState().workspaceId);
            if (project) setRepairProject(project);
          }}
        />
      </Menu>
      {usage.view && <OfficialUsageDialog view={usage.view} read={usage.read} close={usage.close} />}
      {manual && (
        <ManualModelDialog
          model={model}
          disabled={disabled}
          apply={(value) => {
            setModel(value);
            setManual(false);
          }}
          onClose={() => setManual(false)}
        />
      )}
      {searchOpen && (
        <ModelSearchDialog
          models={modelCandidates(models, presentation.id, visible, { agent, origin: presentation.origin })}
          current={presentation.selected ?? ''}
          disabled={disabled}
          choose={(id) => {
            setModel(id);
            closeSearch();
          }}
          close={closeSearch}
        />
      )}
      {repairProject &&
        createPortal(
          <ProjectManageDialog
            project={repairProject}
            action="directory"
            onClose={() => setRepairProject(undefined)}
          />,
          document.body,
        )}
    </>
  );
}
