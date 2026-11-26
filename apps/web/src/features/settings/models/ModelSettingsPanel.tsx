import { useLayoutEffect, type MutableRefObject, type ReactNode } from 'react';
import { ArrowUpRight, ChevronRight, FileCode2, RefreshCw } from 'lucide-react';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { ModelSettingField } from '@agentdeck/shared/settings';
import { buttonClass } from '../../../ui/styles';
import { AGENT_FULL_NAMES, effortLabel } from '../../../cli/shared/labels';
import { ModelSettingsField } from './ModelSettingsField';
import { modelSettingValue, modelSettingsFields, useModelSettings } from './use-model-settings';
import type { SettingsLeave } from '../navigation/settings-navigation';
import { leaveSettings, useGuardedSettingsNavigation } from '../navigation/settings-navigation';
import { modelEfforts } from '../../../cli/model-capabilities';
import { ANTIGRAVITY_CONNECTION_LABELS, antigravityConnectionField } from '../../../cli/antigravity/model-policy';
import { modelVisibilityKey } from '../../../cli/shared/model-visibility';
import { antigravityModelSuggestions } from '../../../cli/antigravity/model-suggestions';
import { ModelVisibilityPanel } from './ModelVisibilityPanel';
import { useVisibilityDraft } from './use-visibility-draft';
import { modelSettingsApi } from './model-settings-api';
import { AntigravityConnectionActions } from './AntigravityConnectionActions';
import { AntigravityProxyField } from './AntigravityProxyField';

type State = ReturnType<typeof useModelSettings>;
function visibleFields(fields: ModelSettingField[], state: State) {
  const auth = fields.find((field) => field.key === 'authMode');
  if (!auth) return fields;
  const mode = modelSettingValue(auth, state.draft);
  return fields.filter((field) => {
    if (field.key === 'envKey') return mode === 'env';
    if (field.key === 'apiKey') return mode !== 'command';
    return true;
  });
}
function modelSuggestions(field: ModelSettingField, state: State) {
  const models = state.modelCatalog?.models ?? [];
  return state.document?.agent === 'antigravity'
    ? antigravityModelSuggestions(models, modelSettingValue(field, state.draft))
    : models.map((model) => ({ value: model.id, label: model.label }));
}
function suggestionsFor(field: ModelSettingField, state: State) {
  const models = state.modelCatalog?.models ?? [];
  if (field.key === 'model') return modelSuggestions(field, state);
  if (field.key !== 'reasoningEffort' || field.options) return undefined;
  const selected = state.document?.fields.find((entry) => entry.key === 'model');
  const modelId = selected && modelSettingValue(selected, state.draft);
  return state.document && modelId
    ? modelEfforts(state.document.agent, modelId, models).map((value) => ({ value, label: effortLabel(value) }))
    : undefined;
}
function FetchModels({ state }: { state: State }) {
  const hasCatalog = state.modelCatalog && state.modelCatalog.discovered !== false;
  const label = Object.keys(state.draft).length ? '保存并获取模型' : hasCatalog ? '重新获取' : '获取模型';
  return (
    <button
      type="button"
      className={`${buttonClass('outline')} shrink-0 rounded-lg`}
      disabled={state.saving || state.modelsLoading}
      onClick={() => void state.fetchModels()}
    >
      <RefreshCw aria-hidden className={`size-3.5 ${state.modelsLoading ? 'motion-safe:animate-spin' : ''}`} />
      {state.modelsLoading ? '正在获取…' : label}
    </button>
  );
}
function Fields({ fields, state }: { fields: ModelSettingField[]; state: State }) {
  const document = state.document!;
  const provider = state.draft.provider ?? document.fields.find((field) => field.key === 'provider')?.value;
  return fields.map((field) => (
    <ModelSettingsField
      key={field.key}
      field={orchestratorField(field, state)}
      value={modelSettingValue(field, state.draft)}
      cleared={state.draft[field.key] === null}
      disabled={state.saving || state.modelsLoading}
      change={(value) => state.change(field, value)}
      suggestions={suggestionsFor(field, state)}
      action={field.key === 'model' ? <FetchModels state={state} /> : undefined}
      secretIdentity={JSON.stringify([
        document.revision,
        provider,
        state.draft.authMode,
        state.draft.modelProvider,
        field.key,
      ])}
      readSecret={
        field.key === 'apiKey' || field.key === 'authToken'
          ? (signal) =>
              modelSettingsApi.readSecret(
                document.agent,
                { revision: document.revision, key: field.key as 'apiKey' | 'authToken', provider },
                signal,
              )
          : undefined
      }
    />
  ));
}

