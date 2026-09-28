'use strict';
// Kaspa script reading and writing: pushes, script numbers, tokenizing, and the
// facts a spender needs from one spend path (locks, signature ops, pinned payee).
// Ported from SilverScript Studio's build-spend, which is proven on mainnet.
//
// Kaspa's opcode table is NOT Bitcoin's in the lock range:
//   0xb0 OP_CHECKLOCKTIMEVERIFY, 0xb1 OP_CHECKSEQUENCEVERIFY.

const { hexToBytes, bytesToHex, bytesEqual } = require('./bytes');

const OP = {
  OP_0: 0x00, OP_PUSHDATA1: 0x4c, OP_PUSHDATA2: 0x4d, OP_PUSHDATA4: 0x4e, OP_1NEGATE: 0x4f,
  OP_IF: 0x63, OP_NOTIF: 0x64, OP_ELSE: 0x67, OP_ENDIF: 0x68, OP_VERIFY: 0x69,
  OP_DUP: 0x76, OP_CAT: 0x7e, OP_EQUAL: 0x87, OP_NUMEQUAL: 0x9c, OP_WITHIN: 0xa5,
  OP_CHECKSIG: 0xac, OP_CHECKSIGVERIFY: 0xad, OP_CHECKMULTISIG: 0xae, OP_CHECKMULTISIGVERIFY: 0xaf,
  OP_CHECKLOCKTIMEVERIFY: 0xb0, OP_CHECKSEQUENCEVERIFY: 0xb1,
};

// Names for disassembly. Opcodes not listed print as 0xNN (best effort, never guessed).
const NAMES = {
  0x00: 'OP_0', 0x4f: 'OP_1NEGATE', 0x61: 'OP_NOP', 0x63: 'OP_IF', 0x64: 'OP_NOTIF', 0x67: 'OP_ELSE',
  0x68: 'OP_ENDIF', 0x69: 'OP_VERIFY', 0x6a: 'OP_RETURN', 0x6b: 'OP_TOALTSTACK', 0x6c: 'OP_FROMALTSTACK',
  0x6d: 'OP_2DROP', 0x6e: 'OP_2DUP', 0x6f: 'OP_3DUP', 0x70: 'OP_2OVER', 0x71: 'OP_2ROT', 0x72: 'OP_2SWAP',
  0x73: 'OP_IFDUP', 0x74: 'OP_DEPTH', 0x75: 'OP_DROP', 0x76: 'OP_DUP', 0x77: 'OP_NIP', 0x78: 'OP_OVER',
  0x79: 'OP_PICK', 0x7a: 'OP_ROLL', 0x7b: 'OP_ROT', 0x7c: 'OP_SWAP', 0x7d: 'OP_TUCK', 0x7e: 'OP_CAT',
  0x7f: 'OP_SUBSTR', 0x80: 'OP_LEFT', 0x81: 'OP_RIGHT', 0x82: 'OP_SIZE', 0x87: 'OP_EQUAL',
  0x88: 'OP_EQUALVERIFY', 0x8b: 'OP_1ADD', 0x8c: 'OP_1SUB', 0x8f: 'OP_NEGATE', 0x90: 'OP_ABS',
  0x91: 'OP_NOT', 0x92: 'OP_0NOTEQUAL', 0x93: 'OP_ADD', 0x94: 'OP_SUB', 0x9a: 'OP_BOOLAND',
  0x9b: 'OP_BOOLOR', 0x9c: 'OP_NUMEQUAL', 0x9d: 'OP_NUMEQUALVERIFY', 0x9e: 'OP_NUMNOTEQUAL',
  0x9f: 'OP_LESSTHAN', 0xa0: 'OP_GREATERTHAN', 0xa1: 'OP_LESSTHANOREQUAL', 0xa2: 'OP_GREATERTHANOREQUAL',
  0xa3: 'OP_MIN', 0xa4: 'OP_MAX', 0xa5: 'OP_WITHIN', 0xa8: 'OP_SHA256', 0xaa: 'OP_BLAKE2B',
  0xac: 'OP_CHECKSIG', 0xad: 'OP_CHECKSIGVERIFY', 0xae: 'OP_CHECKMULTISIG', 0xaf: 'OP_CHECKMULTISIGVERIFY',
  0xb0: 'OP_CHECKLOCKTIMEVERIFY', 0xb1: 'OP_CHECKSEQUENCEVERIFY',
};

