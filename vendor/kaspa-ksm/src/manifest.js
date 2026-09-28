'use strict';
// The .ksm manifest: create, parse, verify.
// Spec: KSM.md. Authority order when fields disagree:
//   script.hex  >  everything derived from it (hash, address, locks, sigOps, payTo)
// A verifier recomputes derived fields and never trusts the stored copies.

const { blake2b256 } = require('./blake2b');
const { hexToBytes, bytesToHex, isHex } = require('./bytes');
const { NETWORKS, prefixOf, decodeAddress, p2shAddress, p2pkAddress, pubkeyFromInput } = require('./address');
const { tokenize, tagGuardIndex, selectorGuardIndex, analyzePath } = require('./script');
const { normType, canonicalValue, typeFromArtifact, typeFromAst } = require('./args');

const KSM_VERSION = 1;
const MAX_SELECTOR = 16;
const KNOWN_TYPES = /^(int|bool|byte|temporal|pubkey|sig|datasig|string|byte\[\]|byte\[\d+\])$/;

class KsmError extends Error {
  constructor(message, problems) { super(message); this.name = 'KsmError'; this.problems = problems || []; }
}

const clean = h => String(h == null ? '' : h).trim().replace(/^0x/i, '').toLowerCase();
const tagHexOf = t => Array.isArray(t) ? bytesToHex(Uint8Array.from(t)) : (t ? clean(t) : null);

// Dispatch for each entry, from tags when present, else selector index when there
// are several entries (pre-v1 silverc), else none (single entry, pre-v1).
function inferDispatch(entries) {
  const anyTag = entries.some(e => e.dispatch && e.dispatch.kind === 'tag' || e.dispatchTag || e.dispatch_tag);
  return entries.map((e, i) => {
    if (e.dispatch && e.dispatch.kind) {
      const d = e.dispatch;
      return d.kind === 'tag' ? { kind: 'tag', hex: clean(d.hex) } : d.kind === 'selector' ? { kind: 'selector', n: Number(d.n) } : { kind: 'none' };
    }
    const tag = tagHexOf(e.dispatchTag || e.dispatch_tag);
    if (tag) return { kind: 'tag', hex: tag };
    if (anyTag) return { kind: 'none' };           // flagged by verify
    return entries.length > 1 ? { kind: 'selector', n: i } : { kind: 'none' };
  });
}

// checkSig(sigParam, keyName) pairs inside one entry body, from SilverScript source
function signersFromSource(source, entryName) {
  const src = String(source || '');
  if (!src) return null;
  const re = new RegExp('\\b(?:entry|entrypoint\\s+function)\\s+' + entryName.replace(/\W/g, '') + '\\s*\\([^)]*\\)\\s*\\{', 'g');
  const m = re.exec(src);
  if (!m) return null;
  let depth = 1, i = re.lastIndex;
  while (i < src.length && depth > 0) { const ch = src[i]; if (ch === '{') depth++; else if (ch === '}') depth--; i++; }
  const body = src.slice(re.lastIndex, i - 1);
  const out = [];
  const sigRe = /\bcheckSig\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g;
  let c;
  while ((c = sigRe.exec(body))) out.push({ sig: c[1], key: c[2] });
  return out;
}

/**
 * Build a complete manifest. Only network, script and entries are required;
 * everything derivable is derived.
 *
 * input = {
 *   network: 'mainnet' | 'testnet-10' | ...,
 *   script: '<redeem script hex>' | Uint8Array,
 *   entries: [{ name, params: [{name,type}], dispatchTag?: hex | dispatch?: {...} }],
 *   name?, constructorArgs?: [{name,type,value}], parties?: [{role,pubkey,creator?}],
 *   source?: { text, language?, contract? } | string, compiler?: {...},
 *   funding?: {...}, created?: {...}, extensions?: {...}
 * }
 */
