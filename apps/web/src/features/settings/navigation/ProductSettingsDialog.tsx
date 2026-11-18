import { Suspense, useLayoutEffect, useRef } from 'react';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { buttonClass } from '../../../ui/styles';
import { SettingsNavigationContext } from './settings-navigation';
import { SettingsNavigation, AgentNavigation } from './SettingsPageNavigation';
import { settingsSection, sectionFor } from './page-registry';
import { useSettingsPage, type SettingsPageProps } from './use-settings-page';
export type { SettingsPage } from './page-registry';
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
  const section = settingsSection(sectionFor(state.page));
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
            {section.showAgent && <AgentNavigation agent={state.currentAgent} select={state.selectAgent} />}
            <div ref={scrollport} className="min-h-0 flex-1 overflow-y-auto">
              <Suspense fallback={<p role="status">正在读取设置…</p>}>
                {section.render({
                  agent: state.currentAgent,
                  formGuard: state.formGuardRef,
                  launchDetail: state.page === 'launch',
                  back: () => state.changePage(state.currentAgent),
                  close: props.onClose,
                  openFiles: () => state.select('files'),
                  openNative: state.openNative,
                  openLaunch: state.openLaunch,
                })}
              </Suspense>
            </div>
          </div>
        </div>
      </section>
    </SettingsNavigationContext.Provider>
  );
}
