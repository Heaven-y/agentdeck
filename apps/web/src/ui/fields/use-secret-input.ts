import { useEffect, useRef, useState } from 'react';
import type { SecretValue } from '@agentdeck/shared/settings';

export type ReadSavedSecret = (signal: AbortSignal) => Promise<SecretValue>;

/** 查看明文独立于表单草稿，隐藏或卸载时释放，并取消迟到读取。 */
export function useSecretInput(value: string, readSaved?: ReadSavedSecret) {
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  if (!value && saved === null && visible) setVisible(false);
  function clearRead() {
    pending.current?.abort();
    pending.current = null;
    setSaved(null);
    setBusy(false);
    setError('');
  }
  async function reveal(read: ReadSavedSecret) {
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await read(controller.signal);
      if (controller.signal.aborted) return;
      setSaved(result.value);
      setVisible(!!result.value);
      if (!result.value) setError('没有已保存的密钥');
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取密钥，请重试');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function toggle() {
    if (visible || busy) {
      clearRead();
      setVisible(false);
    } else if (value) setVisible(true);
    else if (readSaved) void reveal(readSaved);
  }
  return { visible, saved, busy, error, clearRead, toggle };
}
