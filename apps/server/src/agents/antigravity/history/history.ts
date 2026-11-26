import {
  historyTurnFailureMessage,
  preferHistoryTurnFailure,
  type HistoryTurnFailure,
  type HistoryTurnFragment,
  type SessionHistoryPageInfo,
  type AgentEvent,
} from '@agentdeck/shared/conversation';
import { mediaReference } from '../../common/media/native-media';
import {
  managementObject as object,
  managementText as text,
  type ManagementRecord,
} from '../management/management-rpc';
import { contextEvent, historyResponseTiming, historyTiming, stepUsage } from '../run/metrics';
import { historyGeneration } from '../run/generation-timing';
import { historyResponseModel } from '../run/generation-model';
import { OMITTED_HISTORY_STEP } from '../management/history-window';
import { ANTIGRAVITY_EMPTY_REPLY, antigravityToolDiagnostic } from '../run/diagnostics';
import {
  completedStep,
  finalResponse,
  rateLimitedStep,
  recognizedRecordedError,
  recordedToolFailure,
  recordedToolStep,
} from '../commands/completion';

const DONE = 'CORTEX_STEP_STATUS_DONE';
const FAILED = new Set(['CORTEX_STEP_STATUS_ERROR', 'CORTEX_STEP_STATUS_INVALID']);
const CANCELLED = new Set(['CORTEX_STEP_STATUS_CANCELED', 'CORTEX_STEP_STATUS_INTERRUPTED']);
const clip = (value: string, preserve = false) =>
  !preserve && value.length > 20_000 ? `${value.slice(0, 20_000)}\n[输出已截断]` : value;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function argumentsOf(value: unknown, preserve: boolean): unknown {
  const json = text(object(value).argumentsJson);
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return clip(json, preserve);
  }
}

function command(step: ManagementRecord) {
  const value = object(step.runCommand);
  const output = object(value.combinedOutput);
  const snapshot = object(value.combinedOutputSnapshot);
  return {
    name: 'run_command',
    input: { command: value.commandLine ?? value.command, cwd: value.cwd },
    output:
      text(output.full) ||
      text(output.truncated) ||
      text(snapshot.full) ||
      text(snapshot.truncated) ||
      [text(value.stdout), text(value.stderr)].filter(Boolean).join('\n'),
    failed:
      value.userRejected === true ||
      value.timedOut === true ||
      (typeof value.exitCode === 'number' && value.exitCode !== 0),
  };
}

function file(step: ManagementRecord, preserve: boolean) {
  const read = object(step.viewFile);
  if (step.type === 'CORTEX_STEP_TYPE_VIEW_FILE')
    return {
      name: 'read_file',
      input: { path: read.absolutePathUri, startLine: read.startLine, endLine: read.endLine },
      output: text(read.content),
    };
  const change = object(step.fileChange);
  const write = object(step.writeToFile);
  return {
    name: 'fileChange',
    input: {
      ...object(argumentsOf(object(step.metadata).toolCall, preserve)),
      path: change.absolutePathUri ?? write.targetFileUri,
    },
    output: text(write.codeContent) || text(change.instruction),
  };
}