// Absolute locks below this are DAA scores, at or above it Unix milliseconds.
const LOCK_TIME_THRESHOLD = 500000000000n;

const toBytes = s => (typeof s === 'string' ? hexToBytes(s, 'script') : s);

// Data push in the shortest form (OP_0 / OP_1..16 / OP_1NEGATE / direct / PUSHDATA1/2)
function pushData(bytes) {
  const b = typeof bytes === 'string' ? hexToBytes(bytes) : bytes;
  if (b.length === 0) return '00';
  if (b.length === 1 && b[0] >= 1 && b[0] <= 16) return (0x50 + b[0]).toString(16);
  if (b.length === 1 && b[0] === 0x81) return '4f';
  const n = b.length, h = bytesToHex(b);
  if (n <= 0x4b) return n.toString(16).padStart(2, '0') + h;
  if (n <= 0xff) return '4c' + n.toString(16).padStart(2, '0') + h;
  if (n <= 0xffff) return '4d' + (n & 0xff).toString(16).padStart(2, '0') + ((n >> 8) & 0xff).toString(16).padStart(2, '0') + h;
  throw new Error('push too large');
}

// Minimal script number: little-endian magnitude, sign in the top bit
function scriptNum(n) {
  let v = BigInt(n);
  if (v === 0n) return new Uint8Array(0);
  const neg = v < 0n; if (neg) v = -v;
  const out = [];
  while (v > 0n) { out.push(Number(v & 0xffn)); v >>= 8n; }
  if (out[out.length - 1] & 0x80) out.push(neg ? 0x80 : 0x00);
  else if (neg) out[out.length - 1] |= 0x80;
  return Uint8Array.from(out);
}

function decodeScriptNum(b) {
  if (!b.length) return 0n;
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i] & (i === b.length - 1 ? 0x7f : 0xff));
  return (b[b.length - 1] & 0x80) ? -v : v;
}

// [{ op, data }] where data is a Uint8Array for pushes, null for other opcodes
function tokenize(script) {
  const b = toBytes(script);
  const toks = [];
  const rd16 = i => b[i] | (b[i + 1] << 8);
  const rd32 = i => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000;
  let i = 0;
  while (i < b.length) {
    const op = b[i];
    let n = -1, hdr = 1;
    if (op >= 0x01 && op <= 0x4b) n = op;
    else if (op === 0x4c) { n = b[i + 1]; hdr = 2; }
    else if (op === 0x4d) { n = rd16(i + 1); hdr = 3; }
    else if (op === 0x4e) { n = rd32(i + 1); hdr = 5; }
    if (n >= 0) {
      if (i + hdr + n > b.length) throw new Error(`script: push at byte ${i} runs past the end`);
      toks.push({ op, data: b.subarray(i + hdr, i + hdr + n), at: i });
      i += hdr + n;
    } else {
      toks.push({ op, data: null, at: i });
      i += 1;
    }
  }
  return toks;
}

function disassemble(script) {
  return tokenize(script).map(t => {
    if (t.data) return '<' + bytesToHex(t.data) + '>';
    if (t.op >= 0x51 && t.op <= 0x60) return 'OP_' + (t.op - 0x50);
    return NAMES[t.op] || '0x' + t.op.toString(16).padStart(2, '0');
  }).join(' ');
}

const numOf = t => t.op === 0x00 ? 0n
  : t.data ? decodeScriptNum(t.data)
  : (t.op >= 0x51 && t.op <= 0x60) ? BigInt(t.op - 0x50)
  : t.op === 0x4f ? -1n : null;

// Index just after a v1 guard  OP_DUP <4-byte tag> OP_EQUAL OP_IF, or -1
function tagGuardIndex(toks, tagHex) {
  const tag = hexToBytes(tagHex);
  for (let i = 0; i + 3 < toks.length; i++) {
    if (toks[i].op === 0x76 && toks[i + 1].data && bytesEqual(toks[i + 1].data, tag)
        && toks[i + 2].op === 0x87 && toks[i + 3].op === 0x63) return i + 4;
  }
  return -1;
}

