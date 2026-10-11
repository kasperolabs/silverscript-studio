# MinerDrip: a launch endowment for Kaspa's miners

A convention proposed for every KCC-20 launchpad, exchange or wallet that lets people create tokens.
Draft, October 2026. Kaspero Labs / SilverScript Studio. MIT.

## The idea in one paragraph

When a token is launched, the launch fee does not go to the launchpad. It goes into a covenant with no key and no
owner, created by the same transaction that creates the token, and that covenant pays Kaspa's miners on a halving
schedule. Each payment can only become a transaction fee, so it goes to whichever miner includes the claim. The
amount is public, irreversible and readable from the chain. A token's "miner support" is one number that anyone can
check: the KAS its own genesis transaction put into the drip.

Block rewards decline by design. Fees are the only line that can grow. Token launches are a fee stream that does not
exist yet. This convention routes it to the people securing the chain, and makes the routing something a launcher
cannot fake and an indexer cannot be lied to about.

## Why a covenant and not a payment

A launchpad could simply send part of the fee to a miner address. That proves nothing a week later, and it pays one
miner once. A covenant with no key:

- cannot be withdrawn by anyone, the launchpad included;
- pays out over months or years, so the support reaches many miners, not one;
- is funded in the genesis transaction itself, so the proof of support and the proof of the token's birth are the
  same transaction;
- carries the token's covenant ID inside its script, so from the drip alone anyone can read which token endowed it.

## The covenant

SilverScript (silverc v1, kaspanet/silverscript 1.0.0). Proven on Kaspa mainnet: claims accepted, an early claim
refused by the time lock, an extra output refused, a skimmed amount refused (Oct 10 and 11, 2026; transactions
listed at the end).

```silverscript
pragma silverscript ^0.1.0;

// MinerDrip: an endowment for Kaspa miners. No owner, no key, no reclaim.
// Once every `period` DAA score, anyone may release a prize as the transaction fee.
// tokenId is the KCC-20 covenant ID this endowment belongs to. The claim does not depend on it; it is a
// constant in the script, so the script (and so the address) is unique to the token and names it.
// reveal() runs once, right after launch: it puts this script on chain and pays the first miner minPrize.
contract MinerDrip(int period, int divisor, int minPrize, byte[32] tokenId, int endowment) {
    entry claim() {
        require(tokenId == tokenId);                           // the stamp: keeps the constant in the script
        require(this.ageDaa >= period);
        int balance = tx.inputs[this.activeInputIndex].value;
        int prize = balance / divisor;
        if (prize < minPrize) { prize = minPrize; }
        require(balance - prize >= minPrize);                 // the last sliver stays (under 2 x minPrize)
        require(tx.outputs.length == 1);
        require(tx.outputs[0].scriptPubKey == tx.inputs[this.activeInputIndex].scriptPubKey);
        require(tx.outputs[0].value == balance - prize);      // nowhere else to go: the prize is the fee
    }
    entry reveal() {
        int balance = tx.inputs[this.activeInputIndex].value;
        require(balance >= endowment);                         // only the untouched endowment: once
        require(tx.outputs.length == 1);
        require(tx.outputs[0].scriptPubKey == tx.inputs[this.activeInputIndex].scriptPubKey);
        require(tx.outputs[0].value == balance - minPrize);   // the first drip, paid at launch
    }
}
```

What it enforces, in words:

- `claim()`: once the coin is `period` DAA score old (about ten blocks a second on mainnet), anyone may spend it
  into exactly one output paying the same script `balance - prize`, where `prize = max(balance / divisor,
  minPrize)`. Nothing else can receive value, so the prize is the transaction fee. Nobody signs. The last sliver
  (under twice `minPrize`) stays locked forever.
- `reveal()`: valid only while the coin still holds the whole endowment, so it can run once. It pays `minPrize`
  with no age requirement. The launchpad submits it right after the genesis, which puts the full script, the
  token's covenant ID included, on chain within seconds of launch. From then on the proof needs no indexer.
- The claim ignores `tokenId`; it is a constant that makes every token's drip a different script and therefore a
  different address, and lets anyone read the token from the drip.

## The schedule

The launcher chooses three numbers; the launchpad derives the covenant's constants.

| Launcher chooses | Meaning |
|---|---|
| endowment | KAS put into the drip by the genesis (the launch fee, or more) |
| starting prize | what the first claim pays |
| halving time | how long until a claim pays half the starting prize |

| Derived | Formula |
|---|---|
| divisor | round(endowment / starting prize) |
| period (DAA) | halving time in DAA / claims per halving, where claims per halving = ln 2 / -ln(1 - 1/divisor) |
| minPrize | max(0.01 KAS, starting prize / 20) |

Each claim pays a fixed fraction of what is left, so the prize decays smoothly with the chosen half-life. Example:
1,000 KAS, starting prize 1 KAS, halving 180 days gives divisor 1,000 and a claim every 6.2 hours; claim 1 pays
1.000 KAS, claim 100 pays 0.905, day 180 pays 0.500, day 360 pays 0.250; after about two years the floor of 0.05 KAS
applies until the last sliver.

Reasonable bounds, from mainnet: `period` at least 600 DAA (a claim no more than once a minute), starting prize at
most a tenth of the endowment, endowment outputs no smaller than about 1 KAS (KIP-9 storage mass makes small outputs
expensive).

## How a launchpad implements it

1. **Terms.** Take the three choices above with the launch; derive `period`, `divisor`, `minPrize`.
2. **Covenant ID first.** The drip's script contains the token's covenant ID, and the covenant ID depends on the
   genesis's authorizing input (KIP-20), not on the drip output's bytes. So: draft the genesis against a placeholder
   output for the endowment, read the covenant ID from the draft's bound outputs, compile the drip with it, then build
   the real genesis and check the ID is unchanged. (It is; the covenant ID is fixed by the authorizing input and the
   bound output indices.)
