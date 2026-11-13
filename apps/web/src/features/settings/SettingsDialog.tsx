import type { MutableRefObject } from 'react';
import type { Workspace } from '@agentdeck/shared/projects';
import type { SettingsLeave } from './use-model-settings';
import ProductSettingsDialog from './ProductSettingsDialog';

/** 独立设置页入口，保留已登记项目供原生资源选择。 */
export default function SettingsDialog({
  onClose,
  project,
  projects,
  guardRef,
}: {
  onClose(): void;
  project?: Workspace;
  projects?: Workspace[];
  guardRef?: MutableRefObject<SettingsLeave>;
}) {
  return (
    <ProductSettingsDialog
      initialPage="general"
      onClose={onClose}
      project={project}
      projects={projects}
      guardRef={guardRef}
    />
  );
}
