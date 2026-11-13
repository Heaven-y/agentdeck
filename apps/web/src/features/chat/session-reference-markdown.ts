import { defaultRemarkPlugins } from 'streamdown';
import { parseSessionReference, sessionReferenceHash } from '@agentdeck/shared/conversation';
import { findSessionReferences } from '../sessions/session-links';

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };

function textLinks(node: MarkdownNode): MarkdownNode[] {
  const text = node.value ?? '';
  const refs = findSessionReferences(text);
  if (!refs.length) return [node];
  const result: MarkdownNode[] = [];
  let start = 0;
  for (const reference of refs) {
    result.push(
      { type: 'text', value: text.slice(start, reference.start) },
      {
        type: 'link',
        url: sessionReferenceHash(reference.location),
        children: [{ type: 'text', value: reference.text }],
      },
    );
    start = reference.end;
  }
  result.push({ type: 'text', value: text.slice(start) });
  return result;
}

/**
 * sanitize 与 harden 只放行这些形态；其余链接会被替换成带 `[blocked]` 的纯文本。
 * 降级在解析阶段完成，安全策略本身不放宽。
 */
const linkable = (url: string): boolean => /^(?:#|[/.]|(?:https?|mailto|tel|irc|ircs|xmpp):)/.test(url);
const textOnly = (node: MarkdownNode): MarkdownNode[] =>
  node.children?.length ? node.children : [{ type: 'text', value: node.url ?? '' }];

function rewrite(node: MarkdownNode): MarkdownNode[] {
  if (node.type === 'linkReference') return [node];
  if (node.type === 'link' || node.type === 'definition') {
    try {
      node.url = sessionReferenceHash(parseSessionReference(node.url ?? ''));
    } catch {
      /* 普通链接继续按下面的形态判定处理。 */
    }
    if (linkable(node.url ?? '')) return [node];
    // 定义不可用时对应的引用会退化成普通文本，不能留下指向被删定义的链接。
    return node.type === 'link' ? textOnly(node) : [];
  }
  if (!node.children) return [node];
  node.children = node.children.flatMap((child) => (child.type === 'text' ? textLinks(child) : rewrite(child)));
  return [node];
}

/** 在默认 HTML 清理前把已验证引用变为页内链接，并降级无法渲染的链接目标。 */
function remarkSessionReferences() {
  return (node: MarkdownNode) => {
    rewrite(node);
  };
}
export const sessionRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkSessionReferences];
