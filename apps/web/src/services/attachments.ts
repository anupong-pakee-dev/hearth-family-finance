/**
 * Receipt / slip attachments (FR-TXN-05, NFR-SEC-24):
 *  - type detected from the file CONTENT (magic bytes), never from the client's Content-Type or name
 *  - size-limited, metadata (EXIF/XMP/IPTC/text chunks incl. GPS) stripped
 *  - stored encrypted with the owner's data key, served from a separate path as `attachment`
 */
export const MAX_ATTACHMENT = 5 * 1024 * 1024;
export type AttachmentType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

export function sniff(b: Buffer): AttachmentType | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length > 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** JPEG: drop APP1 (EXIF/XMP), APP13 (IPTC) and COM segments; keep JFIF/ICC and image data. */
function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error('bad jpeg');
    const marker = b[i + 1];
    if (marker === 0xda) { out.push(b.subarray(i)); return Buffer.concat(out); } // start of scan: rest is image data
    if (marker === 0xd9) { out.push(b.subarray(i, i + 2)); break; }
    const len = b.readUInt16BE(i + 2);
    const seg = b.subarray(i, i + 2 + len);
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) out.push(seg);
    i += 2 + len;
  }
  return Buffer.concat(out);
}

/** PNG: drop eXIf and textual chunks. */
function stripPng(b: Buffer): Buffer {
  const drop = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const chunk = b.subarray(i, i + 12 + len);
    if (!drop.has(type)) out.push(chunk);
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

/** WebP: drop EXIF / XMP chunks and clear the matching VP8X flags. */
function stripWebp(b: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = b.toString('latin1', i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const total = 8 + len + (len % 2);
    let chunk = Buffer.from(b.subarray(i, i + total));
    if (type === 'VP8X') { chunk[8] &= ~0b00001100; }
    if (type !== 'EXIF' && type !== 'XMP ') chunks.push(chunk);
    i += total;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

export function sanitize(b: Buffer): { type: AttachmentType; data: Buffer } | null {
  if (b.length === 0 || b.length > MAX_ATTACHMENT) return null;
  const type = sniff(b);
  if (!type) return null;
  try {
    const data = type === 'image/jpeg' ? stripJpeg(b) : type === 'image/png' ? stripPng(b) : type === 'image/webp' ? stripWebp(b) : b;
    return { type, data };
  } catch {
    return null;
  }
}