function create(input) {
  if (!input || typeof input !== 'object') throw new KsmError('create: input object required');
  const network = input.network;
  prefixOf(network);
  const scriptBytes = typeof input.script === 'string' ? hexToBytes(input.script, 'script') : input.script;
  if (!scriptBytes || !scriptBytes.length) throw new KsmError('create: script is empty');
  tokenize(scriptBytes); // throws on malformed pushes
  const scriptHex = bytesToHex(scriptBytes);
  const src = typeof input.source === 'string' ? { text: input.source } : input.source || null;

  const ctorArgs = (Array.isArray(input.constructorArgs) ? input.constructorArgs : []).map((p, i) => {
    const type = normType(p.type);
    return { name: p.name || `param_${i}`, type, value: canonicalValue(type, p.value, p.name || `constructor[${i}]`) };
  });
  const ctorKeys = Object.fromEntries(ctorArgs.filter(p => p.type === 'pubkey').map(p => [p.name, p.value]));

  const rawEntries = input.entries || [];
  if (!rawEntries.length) throw new KsmError('create: at least one entry is required');
  const dispatch = inferDispatch(rawEntries);
  const entries = rawEntries.map((e, i) => {
    const params = (e.params || e.inputs || []).map(p => ({ name: p.name, type: normType(typeof p.type === 'object' ? typeFromArtifact(p.type) : p.type) }));
    const a = analyzePath(scriptBytes, dispatch[i]);
    const out = { name: e.name, params, dispatch: dispatch[i], locks: a.locks, sigOps: a.sigOps, payTo: a.payTo };
    const s = src && src.text ? signersFromSource(src.text, e.name) : null;
    if (s) {
      out.signers = s.map(x => {
        const r = { sig: x.sig, key: x.key };
        if (ctorKeys[x.key]) r.pubkey = ctorKeys[x.key];
        else if (params.some(p => p.name === x.key)) r.open = true;
        return r;
      });
    }
    return out;
  });

  let parties = input.parties;
  if (!parties) parties = ctorArgs.filter(p => p.type === 'pubkey').map(p => ({ role: p.name, pubkey: p.value }));
  parties = parties.map(p => {
    const pk = pubkeyFromInput(p.pubkey);
    if (!pk) throw new KsmError(`create: party "${p.role}" has no valid pubkey`);
    const r = { role: p.role, pubkey: pk, address: p2pkAddress(network, pk) };
    if (p.creator) r.creator = true;
    return r;
  });

  const m = {
    ksm: KSM_VERSION,
    network,
    address: p2shAddress(network, scriptBytes),
    name: input.name || (src && src.contract) || null,
    script: { hex: scriptHex, hash: bytesToHex(blake2b256(scriptBytes)) },
    entries,
  };
  if (ctorArgs.length) m.constructorArgs = ctorArgs;
  if (parties.length) m.parties = parties;
  if (src && src.text) m.source = { language: src.language || 'silverscript', contract: src.contract || null, text: src.text };
  if (input.compiler) m.compiler = input.compiler;
  if (input.funding) m.funding = input.funding;
  if (input.created) m.created = input.created;
  if (input.extensions) m.extensions = input.extensions;
  if (m.name === null) delete m.name;
  if (m.source && m.source.contract === null) delete m.source.contract;
  return m;
}

/**
 * From silverc v1 output. artifact = parsed JSON of `silverc file.sil --constructor-args a.json -c`.
 * opts = { network, source?, constructorArgs?: [{name,type,value}] | ast?: parsed `--ast-only -c` with
 *          constructorValues?: [...], contract?: name, name?, parties?, funding?, created? }
 */
