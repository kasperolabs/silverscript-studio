# SilverScript Studio

**Rules for your money, enforced by the chain.**

SilverScript Studio is a web IDE and deploy platform for Kaspa covenants: spending rules locked onto coins. You write the rules (by hand, with a wizard, or by describing them to an AI that only speaks SilverScript), deploy them from your own wallet, and withdraw when the rules allow. Nobody in between holds the money, including the Studio.

Official instance: **https://silverscriptstudio.com**

---

## What a covenant is

A covenant is a Kaspa address with rules attached. Anyone can send KAS to it. Taking KAS out only works if the rules say so: who must sign, after which date, to which address, with which secret.

The address is the hash of the compiled rules and the keys in them. Same rules and same keys always give the same address, and changing either gives a different one. That is what makes a covenant verifiable: if you have the source and the arguments, you can recompile and check the address yourself before you deposit a single sompi.

## What the Studio does

- **Write**: a Monaco editor with SilverScript highlighting, snippets, and compile errors on the line (`Ctrl+B`).
- **Wizard**: common shapes as questions (time-locked vault, dead man's switch, escrow, freelance payroll, secret-claim HTLC, single key).
- **Describe to AI**: plain language in, SilverScript out, checked against the installed compiler.
- **Deploy**: compiles with your real arguments, derives the address, and you fund it from your own wallet (Kasware or Kasla). The server verifies the funding on chain.
- **Withdraw**: builds the spend for the path you choose, your wallet signs, the Studio broadcasts through its node. Time locks are read from the script itself.
- **Share**: every covenant gets an unguessable link (`/c/<token>`) where the parties see the rules in plain English, the source, the balance, and their own action.
- **Covenant file**: every covenant can be downloaded as a `.ksm` file (Kaspa Spend Map). With it and your key you can withdraw using any compatible tool, without this site. Spec at `/ksm.html`, reference library in `vendor/kaspa-ksm`.

The Studio is non-custodial. It never holds keys or funds. Deposits go from your wallet to the covenant address; withdrawals are signed by your wallet.

---

## Verify before you deposit

Anyone can host a copy of this code. A copy could show you rules that look right and an address that belongs to someone else. Before depositing into any covenant, from any site:

1. Open the covenant page and read the rules and the parties' addresses.
2. Download the `.ksm` file and check it with the reference tool, which runs on your machine: `npx kaspa-ksm verify file.ksm` checks that the script, its hash, the address, every spend path and every party's address agree. `npx kaspa-ksm reproduce file.ksm --silverc /path/to/silverc` goes further and recompiles the source, proving the readable rules really are the script behind the address.
3. Make sure your wallet's popup shows the site you expect, and the destination is the covenant address you verified.

If the address on the page and the address in your wallet popup ever differ, stop.

---

## Run it yourself

### Requirements

- Node.js 20
- MySQL 8
- `silverc` v1.0.0, the SilverScript compiler, built from [kaspanet/silverscript](https://github.com/kaspanet/silverscript) (`cargo build --release`)
- A rusty-kaspa node with wRPC Borsh enabled (default port 17110 on mainnet)
- Login uses the KasperoConnect widget (Kasware, Kasla) with sessions issued by kasperopay.com

### Setup

```bash
git clone https://github.com/kasperolabs/silverscript-studio.git
cd silverscript-studio
npm install
cp .env.example .env        # fill in the values
mysql -u root -p -e "CREATE DATABASE silverscript_studio"
mysql -u root -p silverscript_studio < schema.sql
npm start
```

The app serves on `PORT` (default 3000). Put nginx or another reverse proxy with TLS in front of it for anything public.

Every variable the server reads is listed, with comments, in `.env.example`. The important ones: `KASPA_NETWORK`, `KASPA_NODE_RPC`, `SILVERC_PATH`, the `DB_*` values and `JWT_SECRET`. Set `JWT_SECRET`: without it, sessions are decoded but not verified.

### The Kaspa SDK

`vendor/kaspa` holds the Kaspa WASM SDK build the Studio runs on mainnet. It is newer than the `kaspa` package on npm (0.13.0), so it is vendored and installed with `"kaspa": "file:vendor/kaspa"`.

---

## For other sites

### Open in Studio

Send a user to the Studio with a contract loaded. The payload travels in the URL fragment, so it never reaches the server.

Simple form:

```
https://silverscriptstudio.com/#code=<base64url of the .sil source>&name=<file name>
```

With constructor prefills:

```
https://silverscriptstudio.com/#open=<base64url of JSON>
```

```json
{ "v": 1, "file": "escrow.sil", "source": "...", "args": { "buyer": "kaspa:q..." }, "from": "Your Site" }
```

`args` are keyed by constructor parameter name; `pubkey` values are Kaspa addresses. They only prefill the deploy form: the user reviews and confirms everything, and nothing compiles, deploys or signs by itself. A notice tells the user where the file came from.

### Compile API

```
POST /api/compile
{ "source": "pragma silverscript ^0.1.0; ..." }
```

Returns `{ success, contractName, script, scriptHash, abi, ... }` or `{ success: false, errors: [{ line, column, message }] }`. It compiles with placeholder constructor arguments, so it is a check, not a build: never use its `script` to derive an address or receive funds.

---

## Project layout

```
server.js               Express app: compile, deploy, funding checks, spend building, share pages
routes/                 redeem (spend info and notifications)
public/                 the whole frontend, vanilla JS, no build step
  index.html, app.js    the IDE
  wizard-*.js           wizard templates and engine
  covenant.*            the per-covenant share page
  covenant-actions.js   deposit / sign / broadcast, no DOM
  ksm.html, KSM.md      the covenant file spec
vendor/kaspa            Kaspa WASM SDK build (see above)
vendor/kaspa-ksm        Kaspa Spend Map reference library
```

---

## Name

The code is MIT licensed. The name "SilverScript Studio" and the silverscriptstudio.com domain are not. If you host your own copy, give it your own name, so people can tell which site they are depositing through.

## Security

Please report security issues privately to the maintainer rather than in a public issue.

## Credits

SilverScript is by Michael Sutton and the Kaspa core developers ([kaspanet/silverscript](https://github.com/kaspanet/silverscript)). The Studio is built by Kaspero Labs.

## License

MIT. See `LICENSE`.
