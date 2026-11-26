// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ToolGroup } from '../../../../src/features/conversation/timeline/ToolGroup';
import type { ToolItem } from '../../../../src/features/conversation/timeline/timeline-model';

afterEach(cleanup);
const source: ToolItem[] = Array.from({ length: 40 }, (_, i) => ({
  kind: 'tool',
  id: `read-${i}`,
  name: 'Read',
  input: { path: `src/example-${i}.py` },
  output: `读取结果 ${i}`,
  status: 'done',
}));
function fixture(expanded: boolean) {
  return (
    <ToolGroup
      items={source}
      expanded={expanded}
      onExpandedChange={vi.fn()}
      itemExpanded={() => false}
      setItemExpanded={vi.fn()}
    />
  );
}

it('折叠组卸载工具内容，展开呈现组内全部条目', () => {
  const { rerender } = render(fixture(false));
  expect(screen.queryAllByTitle('Read')).toHaveLength(0);
  expect(screen.queryByText('读取结果 0')).toBeNull();
  rerender(fixture(true));
  expect(screen.getAllByTitle('Read')).toHaveLength(source.length);
  for (const item of source) expect(screen.getByText(item.output!)).toBeTruthy();
  rerender(fixture(false));
  expect(screen.queryAllByTitle('Read')).toHaveLength(0);
  expect(screen.queryByText('读取结果 0')).toBeNull();
});
