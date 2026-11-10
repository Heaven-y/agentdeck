import { ATTACHMENT_LIMITS } from '@agentdeck/shared/conversation';
type ImageInfo = { mimeType: string; width: number; height: number };
const invalid = () => new Error('图片格式、尺寸或数据边界无效');
function dimensions(mimeType: string, width: number, height: number): ImageInfo {
  if (
    !width ||
    !height ||
    width > ATTACHMENT_LIMITS.maxDimension ||
    height > ATTACHMENT_LIMITS.maxDimension ||
    width * height > ATTACHMENT_LIMITS.maxPixels
  )
    throw invalid();
  return { mimeType, width, height };
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(data: Buffer, offset: number) {
  const size = data.readUInt32BE(offset),
    end = offset + 12 + size;
  if (end > data.length) throw invalid();
  const type = data.toString('ascii', offset + 4, offset + 8);
  if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) throw invalid();
  return { size, end, type, offset };
}
function pngHeader(data: Buffer, chunk: ReturnType<typeof pngChunk>): ImageInfo {
  if (chunk.offset !== 8 || chunk.size !== 13) throw invalid();
  return dimensions('image/png', data.readUInt32BE(16), data.readUInt32BE(20));
}
function png(data: Buffer): ImageInfo {
  let offset = 8,
    info: ImageInfo | undefined,
    image = false;
  const animation = { declared: 0, frames: 0 };
  while (offset + 12 <= data.length) {
    const chunk = pngChunk(data, offset);
    if (chunk.type === 'IHDR') info = pngHeader(data, chunk);
    if (chunk.type === 'IDAT') image = true;
    pngAnimation(data, chunk, info, animation);
    if (chunk.type === 'IEND') {
      if (animation.frames !== animation.declared) throw invalid();
      return pngEnd(info, image, chunk.size, chunk.end === data.length);
    }
    offset = chunk.end;
  }
  throw invalid();
}
function pngAnimation(
  data: Buffer,
  chunk: ReturnType<typeof pngChunk>,
  info: ImageInfo | undefined,
  state: { declared: number; frames: number },
): void {
  if (chunk.type === 'acTL') {
    if (state.declared) throw invalid();
    state.declared = pngFrameCount(data, chunk, info);
  }
  if (chunk.type === 'fcTL') {
    if (!info || chunk.size !== 26 || ++state.frames > state.declared) throw invalid();
    const frame = dimensions('image/png', data.readUInt32BE(chunk.offset + 12), data.readUInt32BE(chunk.offset + 16));
    if (frame.width > info.width || frame.height > info.height) throw invalid();
  }
}
function pngFrameCount(data: Buffer, chunk: ReturnType<typeof pngChunk>, info: ImageInfo | undefined): number {
  if (!info || chunk.size !== 8) throw invalid();
  const count = data.readUInt32BE(chunk.offset + 8);
  if (!count || count > 100 || info.width * info.height * count > ATTACHMENT_LIMITS.maxPixels) throw invalid();
  return count;
}
function pngEnd(info: ImageInfo | undefined, image: boolean, size: number, atEnd: boolean): ImageInfo {
  if (!info || !image || size || !atEnd) throw invalid();
  return info;
}
function jpegSegment(data: Buffer, offset: number) {
  if (data[offset++] !== 255) throw invalid();
  while (data[offset] === 255) offset++;
  const marker = data[offset++]!;
  if (marker === 0xda || marker === 0xd9) return { marker, offset, length: 0 };
  if ([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8].includes(marker))
    return { marker, offset, length: 0 };
  if (offset + 2 > data.length) throw invalid();
  const length = data.readUInt16BE(offset);
  if (length < 2 || offset + length > data.length) throw invalid();
  return { marker, offset, length };
}
function jpeg(data: Buffer): ImageInfo {
  let offset = 2;
  while (offset + 4 <= data.length) {
    const segment = jpegSegment(data, offset);
    if (segment.marker === 0xda || segment.marker === 0xd9) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(segment.marker))
      return jpegDimensions(data, segment);
    offset = segment.offset + segment.length;
  }
  throw invalid();
}
function jpegDimensions(data: Buffer, segment: ReturnType<typeof jpegSegment>): ImageInfo {
  if (segment.length < 8 || data.at(-2) !== 255 || data.at(-1) !== 0xd9) throw invalid();
  return dimensions('image/jpeg', data.readUInt16BE(segment.offset + 5), data.readUInt16BE(segment.offset + 3));
}
function subblocks(data: Buffer, offset: number): number {
  while (offset < data.length) {
    const size = data[offset++]!;
    if (!size) return offset;
    offset += size;
    if (offset > data.length) throw invalid();
  }
  throw invalid();
}
function gifImage(data: Buffer, offset: number, frames: number) {
  if (offset + 9 > data.length || frames > 100) throw invalid();
  const info = dimensions('image/gif', data.readUInt16LE(offset + 4), data.readUInt16LE(offset + 6));
  const packed = data[offset + 8]!;
  offset += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  return { offset: subblocks(data, offset + 1), pixels: info.width * info.height };
}
function gif(data: Buffer): ImageInfo {
  if (data.length < 14) throw invalid();
  const info = dimensions('image/gif', data.readUInt16LE(6), data.readUInt16LE(8));
  let offset = 13 + (data[10]! & 0x80 ? 3 * 2 ** ((data[10]! & 7) + 1) : 0),
    frames = 0,
    pixels = 0;
  while (offset < data.length) {
    const marker = data[offset++]!;
    if (marker === 0x3b) return gifEnd(info, frames, offset === data.length);
    if (marker === 0x21) {
      offset = subblocks(data, offset + 1);
      continue;
    }
    if (marker !== 0x2c) throw invalid();
    const next = gifImage(data, offset, ++frames);
    offset = next.offset;
    pixels += next.pixels;
    if (Math.max(pixels, info.width * info.height * frames) > ATTACHMENT_LIMITS.maxPixels) throw invalid();
  }
  throw invalid();
}
function gifEnd(info: ImageInfo, frames: number, atEnd: boolean): ImageInfo {
  if (!frames || !atEnd) throw invalid();
  return info;
}
function webp(data: Buffer): ImageInfo {
  if (data.length < 30 || data.readUInt32LE(4) + 8 !== data.length) throw invalid();
  validateWebpChunks(data);
  const type = data.toString('ascii', 12, 16);
  if (type === 'VP8X') {
    return dimensions('image/webp', data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1);
  }
  if (type === 'VP8L' && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return dimensions('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (type === 'VP8 ' && data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a])))
    return dimensions('image/webp', data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
  throw invalid();
}
function validateWebpChunks(data: Buffer): void {
  let offset = 12,
    frames = 0,
    pixels = 0,
    image = false;
  while (offset + 8 <= data.length) {
    const type = data.toString('ascii', offset, offset + 4),
      size = data.readUInt32LE(offset + 4),
      end = offset + 8 + size;
    if (end > data.length) throw invalid();
    if (['VP8 ', 'VP8L'].includes(type)) image = true;
    if (type === 'ANMF') {
      if (size < 16 || ++frames > 100) throw invalid();
      const info = dimensions('image/webp', data.readUIntLE(offset + 14, 3) + 1, data.readUIntLE(offset + 17, 3) + 1);
      pixels += info.width * info.height;
      image = true;
    }
    offset = end + (size % 2);
  }
  const canvas = webpCanvasPixels(data, frames);
  if (offset !== data.length || !image || Math.max(pixels, canvas) > ATTACHMENT_LIMITS.maxPixels) throw invalid();
}
function webpCanvasPixels(data: Buffer, frames: number): number {
  return data.toString('ascii', 12, 16) === 'VP8X'
    ? (data.readUIntLE(24, 3) + 1) * (data.readUIntLE(27, 3) + 1) * frames
    : 0;
}
/** 校验魔数、结构和像素预算；浏览器预览及原生仍负责实际解码，不自动转码。 */
export function imageInfo(data: Buffer): ImageInfo | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return png(data);
  if (data[0] === 255 && data[1] === 0xd8) return jpeg(data);
  if (/^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return gif(data);
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return webp(data);
}
