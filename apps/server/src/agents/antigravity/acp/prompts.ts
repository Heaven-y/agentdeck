import type { AgentTurnInput, NativeSteerInput, NativeInputResult } from '../../contracts';
import { acpInput } from '../../common/attachment-input';
import { AcpError, object, text, type AcpConnection, type AcpRecord } from './types';

type Receipt = {
  id: string;
  text: string;
  imageIds: string[];
  accepted: boolean;
  onAccepted?(): void;
  stored?(ids: string[]): Promise<void>;
  result: Promise<AcpRecord>;
  receipt: Promise<NativeInputResult>;
  resolve(value: NativeInputResult): void;
};
/** ACP新prompt会提前结束旧prompt；只有当前最新请求拥有整轮完成权。 */
export class AcpPrompts {
  accepting = true;
  private latest?: Receipt;
  private readonly entries: Receipt[] = [];
  constructor(
    private readonly client: AcpConnection,
    private readonly sessionId: string,
  ) {}
  send(input: NativeSteerInput): Receipt {
    if (!this.accepting) throw new AcpError('selection', '本轮原生请求已结束。');
    if (input.clientMessageId && this.entries.some((entry) => entry.id === input.clientMessageId))
      throw new AcpError('selection', '此消息已经投递，不能再次发送。');
    if (this.entries.length >= 32) throw new AcpError('selection', '本轮追加输入已达到上限。');
    let finish!: (result: NativeInputResult) => void;
    const receipt = new Promise<NativeInputResult>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(
      () => finish({ status: 'unknown', message: '原生受理尚未确认，请核对历史；不会自动重发。' }),
      30_000,
    );
    timer.unref();
    const entry: Receipt = {
      id: input.clientMessageId,
      text: input.text,
      imageIds: input.attachments?.filter((file) => file.kind === 'image').map((file) => file.id) ?? [],
      accepted: false,
      onAccepted: input.onAccepted,
      stored: input.attachmentsStored,
      result: Promise.resolve({}),
      receipt,
      resolve: (value) => {
        clearTimeout(timer);
        finish(value);
      },
    };
    this.entries.push(entry);
    this.latest = entry;
    entry.result = this.client.request(
      'session/prompt',
      { sessionId: this.sessionId, prompt: acpInput(input.text, input.attachments) },
      { timeoutMs: 0 },
    );
    void entry.result.then(
      () => this.accept(entry),
      (error: unknown) =>
        entry.resolve({
          status: error instanceof AcpError && error.code === 'native' ? 'rejected' : 'unknown',
          message: '原生未确认此输入，请核对历史；不会自动重发。',
        }),
    );
    return entry;
  }
  echo(update: AcpRecord): void {
    if (update.sessionUpdate !== 'user_message_chunk') return;
    const content = object(update.content);
    if (content.type !== 'text') return;
    const candidate = this.entries.find((entry) => !entry.accepted && entry.text && entry.text === text(content.text));
    if (candidate) this.accept(candidate);
  }
  private accept(entry: Receipt): void {
    if (!entry.accepted) {
      entry.accepted = true;
      entry.onAccepted?.();
    }
    entry.resolve({ status: 'accepted' });
  }
  async completion(): Promise<AcpRecord> {
    while (this.latest) {
      const current = this.latest;
      try {
        const result = await current.result;
        if (current === this.latest) {
          this.accepting = false;
          return result;
        }
      } catch (error) {
        if (current === this.latest) {
          this.accepting = false;
          throw error;
        }
      }
    }
    throw new AcpError('protocol', '原生输入尚未开始。');
  }
  async stored(): Promise<void> {
    for (const entry of this.entries)
      if (entry.accepted && entry.imageIds.length) await entry.stored?.(entry.imageIds).catch(() => undefined);
  }
  close(): void {
    this.accepting = false;
    for (const entry of this.entries)
      if (!entry.accepted) entry.resolve({ status: 'unknown', message: '原生连接已结束，输入受理未确认。' });
  }
}
export function firstAcpInput(input: AgentTurnInput, content: string): NativeSteerInput {
  return {
    clientMessageId: input.clientMessageId ?? '',
    text: content,
    attachments: input.attachments,
    onAccepted: input.onInputAccepted,
    attachmentsStored: input.attachmentsStored,
  };
}