function fromSilvercArtifact(artifact, opts = {}) {
  const art = typeof artifact === 'string' ? JSON.parse(artifact) : artifact;
  const asList = x => Array.isArray(x) ? x.map(v => [v.name, v]) : Object.entries(x || {}).map(([k, v]) => [v && v.name ? v.name : k, v]);
  const contracts = asList(art && art.contracts);
  if (!contracts.length) throw new KsmError('artifact has no contracts');
  const [cname, c] = contracts.find(([n]) => n === opts.contract) || contracts[0];
  const comp = c.compiled || {};
  const bytecode = comp.bytecode ? Uint8Array.from(comp.bytecode) : comp.script_hex ? hexToBytes(comp.script_hex) : null;
  if (!bytecode) throw new KsmError('artifact has no bytecode');
  const entries = asList(c.entries).map(([name, e]) => ({
    name,
    dispatchTag: e.dispatch_tag || null,
    params: (e.params || []).map(p => ({ name: p.name, type: typeFromArtifact(p.type) })),
  }));
  let ctorArgs = Array.isArray(opts.constructorArgs) ? opts.constructorArgs : null;
  if (!ctorArgs && opts.ast && opts.constructorValues) {
    ctorArgs = (opts.ast.params || []).map((p, i) => ({ name: p.name, type: typeFromAst(p.type_ref), value: opts.constructorValues[i] }));
  }
  const compiler = { name: 'silverc' };
  if (art.compiler_version != null) compiler.version = String(art.compiler_version);
  if (art.schema_version != null) compiler.abiSchema = art.schema_version;
  if (Array.isArray(comp.template_hash)) compiler.templateHash = bytesToHex(Uint8Array.from(comp.template_hash));
  return create({
    network: opts.network, script: bytecode, entries, constructorArgs: ctorArgs || [],
    name: opts.name || cname, parties: opts.parties,
    source: opts.source ? { text: opts.source, contract: cname } : null,
    compiler: Object.assign(compiler, opts.compiler || {}), funding: opts.funding, created: opts.created, extensions: opts.extensions,
  });
}

// JSON text or object → manifest object, with shape checks. Throws KsmError.
function parse(input) {
  let m = input;
  if (typeof input === 'string' || input instanceof Uint8Array) {
    const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
    try { m = JSON.parse(text); } catch (e) { throw new KsmError('not valid JSON: ' + e.message); }
  }
  const p = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new KsmError('manifest must be a JSON object');
  if (m.ksm !== KSM_VERSION) p.push(`ksm: expected ${KSM_VERSION}, got ${JSON.stringify(m.ksm)}`);
  if (!NETWORKS[m.network]) p.push(`network: unknown "${m.network}"`);
  if (typeof m.address !== 'string') p.push('address: missing');
  if (!m.script || !isHex(m.script.hex) || !m.script.hex.length) p.push('script.hex: missing or not lowercase hex');
  if (!Array.isArray(m.entries) || !m.entries.length) p.push('entries: at least one required');
  else m.entries.forEach((e, i) => {
    if (!e || typeof e.name !== 'string' || !e.name) p.push(`entries[${i}].name: missing`);
    if (!Array.isArray(e && e.params)) p.push(`entries[${i}].params: missing`);
    if (!e || !e.dispatch || !['tag', 'selector', 'none'].includes(e.dispatch.kind)) p.push(`entries[${i}].dispatch: missing or unknown kind`);
  });
  if (p.length) throw new KsmError('invalid manifest: ' + p.join('; '), p);
  return m;
}

/**
 * Deep check. Returns { ok, errors: [], warnings: [], derived: {address, hash, entries} }.
 * errors mean: do not spend with this file. warnings mean: informative fields
 * disagree with the script; use the derived values (tools always do).
 */