// Index just after a pre-v1 guard  OP_DUP <n> OP_NUMEQUAL OP_IF, or -1
function selectorGuardIndex(toks, n) {
  for (let i = 0; i + 3 < toks.length; i++) {
    const t = toks[i + 1];
    const isN = n === 0 ? (t.op === 0x00 || (t.data && t.data.length === 0))
      : (t.op === 0x50 + n || (t.data && t.data.length === 1 && t.data[0] === n));
    if (toks[i].op === 0x76 && isN && toks[i + 2].op === 0x9c && toks[i + 3].op === 0x63) return i + 4;
  }
  return -1;
}

// Tokens of one path's branch. dispatch = {kind:'tag',hex} | {kind:'selector',n} | {kind:'none'}.
// Returns { tokens, scoped }. scoped=false means the whole script was used
// (no guard to scope by, or the guard was not found: fails closed for locks).
function pathTokens(script, dispatch) {
  const toks = tokenize(script);
  const d = dispatch || { kind: 'none' };
  if (d.kind === 'none') return { tokens: toks, scoped: false, found: true };
  const start = d.kind === 'tag' ? tagGuardIndex(toks, d.hex) : selectorGuardIndex(toks, d.n);
  if (start < 0) return { tokens: toks, scoped: false, found: false };
  let depth = 1, end = toks.length;
  for (let i = start; i < toks.length && depth > 0; i++) {
    const t = toks[i];
    if (t.op === 0x63 || t.op === 0x64) depth++;
    else if (t.op === 0x68) depth--;   // branch closed by ENDIF: keep the tail (fails closed), as the Studio does
    else if (t.op === 0x67 && depth === 1) { end = i; break; }
  }
  return { tokens: toks.slice(start, end), scoped: true, found: true };
}

// Time locks in a token list. Two emitted shapes are known:
//   pre-v1:     <N> OP_CSV
//   silverc v1: <N> OP_DUP OP_0 <2^32> OP_WITHIN OP_VERIFY OP_CSV
// Returns { cltv: [BigInt], csv: [BigInt] }.
function locksIn(tokens) {
  const locks = { cltv: [], csv: [] };
  let lastPush = null, held = null;
  for (const t of tokens) {
    const n = numOf(t);
    if (n !== null) { lastPush = n; continue; }
    if (t.op === 0x76 && lastPush !== null) { held = lastPush; lastPush = null; continue; }
    if (t.op === 0xa5 || t.op === 0x69) { lastPush = null; continue; }
    if (t.op === 0xb0 || t.op === 0xb1) {
      const v = lastPush !== null ? lastPush : held;
      if (v !== null) (t.op === 0xb0 ? locks.cltv : locks.csv).push(v);
    }
    lastPush = null; held = null;
  }
  return locks;
}

// Signature-check opcodes in a path (each counts one), at least 1. Goes into
// every input's sigOpCount, which is covered by the signature hash.
function sigOpsIn(tokens) {
  return Math.max(1, tokens.filter(t => !t.data && t.op >= 0xac && t.op <= 0xaf).length);
}

// A path that pins outputs[0] to a P2PK key compiles the comparison as
//   <000020> <32-byte key> OP_CAT <ac> OP_CAT ...
// Returns the key hex or null. Best effort: other pin shapes are not detected.
function pinnedPayeeIn(tokens) {
  const pre = hexToBytes('000020'), ac = hexToBytes('ac');
  for (let i = 0; i + 4 < tokens.length; i++) {
    const [a, k, c1, x, c2] = tokens.slice(i, i + 5);
    if (a.data && bytesEqual(a.data, pre) && k.data && k.data.length === 32
        && c1.op === 0x7e && x.data && bytesEqual(x.data, ac) && c2.op === 0x7e) return bytesToHex(k.data);
  }
  return null;
}

// Everything a spender reads from one path's branch
function analyzePath(script, dispatch) {
  const p = pathTokens(script, dispatch);
  const locks = locksIn(p.tokens);
  return {
    guardFound: p.found,
    scoped: p.scoped,
    locks: { cltv: locks.cltv.map(String), csv: locks.csv.map(String) },
    sigOps: sigOpsIn(p.tokens),
    payTo: (() => { const k = pinnedPayeeIn(p.tokens); return k ? { kind: 'p2pk', pubkey: k } : null; })(),
  };
}

module.exports = {
  OP, LOCK_TIME_THRESHOLD, pushData, scriptNum, decodeScriptNum, tokenize, disassemble,
  tagGuardIndex, selectorGuardIndex, pathTokens, locksIn, sigOpsIn, pinnedPayeeIn, analyzePath,
};
