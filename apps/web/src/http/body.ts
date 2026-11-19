import type { IncomingMessage } from 'node:http';
import { HttpError } from './app.ts';

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'payload too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function parseUrlEncoded(buf: Buffer): { body: Record<string, string>; all: Record<string, string[]> } {
  const params = new URLSearchParams(buf.toString('utf8'));
  const body: Record<string, string> = {};
  const all: Record<string, string[]> = {};
  for (const [k, v] of params) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    (all[k] ??= []).push(v);
    if (!(k in body)) body[k] = v;
  }
  return { body, all };
}

export interface UploadedFile { field: string; filename: string; type: string; data: Buffer }

/** Minimal multipart/form-data parser (single request, in memory, size-limited by readBody). */
export function parseMultipart(buf: Buffer, contentType: string): { body: Record<string, string>; all: Record<string, string[]>; files: UploadedFile[] } {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new HttpError(400, 'missing boundary');
  const boundary = Buffer.from('--' + (m[1] ?? m[2]).trim());
  const body: Record<string, string> = {};
  const all: Record<string, string[]> = {};
  const files: UploadedFile[] = [];
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    const start = pos + boundary.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) break;
    const headers = buf.subarray(start + 2, headerEnd).toString('utf8');
    const next = buf.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    const data = buf.subarray(headerEnd + 4, next - 2);
    const name = /name="([^"]*)"/i.exec(headers)?.[1] ?? '';
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? 'application/octet-stream';
    if (name && name !== '__proto__' && name !== 'constructor') {
      if (filename !== undefined) {
        if (data.length) files.push({ field: name, filename: filename.replace(/[^\w.\- ]/g, '_'), type, data: Buffer.from(data) });
      } else {
        const v = data.toString('utf8');
        (all[name] ??= []).push(v);
        if (!(name in body)) body[name] = v;
      }
    }
    pos = next;
  }
  return { body, all, files };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}