3. **Genesis outputs.** The token's covenant outputs (bound, sharing the covenant ID) first, then the endowment
   output paying the drip's P2SH address (unbound: it is not part of the token's covenant family), then any
   platform fee, then change. The launchpad's own fee, if any, is a separate plain output.
4. **Reveal at launch.** After the genesis is accepted, submit `reveal()`: one input (the endowment coin, signature
   script = push of the reveal entry's dispatch tag + push of the redeem script, `sigOpCount` 0), one output to the
   same address holding `endowment - minPrize`. If the node has not indexed the genesis output yet, retry for a few
   seconds; a keeper can fire it later.
5. **Keeper.** A cron job that claims every due drip (claim tag + redeem script, input sequence = `period`, one
   output back minus the prize). This guarantees the schedule even if no miner bothers; miners who claim first simply
   make the keeper's attempt come too early. Claiming costs the keeper nothing.
6. **Publish the feed.** A public JSON list of every funded drip with everything a miner needs: address, redeem
   script, claim tag, sequence, current outpoint, input amount, keep amount, fee amount, due time. See the format below.
7. **Index the number.** Expose `minerSupportSompi` on every token record: the amount of the genesis's endowment
   output. One number, read from the chain. Rank by it if you like; do not turn it into tiers or names. How to weigh
   it is the reader's call.

A launchpad with a different payout model (a flat schedule, a lump sum after a lock, a different half-life) can
keep everything above and change only the covenant's `claim()`. What the convention asks is the shape: keyless, funded
by the genesis, stamped with the covenant ID, revealed at launch, claimable by anyone, prizes only as fees.

## For miners

A claim transaction is:

1. One input: the drip's current coin, with its sequence set to `period`. The covenant checks the coin's age with
   `OP_CHECKSEQUENCEVERIFY`.
2. Signature script: a push of the claim entry's 4-byte dispatch tag, then a push of the redeem script. Nothing to
   sign; `sigOpCount` 0.
3. Exactly one output: the drip's own address, holding `balance - prize`.
4. The difference is the fee. Put the claim in your own block template before relaying it, or another miner may
   include it first.

This pays off for whoever builds block templates: a solo miner on their own node keeps the fee, a pool operator keeps
it for the pool. The node used needs `--utxoindex` (to look the coin up by address) and a wRPC listener. A reference
script that reads the feed, checks every number against the miner's own node, builds the claim and submits it is at
https://silverscriptstudio.com/claim-drip.js.

## The feed (JSON)

`GET /api/kcc20/drips` on the launchpad. Per drip:

```json
{
  "address": "kaspa:p…",
  "token": { "ticker": "…", "name": "…", "covenantId": "…64 hex…" },
  "stampedTokenId": "…64 hex… (the covenant ID written into the redeem script, or null)",
  "genesisTxid": "…the transaction that created the token and funded this drip…",
  "revealed": true,
  "status": "waiting | due | finished",
  "etaSeconds": 11406, "dueDaa": "…",
  "prizeKas": "1", "prizeSompi": "100000000", "kasPerDay": "3.87",
  "balanceKas": "998.95", "endowedKas": "1000", "emittedKas": "1.05", "claims": 1,
  "claimEverySeconds": 22320, "halvingDays": 180, "divisor": "1000", "minPrizeKas": "0.05",
  "claim": {
    "redeemScriptHex": "…", "claimTag": "26aa3fc0", "sequence": "223200",
    "outpoint": { "txid": "…", "index": 0 },
    "inputSompi": "99895000000", "keepSompi": "99795105000", "feeSompi": "99895000",
    "signatureScript": "04<claimTag> + push(redeemScript)", "outputs": "exactly one: this address, keepSompi"
  }
}
```

Totals alongside: drips, active, due now, claims so far, endowed, paid to miners, still in the drips, due in the
next 24 h. Every value can be checked against the chain; the feed is a convenience, not a source of truth.

## What this proves and what it does not

It proves that the launcher paid a stated amount to Kaspa's miners, irreversibly, at the moment the token was born,
and that no one, the launchpad included, can retrieve it. It does not prove the token is good, honest, or worth
anything. A launcher who pays more has shown more commitment to the network; that is all the number says, and it is
enough to be worth showing.

## Mainnet record

- First MinerDrip claims (Oct 10, 2026): 4a3b35ba0c7eac2db0de634973fa3b68923824e18a0b13c62fbf0590d737d2e0,
  b45b339a529494becdb42f50fefb8d0a56234450856e41c5f7547836fa5c0263; refusals for an extra output, a skim, and an
  early claim.
- Stamped drip with reveal (Oct 11, 2026, drip at kaspa:pz0762pcg4he4mm9vxy70659u0nw6ulug7zg3yqlqarj9te8ldyxx6efz8rzv):
  reveal b33fb37959040cf1c18e6955d8c663f83914d684bb3dbe649e7fdbee68beb5ed, early claim refused by the sequence lock,
  claim c1d8710e1b60ffca4bf5d0c6e821d1b4b7d2ff7cff6c54329df52fb1d74b52b7. The redeem script, covenant ID included,
  is visible in the reveal's input on any explorer.
- Live feed: https://silverscriptstudio.com/drips.html. Launchpad: https://silverscriptstudio.com/launchpad.html.

## Adopting it

Copy the covenant, keep the shape, change the numbers or the payout curve to taste, publish the feed, and show the
number next to every token. If several launchpads do this, miners get a fee stream that grows with the token economy
instead of competing with it, and a token's miner support becomes a figure that means the same thing everywhere.
Questions and claims to kasperolabs on GitHub, or @KasperoLabs on X.
