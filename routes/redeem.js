// routes/redeem.js
//
// Serves contract data needed for client-side PSKT redemption via Kasware.
//
// Flow:
//   1. GET /api/contracts/:contractId/redeem-info
//      → returns funding outpoint + redeem script so client can build spend tx
//   2. Client builds PSKT, calls kasware.signPskt(), then kasware.pushTx()
//   3. POST /api/contracts/:contractId/redeem-notify (optional)
//      → client notifies us of the spend txid so we can mark contract as redeemed

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');

// ── Auth middleware (same pattern as server.js) ────────────────────────────────
function requireAuth(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        // Verify when the shared secret is configured (same rule as server.js requireAuth).
        const decoded = process.env.JWT_SECRET ? jwt.verify(token, process.env.JWT_SECRET) : jwt.decode(token);
        if (decoded && decoded.exp && decoded.exp * 1000 < Date.now()) return res.status(401).json({ error: 'Token expired' });
        if (!decoded?.address) return res.status(401).json({ error: 'Invalid token' });
        req.walletAddress = decoded.address;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

function getDb(req) {
    return req.app.locals.db || req.app.get('db');
}

// ── GET /api/contracts/:contractId/redeem-info ─────────────────────────────────
//
// Returns everything the client needs to build a P2SH spend transaction:
//   - funding outpoint (txid + index + amount)
//   - redeem script hex
//   - script hash
//   - contract address
//   - owner pubkey (from constructor args)
//
// Only the contract owner (wallet_address) can fetch this.
router.get('/contracts/:contractId/redeem-info', requireAuth, async (req, res) => {
    const db = getDb(req);
    if (!db) return res.status(500).json({ error: 'DB not available' });

    const { contractId } = req.params;

    try {
        const [rows] = await db.promise().query(
            `SELECT c.id, c.contract_address, c.redeem_script_hex, c.script_hash_hex,
                    c.funding_txid, c.funding_output_index, c.funding_amount_sompi,
                    c.abi, c.network, c.redeemed_at,
                    u.wallet_address
             FROM contracts c
             JOIN users u ON c.user_id = u.id
             WHERE c.id = ? LIMIT 1`,
            [contractId]
        );

        if (!rows.length) return res.status(404).json({ error: 'Contract not found' });

        const contract = rows[0];

        // Only owner can redeem
        if (contract.wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Not your contract' });
        }

        if (!contract.funding_txid) {
            return res.status(400).json({ error: 'No funding outpoint recorded — contract may not be funded' });
        }

        // Strip 0x prefix from stored hex values
        const redeemScriptHex = contract.redeem_script_hex?.replace(/^0x/, '');
        const scriptHashHex   = contract.script_hash_hex?.replace(/^0x/, '');

        // Get constructor args to find owner pubkey
        const [params] = await db.promise().query(
            `SELECT param_name, param_type, param_value FROM contract_params WHERE contract_id = ?`,
            [contractId]
        );

        return res.json({
            contractId:          contract.id,
            contractAddress:     contract.contractAddress,
            network:             contract.network,
            redeemScriptHex,
            scriptHashHex,
            fundingTxid:         contract.funding_txid,
            fundingOutputIndex:  contract.funding_output_index ?? 0,
            fundingAmountSompi:  contract.funding_amount_sompi?.toString(),
            constructorParams:   params,
            redeemedAt:          contract.redeemed_at || null,
        });

    } catch (err) {
        console.error('[Redeem] Info error:', err);
        return res.status(500).json({ error: 'Failed to fetch redeem info' });
    }
});

// ── POST /api/contracts/:contractId/redeem-notify ─────────────────────────────
//
// Client calls this after successfully submitting the spend tx via kasware.pushTx().
// Body: { txId: '...' }
// Marks the contract as redeemed in the DB.
router.post('/contracts/:contractId/redeem-notify', requireAuth, async (req, res) => {
    const db = getDb(req);
    if (!db) return res.status(500).json({ error: 'DB not available' });

    const { contractId } = req.params;
    const { txId } = req.body;

    if (!txId) return res.status(400).json({ error: 'txId required' });

    try {
        // Owner, or a participant who joined via the share link (external covenant)
        const [rows] = await db.promise().query(
            `SELECT c.id
             FROM contracts c
             JOIN users u ON c.user_id = u.id
             WHERE c.id = ? AND (u.wallet_address = ? OR EXISTS (
                   SELECT 1 FROM contract_participants cp
                    WHERE cp.contract_id = c.id AND cp.address = ? AND cp.joined_at IS NOT NULL))
             LIMIT 1`,
            [contractId, req.walletAddress, req.walletAddress]
        );

        if (!rows.length) return res.status(404).json({ error: 'Contract not found or not yours' });

        await db.promise().query(
            `UPDATE contracts SET redeem_txid = ?, redeemed_at = NOW() WHERE id = ?`,
            [txId, contractId]
        );

        console.log(`[Redeem] ✅ Contract ${contractId} redeemed — txId: ${txId}`);
        return res.json({ success: true, txId });

    } catch (err) {
        console.error('[Redeem] Notify error:', err);
        return res.status(500).json({ error: 'Failed to record redemption' });
    }
});

module.exports = router;


// ── DB Migration ───────────────────────────────────────────────────────────────
// Run once to add funding outpoint + redemption columns to contracts table:
//
// ALTER TABLE contracts
//   ADD COLUMN funding_txid          VARCHAR(64)   NULL,
//   ADD COLUMN funding_output_index  INT           NULL DEFAULT 0,
//   ADD COLUMN funding_amount_sompi  BIGINT        NULL,
//   ADD COLUMN redeem_txid           VARCHAR(64)   NULL,
//   ADD COLUMN redeemed_at           DATETIME      NULL;
