import { useRef, useState } from 'react';
import type { NativeManagementContext, NativeResourceRoot, NativeSkillImportInput } from '@agentdeck/shared/settings';
import { buttonClass, inputClass } from '../../../ui/styles';
import { nativeManagementApi } from './native-management-api';
import { confirmNativeDiscard, nativeSettingsError, nativeScopeNames } from '../resources/native-resource-labels';
import { useSettingsLeave } from '../navigation/settings-navigation';

async function encodeFiles(files: File[]): Promise<NativeSkillImportInput['files']> {
  if (
    files.length > 128 ||
    files.reduce((total, file) => total + file.size, 0) > 8 * 1024 * 1024 ||
    files.some((file) => file.size > 1024 * 1024)
  )
    throw new Error('技能目录最多 128 个文件、合计 8 MiB，每文件最多 1 MiB。');
  const result: NativeSkillImportInput['files'] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192)
      binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    result.push({ path: file.webkitRelativePath.split('/').slice(1).join('/'), contentBase64: btoa(binary) });
  }
  return result;
}
export function NativeSkillImport({
  context,
  roots,
  onChanged,
}: {
  context: NativeManagementContext;
  roots: NativeResourceRoot[];
  onChanged(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState('');
  const [rootId, setRootId] = useState(() => initialRoot(roots));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = files.length > 0 || name !== '';
  useSettingsLeave((action) => {
    if (!busy && confirmNativeDiscard(dirty)) action();
  }, dirty || busy);
  async function save() {
    setBusy(true);
    setError('');
    try {
      await nativeManagementApi.importSkill(context, { rootId, name, files: await encodeFiles(files) });
      setFiles([]);
      setName('');
      if (input.current) input.current.value = '';
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : nativeSettingsError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="space-y-3">
      <summary className="cursor-pointer text-sm font-medium">导入本地技能目录</summary>
      <p className="text-sm text-muted-foreground">
        选择包含 SKILL.md 的技能文件夹。最多 128 个文件、6 层目录，共 8 MiB。
      </p>
      {roots.filter((root) => root.editable).length > 1 && (
        <label className="block space-y-1 text-sm">
          保存位置
          <select
            aria-label="技能导入位置"
            className={inputClass}
            value={rootId}
            onChange={(event) => setRootId(event.target.value)}
            disabled={busy}
          >
            {roots
              .filter((root) => root.editable)
              .map((root) => (
                <option key={root.id} value={root.id}>
                  {nativeScopeNames[root.scope]} · {root.displayPath}
                </option>
              ))}
          </select>
        </label>
      )}
      <label className="block space-y-1 text-sm">
        技能目录
        <input
          ref={input}
          type="file"
          multiple
          {...{ webkitdirectory: '' }}
          aria-label="选择本地技能目录"
          disabled={busy}
          className={inputClass}
          onChange={(event) => {
            const next = Array.from(event.target.files ?? []);
            setFiles(next);
            setName(next[0]?.webkitRelativePath.split('/')[0] ?? '');
            setError('');
          }}
        />
      </label>
      <label className="block space-y-1 text-sm">
        新目录名称
        <input
          aria-label="导入技能名称"
          className={inputClass}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
      </label>
      {files.length > 0 && <p className="text-xs text-muted-foreground">已选择 {files.length} 个文件</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      <button
        className={buttonClass('primary')}
        type="button"
        disabled={busy || !rootId || !files.length || !name}
        onClick={() => void save()}
      >
        {busy ? '正在导入…' : '导入技能'}
      </button>
    </details>
  );
}
function initialRoot(roots: NativeResourceRoot[]) {
  const editable = roots.filter((root) => root.editable);
  return editable.find((root) => root.scope === 'project')?.id ?? editable[0]?.id ?? '';
}
