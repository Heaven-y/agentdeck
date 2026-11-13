import { lazy, Suspense, useLayoutEffect, useRef } from 'react';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { buttonClass, inputClass } from '../../ui/styles';
import { EnvironmentReport } from './EnvironmentReport';
import { GeneralSettingsPanel } from './GeneralSettingsPanel';
import { NativeMemorySettings } from './NativeMemorySettings';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { SettingsNavigationContext } from './settings-navigation';
import { SettingsNavigation, AgentNavigation } from './SettingsPageNavigation';
import {
  isModelPage,
  resourceCategory,
  useSettingsPage,
  type SettingsPageProps,
  type SettingsPageState,
} from './use-settings-page';
export type { SettingsPage } from './use-settings-page';
const NativeResources = lazy(() => import('./NativeResourcesDialog'));
const LaunchEnvironment = lazy(() => import('./LaunchEnvironmentPanel'));

function ResourceScope({ state, label = '资源范围' }: { state: SettingsPageState; label?: string }) {
  return (
    <label className="flex shrink-0 flex-wrap items-center gap-3 text-sm">
      <span>{label}</span>
      <select
        aria-label={label}
        className={`${inputClass} max-w-sm`}
        value={state.selectedProject?.id ?? ''}
        onChange={(event) => {
          const scope = event.target.value;
          state.leave(() => state.setScope(scope));
        }}
      >
        <option value="">全局 / 用户配置</option>
        {state.choices.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
    </label>
  );
}
function SettingsDetailContent({ state, props }: { state: SettingsPageState; props: SettingsPageProps }) {
  const { page, currentAgent, selectedProject } = state;
  if (page === 'environment') return <EnvironmentReport disabled={false} />;
  if (page === 'memory')
    return (
      <NativeMemorySettings
        agent={currentAgent}
        projectId={selectedProject?.id}
        onOpenFiles={() => state.select('files')}
      />
    );
  const category = resourceCategory[page as keyof typeof resourceCategory];
  const back = () => state.changePage(currentAgent);
  return (
    <Suspense fallback={<p role="status">正在读取设置…</p>}>
      {page === 'launch' ? (
        <LaunchEnvironment key={currentAgent} embedded agent={currentAgent} onBack={back} onClose={props.onClose} />
      ) : (
        category && (
          <NativeResources
            key={JSON.stringify([currentAgent, selectedProject?.id, category])}
            embedded
            category={category}
            agent={currentAgent}
            project={selectedProject}
            onBack={back}
            onClose={props.onClose}
          />
        )
      )}
    </Suspense>
  );
}
function SettingsContent({ state, props }: { state: SettingsPageState; props: SettingsPageProps }) {
  if (state.page === 'general') return <GeneralSettingsPanel guardRef={state.formGuardRef} />;
  if (isModelPage(state.page))
    return (
      <ModelSettingsPanel
        key={state.page}
        agent={state.page}
        projectId={props.project?.id ?? props.projectId}
        guardRef={state.formGuardRef}
        onNative={state.openNative}
        onLaunchEnvironment={state.openLaunch}
      />
    );
  return <SettingsDetailContent state={state} props={props} />;
}
/** 设置占用应用工作区；表单离开统一经过保护，敏感内容不跨分类保留。 */
export default function ProductSettingsDialog(props: SettingsPageProps) {
  const state = useSettingsPage(props);
  const scrollport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollport.current) scrollport.current.scrollTop = 0;
  }, [state.page, state.currentAgent, state.selectedProject?.id]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    headingRef.current?.focus();
  }, []);
  const hasAgent = state.page !== 'general' && state.page !== 'environment';
  const category = resourceCategory[state.page as keyof typeof resourceCategory];
  const hasScope = !!category || state.page === 'memory';
  return (
    <SettingsNavigationContext.Provider value={state.guards}>
      <section
        aria-label="设置页面"
        className="settings-page flex h-full min-h-0 w-full flex-1 flex-col bg-background text-foreground"
      >
        <header className="flex shrink-0 items-center gap-4 border-b border-border px-5 py-3">
          <button
            type="button"
            className={buttonClass('ghost')}
            aria-label="关闭设置"
            onClick={() => state.leave(props.onClose)}
          >
            <ArrowLeft aria-hidden className="size-4" />
            返回工作台
          </button>
          <h1 ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-sm font-semibold outline-none">
            <Settings2 aria-hidden className="size-4" />
            设置
          </h1>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <SettingsNavigation page={state.page} select={state.select} agent={state.currentAgent} />
          <div className="settings-main flex min-h-0 min-w-0 flex-1 flex-col gap-5 p-5 sm:p-7">
            {hasAgent && <AgentNavigation agent={state.currentAgent} select={state.selectAgent} />}
            {hasScope && <ResourceScope state={state} label={state.page === 'memory' ? '记忆范围' : undefined} />}
            <div ref={scrollport} className="min-h-0 flex-1 overflow-y-auto">
              <SettingsContent state={state} props={props} />
            </div>
          </div>
        </div>
      </section>
    </SettingsNavigationContext.Provider>
  );
}
