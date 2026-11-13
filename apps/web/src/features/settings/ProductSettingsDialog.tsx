import { lazy, Suspense, useLayoutEffect, useRef } from 'react';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { buttonClass } from '../../ui/styles';
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

function SettingsDetailContent({ state, props }: { state: SettingsPageState; props: SettingsPageProps }) {
  const { page, currentAgent } = state;
  if (page === 'environment') return <EnvironmentReport disabled={false} />;
  if (page === 'memory') return <NativeMemorySettings agent={currentAgent} onOpenFiles={() => state.select('files')} />;
  const category = resourceCategory[page as keyof typeof resourceCategory];
  const back = () => state.changePage(currentAgent);
  return (
    <Suspense fallback={<p role="status">正在读取设置…</p>}>
      {page === 'launch' ? (
        <LaunchEnvironment key={currentAgent} embedded agent={currentAgent} onBack={back} onClose={props.onClose} />
      ) : (
        category && (
          <NativeResources
            key={JSON.stringify([currentAgent, category])}
            embedded
            category={category}
            agent={currentAgent}
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
        guardRef={state.formGuardRef}
        onNative={state.openNative}
        onLaunchEnvironment={state.openLaunch}
      />
    );
  return <SettingsDetailContent state={state} props={props} />;
}
/** 设置占用应用工作区；只管理全局/用户配置，表单离开统一经过保护，敏感内容不跨分类保留。 */
export default function ProductSettingsDialog(props: SettingsPageProps) {
  const state = useSettingsPage(props);
  const scrollport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollport.current) scrollport.current.scrollTop = 0;
  }, [state.page, state.currentAgent]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    headingRef.current?.focus();
  }, []);
  const hasAgent = state.page !== 'general' && state.page !== 'environment';
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
            <div ref={scrollport} className="min-h-0 flex-1 overflow-y-auto">
              <SettingsContent state={state} props={props} />
            </div>
          </div>
        </div>
      </section>
    </SettingsNavigationContext.Provider>
  );
}
