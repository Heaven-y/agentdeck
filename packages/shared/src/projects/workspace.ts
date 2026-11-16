import { z } from 'zod';

/**
 * 项目输入：名称 + 本地项目目录。
 * 项目是本地工作区的容器，与服务器档案无关——服务器由 SSH Console 按服务器自身管理。
 * 旧配置里的 localDir / sshHost / server / remoteDir 等键不再声明；zod 默认丢弃未知键，
 * 因此旧配置能被读入而不会整份解析失败。
 */
export const WorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** 本地项目目录的绝对路径，是否存在由后端检查 */
  dir: z.string().min(1),
});

export const WorkspaceSchema = WorkspaceInputSchema.extend({ id: z.string().min(1) });
export type WorkspaceInput = z.infer<typeof WorkspaceInputSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
