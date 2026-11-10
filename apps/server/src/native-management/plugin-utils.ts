import path from 'node:path';
import { opendir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NativeResourceError } from '../agents/common/configuration/errors';
import { inspectDirectory } from '../platform/files/safe-file';
import { NativeManagementError } from './errors';
import { object, string } from './plugin-types';
import type { ResourceContext } from '../agents/common/configuration/resources';
import { sameSessionDirectory } from '../agents/common/session-scope';
export const pluginDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const safeName = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export const safeSelector = (value: string) => value.split('@').length === 2 && value.split('@').every(safeName);
export function jsonResult(data: Buffer): unknown {
  const text = data.toString('utf8').trim();
  try {
    return JSON.parse(text);
  } catch {
    const last = text.split('\n').findLast((line) => line.trim().startsWith('{'));
    if (last) return JSON.parse(last);
    throw new NativeManagementError('native_unavailable');
  }
}
export function arrayResult(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > 512) throw new NativeManagementError('native_unavailable');
  return value.map(object);
}
/** Claude 列表跨项目返回安装记录；项目/个人项目项必须核对原生 projectPath。 */
export async function claudePluginRecords(context: ResourceContext, value: unknown) {
  const selected: Array<Record<string, unknown>> = [];
  for (const record of arrayResult(value)) {
    if (!['project', 'local'].includes(string(record.scope))) {
      selected.push(record);
      continue;
    }
    if (
      context.project &&
      typeof record.projectPath === 'string' &&
      (await sameSessionDirectory(context.project.dir, record.projectPath))
    )
      selected.push(record);
  }
  return selected;
}
export async function directories(root: string) {
  if (!(await inspectDirectory(root))) return [];
  const names: string[] = [];
  const dir = await opendir(root);
  for await (const item of dir) {
    if (names.length >= 512) throw new NativeManagementError('native_unavailable');
    if (item.isDirectory() && !item.isSymbolicLink()) names.push(item.name);
  }
  return names.sort();
}
function sourceLocation(value: unknown) {
  const source = object(value);
  if (['directory', 'file'].includes(string(source.source)) && typeof source.path === 'string') return source.path;
  return typeof value === 'string' ? value : string(source.url ?? source.repo ?? source.source);
}
export function sourceLabel(value: unknown): string {
  const source = object(value),
    location = sourceLocation(value);
  if (/^https?:\/\//.test(location)) {
    try {
      const url = new URL(location);
      return `${url.origin}${url.pathname}`;
    } catch {
      return '原生来源';
    }
  }
  return location.slice(0, 1024) || string(source.source_type ?? source.sourceType) || '本地目录';
}
function validHttps(source: string) {
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
export async function validatePluginSource(source: string, selectorOnly: boolean) {
  if (/[\r\n\0]/.test(source) || source.startsWith('-')) throw new NativeResourceError('invalid_request');
  if (selectorOnly) {
    if (!safeSelector(source)) throw new NativeResourceError('invalid_request');
    return;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/.test(source) || validHttps(source)) return;
  if (path.isAbsolute(source) && (await inspectDirectory(source))) return;
  throw new NativeResourceError('invalid_request');
}
