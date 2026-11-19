import type { SessionForkInput } from '@agentdeck/shared/conversation';
import type { HistoryWindow } from '../management/history-window';
export type SubagentTrajectoryIdentity = { id: string; parentId: string; rootId: string; depth: number };

/** 通过 Antigravity 自身服务管理会话，提供方仍负责归属和返回身份复核。 */
export type AntigravitySessionManagement = {
  /** 子代理专用只读快照；根和每条父边仍须由原生轨迹核实，允许活动历史。 */
  readSubagentTrajectory?(
    rootId: string,
    dir: string,
    child?: SubagentTrajectoryIdentity,
    signal?: AbortSignal,
  ): Promise<{ trajectory: Record<string, unknown>; status?: string }>;
  /** 只读完整轨迹；实现必须先校验会话身份与工作区目录。 */
  readTrajectory?(
    id: string,
    dir: string,
    signal?: AbortSignal,
  ): Promise<{ trajectory: Record<string, unknown>; status?: string }>;
  readHistoryWindow?(id: string, dir: string, before?: string, signal?: AbortSignal): Promise<HistoryWindow>;
  readHistoryStep?(id: string, dir: string, index: number, signal?: AbortSignal): Promise<unknown>;
  /** 回合判定需要已核对完整性和空闲状态的轨迹；不可用时保留结果未确认。 */
  readTurnTrajectory?: AntigravitySessionManagement['readTrajectory'];
  rename?(id: string, dir: string, title: string): Promise<void>;
  delete(id: string, dir: string): Promise<void>;
  fork(id: string, dir: string, input: SessionForkInput): Promise<{ sessionId: string }>;
};
