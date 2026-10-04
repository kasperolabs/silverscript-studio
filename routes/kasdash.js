// routes/kasdash.js: the live side of the KasDash demo (public/kasdash-app.*).
//
// An order is an ordinary DoorDashEscrow covenant: the customer deploys it through /api/deploy
// (funder role "user") and deposits through covenant-actions.js, both unchanged. This module adds
// the two things the generic Studio paths can't do:
//   GET  /api/kasdash/:token          the order as the chain and the Studio see it (no auth: the
//                                     dasher's phone reads it from the QR link)
//   POST /api/kasdash/:token/release  { pin }  builds the four-output `release` spend, puts the code
//                                     in the sigScript and submits it. No wallet, no signature:
//                                     the covenant pays whoever presents the code, and only to the
//                                     four keys and amounts it was built with.
// The code never reaches the server before release; the covenant holds only its sha256.
//
// Mount in server.js (next to the offers block):
//   let kasdash = null;
//   try { kasdash = require('./routes/kasdash'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
//   if (kasdash) app.use('/api', kasdash.router);
//
// marker: kasdash-routes-b-2026-10-03

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const router = express.Router();

const IS_MAINNET = (process.env.KASPA_NETWORK || 'testnet').toLowerCase().trim() === 'mainnet';
const NET_ID     = IS_MAINNET ? 'mainnet' : 'testnet-12';
const EXPLORER   = IS_MAINNET ? 'https://explorer.kaspa.org' : 'https://explorer-tn12.kaspa.org';
const MIN_FEE_SOMPI_PER_GRAM = Number(process.env.MIN_FEE_SOMPI_PER_GRAM || 100);
const NODE_URL   = () => process.env.KASPA_NODE_RPC || 'ws://127.0.0.1:17110';
// The same Kaspa SDK server.js uses: KASPA_SDK_PATH if set, else the "kaspa" package
// (vendor/kaspa in the public repo), else the unpacked SDK folder some live installs keep.
let _sdk = null;
function sdk() {
    if (_sdk) return _sdk;
    const tries = [];
    const p = process.env.KASPA_SDK_PATH;
    if (p) tries.push(path.isAbsolute(p) ? p : path.resolve(process.cwd(), p));
    tries.push('kaspa', path.join(__dirname, '..', 'vendor', 'kaspa-wasm32-sdk', 'nodejs', 'kaspa'));
    let last = null;
    for (const t of tries) { try { _sdk = require(t); return _sdk; } catch (e) { last = e; } }
    throw last || new Error('Kaspa SDK not found');
}

const CONTRACT = 'DoorDashEscrow';
const ROLES = ['restaurant', 'driver', 'irs', 'stateTax'];
const AMOUNTS = ['restaurantAmount', 'driverAmount', 'irsAmount', 'stateTaxAmount'];

// ── small helpers (copies of server.js's, kept local so this file stands alone) ──
function pushDataHex(buf) {
    if (buf.length === 0) return '00';
    if (buf.length === 1 && buf[0] >= 1 && buf[0] <= 16) return (0x50 + buf[0]).toString(16);
    if (buf.length === 1 && buf[0] === 0x81) return '4f';
    const len = buf.length;
    let prefix;
    if (len <= 0x4b) prefix = len.toString(16).padStart(2, '0');
    else if (len <= 0xff) prefix = '4c' + len.toString(16).padStart(2, '0');
    else if (len <= 0xffff) prefix = '4d' + (len & 0xff).toString(16).padStart(2, '0') + ((len >> 8) & 0xff).toString(16).padStart(2, '0');
    else throw new Error('Push too large');
    return prefix + buf.toString('hex');
}
function storageMassGrams(ins, outs) {
    const C = 1e12;
    const harm = arr => arr.reduce((a, v) => a + (v > 0n ? C / Number(v) : 0), 0);
    return Math.max(0, Math.ceil(harm(outs) - harm(ins)));     // one input here
}
const kasTxt = s => (Number(s) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });
const normCode = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const amtOf = e => BigInt(e.amount ?? e.entry?.amount ?? 0);
const opOf = e => e.outpoint || e.entry?.outpoint || {};

async function withRpc(fn) {
    const { RpcClient } = sdk();
    const rpc = new RpcClient({ url: NODE_URL() });
    let timedOut = false;
    const connectP = rpc.connect(); connectP.catch(() => {});
    try {
        await Promise.race([connectP, new Promise((_, rej) => setTimeout(() => { timedOut = true; rej(new Error('Kaspa node did not answer (10s)')); }, 10000))]);
        return await fn(rpc);
    } finally {
        if (!timedOut) { try { await rpc.disconnect(); } catch (_) {} }
    }
}

