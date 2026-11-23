import { useState, type MutableRefObject } from 'react';
import type { SettingsPageProps } from './navigation/use-settings-page';
import type { SettingsLeave } from './navigation/settings-navigation';
import ProductSettingsDialog from './navigation/ProductSettingsDialog';

export default function SettingsDialog({
  onClose,
  guardRef,
  workspace,
}: {
  onClose(): void;
  guardRef?: MutableRefObject<SettingsLeave>;
  workspace?: SettingsPageProps['workspace'];
}) {
  // 此次打开固定工作区；外部导航不能把未保存的资源草稿切到另一个目录。
  const [scopeWorkspace] = useState(workspace);
  return (
    <ProductSettingsDialog initialPage="general" onClose={onClose} guardRef={guardRef} workspace={scopeWorkspace} />
  );
}
