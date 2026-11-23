import { AGENT_KINDS, type AgentKind } from '@agentdeck/shared/conversation';
import { AgentIcon } from '../../../ui/BrandIcons';
import { AGENT_FULL_NAMES } from '../../../cli/shared/labels';
import { sectionIds, sectionFor, settingsSection, type SettingsPage } from './page-registry';
export function SettingsNavigation({
  page,
  select,
  agent,
}: {
  page: SettingsPage;
  select(page: SettingsPage): void;
  agent: AgentKind;
}) {
  return (
    <nav
      aria-label="设置分类"
      className="settings-navigation flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-sidebar p-3 sm:w-48 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-4"
    >
      {sectionIds.map((id) => {
        const item = settingsSection(id);
        const target = id === 'models' ? agent : id;
        const selected = sectionFor(page) === id;
        const Icon = item.icon;
        return (
          <button
            key={id}
            type="button"
            aria-current={selected ? 'page' : undefined}
            onClick={() => select(target)}
            className={`settings-navigation-item flex w-auto shrink-0 items-center gap-2.5 px-3 py-2 text-left text-[13px] sm:w-full ${selected ? '' : 'text-muted-foreground hover:bg-control-hover/70 hover:text-foreground'}`}
          >
            <Icon aria-hidden className="size-4 shrink-0" />
            <span className="whitespace-nowrap">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
export function AgentNavigation({ agent, select }: { agent: AgentKind; select(agent: AgentKind): void }) {
  return (
    <div
      role="group"
      aria-label="CLI 来源"
      className="settings-model-tabs flex shrink-0 flex-wrap gap-1.5 border-b border-border pb-4"
    >
      {AGENT_KINDS.map((item) => (
        <button
          key={item}
          type="button"
          aria-pressed={agent === item}
          onClick={() => select(item)}
          className={`settings-model-tab ${agent === item ? '' : 'text-muted-foreground hover:bg-control-hover/70 hover:text-foreground'}`}
        >
          <AgentIcon agent={item} className="size-4" />
          <span>{AGENT_FULL_NAMES[item]}</span>
        </button>
      ))}
    </div>
  );
}
