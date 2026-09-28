#!/usr/bin/env node
'use strict';
// ksm: inspect, verify and plan spends for .ksm covenant manifests.
//   ksm verify  <file.ksm>
//   ksm inspect <file.ksm> [--asm]
//   ksm plan    <file.ksm> <entry> [--daa N] [--utxo-daa N] [--arg name=value ...]
//   ksm reproduce <file.ksm> [--silverc /path/to/silverc]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const K = require('../src');

const argv = process.argv.slice(2);
const cmd = argv[0], file = argv[1];
const flag = n => { const i = argv.indexOf(n); return i > 0 ? argv[i + 1] : undefined; };
const flags = n => argv.reduce((a, x, i) => (x === n && argv[i + 1] ? a.concat(argv[i + 1]) : a), []);
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

if (!cmd || !file || cmd === '-h' || cmd === '--help') {
  console.log('usage: ksm verify|inspect|plan|reproduce <file.ksm> [...]\n  see KSM.md');
  process.exit(cmd ? 0 : 1);
}
let text;
try { text = fs.readFileSync(file, 'utf8'); } catch (e) { die('cannot read ' + file + ': ' + e.message); }

const kas = s => (Number(BigInt(s)) / 1e8).toString();

if (cmd === 'verify') {
  const r = K.verify(text);
  for (const e of r.errors) console.log('ERROR   ' + e);
  for (const w of r.warnings) console.log('warning ' + w);
  console.log(r.ok ? `OK  ${r.derived.address}` : 'NOT OK: do not spend with this file');
  process.exit(r.ok ? 0 : 2);
}

let m;
try { m = K.parse(text); } catch (e) { die(e.message, 2); }

if (cmd === 'inspect') {
  const r = K.verify(m);
  console.log(`${m.name || '(unnamed)'}  on ${m.network}`);
  console.log(`address   ${m.address}  ${r.ok ? '(matches script)' : '(DOES NOT VERIFY)'}`);
  console.log(`script    ${m.script.hex.length / 2} bytes, blake2b ${r.derived ? r.derived.hash : '?'}`);
  if (m.compiler) console.log(`compiler  ${[m.compiler.name, m.compiler.version, m.compiler.ref].filter(Boolean).join(' ')}`);
  for (const p of m.parties || []) console.log(`party     ${p.role.padEnd(12)} ${p.address}${p.creator ? '  (creator)' : ''}`);
  for (const c of m.constructorArgs || []) console.log(`param     ${c.name}: ${c.type} = ${JSON.stringify(c.value)}`);
  console.log('');
  for (const e of m.entries) {
    const d = (r.derived && r.derived.entries.find(x => x.name === e.name)) || {};
    const sig = e.params.filter(p => p.type === 'sig').length;
    const disp = e.dispatch.kind === 'tag' ? 'tag ' + e.dispatch.hex : e.dispatch.kind === 'selector' ? 'selector ' + e.dispatch.n : 'no dispatch';
    console.log(`path ${e.name}(${e.params.map(p => p.type + ' ' + p.name).join(', ')})  [${disp}]`);
    console.log(`  signatures ${sig}${sig === 0 ? ' (no signature: anyone holding a valid spend can submit it)' : ''}, sigOps ${d.sigOps}`);
    if (d.locks && d.locks.cltv.length) console.log(`  absolute lock ${d.locks.cltv.map(v => BigInt(v) >= K.script.LOCK_TIME_THRESHOLD ? new Date(Number(v)).toISOString() : 'DAA ' + v).join(', ')}`);
    if (d.locks && d.locks.csv.length) console.log(`  relative lock ${d.locks.csv.map(v => v + ' DAA (~' + (Number(v) / 864000).toFixed(2) + ' days on mainnet)').join(', ')}`);
    if (d.payTo) console.log(`  pays only to ${K.p2pkAddress(m.network, d.payTo.pubkey)}`);
    for (const s of e.signers || []) console.log(`  ${s.sig} signs as ${s.key}${s.open ? ' (key supplied by the spender: open path)' : ''}`);
  }
  if (argv.includes('--asm')) console.log('\n' + K.disassemble(m.script.hex));
  process.exit(0);
}

if (cmd === 'plan') {
  const entry = argv[2];
  if (!entry || entry.startsWith('--')) die('usage: ksm plan <file.ksm> <entry> [--daa N] [--utxo-daa N] [--arg name=value]');
  const args = {};
  for (const a of flags('--arg')) { const i = a.indexOf('='); args[a.slice(0, i)] = a.slice(i + 1); }
  const daa = flag('--daa'), udaa = flag('--utxo-daa');
  try {
    const p = K.planSpend(m, entry, { args, chain: { daa, nowMs: Date.now() }, utxos: udaa ? [{ blockDaaScore: udaa }] : [] });
    console.log(JSON.stringify(p, null, 2));
    process.exit(p.ready ? 0 : 3);
  } catch (e) { die(e.message); }
}

if (cmd === 'reproduce') {
  if (!m.source || !m.source.text) die('no source in this manifest; nothing to reproduce');
  const silverc = flag('--silverc') || process.env.SILVERC || 'silverc';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksm-'));
  const src = path.join(dir, 'c.sil'), ctor = path.join(dir, 'args.json');
  fs.writeFileSync(src, m.source.text);
  fs.writeFileSync(ctor, JSON.stringify((m.constructorArgs || []).map(c => K.args.toSilvercValue(c.type, c.value, c.name))));
  let out;
  try { out = execFileSync(silverc, [src, '--constructor-args', ctor, '-c'], { encoding: 'utf8', maxBuffer: 10 << 20 }); }
  catch (e) { die('silverc failed: ' + (e.stderr || e.message)); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const again = K.fromSilvercArtifact(JSON.parse(out), { network: m.network, contract: m.source.contract });
  const same = again.script.hex === m.script.hex;
  console.log(same ? `REPRODUCED  source + args compile to the same script (${again.address})`
                   : `DIFFERENT   this compiler gives ${again.address}; the file says ${m.address}. Check compiler version.`);
  process.exit(same ? 0 : 4);
}

die('unknown command ' + cmd);
