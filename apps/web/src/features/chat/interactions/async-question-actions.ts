import {
  InteractionAnswerSchema,
  interactionAnswerErrors,
  type AsyncQuestion,
  type InteractionAnswer,
  type FollowupSnapshot,
  type ServerMessage,
  type AgentEvent,
} from '@agentdeck/shared/conversation';
import type { ChatState, ConversationView } from '../state/chat-state';
import type { ChatSocket } from '../../../lib/ws';
import type { ChatItem } from '../../conversation/model/conversation-events';
import { reduceChat } from '../../conversation/model/conversation-events';
import { conversationViews, updateConversation } from '../state/conversations';
import { sessionsApi } from '../../sessions/api';
type Get = () => ChatState;
type Set = (patch: Partial<ChatState>) => void;
function questionView(state: ChatState, question: AsyncQuestion) {
  return conversationViews(state).find(
    (view) =>
      view.agent === 'codex' &&
      view.sessionId === question.sessionId &&
      view.items.some((item) => item.kind === 'async-question' && item.question.messageId === question.messageId),
  );
}
function updateQuestion(
  view: ConversationView,
  question: AsyncQuestion,
  patch: Partial<Extract<ChatItem, { kind: 'async-question' }>>,
) {
  return view.items.map((item) =>
    item.kind === 'async-question' &&
    item.question.sessionId === question.sessionId &&
    item.question.messageId === question.messageId
      ? { ...item, ...patch }
      : item,
  );
}
function validAnswer(question: AsyncQuestion, answer: InteractionAnswer) {
  return (
    InteractionAnswerSchema.safeParse(answer).success &&
    answer.action === 'submit' &&
    !Object.keys(interactionAnswerErrors(question.spec, answer)).length
  );
}
function canAnswer(item: ChatItem | undefined) {
  return (
    item?.kind === 'async-question' && item.status === 'open' && !item.responding && !item.dismissed && !item.recovery
  );
}

function startQuestionVerification(
  question: AsyncQuestion,
  id: string,
  change: (question: AsyncQuestion, patch: Partial<Extract<ChatItem, { kind: 'async-question' }>>) => void,
) {
  change(question, { recovery: { id, checking: true }, error: undefined });
  return id;
}

function isCurrentVerification(get: Get, question: AsyncQuestion, id: string) {
  return findQuestion(questionView(get(), question), question)?.recovery?.id === id;
}

function verifiedAnswer(native: Extract<AgentEvent, { type: 'async_question' }>) {
  return {
    question: native.question,
    status: native.answered ? ('accepted' as const) : ('open' as const),
    recovery: undefined,
    responding: false,
    error: native.answered ? undefined : '原生历史尚未确认回答；已保留答案，可显式提交，服务端仍会核对去重。',
  };
}

function recordVerificationFailure(
  get: Get,
  question: AsyncQuestion,
  id: string,
  change: (question: AsyncQuestion, patch: Partial<Extract<ChatItem, { kind: 'async-question' }>>) => void,
) {
  if (isCurrentVerification(get, question, id))
    change(question, { recovery: { id }, error: '未能核对原生问题，请保留答案并重试核对。' });
}

async function readNativeQuestion(question: AsyncQuestion, workspaceId: string) {
  const history = await sessionsApi.fullSessionEvents(
    workspaceId,
    question.sessionId,
    'codex',
    AbortSignal.timeout(30_000),
  );
  const native = history.events.find(
    (event) =>
      event.type === 'async_question' &&
      event.question.sessionId === question.sessionId &&
      event.question.messageId === question.messageId,
  );
  if (native?.type !== 'async_question') throw new Error('未找到原生问题');
  return native;
}

async function verifyQuestion(
  get: Get,
  question: AsyncQuestion,
  change: (question: AsyncQuestion, patch: Partial<Extract<ChatItem, { kind: 'async-question' }>>) => void,
) {
  const view = questionView(get(), question);
  const item = findQuestion(view, question);
  if (!view?.workspaceId || !item?.recovery || item.recovery.checking || get().connection !== 'open') return false;
  const id = startQuestionVerification(question, item.recovery.id, change);
  try {
    const native = await readNativeQuestion(question, view.workspaceId);
    if (!isCurrentVerification(get, question, id)) return false;
    change(question, verifiedAnswer(native));
    return true;
  } catch {
    recordVerificationFailure(get, question, id, change);
    return false;
  }
}