function orchestratorField(field: ModelSettingField, state: State): ModelSettingField {
  const role =
    field.key === 'orchestratorPlanner' ? 'planner' : field.key === 'orchestratorExecutor' ? 'executor' : undefined;
  if (!role) return field;
  const models = (state.modelCatalog?.models ?? []).filter((model) => model.orchestratorRoles?.includes(role));
  const current = modelSettingValue(field, state.draft);
  const options = [
    { value: '', label: '原生默认' },
    ...models.map((model) => ({ value: model.label, label: model.label })),
  ];
  if (current && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
  return {
    ...field,
    options: options.map((option) => ({
      ...option,
      label: option.label.replace(
        / \((low|medium|high|xhigh|max)\)$/i,
        (_all, effort: string) => `（${effortLabel(effort.toLowerCase())}）`,
      ),
    })),
  };
}
function ConnectionFields({ fields, state }: { fields: ModelSettingField[]; state: State }) {
  const paired = fields.some((field) => field.key === 'provider')
    ? ['provider', 'displayName']
    : ['displayName', 'baseUrl'];
  const showPair = paired.every((key) => fields.some((field) => field.key === key));
  return (
    <div className="grid gap-3.5 sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field.key} className={showPair && paired.includes(field.key) ? 'min-w-0' : 'min-w-0 sm:col-span-2'}>
          <Fields fields={[field]} state={state} />
        </div>
      ))}
    </div>
  );
}
function ModelSettingsForm({
  state,
  fields,
  connectionActions,
}: {
  state: State;
  fields: ModelSettingField[];
  connectionActions?: ReactNode;
}) {
  const connections = fields.filter((field) => !field.advanced && field.group === 'connection');
  const models = fields.filter((field) => !field.advanced && field.group === 'model');
  const parameters = models.filter((field) =>
    ['reasoningEffort', 'contextWindow', 'autoCompactTokenLimit'].includes(field.key),
  );
  const orchestrator = models.filter(
    (field) => field.key === 'orchestratorPlanner' || field.key === 'orchestratorExecutor',
  );
  return (
    <div className="space-y-6">
      {connections.length > 0 && (
        <section aria-label="服务连接" className="space-y-3.5">
          <h4 className="text-xs font-medium text-muted-foreground">服务连接</h4>
          <ConnectionFields fields={connections} state={state} />
          {connectionActions}
        </section>
      )}
      <section aria-label="模型选择" className="space-y-3.5 border-t border-border pt-5">
        <Fields
          fields={models.filter((field) => !parameters.includes(field) && !orchestrator.includes(field))}
          state={state}
        />
        {state.modelsError && (
          <p role="alert" className="text-xs leading-5 text-destructive-foreground">
            {state.modelsError}
          </p>
        )}
        {state.modelMessage && (
          <p role="status" className="text-xs text-muted-foreground">
            {state.modelMessage}
          </p>
        )}
        {parameters.length > 0 && (
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Fields fields={parameters} state={state} />
          </div>
        )}
      </section>
      {orchestrator.length > 0 && (
        <section aria-label="编排器" className="space-y-3.5 border-t border-border pt-5">
          <h4 className="text-xs font-medium text-muted-foreground">编排器</h4>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Fields fields={orchestrator} state={state} />
          </div>
        </section>
      )}
    </div>
  );
}
function AdvancedSettings({
  state,
  fields,
  onNative,
  onLaunchEnvironment,
}: {
  state: State;
  fields: ModelSettingField[];
  onNative(): void;
  onLaunchEnvironment?: () => void;
}) {
  return (
    <details className="group/adv border-t border-border pt-4">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-[13px] font-medium text-muted-foreground marker:hidden transition-colors select-none hover:text-foreground">
        <ChevronRight aria-hidden className="size-3.5 transition-transform group-open/adv:rotate-90" />
        高级设置
      </summary>
      <div className="mt-4 space-y-4">
        <Fields fields={fields.filter((field) => field.advanced)} state={state} />
        {state.document?.warnings.map((warning) => (
          <p key={warning} className="text-xs leading-5 text-muted-foreground">
            {warning}
          </p>
        ))}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass('ghost')}
            disabled={state.saving || state.modelsLoading}
            aria-label={`编辑 ${AGENT_FULL_NAMES[state.document!.agent]} 配置文件`}
            title="打开 CLI 自己的配置、规则与扩展文件"
            onClick={onNative}
          >
            <FileCode2 aria-hidden className="size-3.5" />
            CLI 配置文件
          </button>
          {onLaunchEnvironment && (
            <button
              type="button"
              className={buttonClass('ghost')}
              disabled={state.saving || state.modelsLoading}
              title="仅为工作台启动的 CLI 设置环境变量"
              onClick={onLaunchEnvironment}
            >
              CLI 环境变量
              <ArrowUpRight aria-hidden className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            className={buttonClass('ghost')}
            disabled={state.saving || state.modelsLoading}
            onClick={state.reread}
          >
            重新读取配置
          </button>
        </div>
        <p className="break-all font-mono text-[11px] text-muted-foreground">{state.document?.displayPath}</p>
      </div>
    </details>
  );
}

function SettingsFeedback({ state }: { state: State }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-destructive-foreground">
        {state.error}
      </p>
    );
  if (!state.document)
    return (
      <p role="status" className="py-12 text-center text-sm text-muted-foreground">
        正在读取配置…
      </p>
    );
  return null;
}
function footerStatus(message: string, dirty: boolean) {
  if (message) return { text: message, tone: 'text-muted-foreground' };
  return dirty
    ? { text: '有未保存修改', tone: 'font-medium text-warning' }
    : { text: '', tone: 'text-muted-foreground' };
}
function SettingsFooter({
  state,
  dirty,
  save,
  reread,
}: {
  state: State;
  dirty: boolean;
  save(): void;
  reread(): void;
}) {
  const status = footerStatus(state.message, dirty);
  return (
    <footer className="settings-footer mt-4 flex shrink-0 items-center justify-between gap-3 border-t border-border py-3.5">
      <p role={state.message ? 'status' : undefined} className={`min-w-0 text-xs ${status.tone}`}>
        {status.text}
      </p>
      <div className="flex shrink-0 gap-2">
        {!state.document && state.error && (
          <button type="button" className={buttonClass('ghost')} disabled={state.saving} onClick={reread}>
            重试
          </button>
        )}
        <button
          type="button"
          className={`${buttonClass('primary')} rounded-lg`}
          disabled={state.saving || state.modelsLoading || !dirty}
          onClick={() => void save()}
        >
          {state.saving ? '正在保存…' : '保存配置'}
        </button>
      </div>
    </footer>
  );
}

