'use strict';
// Spending a covenant described by a .ksm manifest, wallet- and SDK-agnostic.
//
//   planSpend      what the transaction must look like for one path, and whether it can go now
//   applyPlan      write sequence / lockTime / sigOpCount into an unsigned tx JSON (before signing)
//   signatureScript  assemble one input's signature script from the signatures
//
// Signature script layout, per input:
//   <arg 1> ... <arg n>   entry params in declaration order (a sig param = its 65-byte signature push)
//   <dispatch>            v1: push of the 4-byte tag; pre-v1 multi-entry: script number n; else nothing
//   <redeem script>       push of script.hex

const { hexToBytes, bytesToHex } = require('./bytes');
const { pushData, scriptNum, analyzePath, LOCK_TIME_THRESHOLD } = require('./script');
const { encodeArg, normType } = require('./args');
const { p2pkAddress } = require('./address');
const { parse } = require('./manifest');

const DAA_PER_DAY = 864000n; // mainnet, ~10 blocks per second

function findEntry(m, name) {
  const e = m.entries.find(x => x.name === name);
  if (!e) throw new Error(`no entry "${name}"; entries are: ${m.entries.map(x => x.name).join(', ')}`);
  return e;
}

function dispatchPush(d) {
  if (!d || d.kind === 'none') return '';
  if (d.kind === 'tag') return pushData(hexToBytes(d.hex));
  if (d.kind === 'selector') return pushData(scriptNum(d.n));
  throw new Error('unknown dispatch kind ' + d.kind);
}

/**
 * plan = planSpend(manifest, entryName, {
 *   args:  { paramName: value },          non-sig params (canonical values; "text:..." allowed for bytes)
 *   utxos: [{ blockDaaScore }],           optional; needed to judge relative-lock maturity
 *   chain: { daa, nowMs },                optional; current virtual DAA score and wall clock
 * })
 */
function planSpend(manifest, entryName, opts = {}) {
  const m = parse(manifest);
  const e = findEntry(m, entryName);
  const a = analyzePath(m.script.hex, e.dispatch);   // recomputed, never the stored copy
  const args = opts.args || {};
  const layout = [];
  const sigParams = [];
  for (const p of e.params) {
    if (normType(p.type) === 'sig') { layout.push({ kind: 'sig', name: p.name }); sigParams.push(p.name); continue; }
    if (!(p.name in args)) throw new Error(`missing argument "${p.name}" (${p.type})`);
    layout.push({ kind: 'push', name: p.name, hex: encodeArg(p.type, args[p.name], p.name) });
  }
  const suffixHex = dispatchPush(e.dispatch) + pushData(hexToBytes(m.script.hex));

  const cltv = a.locks.cltv.map(BigInt), csv = a.locks.csv.map(BigInt);
  const blockers = [];
  let lockTime = 0n, sequence = 0n;
  const daa = opts.chain && opts.chain.daa != null ? BigInt(opts.chain.daa) : null;
  const nowMs = opts.chain && opts.chain.nowMs != null ? BigInt(opts.chain.nowMs) : null;
  const unlock = {};

  if (cltv.length) {
    const byDaa = cltv.filter(v => v < LOCK_TIME_THRESHOLD), byTime = cltv.filter(v => v >= LOCK_TIME_THRESHOLD);
    if (byDaa.length && byTime.length) blockers.push('path mixes DAA-score and timestamp locks; not spendable in one transaction');
    else if (byTime.length) {
      lockTime = byTime.reduce((x, v) => v > x ? v : x, 0n);
      unlock.atMs = lockTime.toString();
      if (nowMs === null) blockers.push('unknown: pass chain.nowMs to judge the timestamp lock');
      else if (nowMs < lockTime) blockers.push(`locked until ${new Date(Number(lockTime)).toISOString()}`);
    } else {
      lockTime = byDaa.reduce((x, v) => v > x ? v : x, 0n);
      unlock.atDaa = lockTime.toString();
      if (daa === null) blockers.push('unknown: pass chain.daa to judge the DAA-score lock');
      else if (daa < lockTime) blockers.push(`locked until DAA ${lockTime} (now ${daa}, about ${(lockTime - daa + DAA_PER_DAY - 1n) / DAA_PER_DAY} day(s))`);
    }
  }
  if (csv.length) {
    sequence = csv.reduce((x, v) => v > x ? v : x, 0n);
    unlock.ageDaa = sequence.toString();
    if (sequence >= (1n << 32n)) blockers.push('relative lock out of range');
    const utxos = opts.utxos || [];
    if (daa === null || !utxos.length) blockers.push(`unknown: coins must be ${sequence} DAA old; pass chain.daa and utxos[].blockDaaScore`);
    else for (const u of utxos) {
      if (u.blockDaaScore == null) { blockers.push('unknown: a utxo has no blockDaaScore'); break; }
      const at = BigInt(u.blockDaaScore) + sequence;
      if (daa < at) { blockers.push(`coins still aging: unlock at DAA ${at} (now ${daa})`); break; }
    }
  }
  if (!a.guardFound) blockers.push(`script has no branch for ${e.name}; the manifest and the script disagree`);

  return {
    entry: e.name,
    ready: blockers.length === 0,
    blockers,
    signaturesNeeded: sigParams,
    layout, suffixHex,
    lockTime: lockTime.toString(),
    sequence: sequence.toString(),
    sigOpCount: a.sigOps,
    payTo: a.payTo ? Object.assign({}, a.payTo, { address: p2pkAddress(m.network, a.payTo.pubkey) }) : null,
    unlock,
    note: a.sigOps > 1 ? 'every input must commit sigOpCount = ' + a.sigOps : undefined,
  };
}

