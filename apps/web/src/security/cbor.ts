/**
 * Minimal CBOR (RFC 8949) codec — enough for WebAuthn attestation objects and COSE keys.
 * Supports unsigned/negative integers, byte/text strings, arrays, maps, true/false/null.
 */
export type CborValue = number | bigint | string | boolean | null | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

/** Decode the first CBOR item and report how many bytes it used (COSE key inside authenticator data). */
export function decodeFirst(buf: Uint8Array): { value: CborValue; length: number } {
  let pos = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const readLen = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return buf[pos++];
    if (info === 25) { const v = view.getUint16(pos); pos += 2; return v; }
    if (info === 26) { const v = view.getUint32(pos); pos += 4; return v; }
    if (info === 27) { const v = view.getBigUint64(pos); pos += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: length too large'); return Number(v); }
    throw new Error('cbor: indefinite lengths are not supported');
  };
  const item = (depth: number): CborValue => {
    if (depth > 16) throw new Error('cbor: too deep');
    if (pos >= buf.length) throw new Error('cbor: truncated');
    const b = buf[pos++];
    const major = b >> 5, info = b & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); if (pos + n > buf.length) throw new Error('cbor: truncated'); const v = buf.slice(pos, pos + n); pos += n; return v; }
      case 3: { const n = readLen(info); if (pos + n > buf.length) throw new Error('cbor: truncated'); const v = new TextDecoder().decode(buf.subarray(pos, pos + n)); pos += n; return v; }
      case 4: { const n = readLen(info); const a: CborValue[] = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
      case 5: { const n = readLen(info); const m = new Map<CborValue, CborValue>(); for (let i = 0; i < n; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); } return m; }
      case 7: if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; throw new Error('cbor: unsupported simple value');
      default: throw new Error('cbor: unsupported major type');
    }
  };
  const value = item(0);
  return { value, length: pos };
}

export function decode(buf: Uint8Array): CborValue { return decodeFirst(buf).value; }

export function encode(v: CborValue): Uint8Array {
  const out: number[] = [];
  const head = (major: number, n: number) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 256) out.push((major << 5) | 24, n);
    else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 255);
    else out.push((major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  };
  const enc = (x: CborValue) => {
    if (x === null) out.push(0xf6);
    else if (x === true) out.push(0xf5);
    else if (x === false) out.push(0xf4);
    else if (typeof x === 'number') { if (x >= 0) head(0, x); else head(1, -1 - x); }
    else if (typeof x === 'string') { const b = new TextEncoder().encode(x); head(3, b.length); out.push(...b); }
    else if (x instanceof Uint8Array) { head(2, x.length); out.push(...x); }
    else if (Array.isArray(x)) { head(4, x.length); x.forEach(enc); }
    else if (x instanceof Map) { head(5, x.size); for (const [k, val] of x) { enc(k); enc(val); } }
    else throw new Error('cbor: cannot encode');
  };
  enc(v);
  return Uint8Array.from(out);
}
