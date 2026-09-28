'use strict';
// Optional adapter for the rusty-kaspa WASM SDK (the `kaspa` package or the
// wasm32 SDK from the rusty-kaspa release zip). You pass the SDK in; this
// package never imports it, so the core stays dependency-free.
//
// Mirrors SilverScript Studio's build-spend (proven on mainnet): sweep the
// covenant's UTXOs to one destination, size the fee from the transaction mass
// plus what the signature script will weigh, then bake lockTime / sequence /
// sigOpCount in before anyone signs.

const { planSpend, applyPlan } = require('./spend');
const { parse } = require('./manifest');

const FLAT_FEE_PER_INPUT = 200000n;  // 0.002 KAS, the Studio's floor per input

/**
 * const { txJsonString, plan, amountSompi, feeSompi } = await buildSpendTx({
 *   kaspa,                 // require('kaspa') or the wasm32 SDK module
 *   manifest, entry,       // .ksm object and entry name
 *   args,                  // non-sig arguments
 *   utxos,                 // entries from rpc.getUtxosByAddresses({addresses:[manifest.address]}).entries
 *   destination,           // kaspa:... address to receive the sweep (ignored if the path pins a payee)
 *   daa,                   // current virtual DAA score (rpc.getBlockDagInfo().virtualDaaScore)
 *   networkId,             // 'mainnet' | 'testnet-10' | ...; defaults to manifest.network
 *   feeSompiPerGram = 100n, maxInputs = 10
 * })
 * Then: wallet signs txJsonString (Kasware signPskt shape: see KSM.md), you build each
 * input's signature script with signatureScript(plan, {...}) and broadcast.
 */
async function buildSpendTx(o) {
  const { kaspa } = o;
  if (!kaspa || typeof kaspa.createTransactions !== 'function') throw new Error('pass the Kaspa WASM SDK as `kaspa`');
  const m = parse(o.manifest);
  const all = o.utxos || [];
  if (!all.length) throw new Error('no UTXOs at the covenant address');
  const sweep = all.slice(0, o.maxInputs || 10);
  const amt = u => BigInt(u.amount ?? (u.entry && u.entry.amount) ?? 0);
  const daaOf = u => u.blockDaaScore ?? (u.entry && u.entry.blockDaaScore);
  const plan = planSpend(m, o.entry, {
    args: o.args, chain: { daa: o.daa, nowMs: Date.now() },
    utxos: sweep.map(u => ({ blockDaaScore: daaOf(u) })),
  });
  if (!plan.ready) { const e = new Error('not spendable now: ' + plan.blockers.join('; ')); e.plan = plan; throw e; }

  let destination = o.destination;
  if (plan.payTo) destination = plan.payTo.address;
  if (!destination) throw new Error('destination required');

  const total = sweep.reduce((a, u) => a + amt(u), 0n);
  const sigScriptBytes = plan.layout.reduce((n, x) => n + (x.kind === 'sig' ? 66 : x.hex.length / 2), 0) + plan.suffixHex.length / 2 + 3;
  const networkId = o.networkId || m.network;
  const build = async fee => {
    const { transactions } = await kaspa.createTransactions({
      entries: sweep, outputs: [{ address: destination, amount: total - fee }],
      changeAddress: destination, priorityFee: 0n, networkId,
    });
    if (!transactions || transactions.length !== 1) throw new Error('SDK did not produce exactly one transaction; spend fewer inputs');
    const p = transactions[0];
    const json = typeof p.serializeToSafeJSON === 'function' ? p.serializeToSafeJSON()
      : p.transaction && typeof p.transaction.serializeToSafeJSON === 'function' ? p.transaction.serializeToSafeJSON() : null;
    if (!json) throw new Error('SDK cannot serialize the transaction (serializeToSafeJSON missing)');
    return json;
  };
  let fee = FLAT_FEE_PER_INPUT * BigInt(sweep.length);
  if (total <= fee) throw new Error('balance too small to cover the network fee');
  let json = await build(fee);
  const sdkMass = Number(JSON.parse(json).mass || 0);
  const estMass = sdkMass + sweep.length * (sigScriptBytes + (plan.sigOpCount - 1) * 1000) + 64;
  const needed = BigInt(Math.ceil(estMass * Number(o.feeSompiPerGram ?? 100)));
  if (needed > fee) {
    fee = needed;
    if (total <= fee) throw new Error('balance too small to cover the network fee');
    json = await build(fee);
  }
  return {
    txJsonString: applyPlan(plan, json), plan, destination,
    amountSompi: (total - fee).toString(), feeSompi: fee.toString(),
    inputCount: sweep.length, remainingUtxos: all.length - sweep.length,
  };
}

module.exports = { buildSpendTx };
