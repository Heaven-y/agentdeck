import type { MutableRefObject } from 'react';
import type { SettingsLeave } from './use-model-settings';
import ProductSettingsDialog from './ProductSettingsDialog';

/** 独立设置页入口；设置只管理全局/用户配置，项目级配置交给各 CLI 原生入口。 */
export default function SettingsDialog({
  onClose,
  guardRef,
}: {
  onClose(): void;
  guardRef?: MutableRefObject<SettingsLeave>;
}) {
  return <ProductSettingsDialog initialPage="general" onClose={onClose} guardRef={guardRef} />;
}