function verify(input) {
  const errors = [], warnings = [];
  let m;
  try { m = parse(input); } catch (e) { return { ok: false, errors: e.problems && e.problems.length ? e.problems : [e.message], warnings, derived: null }; }

  let script;
  try { script = hexToBytes(m.script.hex); tokenize(script); }
  catch (e) { return { ok: false, errors: ['script.hex: ' + e.message], warnings, derived: null }; }

  const hash = bytesToHex(blake2b256(script));
  const address = p2shAddress(m.network, script);
  if (m.script.hash !== undefined && clean(m.script.hash) !== hash) errors.push(`script.hash: stored ${m.script.hash}, script hashes to ${hash}`);
  if (m.address !== address) {
    let why = 'does not match the script';
    try { const d = decodeAddress(m.address); if (d.prefix !== prefixOf(m.network)) why = `prefix "${d.prefix}" does not match network ${m.network}`; } catch (e) { why = e.message; }
    errors.push(`address: ${m.address} ${why}; the script gives ${address}`);
  }

  const toks = tokenize(script);
  const names = new Set();
  const kinds = new Set(m.entries.map(e => e.dispatch.kind));
  if (kinds.has('tag') && kinds.size > 1) errors.push('entries: tagged and untagged dispatch mixed in one covenant');
  if (kinds.has('none') && m.entries.length > 1) errors.push('entries: several entries but dispatch "none" (a spender cannot select a path)');
  const derivedEntries = m.entries.map((e, i) => {
    if (names.has(e.name)) errors.push(`entries[${i}]: duplicate name "${e.name}"`);
    names.add(e.name);
    const d = e.dispatch;
    if (d.kind === 'tag') {
      if (!/^[0-9a-f]{8}$/.test(clean(d.hex))) errors.push(`entries[${i}].dispatch.hex: expected 4 bytes hex`);
      else if (tagGuardIndex(toks, clean(d.hex)) < 0) errors.push(`entries[${i}] (${e.name}): dispatch tag ${d.hex} has no branch in the script`);
    } else if (d.kind === 'selector') {
      if (!Number.isInteger(d.n) || d.n < 0 || d.n > MAX_SELECTOR) errors.push(`entries[${i}].dispatch.n: expected 0..${MAX_SELECTOR}`);
      else if (selectorGuardIndex(toks, d.n) < 0) errors.push(`entries[${i}] (${e.name}): selector ${d.n} has no branch in the script`);
    }
    (e.params || []).forEach((p, k) => {
      if (!p || !p.name) errors.push(`entries[${i}].params[${k}]: missing name`);
      else if (!KNOWN_TYPES.test(normType(p.type))) warnings.push(`entries[${i}].params[${k}] (${p.name}): type "${p.type}" has no defined push encoding in ksm/1`);
    });
    const a = analyzePath(script, d);
    const same = (x, y) => JSON.stringify((x || []).map(String)) === JSON.stringify((y || []).map(String));
    if (e.locks && (!same(e.locks.cltv, a.locks.cltv) || !same(e.locks.csv, a.locks.csv)))
      warnings.push(`entries[${i}] (${e.name}): stored locks differ from the script's (${JSON.stringify(a.locks)})`);
    if (e.sigOps !== undefined && e.sigOps !== a.sigOps) warnings.push(`entries[${i}] (${e.name}): stored sigOps ${e.sigOps}, script has ${a.sigOps}`);
    if (e.payTo !== undefined && JSON.stringify(e.payTo || null) !== JSON.stringify(a.payTo || null))
      warnings.push(`entries[${i}] (${e.name}): stored payTo differs from the script's (${JSON.stringify(a.payTo)})`);
    return Object.assign({ name: e.name }, a);
  });

  (Array.isArray(m.constructorArgs) ? m.constructorArgs : []).forEach((p, i) => {
    try { canonicalValue(p.type, p.value, p.name); }
    catch (e) { warnings.push(`constructorArgs[${i}]: ${e.message}`); }
  });
  (m.parties || []).forEach((p, i) => {
    const pk = pubkeyFromInput(p.pubkey);
    if (!pk) { errors.push(`parties[${i}] (${p.role}): invalid pubkey`); return; }
    const want = p2pkAddress(m.network, pk);
    if (p.address && p.address !== want) errors.push(`parties[${i}] (${p.role}): address ${p.address} is not the key's address ${want}`);
  });
  if (!m.source) warnings.push('source: absent; the covenant can be spent but not re-derived or read as source');

  return { ok: errors.length === 0, errors, warnings, derived: { address, hash, entries: derivedEntries } };
}

module.exports = { KSM_VERSION, KsmError, create, fromSilvercArtifact, parse, verify, inferDispatch, signersFromSource };
