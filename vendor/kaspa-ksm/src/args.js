'use strict';
// SilverScript values in three forms:
//   canonical  : how a .ksm file stores a value (JSON-safe, one spelling per value)
//   push       : the script push (hex) a spender puts in the signature script
//   silverc    : the ArtifactValue {kind, value} silverc v1 takes in --constructor-args
//
// Types are the ABI strings: int, bool, byte, temporal, pubkey, sig, datasig,
// string, byte[], byte[N].

const { hexToBytes, bytesToHex, utf8, isHex } = require('./bytes');
const { pushData, scriptNum } = require('./script');
const { pubkeyFromInput } = require('./address');

const FIXED = /^byte\[(\d+)\]$/;

function normType(t) {
  const s = String(t || '').trim().toLowerCase();
  return s === 'bytes' ? 'byte[]' : s;
}

// Bytes from a canonical hex string, or "text:..." as a UTF-8 convenience
function bytesFrom(v, label) {
  const s = String(v == null ? '' : v);
  if (s.startsWith('text:')) return utf8(s.slice(5));
  return hexToBytes(s, label);
}

function intFrom(v, label) {
  const s = String(v == null ? '' : v).trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`${label}: expected an integer (decimal string)`);
  return BigInt(s);
}

function temporalFrom(v, label) {
  const s = String(v == null ? '' : v).trim();
  if (/^-?\d+$/.test(s)) return BigInt(s);
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new Error(`${label}: expected Unix milliseconds or an ISO date`);
  return BigInt(ms);
}

// Any accepted input → the canonical .ksm value for that type
function canonicalValue(type, v, label = 'value') {
  const t = normType(type);
  switch (t) {
    case 'int':      return intFrom(v, label).toString();
    case 'temporal': return temporalFrom(v, label).toString();
    case 'bool':     return v === true || v === 'true' || v === 1 || v === '1';
    case 'byte': {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`${label}: expected a byte 0..255`);
      return n;
    }
    case 'pubkey': {
      const pk = pubkeyFromInput(v);
      if (!pk) throw new Error(`${label}: expected a 32-byte x-only public key (hex) or a version-0 kaspa address`);
      return pk;
    }
    case 'sig':      { const b = bytesFrom(v, label); if (b.length !== 65) throw new Error(`${label}: a sig is 65 bytes`); return bytesToHex(b); }
    case 'datasig':  { const b = bytesFrom(v, label); if (b.length !== 64) throw new Error(`${label}: a datasig is 64 bytes`); return bytesToHex(b); }
    case 'string':   return String(v == null ? '' : v);
    case 'byte[]':   return bytesToHex(bytesFrom(v, label));
    default: {
      const m = t.match(FIXED);
      if (m) {
        const b = bytesFrom(v, label);
        if (b.length !== Number(m[1])) throw new Error(`${label}: expected ${m[1]} bytes, got ${b.length}`);
        return bytesToHex(b);
      }
      throw new Error(`${label}: unsupported type "${type}"`);
    }
  }
}

// Value → the push a spender places in the signature script (hex)
function encodeArg(type, v, label = 'argument') {
  const t = normType(type);
  const c = canonicalValue(t, v, label);
  switch (t) {
    case 'int': case 'temporal': return pushData(scriptNum(BigInt(c)));
    case 'bool':   return pushData(scriptNum(c ? 1 : 0));
    case 'byte':   return pushData(Uint8Array.of(c));
    case 'string': return pushData(utf8(c));
    default:       return pushData(hexToBytes(c));
  }
}

// Canonical value → silverc v1 ArtifactValue for --constructor-args
function toSilvercValue(type, v, label = 'value') {
  const t = normType(type);
  const c = canonicalValue(t, v, label);
  switch (t) {
    case 'int':      return { kind: 'int', value: Number(c) };
    case 'temporal': return { kind: 'int', value: Number(c) };
    case 'bool':     return { kind: 'bool', value: c };
    case 'byte':     return { kind: 'byte', value: c };
    case 'string':   return { kind: 'text', value: c };
    default:         return { kind: 'bytes', value: Array.from(hexToBytes(c)) };
  }
}

// silverc v1 artifact param type {kind,...} → ABI type string
function typeFromArtifact(t) {
  if (!t) return 'unknown';
  if (typeof t === 'string') return t;
  switch (t.kind) {
    case 'bytes':         return 'byte[]';
    case 'fixed_bytes':   return `byte[${t.len}]`;
    case 'dynamic_array': return `${typeFromArtifact(t.item)}[]`;
    case 'fixed_array':   return `${typeFromArtifact(t.item)}[${t.len}]`;
    default:              return t.kind || 'unknown';
  }
}

// silverc --ast-only type_ref {base, array_dims} → ABI type string
function typeFromAst(r) {
  if (!r) return 'unknown';
  let s = r.base || 'unknown';
  for (const d of r.array_dims || []) s += d.kind === 'dynamic' ? '[]' : `[${d.value}]`;
  return s;
}

module.exports = { normType, canonicalValue, encodeArg, toSilvercValue, typeFromArtifact, typeFromAst, isHex };
