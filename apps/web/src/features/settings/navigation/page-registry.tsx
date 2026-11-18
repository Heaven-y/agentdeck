import { lazy, type MutableRefObject, type ReactNode } from 'react';
import {
  Blocks,
  Brain,
  FileCode2,
  MonitorCheck,
  Plug,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import { isAgentKind, type AgentKind } from '@agentdeck/shared/conversation';
import { EnvironmentReport } from '../environment/EnvironmentReport';
import { GeneralSettingsPanel } from '../general/GeneralSettingsPanel';
import { ModelSettingsPanel } from '../models/ModelSettingsPanel';
import { NativeMemorySettings } from '../resources/NativeMemorySettings';
import type { NativeResourceCategory } from '../resources/NativeResourcesDialog';
import type { SettingsLeave } from './settings-navigation';

const NativeResources = lazy(() => import('../resources/NativeResourcesDialog'));
const LaunchEnvironment = lazy(() => import('../environment/LaunchEnvironmentPanel'));

type PageContext = {
  agent: AgentKind;
  formGuard: MutableRefObject<SettingsLeave>;
  launchDetail: boolean;
  back(): void;
  close(): void;
  openFiles(): void;
  openNative(): void;
  openLaunch(): void;
};
type SettingsSection = {
  label: string;
  icon: LucideIcon;
  showAgent: boolean;
  render(context: PageContext): ReactNode;
};
function resource(category: NativeResourceCategory) {
  return ({ agent, back, close }: PageContext) => (
    <NativeResources
      key={JSON.stringify([agent, category])}
      embedded
      category={category}
      agent={agent}
      onBack={back}
      onClose={close}
    />
  );
}
/** 键即页面分类，登记顺序即菜单顺序。模型页用所选 CLI 作路由，启动环境为其详情。 */
const sections = {
  general: {
    label: '通用设置',
    icon: SlidersHorizontal,
    showAgent: false,
    render: ({ formGuard }) => <GeneralSettingsPanel guardRef={formGuard} />,
  },
  models: {
    label: '模型与连接',
    icon: Sparkles,
    showAgent: true,
    render: ({ agent, launchDetail, formGuard, openNative, openLaunch, back, close }) =>
      launchDetail ? (
        <LaunchEnvironment key={agent} embedded agent={agent} onBack={back} onClose={close} />
      ) : (
        <ModelSettingsPanel
          key={agent}
          agent={agent}
          guardRef={formGuard}
          onNative={openNative}
          onLaunchEnvironment={openLaunch}
        />
      ),
  },
  skills: { label: 'Skills', icon: WandSparkles, showAgent: true, render: resource('skills') },
  mcp: { label: 'MCP', icon: Plug, showAgent: true, render: resource('mcp') },
  plugins: { label: '原生插件', icon: Blocks, showAgent: true, render: resource('plugins') },
  files: { label: '原生文件', icon: FileCode2, showAgent: true, render: resource('all') },
  memory: {
    label: '记忆',
    icon: Brain,
    showAgent: true,
    render: ({ agent, openFiles }) => <NativeMemorySettings agent={agent} onOpenFiles={openFiles} />,
  },
  environment: {
    label: '运行环境',
    icon: MonitorCheck,
    showAgent: false,
    render: () => <EnvironmentReport disabled={false} />,
  },
} satisfies Record<string, SettingsSection>;
type SectionId = keyof typeof sections;
export type SettingsPage = AgentKind | Exclude<SectionId, 'models'> | 'launch';
export const sectionIds = Object.keys(sections) as SectionId[];
export const sectionFor = (page: SettingsPage): SectionId => (isAgentKind(page) || page === 'launch' ? 'models' : page);
export const settingsSection = (id: SectionId): SettingsSection => sections[id];
