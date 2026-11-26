import type { ServerMessage } from '@agentdeck/shared/conversation';

type Receipt = { state: 'sent' | 'accepted' | 'rejected'; at: number };
const receipts = new Map<string, Receipt>();

/** WebSocket 写入与服务端受理分开记录，插件重试只能沿用同一请求身份。 */
export function pluginInputReceipt(id: string): Receipt['state'] | undefined {
  return receipts.get(id)?.state;
}
export function previousPluginInput(id: string): boolean | undefined {
  const receipt = pluginInputReceipt(id);
  if (receipt === 'accepted') return true;
  if (receipt === 'sent') return false;
  if (receipt === 'rejected') throw new Error('会话未接受自动续接，请在原会话中查看原因并手动继续。');
  return undefined;
}
export function markPluginInputSent(id: string) {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [key, receipt] of receipts) if (receipt.at < cutoff) receipts.delete(key);
  if (receipts.size >= 1024) throw new Error('待确认的插件消息过多，请等待已有会话完成。');
  receipts.set(id, { state: 'sent', at: Date.now() });
}
export function observePluginInput(message: ServerMessage) {
  if (message.type !== 'turn.started' && message.type !== 'error') return;
  const id = message.clientTurnId;
  if (!id || !receipts.has(id)) return;
  receipts.set(id, { state: message.type === 'turn.started' ? 'accepted' : 'rejected', at: Date.now() });
}