// The order: contract row + its constructor values + party addresses
async function loadOrder(db, token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(token)) return null;
    const [rows] = await db.promise().query(
        `SELECT id, contract_name, contract_address, redeem_script_hex, abi, funding_txid, funding_amount_sompi, redeem_txid, created_at
           FROM contracts WHERE share_token = ? LIMIT 1`, [token]);
    const c = rows[0];
    if (!c || c.contract_name !== CONTRACT) return null;
    const [params] = await db.promise().query('SELECT param_name, param_value FROM contract_params WHERE contract_id = ?', [c.id]);
    const [parts] = await db.promise().query('SELECT role, address FROM contract_participants WHERE contract_id = ?', [c.id]);
    const p = {}; for (const r of params) p[r.param_name] = r.param_value;
    const addr = {}; for (const r of parts) if (!addr[r.role]) addr[r.role] = r.address;
    for (const role of ROLES.concat('user')) if (!addr[role] && /^kaspa(test)?:/.test(p[role] || '')) addr[role] = p[role];
    let abi = c.abi; if (typeof abi === 'string') { try { abi = JSON.parse(abi); } catch (_) { abi = null; } }
    const release = abi && Array.isArray(abi.functions) ? abi.functions.find(f => f.name === 'release') : null;
    const amounts = AMOUNTS.map(k => BigInt(String(p[k] || '0')));
    return {
        c, release, addr, amounts,
        pinHash: String(p.pinHash || '').replace(/^0x/i, '').toLowerCase(),
        refundDelayBlocks: Number(p.refundDelayBlocks || 0)
    };
}

// Light brake on code guessing (80-bit codes make guessing hopeless anyway; this keeps the node quiet)
const tries = new Map();
function tooMany(ip) {
    const now = Date.now(), win = 10 * 60 * 1000;
    const list = (tries.get(ip) || []).filter(t => now - t < win);
    list.push(now); tries.set(ip, list);
    return list.length > 30;
}

// ══ GET /api/kasdash/:token ══════════════════════════════════════
router.get('/kasdash/:token', async (req, res) => {
    const db = req.app.get('db') || req.app.locals.db;
    if (!db) return res.json({ success: false, error: 'DB unavailable' });
    try {
        const o = await loadOrder(db, req.params.token);
        if (!o) return res.status(404).json({ success: false, error: 'No such order' });
        let coins = [];
        try {
            coins = await withRpc(async rpc => (await rpc.getUtxosByAddresses({ addresses: [o.c.contract_address] })).entries || []);
        } catch (e) { return res.json({ success: false, error: 'Could not read the chain: ' + (e.message || e), retryable: true }); }
        const held = coins.reduce((a, e) => a + amtOf(e), 0n);
        const sum = o.amounts.reduce((a, v) => a + v, 0n);
        const state = o.c.redeem_txid ? 'released' : held >= sum && sum > 0n ? 'held' : o.c.funding_txid ? 'spent' : 'unfunded';
        res.json({
            success: true,
            contractId: o.c.id, address: o.c.contract_address, createdAt: o.c.created_at,
            parties: Object.fromEntries(ROLES.concat('user').map(r => [r, o.addr[r] || null])),
            amounts: Object.fromEntries(ROLES.map((r, i) => [r, String(o.amounts[i])])),
            heldSompi: String(held), coins: coins.length, state,
            fundingTxid: o.c.funding_txid || null, releaseTxid: o.c.redeem_txid || null,
            refundDelayBlocks: o.refundDelayBlocks, explorer: EXPLORER
        });
    } catch (e) {
        console.error('[KasDash] read:', e.message);
        res.json({ success: false, error: e.message || 'Error' });
    }
});