function visibleCatalog(
  state: State,
  agent: AgentKind,
  connection: ReturnType<typeof antigravityConnectionField>,
  switching: boolean,
) {
  const catalog = state.modelCatalog;
  if (switching || (agent === 'antigravity' && catalog?.antigravityConnection !== connection)) return undefined;
  return catalog;
}

function connectionInfo(state: State, agent: AgentKind) {
  const provider = state.document?.fields.find(
    (field) => field.key === (agent === 'codex' ? 'provider' : 'modelProvider'),
  );
  const connection = agent === 'antigravity' ? antigravityConnectionField(provider?.value) : undefined;
  const switching = !!provider && modelSettingValue(provider, state.draft) !== provider.value;
  return { connection, switching };
}

function VisibilitySection({
  agent,
  state,
  visibility,
  info,
}: {
  agent: AgentKind;
  state: State;
  visibility: ReturnType<typeof useVisibilityDraft>;
  info: ReturnType<typeof connectionInfo>;
}) {
  if (info.switching) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        保存连接方式后，再获取该连接的模型并设置显示范围。
      </p>
    );
  }
  const codexAccount = state.modelCatalog?.codexAccount;
  const scope = modelVisibilityKey(agent, info.connection, codexAccount);
  return (
    <ModelVisibilityPanel
      key={scope}
      agent={agent}
      models={state.modelCatalog?.models ?? []}
      connectionLabel={
        info.connection ? ANTIGRAVITY_CONNECTION_LABELS[info.connection] : codexAccount ? 'ChatGPT 账号' : undefined
      }
      draft={visibility.range(scope)}
    />
  );
}

