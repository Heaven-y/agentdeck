import { z } from 'zod';

/**
 * 项目输入：名称 + 本地项目目录。
 * 项目是本地工作区的容器，与服务器档案无关——服务器由 SSH Console 按服务器自身管理。
 * 只读取声明的字段，必须提供 dir；其他字段不会被转换为本地目录或服务器绑定。
 */
export const WorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** 本地项目目录的绝对路径，是否存在由后端检查 */
  dir: z.string().min(1),
});

export const WorkspaceSchema = WorkspaceInputSchema.extend({ id: z.string().min(1) });
export type WorkspaceInput = z.infer<typeof WorkspaceInputSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;

export type WorkspaceFilePreview = { path: string; content: string; view: 'content' | 'diff' };
