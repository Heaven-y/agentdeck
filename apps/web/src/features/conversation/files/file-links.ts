export type FileLocation = { path: string; line?: number };

/** 文件链接只负责定位；读取范围由当前工作区的后端接口校验。 */
export function localFileLink(href: string): FileLocation | undefined {
  let value = href;
  if (value.startsWith('#file?')) return hashLocation(value);
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname) return;
      value = url.pathname + url.hash;
      if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
    } catch {
      return;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return;
  if (!/^(?:[a-z]:[\\/]|\/[^/]|\.\.?\/)|^[^?#]+\.[a-z\d]{1,12}(?::\d+)?(?:#L\d+)?$/i.test(value)) return;
  try {
    value = decodeURIComponent(value);
  } catch {
    return;
  }
  return pathLocation(value);
}

function pathLocation(value: string): FileLocation {
  const suffix = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(value);
  const line = suffix ? Number(suffix[1] ?? suffix[2]) : undefined;
  return { path: suffix ? value.slice(0, suffix.index) : value, ...(line ? { line } : {}) };
}

function hashLocation(value: string): FileLocation | undefined {
  const query = new URLSearchParams(value.slice(6));
  const path = query.get('path');
  const line = Number(query.get('line'));
  return path ? { path, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) } : undefined;
}

export function fileLocationHash(location: FileLocation) {
  return `#file?${new URLSearchParams({ path: location.path, ...(location.line ? { line: String(location.line) } : {}) })}`;
}
