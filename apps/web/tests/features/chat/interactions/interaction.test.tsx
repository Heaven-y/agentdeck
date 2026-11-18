// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { UserInteraction } from '@agentdeck/shared/conversation';
import { InteractionCard } from '../../../../src/features/chat/interactions/InteractionCard';
import { reduceChat } from '../../../../src/features/chat/state/chat-reducer';
afterEach(cleanup);
it('浮点数表单允许原生支持的小数，不被浏览器默认整数步长阻止', () => {
  const respond = vi.fn(() => true);
  const spec: UserInteraction = {
    ...interaction,
    kind: 'form',
    fields: [{ id: 'value', type: 'number', label: '浮点值', required: true }],
  };
  render(<InteractionCard item={{ kind: 'interaction', id: spec.id, interaction: spec }} onAnswer={respond} />);
  const control = screen.getByLabelText<HTMLInputElement>('浮点值');
  fireEvent.change(control, { target: { value: '1.5' } });
  expect(control.checkValidity()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
  expect(respond).toHaveBeenCalledWith({ action: 'submit', values: { value: 1.5 } });
});
it('超过答复字节预算时保留输入并提示，不进入无法收到回执的提交状态', () => {
  const respond = vi.fn(() => true);
  const spec: UserInteraction = {
    ...interaction,
    kind: 'form',
    fields: [{ id: 'value', type: 'text', label: '长回答', required: true }],
  };
  render(<InteractionCard item={{ kind: 'interaction', id: spec.id, interaction: spec }} onAnswer={respond} />);
  fireEvent.change(screen.getByLabelText('长回答'), { target: { value: '中'.repeat(6000) } });
  fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
  expect(respond).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('过大');
});
const interaction: UserInteraction = {
  id: '00000000-0000-4000-8000-000000000001',
  owner: { kind: 'turn', id: 'turn', runtimeId: 'runtime' },
  kind: 'questions',
  title: '选择方案',
  blocking: true,
  fields: [
    {
      id: 'choice',
      type: 'choice',
      label: '使用哪个',
      required: true,
      multiple: false,
      allowOther: true,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
  ],
};
it('选择题未回答不提交，原生选项和自由输入都由用户显式提交', () => {
  const respond = vi.fn(() => true);
  render(<InteractionCard item={{ kind: 'interaction', id: interaction.id, interaction }} onAnswer={respond} />);
  fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
  expect(respond).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('必填');
  fireEvent.click(screen.getByLabelText('B'));
  fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
  expect(respond).toHaveBeenLastCalledWith({ action: 'submit', values: { choice: 'b' } });
  fireEvent.change(screen.getByLabelText('其他回答'), { target: { value: '自定义' } });
  fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
  expect(respond).toHaveBeenLastCalledWith({ action: 'submit', values: { choice: '自定义' } });
});
it('秘密输入使用密码框，提交回执只显示状态且清除字段', () => {
  const secret: UserInteraction = {
    ...interaction,
    kind: 'form',
    fields: [{ id: 'key', type: 'text', label: '令牌', required: true, secret: true }],
  };
  const respond = vi.fn(() => true);
  const view = render(
    <InteractionCard item={{ kind: 'interaction', id: secret.id, interaction: secret }} onAnswer={respond} />,
  );
  expect(screen.getByLabelText('令牌').getAttribute('type')).toBe('password');
  fireEvent.change(screen.getByLabelText('令牌'), { target: { value: 'private-value' } });
  fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
  expect(respond).toHaveBeenCalledWith({ action: 'submit', values: { key: 'private-value' } });
  view.rerender(
    <InteractionCard
      item={{ kind: 'interaction', id: secret.id, interaction: secret, resolved: 'submitted' }}
      onAnswer={respond}
    />,
  );
  expect(view.container.innerHTML).not.toContain('private-value');
  expect(screen.queryByLabelText('令牌')).toBeNull();
});
it('取消无默认答案，回合结束只取消回合所属问题，操作表单独立', () => {
  const respond = vi.fn(() => true);
  render(<InteractionCard item={{ kind: 'interaction', id: interaction.id, interaction }} onAnswer={respond} />);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(respond).toHaveBeenCalledWith({ action: 'cancel' });
  let items = reduceChat([], { type: 'interaction_request', interaction });
  items = reduceChat(items, {
    type: 'interaction_request',
    interaction: {
      ...interaction,
      id: 'operation',
      owner: { kind: 'nativeOperation', id: 'oauth', runtimeId: 'runtime' },
    },
  });
  items = reduceChat(items, { type: 'turn_end', isError: false });
  expect(items[0]).toMatchObject({ resolved: 'cancelled' });
  expect(items[1]).not.toHaveProperty('resolved');
});
