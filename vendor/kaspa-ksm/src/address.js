'use strict';
// Kaspa addresses: CashAddr-style bech32 with a 40-bit BCH checksum.
//   prefix ":" base32( versionByte || payload ) checksum
// Version 0 = P2PK Schnorr (32-byte x-only key), 1 = P2PK ECDSA (33 bytes),
// 8 = P2SH (32-byte BLAKE2b-256 of the redeem script).

const { blake2b256 } = require('./blake2b');
const { hexToBytes, bytesToHex, concatBytes } = require('./bytes');

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

const NETWORKS = {
  mainnet:      'kaspa',
  'testnet-10': 'kaspatest',
  'testnet-11': 'kaspatest',
  'testnet-12': 'kaspatest',
  simnet:       'kaspasim',
  devnet:       'kaspadev',
};

function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}

function polymod(values) {
  let c = 1n;
  for (const v of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
  }
  return c;
}

function checksumWords(prefix, words) {
  const hrp = [...prefix].map(ch => ch.charCodeAt(0) & 0x1f).concat([0]);
  const pm = polymod(hrp.concat(words, [0, 0, 0, 0, 0, 0, 0, 0])) ^ 1n;
  const out = [];
  for (let i = 7; i >= 0; i--) out.push(Number((pm >> BigInt(5 * i)) & 31n));
  return out;
}

function encodeAddress(prefix, version, payload) {
  const words = convertBits(concatBytes(Uint8Array.of(version), payload), 8, 5, true);
  return prefix + ':' + words.concat(checksumWords(prefix, words)).map(w => CHARSET[w]).join('');
}

// Returns { prefix, version, payload } or throws. Checksum is verified.
function decodeAddress(addr) {
  const s = String(addr || '').trim();
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('address: mixed case');
  const lower = s.toLowerCase();
  const i = lower.lastIndexOf(':');
  if (i < 1) throw new Error('address: missing prefix');
  const prefix = lower.slice(0, i), data = lower.slice(i + 1);
  if (data.length < 9) throw new Error('address: too short');
  const words = [];
  for (const ch of data) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) throw new Error(`address: invalid character "${ch}"`);
    words.push(v);
  }
  const body = words.slice(0, -8), sum = words.slice(-8);
  const want = checksumWords(prefix, body);
  if (want.some((w, k) => w !== sum[k])) throw new Error('address: bad checksum');
  const bytes = convertBits(body, 5, 8, false);
  return { prefix, version: bytes[0], payload: Uint8Array.from(bytes.slice(1)) };
}

function prefixOf(network) {
  const p = NETWORKS[network];
  if (!p) throw new Error(`unknown network "${network}"`);
  return p;
}

// P2SH address of a redeem script (hex or bytes)
function p2shAddress(network, script) {
  const b = typeof script === 'string' ? hexToBytes(script, 'script') : script;
  return encodeAddress(prefixOf(network), 8, blake2b256(b));
}

// P2PK (Schnorr, version 0) address of a 32-byte x-only public key
function p2pkAddress(network, pubkeyHex) {
  const pk = hexToBytes(pubkeyHex, 'pubkey');
  if (pk.length !== 32) throw new Error('pubkey: expected 32 bytes (x-only Schnorr key)');
  return encodeAddress(prefixOf(network), 0, pk);
}

// Script public key for a P2SH payment (what the funding output carries)
function p2shScriptPublicKey(script) {
  const b = typeof script === 'string' ? hexToBytes(script, 'script') : script;
  return { version: 0, script: 'aa20' + bytesToHex(blake2b256(b)) + '87' };
}

// "kaspa:q…" (version 0) or 64-hex → canonical 64-hex x-only pubkey, else null
function pubkeyFromInput(value) {
  if (value == null) return null;
  let s = String(value).trim();
  if (/^[a-z]+:/i.test(s)) {
    try {
      const d = decodeAddress(s);
      if (d.version !== 0 || d.payload.length !== 32) return null;
      return bytesToHex(d.payload);
    } catch (_) { return null; }
  }
  s = s.replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

module.exports = {
  NETWORKS, prefixOf, encodeAddress, decodeAddress,
  p2shAddress, p2pkAddress, p2shScriptPublicKey, pubkeyFromInput,
};
