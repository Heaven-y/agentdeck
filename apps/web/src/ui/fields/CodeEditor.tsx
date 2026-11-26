import CodeMirror, { EditorView, EditorState, Prec } from '@uiw/react-codemirror';
import { useCallback, useMemo } from 'react';
import { json } from '@codemirror/lang-json';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { python } from '@codemirror/legacy-modes/mode/python';
import { javascript, typescript } from '@codemirror/legacy-modes/mode/javascript';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { markdown } from '@codemirror/lang-markdown';
import { useUiPreferences } from '../appearance/ui-preferences';

const themeStyle = {
  '&': { backgroundColor: 'var(--color-background)', color: 'var(--color-foreground)' },
  '.cm-gutters': { backgroundColor: 'var(--color-card)', color: 'var(--color-muted-foreground)', border: 'none' },
  '.cm-content': { fontFamily: 'var(--font-mono)', fontSize: '13px' },
  '.cm-scroller': { overflow: 'auto' },
  '&.cm-focused': { outline: '2px solid var(--color-accent)', outlineOffset: '-2px' },
};
const editorThemes = {
  dark: EditorView.theme(themeStyle, { dark: true }),
  light: EditorView.theme(themeStyle, { dark: false }),
};
const extensions = {
  json: [json()],
  toml: [StreamLanguage.define(toml)],
  python: [StreamLanguage.define(python)],
  javascript: [StreamLanguage.define(javascript)],
  typescript: [StreamLanguage.define(typescript)],
  shell: [StreamLanguage.define(shell)],
  yaml: [StreamLanguage.define(yaml)],
  markdown: [markdown()],
  diff: [StreamLanguage.define(diff)],
  text: [],
};
export type CodeFormat = keyof typeof extensions;
const basicSetup = { foldGutter: true, highlightActiveLine: true, autocompletion: false };

/** 仅保存当前组件的编辑状态；不序列化撤销历史，不连接浏览器持久存储。 */
export function CodeEditor({
  value,
  format,
  disabled,
  lineSeparator = '\n',
  label = '配置文件内容',
  height = 'min(42vh, 440px)',
  initialLine,
  onChange,
}: {
  value: string;
  format: CodeFormat;
  disabled: boolean;
  lineSeparator?: '\n' | '\r\n';
  label?: string;
  height?: string;
  initialLine?: number;
  onChange?(value: string): void;
}) {
  const theme = useUiPreferences((state) => state.theme);
  const configured = useMemo(
    () => [
      ...extensions[format],
      EditorState.phrases.of({
        Find: '查找',
        Replace: '替换',
        next: '下一个',
        previous: '上一个',
        all: '全部',
        'match case': '区分大小写',
        regexp: '正则表达式',
        'by word': '全词匹配',
        replace: '替换',
        'replace all': '全部替换',
        close: '关闭',
        'Go to line': '跳转到行',
        go: '跳转',
        'current match': '当前匹配',
        'on line': '所在行',
        'replaced match on line $': '已替换第 $ 行的匹配',
        'replaced $ matches': '已替换 $ 处匹配',
        'Fold line': '折叠此行',
        'Unfold line': '展开此行',
      }),
      Prec.high(editorThemes[theme]),
      EditorView.contentAttributes.of({
        'aria-label': label,
        tabindex: '0',
        spellcheck: 'false',
        'data-gramm': 'false',
      }),
    ],
    [format, label, theme],
  );
  const changed = useCallback(
    (text: string) => onChange?.(lineSeparator === '\r\n' ? text.replace(/\n/g, '\r\n') : text),
    [lineSeparator, onChange],
  );
  return (
    <CodeMirror
      value={value.replace(/\r\n/g, '\n')}
      theme={theme}
      extensions={configured}
      height={height}
      style={height === '100%' ? { height: '100%' } : undefined}
      minHeight="220px"
      readOnly={disabled}
      editable={!disabled}
      indentWithTab={false}
      basicSetup={basicSetup}
      onCreateEditor={(view) => {
        if (!initialLine) return;
        const from = view.state.doc.line(Math.min(initialLine, view.state.doc.lines)).from;
        view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
      }}
      // 编辑器内部保持 LF，写回沿用原行尾；避免 wrapper 反复替换整份内容和光标。
      onChange={changed}
    />
  );
}
