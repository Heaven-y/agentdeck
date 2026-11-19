import { Combobox, ComboboxItem, ComboboxPopover, useComboboxStore } from '@ariakit/react/combobox';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { AgentCapabilities, AgentCapability, AgentKind } from '@agentdeck/shared/conversation';
import { capabilityRestriction, isInvocableCapability } from '../controls/capability-selection';
import { useChat } from '../state/chat-store';
import { matchesCapability, slashCompletion } from './slash-completion';
import { useAgentCapabilities } from '../controls/use-agent-capabilities';
import { commandWarnings } from '../controls/capability-feedback';
import { isResumeName, RESUME_ALIASES, resumeSuggestionMatches } from './resume-command';

const MAX_SUGGESTIONS = 20;
const itemClass =
  'cursor-pointer rounded-xl px-3 py-2 text-[13px] outline-none data-active-item:bg-muted data-active-item:ring-1 data-active-item:ring-border-strong aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

function ResumeSuggestion({ choose, agent }: { choose(): void; agent: AgentKind }) {
  const aliases = RESUME_ALIASES[agent];
  return (
    <ComboboxItem
      value="workbench:resume"
      setValueOnClick={false}
      selectValueOnClick={false}
      onClick={choose}
      className={itemClass}
    >
      <span className="font-medium">/resume</span>
      <span className="ml-2 text-xs text-muted-foreground">工作台命令</span>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        打开当前项目、当前 CLI 的已有会话。
        {aliases.length > 0 && `别名：${aliases.map((name) => `/${name}`).join('、')}。`}
      </p>
    </ComboboxItem>
  );
}
type InputProps = {
  id: string;
  text: string;
  onChange(text: string): void;
  onSend(): void;
  onSteer?(): void;
  onResume(argument: string): void;
  placeholder: string;
  busy: boolean;
};

function Suggestion({ entry, select }: { entry: AgentCapability; select(): void }) {
  const sessionId = useChat((state) => state.sessionId);
  const reason = capabilityRestriction(entry, sessionId);
  return (
    <ComboboxItem
      value={entry.id}
      disabled={!!reason}
      setValueOnClick={false}
      selectValueOnClick={false}
      onClick={select}
      className={itemClass}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="break-all font-medium">/{entry.name}</span>
        <span className="text-xs text-muted-foreground">{entry.kind === 'skill' ? '技能' : '命令'}</span>
        {entry.source && <span className="break-all text-xs text-muted-foreground">{entry.source}</span>}
      </div>
      <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{entry.description}</p>
      {reason && <p className="mt-1 break-words text-xs leading-5 text-warning">{reason}</p>}
    </ComboboxItem>
  );
}

function SuggestionsFooter({ count, catalog }: { count: number; catalog: ReturnType<typeof useAgentCapabilities> }) {
  if (!catalog.data || catalog.isError || catalog.isFetching || commandWarnings(catalog.data).length) return null;
  if (!count) return <p className="px-3 py-2 text-sm text-muted-foreground">没有匹配的技能或命令。</p>;
  return count > MAX_SUGGESTIONS ? (
    <p className="px-3 py-2 text-xs text-muted-foreground">显示前 {MAX_SUGGESTIONS} 项，继续输入可缩小范围。</p>
  ) : null;
}

function nativeSuggestions(catalog: AgentCapabilities | undefined, query: string, agent: AgentKind) {
  return (catalog?.entries ?? []).filter(
    (entry) => !isResumeName(entry.name, agent) && isInvocableCapability(entry) && matchesCapability(entry, query),
  );
}

