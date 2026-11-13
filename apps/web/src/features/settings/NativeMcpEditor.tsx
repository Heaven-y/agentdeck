import { useState } from 'react';
import type {
  NativeManagementContext,
  NativeMcpConfigInput,
  NativeMcpEntry,
  NativeMcpSource,
} from '@agentdeck/shared/settings';
import { inputClass, buttonClass } from '../../ui/styles';
import { nativeMcpApi } from './native-mcp-api';
import { confirmNativeDiscard, nativeSettingsError } from './native-resource-labels';
import { useSettingsLeave } from './settings-navigation';
type Secret = NonNullable<NativeMcpConfigInput['url']>;
type SecretMap = NonNullable<NativeMcpConfigInput['env']>;
function SecretField({ name, value, onChange }: { name: string; value: Secret; onChange(value: Secret): void }) {
  const [shown, setShown] = useState(false);
  const [draft, setDraft] = useState(value.action === 'replace' ? value.value : '');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-40 flex-1 space-y-1 text-sm">
        <span>{name}</span>
        <select
          className={inputClass}
          aria-label={`${name} 操作`}
          value={value.action}
          onChange={(e) =>
            onChange(
              e.target.value === 'replace'
                ? { action: 'replace', value: draft }
                : { action: e.target.value as 'keep' | 'clear' },
            )
          }
        >
          <option value="keep">保留原值</option>
          <option value="replace">替换为新值</option>
          <option value="clear">清除</option>
        </select>
      </label>
      <label className="min-w-40 flex-1 space-y-1 text-sm">
        <span>新值</span>
        <input
          className={inputClass}
          aria-label={`${name} 新值`}
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          value={draft}
          disabled={value.action !== 'replace'}
          onChange={(e) => {
            setDraft(e.target.value);
            onChange({ action: 'replace', value: e.target.value });
          }}
        />
      </label>
      <button
        type="button"
        className={buttonClass('outline')}
        aria-label={`${shown ? '隐藏' : '显示'} ${name} 新值`}
        onClick={() => setShown(!shown)}
      >
        {shown ? '隐藏' : '显示'}
      </button>
    </div>
  );
}
function SecretFields({
  title,
  value,
  onChange,
}: {
  title: string;
  value: SecretMap;
  onChange(value: SecretMap): void;
}) {
  const [key, setKey] = useState('');
  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm">{title}</legend>
      {Object.entries(value).map(([name, secret]) => (
        <SecretField key={name} name={name} value={secret} onChange={(next) => onChange({ ...value, [name]: next })} />
      ))}
      <div className="flex flex-wrap gap-2">
        <input
          aria-label={`${title}字段名称`}
          className={`${inputClass} min-w-0 flex-1`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key) || Object.hasOwn(value, key)}
          onClick={() => {
            onChange({ ...value, [key]: { action: 'replace', value: '' } });
            setKey('');
          }}
        >
          添加字段
        </button>
      </div>
    </fieldset>
  );
}
const keep = (keys: string[]): SecretMap => Object.fromEntries(keys.map((key) => [key, { action: 'keep' }]));
function initialFields(entry?: NativeMcpEntry) {
  if (!entry)
    return {
      name: '',
      transport: 'stdio' as const,
      command: '',
      env: {},
      headers: {},
      url: { action: 'replace', value: '' } as Secret,
    };
  return {
    name: entry.name,
    transport: entry.transport === 'unknown' ? ('stdio' as const) : entry.transport,
    command: entry.config.command ?? '',
    env: keep(entry.config.envKeys),
    headers: keep(entry.config.headerKeys),
    url: { action: 'keep' } as Secret,
  };
}
export default function NativeMcpEditor({
  context,
  source,
  entry,
  onSaved,
  onClose,
}: {
  context: NativeManagementContext;
  source: NativeMcpSource;
  entry?: NativeMcpEntry;
  onSaved(): void;
  onClose(): void;
}) {
  const initial = initialFields(entry);
  const [name, setName] = useState(initial.name);
  const [transport, setTransport] = useState<NativeMcpConfigInput['transport']>(initial.transport);
  const [command, setCommand] = useState(initial.command);
  const [args, setArgs] = useState('');
  const [replaceArgs, setReplaceArgs] = useState(!entry);
  const [url, setUrl] = useState<Secret>(initial.url);
  const [env, setEnv] = useState<SecretMap>(initial.env);
  const [headers, setHeaders] = useState<SecretMap>(initial.headers);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const leave = (action: () => void) => {
    if (!busy && confirmNativeDiscard(dirty)) action();
  };
  useSettingsLeave(leave, dirty || busy);
  async function save() {
    setBusy(true);
    setError('');
    try {
      const config: NativeMcpConfigInput =
        transport === 'stdio'
          ? { transport, command, ...(replaceArgs ? { args: args ? args.split('\n') : [] } : {}) }
          : { transport, url };
      await nativeMcpApi.save(context, {
        id: entry?.id,
        sourceId: source.id,
        revision: entry?.revision ?? source.revision,
        name,
        config: { ...config, env, headers },
      });
      onSaved();
    } catch (reason) {
      setError(nativeSettingsError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="space-y-4 rounded-lg border border-border p-4"
      // 字段名称和切回“保留”的秘密仍可能含有尚未提交的本地草稿。
      onChangeCapture={() => setDirty(true)}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {source.label}。已有参数、地址和秘密不回填；未修改的字段保持原值。
      </p>
      {!source.secretInput && (
        <p className="text-sm text-muted-foreground">
          此作用域只通过原生命令维护不含参数或秘密的 stdio 配置。地址、命令参数与凭据请使用 Claude 原生入口；项目
          .mcp.json 支持完整表单。
        </p>
      )}
      <label className="block space-y-1 text-sm">
        <span>服务名称</span>
        <input
          className={inputClass}
          value={name}
          disabled={!!entry || busy}
          required
          pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,127}"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>传输方式</span>
        <select
          className={inputClass}
          value={transport}
          disabled={busy}
          onChange={(e) => setTransport(e.target.value as NativeMcpConfigInput['transport'])}
        >
          {source.transports.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      {transport === 'stdio' ? (
        <>
          <label className="block space-y-1 text-sm">
            <span>可执行程序</span>
            <input className={inputClass} value={command} required onChange={(e) => setCommand(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={replaceArgs} onChange={(e) => setReplaceArgs(e.target.checked)} />
            替换全部参数（留空表示清空）
          </label>
          <label className="block space-y-1 text-sm">
            <span>参数，每行一个</span>
            <textarea
              className={inputClass}
              value={args}
              disabled={!replaceArgs}
              onChange={(e) => setArgs(e.target.value)}
            />
          </label>
        </>
      ) : (
        <SecretField name="服务 URL" value={url} onChange={setUrl} />
      )}
      <SecretFields title="环境变量" value={env} onChange={setEnv} />
      {transport !== 'stdio' && <SecretFields title="请求头" value={headers} onChange={setHeaders} />}
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass('primary')} disabled={busy}>
          {busy ? '正在保存…' : '保存 MCP 配置'}
        </button>
        <button type="button" className={buttonClass('outline')} disabled={busy} onClick={() => leave(onClose)}>
          取消编辑
        </button>
      </div>
    </form>
  );
}
