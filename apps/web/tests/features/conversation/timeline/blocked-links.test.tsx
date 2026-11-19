// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MessageItem } from '../../../../src/features/conversation/timeline/MessageItem';
import type { ChatItem } from '../../../../src/features/conversation/model/conversation-events';

afterEach(cleanup);
/** Streamdown 把可点链接渲染成安全确认按钮，被拦截的降级为纯文本 span。 */
function shown(href: string) {
  const item: Extract<ChatItem, { kind: 'assistant' }> = {
    kind: 'assistant',
    id: 'a1',
    text: `[标签](${href})`,
    streaming: false,
  };
  const { container } = render(<MessageItem item={item} expanded={false} onExpandedChange={() => {}} />);
  const content = container.textContent ?? '';
  const link = container.querySelector('[data-streamdown="link"], a');
  cleanup();
  return { content, link };
}

it.each(['src/app.ts', 'docs/readme.md', 'vscode://file/x', 'javascript:alert(1)', 'data:text/html,x', 'HTTP://X'])(
  '不可渲染的链接目标 %s 只显示文字，不带 [blocked]',
  (href) => {
    const { content, link } = shown(href);
    expect(content).toBe('标签');
    expect(content).not.toContain('[blocked]');
    expect(link).toBeNull();
  },
);

it.each(['https://example.com', 'mailto:a@b.c', '#section'])('可渲染的链接目标 %s 仍是链接', (href) => {
  const { content, link } = shown(href);
  expect(content).toBe('标签');
  expect(link).not.toBeNull();
});