function connectedSettings(native: State, agent: AgentKind, saving: boolean, info: ReturnType<typeof connectionInfo>) {
  return {
    ...native,
    saving: native.saving || saving,
    modelCatalog: visibleCatalog(native, agent, info.connection, info.switching),
    modelsError: info.switching ? '' : native.modelsError,
    modelMessage: info.switching ? '' : native.modelMessage,
  };
}

export function ModelSettingsPanel({
  agent,
  guardRef,
  onNative,
  onLaunchEnvironment,
}: {
  agent: AgentKind;
  guardRef: MutableRefObject<SettingsLeave>;
  onNative(): void;
  onLaunchEnvironment?: () => void;
}) {
  const visibility = useVisibilityDraft(agent);
  // 显示范围草稿也属于这张表单：未保存时同样阻止离开。
  const native = useModelSettings(agent, visibility.dirty);
  const info = connectionInfo(native, agent);
  const state = connectedSettings(native, agent, visibility.saving, info);
  const fields = state.document ? visibleFields(modelSettingsFields(state.document, state.draft), state) : [];
  const dirty = state.dirty;
  const saving = state.saving;
  const leave = (action: () => void) => {
    if (saving) return;
    state.leave(() => {
      visibility.reload();
      action();
    });
  };
  const leavePage = useGuardedSettingsNavigation(leave);
  const save = async () => {
    if (await state.save()) await visibility.save();
  };
  useLayoutEffect(() => {
    guardRef.current = leave;
    return () => {
      guardRef.current = leaveSettings;
    };
  });
  return (
    <div aria-label={`${AGENT_FULL_NAMES[agent]} 模型设置`} className="settings-model-panel flex flex-col">
      {/* 只保留设置页这一层滚动：内层 overflow 容器会让滚轮停在不可滚动的元素上。 */}
      <div className="space-y-5 px-1">
        <SettingsFeedback state={state} />
        {state.document && (
          <>
            <ModelSettingsForm
              state={state}
              fields={fields}
              connectionActions={
                agent === 'antigravity' && (
                  <>
                    {info.connection === 'account' && !info.switching && (
                      <AntigravityConnectionActions disabled={saving} />
                    )}
                    <AntigravityProxyField disabled={saving} />
                  </>
                )
              }
            />
            <VisibilitySection agent={agent} state={state} visibility={visibility} info={info} />
            <AdvancedSettings
              state={state}
              fields={fields}
              onNative={() => leavePage(onNative)}
              onLaunchEnvironment={onLaunchEnvironment && (() => leavePage(onLaunchEnvironment))}
            />
          </>
        )}
      </div>
      <SettingsFooter state={state} dirty={dirty} save={() => void save()} reread={() => leave(state.reread)} />
    </div>
  );
}