function tool(step: ManagementRecord, preserve: boolean) {
  const call = object(object(step.metadata).toolCall);
  if (step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND') return command(step);
  if (
    ['CORTEX_STEP_TYPE_VIEW_FILE', 'CORTEX_STEP_TYPE_FILE_CHANGE', 'CORTEX_STEP_TYPE_WRITE_TO_FILE'].includes(
      text(step.type),
    )
  )
    return file(step, preserve);
  if (step.type === 'CORTEX_STEP_TYPE_MCP_TOOL') {
    const mcp = object(step.mcpTool);
    return {
      name: `mcp__${text(mcp.serverName)}__${text(object(mcp.toolCall).name)}`,
      input: argumentsOf(mcp.toolCall, preserve),
      output: text(mcp.resultString),
      failed: mcp.userRejected === true,
    };
  }
  if (step.type === 'CORTEX_STEP_TYPE_GENERIC') {
    const generic = object(step.generic);
    return {
      name: text(call.name) || '原生工具',
      input: generic.args ?? argumentsOf(call, preserve),
      output: text(object(generic.result).result),
    };
  }
  // 未适配的步骤只展示原生类型、工具参数与状态，绝不展开内部 Any、签名和调试正文。
  return {
    name: text(call.name) || text(step.type).replace('CORTEX_STEP_TYPE_', ''),
    input: { arguments: argumentsOf(call, preserve), status: step.status },
    output: '',
  };
}

function toolEvents(step: ManagementRecord, index: number, preserve: boolean): AgentEvent[] {
  const value = tool(step, preserve);
  const id = `agy-step-${index}`;
  const events: AgentEvent[] = [{ type: 'tool_call', id, name: value.name, input: value.input }];
  if (step.status !== DONE && !FAILED.has(text(step.status))) return events;
  const error = object(step.error);
  const visible = text(error.userErrorMessage);
  const diagnostic = antigravityToolDiagnostic({ type: error.type, message: visible });
  events.push({
    type: 'tool_result',
    id,
    output: clip(value.output || diagnostic?.message || visible, preserve),
    isError: FAILED.has(text(step.status)) || !!text(error.type) || ('failed' in value && value.failed === true),
    ...historyTiming(step.metadata),
  });
  return events;
}

function checkpoint(step: ManagementRecord): AgentEvent[] {
  const failed = object(step.checkpoint).modelSummarizationFailed === true || FAILED.has(text(step.status));
  const status = failed ? 'failed' : step.status === DONE ? 'completed' : 'cancelled';
  return [{ type: 'compaction', state: { status } }];
}

function activityStatus(status: unknown): Extract<AgentEvent, { type: 'activity' }>['status'] {
  if (status === DONE) return 'completed';
  if (FAILED.has(text(status))) return 'failed';
  if (CANCELLED.has(text(status))) return 'cancelled';
  if (
    [
      'CORTEX_STEP_STATUS_RUNNING',
      'CORTEX_STEP_STATUS_GENERATING',
      'CORTEX_STEP_STATUS_PENDING',
      'CORTEX_STEP_STATUS_QUEUED',
      'CORTEX_STEP_STATUS_WAITING',
    ].includes(text(status))
  )
    return 'running';
  return 'unknown';
}

function activity(step: ManagementRecord, index: number): AgentEvent[] {
  const type = text(step.type);
  if (!type) return [];
  return [
    {
      type: 'activity',
      id: `agy-step-${index}`,
      name: type.replace('CORTEX_STEP_TYPE_', ''),
      status: activityStatus(step.status),
      input: { type, status: step.status },
      ...historyTiming(step.metadata),
    },
  ];
}

function responseContent(step: ManagementRecord): string {
  const planner = object(step.plannerResponse);
  return text(planner.modifiedResponse) || text(planner.response);
}

/** 后续完整答复可恢复步骤取消；明确失败另行保留。 */
function recordedCancellation(step: ManagementRecord): boolean | undefined {
  if (CANCELLED.has(text(step.status))) return true;
  if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && step.status === DONE && responseContent(step).trim())
    return false;
}

function response(step: ManagementRecord, index: number, trajectory: ManagementRecord): AgentEvent[] {
  const content = responseContent(step);
  const responseModel = historyResponseModel(trajectory, step, index);
  const events: AgentEvent[] = content.trim()
    ? [{ type: 'text', id: `agy-step-${index}`, delta: content, ...(responseModel ? { responseModel } : {}) }]
    : [];
  const usage = stepUsage(object(step.metadata).modelUsage);
  if (step.status === DONE && usage) {
    const generation = historyGeneration(trajectory, step, index, usage);
    events.push({
      type: 'step_usage',
      id: `agy-step-${index}`,
      usage,
      ...historyResponseTiming(step.metadata),
      ...(generation ? { generation } : {}),
    });
  }
  return events;
}

function emptyFinalResponse(step: ManagementRecord): boolean {
  if (step.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step.status !== DONE || step.error) return false;
  const reply = object(step.plannerResponse);
  return (
    reply.stopReason === 'STOP_REASON_STOP_PATTERN' && !list(reply.toolCalls).length && !responseContent(step).trim()
  );
}

