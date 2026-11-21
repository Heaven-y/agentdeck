import type { SessionHistoryPageInfo, AgentEvent } from '@agentdeck/shared/conversation';
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
import { antigravityDiagnostic } from '../run/diagnostics';

const DONE = 'CORTEX_STEP_STATUS_DONE';
const FAILED = new Set(['CORTEX_STEP_STATUS_ERROR', 'CORTEX_STEP_STATUS_INVALID']);
const CANCELLED = new Set(['CORTEX_STEP_STATUS_CANCELED', 'CORTEX_STEP_STATUS_INTERRUPTED']);
const TOOL_TYPES = new Set([
  'CORTEX_STEP_TYPE_RUN_COMMAND',
  'CORTEX_STEP_TYPE_VIEW_FILE',
  'CORTEX_STEP_TYPE_FILE_CHANGE',
  'CORTEX_STEP_TYPE_WRITE_TO_FILE',
  'CORTEX_STEP_TYPE_MCP_TOOL',
  'CORTEX_STEP_TYPE_GENERIC',
]);
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
  events.push({
    type: 'tool_result',
    id,
    output: clip(value.output || text(object(step.error).userErrorMessage), preserve),
    isError: FAILED.has(text(step.status)) || ('failed' in value && value.failed === true),
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
  const events: AgentEvent[] = content
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

function toolOrActivity(step: ManagementRecord, index: number, preserve: boolean): AgentEvent[] {
  return TOOL_TYPES.has(text(step.type)) || text(object(object(step.metadata).toolCall).name)
    ? toolEvents(step, index, preserve)
    : activity(step, index);
}

function failedStep(step: ManagementRecord) {
  return FAILED.has(text(step.status)) || !!errorMessage(step);
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
    case 'CORTEX_STEP_TYPE_ERROR_MESSAGE': {
      const message = errorMessage(step);
      const diagnostic = antigravityDiagnostic(message);
      return message
        ? [{ type: 'error', message: diagnostic?.type === 'error' ? diagnostic.message : clip(message) }]
        : [];
    }
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

/** 跨页片段仅保存用来核对整轮的事实；读到真实轮头才结算，不制造实时“结果待核实”。 */
export function projectAntigravityHistory(trajectory: ManagementRecord, options: ReplayOptions) {
  const events: AgentEvent[] = pageNotice(options);
  const fragments: Pick<SessionHistoryPageInfo, 'leading' | 'trailing' | 'sameFragment'> = {};
  let forkPoint: string | undefined;
  let failed = false;
  let omitted = false;
  let cancelled: boolean | undefined;
  let started = false;
  let leading = !!options.partialStart;
  const finish = (trailing: boolean) => {
    const fragment = { failed, cancelled, omitted, forkPoint: trailing ? undefined : forkPoint };
    if (leading) fragments.leading = fragment;
    if (trailing) {
      fragments.trailing = fragment;
      if (leading) fragments.sameFragment = true;
    }
    if (!leading && !trailing && !omitted)
      events.push({ type: 'turn_end', isError: failed || !!cancelled, ...(forkPoint ? { forkPoint } : {}) });
  };
  list(trajectory.steps).forEach((value, position) => {
    const index = (options.offset ?? 0) + position;
    const step = object(value);
    if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT' && started) {
      finish(false);
      forkPoint = undefined;
      failed = false;
      omitted = false;
      cancelled = undefined;
      leading = false;
    }
    started = true;
    omitted ||= step.type === OMITTED_HISTORY_STEP;
    const status = text(step.status);
    if (status === DONE && step.type !== 'CORTEX_STEP_TYPE_USER_INPUT') forkPoint = String(index);
    else forkPoint = undefined;
    cancelled = recordedCancellation(step) ?? cancelled;
    failed ||= failedStep(step);
    events.push(...stepEvents(step, index, options.preserveToolContent ?? false, trajectory));
  });
  if (started) finish(!!options.partialEnd);
  if (options.includeContext !== false) {
    const last = object(list(trajectory.generatorMetadata).at(-1));
    const context = object(object(last.chatModel).chatStartMetadata).contextWindowMetadata;
    events.push(...contextEvent(context));
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
