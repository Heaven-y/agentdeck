import { useRef, useState } from 'react';
import {
  CodeBlock as MarkdownCodeBlock,
  CodeBlockCopyButton,
  defaultComponents,
  useIsCodeFenceIncomplete,
  type Components,
} from 'streamdown';

/** 复用原有代码渲染和复制，只为长代码增加手动折叠。 */
export const ConversationCode: NonNullable<Components['code']> = (props) => {
  const code = typeof props.children === 'string' ? props.children : '';
  const lines = code.replace(/\n$/, '').split('\n').length;
  const language = /language-([^\s]+)/.exec(props.className ?? '')?.[1] ?? '';
  const DefaultCode = defaultComponents.code;
  if (!('data-block' in props) || language === 'mermaid' || lines < 40) return <DefaultCode {...props} />;
  return <FoldableCode code={code} language={language} lines={lines} />;
};

function FoldableCode({ code, language, lines }: { code: string; language: string; lines: number }) {
  const incomplete = useIsCodeFenceIncomplete();
  const [collapsed, setCollapsed] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const folded = collapsed && !incomplete;
  const toggle = () => {
    const above = (container.current?.getBoundingClientRect().top ?? 0) < 0;
    setCollapsed((value) => !value);
    if (above) requestAnimationFrame(() => container.current?.scrollIntoView({ block: 'nearest' }));
  };
  return (
    <div ref={container} className="conversation-code" data-collapsed={folded || undefined}>
      <MarkdownCodeBlock code={code} language={language} isIncomplete={incomplete}>
        <span className="text-xs text-muted-foreground">{lines} 行</span>
        <button
          type="button"
          aria-expanded={!folded}
          disabled={incomplete}
          onClick={toggle}
          className="rounded px-1.5 py-0.5 text-xs hover:bg-control-hover"
        >
          {folded ? '展开代码' : '收起代码'}
        </button>
        <CodeBlockCopyButton code={code} aria-label="复制代码" title="复制代码" />
      </MarkdownCodeBlock>
    </div>
  );
}