function toolOrActivity(step: ManagementRecord, index: number, preserve: boolean): AgentEvent[] {
  return recordedToolStep(step) ? toolEvents(step, index, preserve) : activity(step, index);
}

function errorMessage(step: ManagementRecord): string {
  const error = object(step.errorMessage);
  return error.shouldShowUser === true ? text(object(error.error).userErrorMessage) : '';
}

function stepEvents(
  step: ManagementRecord,
  index: number,
  preserve: boolean,
  trajectory: ManagementRecord,
): AgentEvent[] {
  switch (step.type) {
    case OMITTED_HISTORY_STEP:
      return [{ type: 'activity', id: `agy-step-${index}`, name: '原生步骤内容过大，已省略', status: 'unknown' }];
    case 'CORTEX_STEP_TYPE_USER_INPUT':
      return userInputEvents(step, index, trajectory);
    case 'CORTEX_STEP_TYPE_PLANNER_RESPONSE':
      return response(step, index, trajectory);
    case 'CORTEX_STEP_TYPE_CHECKPOINT':
      return checkpoint(step);
    case 'CORTEX_STEP_TYPE_ERROR_MESSAGE':
      return []; // 同轮错误在结算时选一条，重试步骤不单独挂红条。
    default:
      return toolOrActivity(step, index, preserve);
  }
}

type ReplayOptions = {
  preserveToolContent?: boolean;
  offset?: number;
  partialStart?: boolean;
  partialEnd?: boolean;
  compact?: boolean;
  includeContext?: boolean;
};

function pageNotice(options: ReplayOptions): AgentEvent[] {
  const first = options.offset ?? 0;
  const notices = [];
  if (options.partialStart || options.partialEnd) notices.push('此页含长回合的部分步骤');
  if (options.compact) notices.push('此页含较大的原生内容，工具详情已精简');
  return notices.length
    ? [{ type: 'activity', id: `agy-page-${first}`, name: notices.join('；'), status: 'unknown' }]
    : [];
}

export function antigravityHistory(trajectory: ManagementRecord, options: ReplayOptions = {}): AgentEvent[] {
  return projectAntigravityHistory(trajectory, options).events;
}

function historyEmptyReply(
  fragment: HistoryTurnFragment,
  tail: { step: ManagementRecord; hasReply: boolean; knownStart: boolean },
  trailing: boolean,
): string | undefined {
  if (
    trailing ||
    !tail.knownStart ||
    tail.hasReply ||
    fragment.failed ||
    fragment.failure ||
    fragment.cancelled ||
    fragment.omitted
  )
    return;
  return emptyFinalResponse(tail.step) ? ANTIGRAVITY_EMPTY_REPLY : undefined;
}

function historyTurnEnd(turn: HistoryTurnFragment): AgentEvent[] {
  const message = historyTurnFailureMessage(turn) ?? turn.emptyReplyMessage;
  const events: AgentEvent[] = message ? [{ type: 'error', message }] : [];
  if (!turn.omitted)
    events.push({
      type: 'turn_end',
      isError: turn.failed || !!turn.cancelled || !!message,
      ...(turn.forkPoint ? { forkPoint: turn.forkPoint } : {}),
    });
  return events;
}

function showTailFailure(turn: HistoryTurnFragment, events: AgentEvent[]): void {
  const failure = turn.failure;
  if (!failure || failure.retryOnly) return;
  turn.failure = { ...failure, shownAtTail: true };
  events.push({ type: 'error', message: failure.message });
}

function historyForkPoint(step: ManagementRecord, index: number) {
  return step.status === DONE && step.type !== 'CORTEX_STEP_TYPE_USER_INPUT' ? String(index) : undefined;
}

function historyStepFailure(
  step: ManagementRecord,
  only429: boolean,
): { failed: boolean; failure?: HistoryTurnFailure } {
  if (recordedToolStep(step)) {
    const diagnostic = recordedToolFailure(step);
    return { failed: !!diagnostic, failure: diagnostic && { message: diagnostic.message } };
  }
  const visible = step.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' ? errorMessage(step).trim() : '';
  return {
    failed: !only429 && (!!visible || FAILED.has(text(step.status))),
    failure: visible
      ? { message: recognizedRecordedError(step) ?? clip(visible), ...(only429 ? { retryOnly: true } : {}) }
      : undefined,
  };
}