export function createAsyncQuestionActions(get: Get, set: Set, send: ChatSocket['send']) {
  function change(question: AsyncQuestion, patch: Partial<Extract<ChatItem, { kind: 'async-question' }>>) {
    const view = questionView(get(), question);
    if (view) set(updateConversation(get(), view, { items: updateQuestion(view, question, patch) }));
  }
  return {
    respondAsyncQuestion(question: AsyncQuestion, answer: InteractionAnswer) {
      const state = get(),
        view = questionView(state, question);
      if (!view?.workspaceId || state.connection !== 'open' || !validAnswer(question, answer)) return false;
      const item = view.items.find(
        (item) => item.kind === 'async-question' && item.question.messageId === question.messageId,
      );
      if (!canAnswer(item)) return false;
      change(question, { responding: true, answer, error: undefined });
      if (
        !send({
          type: 'question.respond',
          workspaceId: view.workspaceId,
          agent: 'codex',
          sessionId: question.sessionId,
          conversationId: view.conversationId,
          messageId: question.messageId,
          answer,
          model: view.modelOverrides.codex.trim() || undefined,
          reasoningEffort: view.reasoningEfforts.codex.trim() || undefined,
          collaborationMode: view.collaborationMode,
          ...(view.permission ? { permission: view.permission } : {}),
        })
      ) {
        change(question, { responding: false });
        return false;
      }
      return true;
    },
    dismissAsyncQuestion(question: AsyncQuestion) {
      change(question, { dismissed: true });
    },
    verifyAsyncQuestion: (question: AsyncQuestion) => verifyQuestion(get, question, change),
  };
}
function findQuestion(view: ConversationView | undefined, question: AsyncQuestion) {
  return view?.items.find(
    (item): item is Extract<ChatItem, { kind: 'async-question' }> =>
      item.kind === 'async-question' &&
      item.question.sessionId === question.sessionId &&
      item.question.messageId === question.messageId,
  );
}
export function invalidateAsyncQuestions(get: Get, set: Set) {
  for (const view of conversationViews(get())) {
    const items = view.items.map((item) =>
      item.kind === 'async-question' &&
      (item.responding || item.recovery || ['queued', 'dispatching', 'unknown'].includes(item.status))
        ? {
            ...item,
            status: 'open' as const,
            responding: false,
            recovery: { id: crypto.randomUUID() },
            error: '答复受理尚未确认；请先核对原生历史，答案已保留，不会自动重发。',
          }
        : item,
    );
    set(updateConversation(get(), view, { items }));
  }
}
export function snapshotQuestions(items: ChatItem[], snapshot: FollowupSnapshot) {
  let next = items;
  for (const state of snapshot.questions ?? []) {
    next = reduceChat(next, { type: 'async_question', question: state.question });
    next = next.map((item) =>
      item.kind === 'async-question' &&
      item.question.sessionId === state.question.sessionId &&
      item.question.messageId === state.question.messageId
        ? {
            ...item,
            status: item.status === 'accepted' ? 'accepted' : state.status,
            responding: false,
            error: undefined,
          }
        : item,
    );
  }
  return next;
}
export function asyncQuestionError(get: Get, set: Set, message: Extract<ServerMessage, { type: 'question.error' }>) {
  const view = conversationViews(get()).find(
    (view) =>
      view.workspaceId === message.workspaceId && view.agent === message.agent && view.sessionId === message.sessionId,
  );
  if (!view) return;
  set(
    updateConversation(get(), view, {
      items: view.items.map((item) =>
        item.kind === 'async-question' && item.question.messageId === message.messageId
          ? { ...item, responding: false, error: message.message }
          : item,
      ),
    }),
  );
}
