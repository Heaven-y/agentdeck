import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { attachmentFormat, attachmentExtension } from '../../src/chat/attachment-format';
import { imageInfo } from '../../src/agents/common/media-format';

const fixture = (name: string) => readFile(new URL(`../fixtures/media/${name}`, import.meta.url));
it('识别真实JPEG、渐进JPEG、GIF与WebP静态和动画，不依赖扩展名', async () => {
  for (const [name, type] of [
    ['sample.jpg', 'jpeg'],
    ['progressive.jpg', 'jpeg'],
    ['sample.gif', 'gif'],
    ['animated.gif', 'gif'],
    ['sample.webp', 'webp'],
    ['lossless.webp', 'webp'],
    ['animated.webp', 'webp'],
    ['animated.png', 'png'],
  ]) {
    const data = await fixture(name!);
    expect(imageInfo(data)).toEqual({ mimeType: `image/${type}`, width: 3, height: 2 });
    const asset = attachmentFormat({ name: '无扩展名', mimeType: 'application/octet-stream', data });
    expect(asset.kind).toBe('image');
    expect(attachmentExtension({ ...asset, id: '', revision: '' })).toBe(type === 'jpeg' ? '.jpg' : `.${type}`);
    expect(() => imageInfo(data.subarray(0, data.length - 3))).toThrow();
    expect(() =>
      attachmentFormat({ name: name!, mimeType: type === 'png' ? 'image/jpeg' : 'image/png', data }),
    ).toThrow('类型');
  }
});
it('拒绝伪造WebP块长度、JPEG超大尺寸与动画解码预算溢出', async () => {
  const webp = await fixture('sample.webp');
  webp.writeUInt32LE(webp.length * 2, 16);
  expect(() => imageInfo(webp)).toThrow();
  const jpeg = await fixture('sample.jpg');
  const frame = jpeg.indexOf(Buffer.from([255, 192]));
  expect(frame).toBeGreaterThan(0);
  jpeg.writeUInt16BE(65535, frame + 5);
  expect(() => imageInfo(jpeg)).toThrow();
  const gif = await fixture('animated.gif');
  gif.writeUInt16LE(5000, 6);
  gif.writeUInt16LE(5000, 8);
  expect(() => imageInfo(gif)).toThrow();
  const animation = await fixture('animated.webp');
  animation.writeUIntLE(4999, 24, 3);
  animation.writeUIntLE(4999, 27, 3);
  expect(() => imageInfo(animation)).toThrow();
});
it('文件类型按内容判定，拒绝保留名、路径、空文件与错误PDF声明', () => {
  for (const name of ['con.txt', 'notes.', 'bad/name', 'bad\\name', 'bad\u0000.txt'])
    expect(() => attachmentFormat({ name, mimeType: '', data: Buffer.from('文字') })).toThrow();
  expect(() => attachmentFormat({ name: 'notes', mimeType: '', data: Buffer.alloc(0) })).toThrow();
  expect(() =>
    attachmentFormat({ name: 'notes.pdf', mimeType: 'application/pdf', data: Buffer.from('文本') }),
  ).toThrow();
  for (const [data, kind, extension] of [
    [Buffer.from('%PDF-1.7'), 'pdf', '.pdf'],
    [Buffer.from('多行\n文本'), 'text', '.txt'],
    [Buffer.from([255, 0, 1]), 'file', '.bin'],
  ] as const) {
    const value = attachmentFormat({ name: '无扩展名', mimeType: '', data });
    expect(value.kind).toBe(kind);
    expect(attachmentExtension({ ...value, id: '', revision: '' })).toBe(extension);
  }
});