/** 跨页片段仅保存用来核对整轮的事实；读到真实轮头才结算，不制造实时“结果待核实”。 */
export function projectAntigravityHistory(trajectory: ManagementRecord, options: ReplayOptions) {
  const events: AgentEvent[] = pageNotice(options);
  const fragments: Pick<SessionHistoryPageInfo, 'leading' | 'trailing' | 'sameFragment'> = {};
  let forkPoint: string | undefined;
  let failed = false;
  let failure: HistoryTurnFailure | undefined;
  let stepsCompleted = true;
  let omitted = false;
  let cancelled: boolean | undefined;
  let started = false;
  let leading = !!options.partialStart;
  let hasUser = false;
  let hasReply = false;
  let last: ManagementRecord = {};
  const finish = (trailing: boolean) => {
    const fragment: HistoryTurnFragment = {
      failed,
      cancelled,
      omitted,
      forkPoint: trailing ? undefined : forkPoint,
      failure,
    };
    if (stepsCompleted && (trailing || finalResponse(last))) fragment.retryRecovered = true;
    fragment.emptyReplyMessage = historyEmptyReply(
      fragment,
      { step: last, hasReply, knownStart: hasUser || leading },
      trailing,
    );
    if (leading) fragments.leading = fragment;
    if (trailing) {
      fragments.trailing = fragment;
      if (leading) fragments.sameFragment = true;
    } else if (!leading) events.push(...historyTurnEnd(fragment));
    else showTailFailure(fragment, events);
  };
  const recordStep = (step: ManagementRecord, index: number) => {
    started = true;
    last = step;
    omitted ||= step.type === OMITTED_HISTORY_STEP;
    forkPoint = historyForkPoint(step, index);
    cancelled = recordedCancellation(step) ?? cancelled;
    const only429 = rateLimitedStep(step);
    stepsCompleted &&=
      step.type === 'CORTEX_STEP_TYPE_USER_INPUT' ? step.status === DONE : only429 || completedStep(step);
    const outcome = historyStepFailure(step, only429);
    failed ||= outcome.failed;
    failure = preferHistoryTurnFailure(failure, outcome.failure);
  };
  list(trajectory.steps).forEach((value, position) => {
    const index = (options.offset ?? 0) + position;
    const step = object(value);
    if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      if (started) {
        finish(false);
        forkPoint = undefined;
        failed = false;
        failure = undefined;
        stepsCompleted = true;
        omitted = false;
        cancelled = undefined;
        leading = false;
        hasReply = false;
      }
      hasUser = true;
    }
    recordStep(step, index);
    const projected = stepEvents(step, index, options.preserveToolContent ?? false, trajectory);
    hasReply ||= projected.some((event) => event.type === 'text');
    events.push(...projected);
  });
  if (started) finish(!!options.partialEnd);
  if (options.includeContext !== false) {
    const last = object(list(trajectory.generatorMetadata).at(-1));
    const chatModel = object(last.chatModel);
    const context = object(chatModel.chatStartMetadata).contextWindowMetadata;
    events.push(...contextEvent(context, chatModel.usage));
  }
  return { events, fragments };
}

function userInputEvents(step: ManagementRecord, index: number, trajectory: ManagementRecord): AgentEvent[] {
  const user = object(step.userInput);
  const attachments = list(user.media).flatMap((value, mediaIndex) =>
    text(object(value).mimeType).startsWith('image/')
      ? [
          mediaReference(text(trajectory.cascadeId), String(index), mediaIndex, {
            kind: 'user',
            mimeType: text(object(value).mimeType),
          }),
        ]
      : [],
  );
  const content =
    text(user.query) ||
    text(user.userResponse) ||
    list(user.items)
      .map((item) => text(object(item).text))
      .filter(Boolean)
      .join('\n');
  return content || attachments.length
    ? [{ type: 'user_message', text: content, ...(attachments.length ? { attachments } : {}) }]
    : [];
}
