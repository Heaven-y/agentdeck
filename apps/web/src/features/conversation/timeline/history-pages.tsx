import { Component, createRef, useRef, useState, type ReactNode } from 'react';
import { buttonClass } from '../../../ui/styles';

export type HistoryPagination = {
  start: number;
  hasOlder: boolean;
  loading: boolean;
  error?: { message: string; restart: boolean };
  load(): void;
  restart(): void;
  restartDisabled: boolean;
};

export function HistoryPageControl({ context }: { context?: HistoryPagination }) {
  if (!context) return null;
  const { error, hasOlder, loading, load, restart, restartDisabled } = context;
  return (
    <div className="flex min-h-[68px] flex-col items-center justify-center px-3 py-2 text-center text-xs text-muted-foreground">
      {error && (
        <p role="status" className="mb-1 text-warning">
          {error.message}
        </p>
      )}
      {hasOlder ? (
        <button
          type="button"
          className={`${buttonClass('ghost')} min-h-8 px-3 text-xs`}
          disabled={loading || (error?.restart && restartDisabled)}
          onClick={error?.restart ? restart : load}
        >
          {pageAction(context)}
        </button>
      ) : (
        <span>已加载至会话开头</span>
      )}
    </div>
  );
}
export function pageAction({ loading, error }: HistoryPagination) {
  if (loading) return '正在加载更早记录…';
  if (!error) return '加载更早记录';
  return error.restart ? '重新读取最近记录' : '重试加载更早记录';
}

const components = { Header: HistoryPageControl };
const noComponents = {};
const PREPEND_BASE = 1_000_000_000;
type Anchor = { start?: number; ids: string[]; index: number };

/** 用稳定行身份算实际前插条数，不用步骤数代替 UI 行数。Virtuoso 负责测量和补偿阅读位置。 */
function useAnchor(rows: { id: string }[], start?: number) {
  const ids = rows.slice(0, 4).map((row) => row.id);
  const base = start === undefined ? 0 : PREPEND_BASE;
  const [previous, setPrevious] = useState<Anchor>({ start, ids, index: base });
  if (previous.start === start && ids.length === previous.ids.length && ids.every((id, n) => id === previous.ids[n]))
    return previous.index;
  const index = shiftedIndex(previous, rows, start, base);
  setPrevious({ start, ids, index });
  return index;
}

function shiftedIndex(previous: Anchor, rows: { id: string }[], start: number | undefined, base: number) {
  if (previous.start === undefined || start === undefined) return base;
  if (start >= previous.start) return previous.index;
  // 巨型回合分两页时，轨迹的临时轮头可能消失，用下一个仍在的步骤定位。
  for (const [old, id] of previous.ids.entries()) {
    const next = rows.findIndex((row) => row.id === id);
    if (next >= 0) return previous.index - Math.max(0, next - old);
  }
  return previous.index;
}

export function useHistoryPages(rows: { id: string }[], pagination?: HistoryPagination) {
  const firstItemIndex = useAnchor(rows, pagination?.start);
  const leftTop = useRef(false);
  const load = () => {
    if (pagination?.hasOlder && !pagination.loading && !pagination.error) pagination.load();
  };
  return {
    context: pagination,
    components: pagination ? components : noComponents,
    firstItemIndex,
    atTopThreshold: 40,
    atTopStateChange: pagination
      ? (atTop: boolean) => {
          if (atTop && leftTop.current) load();
          leftTop.current = !atTop;
        }
      : undefined,
    onWheel: pagination
      ? (event: React.WheelEvent<HTMLDivElement>) => {
          if (event.deltaY < 0 && event.currentTarget.scrollTop <= 40) load();
        }
      : undefined,
  };
}

const rowSelector = '[data-chat-row], [data-trajectory-row]';
const rowKey = (row: HTMLElement) => row.dataset.chatRow ?? row.dataset.trajectoryRow;
type ScrollAnchor = { scroller: HTMLElement; anchors: { id: string; offset: number }[] };

function measureAnchor(root: HTMLElement | null): ScrollAnchor | null {
  const scroller = root?.querySelector<HTMLElement>('[data-virtuoso-scroller]');
  if (!scroller) return null;
  const bounds = scroller.getBoundingClientRect();
  const anchors = [];
  for (const row of scroller.querySelectorAll<HTMLElement>(rowSelector)) {
    const id = rowKey(row);
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom || id === undefined) continue;
    anchors.push({ id, offset: rect.top - bounds.top });
    if (anchors.length === 3) break;
  }
  return anchors.length ? { scroller, anchors } : null;
}

function restoreAnchor({ scroller, anchors }: ScrollAnchor) {
  if (!scroller.isConnected) return;
  const rows = [...scroller.querySelectorAll<HTMLElement>(rowSelector)];
  for (const anchor of anchors) {
    const row = rows.find((candidate) => rowKey(candidate) === anchor.id);
    if (!row) continue;
    const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) > 1) scroller.scrollTop += delta;
    return;
  }
}

type ViewportProps = { start?: number; className: string; children: ReactNode };

/** 虚拟列表先按估算补偿，DOM 提交前留住可见行，测量完成后只修正剩下的像素差。 */
export class HistoryPageViewport extends Component<ViewportProps, unknown, ScrollAnchor | null> {
  private readonly area = createRef<HTMLDivElement>();
  private frame?: number;
  private readonly cancel = () => {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  };

  getSnapshotBeforeUpdate(previous: ViewportProps) {
    const { start } = this.props;
    return start !== undefined && previous.start !== undefined && start < previous.start
      ? measureAnchor(this.area.current)
      : null;
  }
  componentDidUpdate(_previous: ViewportProps, _state: unknown, snapshot: ScrollAnchor | null) {
    if (!snapshot) return;
    this.cancel();
    // 测量与 Virtuoso 的向上滚动补偿分别排在后续帧，不与其第一次滚动争夺位置。
    const settle = (frame: number) => {
      this.frame = requestAnimationFrame(() => {
        this.frame = undefined;
        if (frame >= 4) restoreAnchor(snapshot);
        // 一次修正可能让虚拟列表挂载并测量更多行；短暂复核，用户操作会立即结束补偿。
        if (frame < 10) settle(frame + 1);
      });
    };
    settle(1);
  }
  componentWillUnmount() {
    this.cancel();
  }
  render() {
    return (
      <div
        ref={this.area}
        className={this.props.className}
        onWheelCapture={this.cancel}
        onPointerDownCapture={this.cancel}
        onKeyDownCapture={this.cancel}
      >
        {this.props.children}
      </div>
    );
  }
}
