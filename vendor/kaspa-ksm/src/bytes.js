'use strict';
// Byte helpers on plain Uint8Array (no Buffer), so the package runs in browsers too.

function hexToBytes(hex, label) {
  const s = String(hex == null ? '' : hex).trim().replace(/^0x/i, '').toLowerCase();
  if (s.length % 2 || !/^[0-9a-f]*$/.test(s)) throw new Error(`${label || 'value'}: expected hex bytes`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function concatBytes(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function utf8(s) { return new TextEncoder().encode(String(s)); }

function isHex(s, bytes) {
  const h = String(s == null ? '' : s);
  if (!/^[0-9a-f]*$/.test(h) || h.length % 2) return false;
  return bytes === undefined || h.length === bytes * 2;
}

module.exports = { hexToBytes, bytesToHex, concatBytes, bytesEqual, utf8, isHex };
