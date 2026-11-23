import { parseSessionReference, sessionReferenceHash, type SessionLocation } from '@agentdeck/shared/conversation';
export type { SessionLocation } from '@agentdeck/shared/conversation';
export { findSessionReferences, type TextSessionReference } from '@agentdeck/shared/conversation';
const invalidLink = () => new Error('会话链接格式无效，请重新复制完整链接');

/** 网页链接保留本机定位身份；发送引用时由后端补充原生记录位置。 */
export function sessionLink(location: SessionLocation, base: string): string {
  const url = new URL(base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidLink();
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = sessionReferenceHash(location);
  return url.href;
}

export function parseSessionLink(hash: string): SessionLocation | undefined {
  if (!hash || hash === '#') return undefined;
  if (hash.length > 1024 || !hash.startsWith('#session?')) throw invalidLink();
  return parseSessionReference(hash);
}

export const SESSION_OPEN_EVENT = 'agentdeck:session-open';

/** 相同链接也能重新打开；不把自有协议交给浏览器启动外部应用。 */
export function navigateToSessionReference(reference: string): void {
  const hash = sessionReferenceHash(parseSessionReference(reference));
  if (window.location.hash !== hash) window.location.hash = hash;
  else window.dispatchEvent(new CustomEvent(SESSION_OPEN_EVENT, { detail: hash }));
}