/** 选择工作台导航或原生能力；发送原生能力仍经过原有 store 和后端复验。 */
function imeEnter(event: KeyboardEvent, composing: boolean) {
  return composing || event.nativeEvent.isComposing || event.keyCode === 229;
}
function captureSteerShortcut(event: KeyboardEvent, open: boolean, steer?: () => void) {
  if (!event.ctrlKey && !event.metaKey) return false;
  event.preventDefault();
  event.stopPropagation();
  if (!open) steer?.();
  return true;
}
function ScopedInput({ id, text, onChange, onSend, onSteer, onResume, placeholder, busy }: InputProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [range, setRange] = useState({ start: text.length, end: text.length });
  const [requested, setRequested] = useState(false);
  const [composing, setComposing] = useState(false);
  const selection = useChat((state) => state.selectedCapability);
  const agent = useChat((state) => state.agent);
  const select = useChat((state) => state.selectCapability);
  const completion = slashCompletion(text, range.start, range.end);
  const eligible = !busy && !selection && !!completion && !composing;
  const open = requested && eligible;
  const catalog = useAgentCapabilities(open);
  const query = completion?.query ?? '';
  const showResume = resumeSuggestionMatches(query, agent);
  const matches = nativeSuggestions(catalog.data, query, agent);
  const store = useComboboxStore({
    inputValue: text,
    setInputValue: onChange,
    open,
    setOpen: setRequested,
    placement: 'top-start',
  });

  const choose = (entry: AgentCapability) => {
    select(entry);
    if (useChat.getState().selectedCapability?.id !== entry.id || !completion) return;
    onChange(completion.remainder);
    setRange({ start: completion.remainder.length, end: completion.remainder.length });
    store.hide();
    input.current?.focus();
  };
  const show = () => {
    const element = input.current;
    return (
      !busy && !selection && !!element && !!slashCompletion(element.value, element.selectionStart, element.selectionEnd)
    );
  };
  const syncRange = () => {
    const element = input.current;
    if (element) setRange({ start: element.selectionStart, end: element.selectionEnd });
  };

  return (
    <>
      <Combobox
        id={id}
        store={store}
        render={<textarea ref={input} rows={2} />}
        autoSelect="always"
        autoComplete="list"
        showOnChange={show}
        showOnClick={show}
        showOnKeyPress={show}
        moveOnKeyPress={open}
        onChange={syncRange}
        onSelect={syncRange}
        onKeyUp={syncRange}
        onPointerUp={syncRange}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDownCapture={(event) => {
          if (event.key !== 'Enter') return;
          // 部分输入法在确认文字时已清除 isComposing，仍需识别组字状态或 IME 键码。
          if (imeEnter(event, composing)) {
            event.stopPropagation();
            return;
          }
          if (event.shiftKey) {
            if (open && input.current) {
              event.preventDefault();
              input.current.setRangeText('\n', input.current.selectionStart, input.current.selectionEnd, 'end');
              onChange(input.current.value);
              store.hide();
            }
            return;
          }
          if (captureSteerShortcut(event, open, onSteer)) return;
          if (open) return;
          event.preventDefault();
          onSend();
        }}
        placeholder={placeholder}
        className="composer-input"
      />
      <ComboboxPopover
        store={store}
        portal
        gutter={12}
        sameWidth
        aria-label="命令补全"
        className="z-50 max-h-[min(360px,var(--popover-available-height))] overflow-y-auto rounded-2xl border border-border bg-card p-1.5 text-foreground shadow-lg"
      >
        <p role="status" className="px-3 py-2 text-xs leading-5 text-muted-foreground">
          {catalog.isFetching ? '正在读取原生能力…' : '↑ ↓ 选择 · Enter 确认 · Esc 关闭'}
        </p>
        {catalog.isError && (
          <p role="alert" className="px-3 py-2 text-xs text-warning">
            能力目录暂不可用，可按 Esc 关闭后继续输入。
          </p>
        )}
        {commandWarnings(catalog.data).map((warning, index) => (
          <p key={index} role="status" className="px-3 py-2 text-xs leading-5 text-warning">
            {warning}
          </p>
        ))}
        {showResume && (
          <ResumeSuggestion
            agent={agent}
            choose={() => {
              if (!completion) return;
              store.hide();
              onResume(completion.remainder);
            }}
          />
        )}
        {matches.slice(0, MAX_SUGGESTIONS - Number(showResume)).map((entry) => (
          <Suggestion key={entry.id} entry={entry} select={() => choose(entry)} />
        ))}
        <SuggestionsFooter count={matches.length + Number(showResume)} catalog={catalog} />
      </ComboboxPopover>
    </>
  );
}

export function ComposerInput(props: InputProps) {
  const scope = useChat((state) => state.conversationVersion);
  return <ScopedInput key={scope} {...props} />;
}
