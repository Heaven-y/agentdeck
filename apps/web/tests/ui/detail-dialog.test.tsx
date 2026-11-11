// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DetailDialog } from '../../src/ui/DetailDialog';
afterEach(cleanup);
it('关闭嵌套图片弹窗时保留外层历史，并恢复图片触发点焦点', () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  function History() {
    const [outer, setOuter] = useState(true);
    const [image, setImage] = useState(false);
    return outer ? (
      <DetailDialog title="子代理历史" onClose={() => setOuter(false)}>
        <button type="button" onClick={() => setImage(true)}>
          查看图片
        </button>
        {image && (
          <DetailDialog title="图片" onClose={() => setImage(false)}>
            合成图片
          </DetailDialog>
        )}
      </DetailDialog>
    ) : null;
  }
  render(<History />);
  const trigger = screen.getByRole('button', { name: '查看图片' });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent(screen.getByRole('dialog', { name: '图片' }), new Event('cancel', { bubbles: true, cancelable: true }));
  expect(screen.queryByRole('dialog', { name: '图片' })).toBeNull();
  expect(screen.getByRole('dialog', { name: '子代理历史' })).toBeTruthy();
  expect(document.activeElement).toBe(trigger);
});