// Set the plan's fields on an unsigned transaction in rusty-kaspa "safe JSON".
// All three are covered by the signature hash, so this happens BEFORE signing.
function applyPlan(plan, txJsonString) {
  const tx = typeof txJsonString === 'string' ? JSON.parse(txJsonString) : txJsonString;
  if (BigInt(plan.lockTime) > 0n) tx.lockTime = plan.lockTime;
  for (const inp of tx.inputs || []) {
    if (BigInt(plan.sequence) > 0n) inp.sequence = plan.sequence;
    if (plan.sigOpCount > 1) inp.sigOpCount = plan.sigOpCount;
  }
  return JSON.stringify(tx);
}

// A wallet's own signature script for an input is  41 <64-byte sig> <sighash byte>.
// Returns the 65-byte signature (hex) to place in the covenant's layout.
function signatureFromWallet(sigScriptHex) {
  const h = String(sigScriptHex || '').toLowerCase().replace(/^0x/, '');
  if (h.length === 132 && h.startsWith('41')) return h.slice(2);
  if (h.length === 130) return h;
  if (h.length === 128) return h + '01';
  throw new Error('unrecognized signature: expected 41<64-byte sig><sighash>, 65 or 64 bytes');
}

// sigs: { sigParamName: hex } for this input (65-byte, or 64-byte meaning SIGHASH_ALL)
function signatureScript(plan, sigs) {
  let out = '';
  for (const x of plan.layout) {
    if (x.kind === 'push') { out += x.hex; continue; }
    const s = sigs && sigs[x.name];
    if (!s) throw new Error(`missing signature for "${x.name}"`);
    out += pushData(hexToBytes(signatureFromWallet(s)));
  }
  return out + plan.suffixHex;
}

// Convenience: write finished signature scripts into the tx JSON.
// sigsPerInput: [{ sigParamName: hex }, ...] in input order.
function finalize(plan, txJsonString, sigsPerInput) {
  const tx = typeof txJsonString === 'string' ? JSON.parse(txJsonString) : txJsonString;
  (tx.inputs || []).forEach((inp, i) => { inp.signatureScript = signatureScript(plan, sigsPerInput[i]); });
  return JSON.stringify(tx);
}

module.exports = { planSpend, applyPlan, signatureFromWallet, signatureScript, finalize, DAA_PER_DAY };