// ══ POST /api/kasdash/:token/release { pin } ═════════════════════
router.post('/kasdash/:token/release', async (req, res) => {
    const db = req.app.get('db') || req.app.locals.db;
    if (!db) return res.json({ success: false, error: 'DB unavailable' });
    if (tooMany(req.ip)) return res.status(429).json({ success: false, error: 'Too many attempts. Wait a few minutes.' });
    try {
        const o = await loadOrder(db, req.params.token);
        if (!o) return res.status(404).json({ success: false, error: 'No such order' });
        if (o.c.redeem_txid) return res.json({ success: false, released: true, txId: o.c.redeem_txid, error: 'Already released' });
        if (!o.release || !/^[0-9a-f]{8}$/i.test(o.release.dispatchTag || '')) return res.json({ success: false, error: 'This order was compiled without a release entry tag; it cannot be released here' });
        for (const r of ROLES) if (!o.addr[r]) return res.json({ success: false, error: `No address on record for ${r}` });

        // The same test the covenant runs, before touching the node
        const pin = normCode(req.body && req.body.pin);
        if (pin.length < 8) return res.json({ success: false, badPin: true, error: 'That is not a full code' });
        const pinBuf = Buffer.from(pin, 'utf8');
        if (crypto.createHash('sha256').update(pinBuf).digest('hex') !== o.pinHash)
            return res.json({ success: false, badPin: true, error: 'That code does not open this order. Nothing moved.' });

        const { createTransaction, calculateTransactionMass, updateTransactionMass, Transaction } = sdk();
        const sum = o.amounts.reduce((a, v) => a + v, 0n);
        const redeem = Buffer.from(String(o.c.redeem_script_hex || '').replace(/^0x/i, ''), 'hex');
        const sigScript = pushDataHex(pinBuf) + pushDataHex(Buffer.from(o.release.dispatchTag, 'hex')) + pushDataHex(redeem);

        const result = await withRpc(async rpc => {
            const { entries } = await rpc.getUtxosByAddresses({ addresses: [o.c.contract_address] });
            // `release` takes exactly one coin: the largest that covers the four payouts
            const coin = (entries || []).filter(e => amtOf(e) > sum).sort((a, b) => (amtOf(b) > amtOf(a) ? 1 : -1))[0];
            if (!coin) {
                const held = (entries || []).reduce((a, e) => a + amtOf(e), 0n);
                return { error: held ? `The order holds ${kasTxt(held)} KAS in ${entries.length} coin(s); release needs one coin above ${kasTxt(sum)} KAS` : 'Nothing is held for this order (not funded yet, or already spent)' };
            }
            const outputs = ROLES.map((r, i) => ({ address: o.addr[r], amount: o.amounts[i] }));
            const tx = createTransaction([coin], outputs, 0n, undefined, 1);
            const mass = Number(calculateTransactionMass(NET_ID, tx, 1));
            if (typeof updateTransactionMass === 'function') { try { updateTransactionMass(NET_ID, tx, 1); } catch (_) {} }
            const t = JSON.parse(tx.serializeToSafeJSON());
            const outs = (t.outputs || []).map(x => BigInt(x.value ?? x.amount ?? 0));
            if ((t.inputs || []).length !== 1 || outs.length !== 4 || outs.some((v, i) => v !== o.amounts[i]))
                return { error: 'The SDK built a different transaction than the covenant requires; not sending it' };

            const fee = amtOf(coin) - sum;
            // relay-fee-2026-10-04: the node prices compute/transient mass, not storage mass
            // (server.js relayFeeFor); storage mass only has to stay under the per-transaction limit
            const st = req.app.locals.studio;
            const storage = storageMassGrams([amtOf(coin)], outs);
            if (st && storage > st.MAX_STANDARD_TX_MASS) return { error: 'A payout in this order is too small for the network (storage mass over the limit); it can only be refunded.' };
            const needed = st ? st.relayFeeFor(t, sigScript.length / 2).fee
                              : BigInt(Math.ceil(Math.max(mass + sigScript.length / 2 + 64, storage) * MIN_FEE_SOMPI_PER_GRAM));
            if (fee < needed) return { error: `The deposit left ${kasTxt(fee)} KAS for the network fee and the node wants ${kasTxt(needed)} KAS. The covenant allows no other outputs, so this order can only be refunded.` };

            t.inputs[0].signatureScript = sigScript;
            const signed = Transaction.deserializeFromSafeJSON(JSON.stringify(t));
            const r = await rpc.submitTransaction({ transaction: signed, allowOrphan: false });
            const txId = r?.transactionId || r?.txId || (typeof r === 'string' ? r : null);
            return { txId, fee, coin: `${opOf(coin).transactionId}:${opOf(coin).index}` };
        });
        if (result.error) return res.json({ success: false, error: result.error });

        if (result.txId) {
            try { await db.promise().query('UPDATE contracts SET redeem_txid = ?, redeemed_at = NOW() WHERE id = ?', [result.txId, o.c.id]); } catch (_) {}
        }
        console.log(`[KasDash] ✅ order ${o.c.id} released: ${result.txId} (fee ${kasTxt(result.fee)} KAS)`);
        res.json({
            success: true, txId: result.txId, feeSompi: String(result.fee),
            explorerUrl: result.txId ? `${EXPLORER}/transactions/${result.txId}` : null,
            paid: Object.fromEntries(ROLES.map((r, i) => [r, { address: o.addr[r], sompi: String(o.amounts[i]) }]))
        });
    } catch (e) {
        const msg = typeof e === 'string' ? e : (e?.message || JSON.stringify(e));
        console.error('[KasDash] release:', msg);
        res.json({ success: false, error: 'Node rejected the release: ' + msg });
    }
});

module.exports = { router };
