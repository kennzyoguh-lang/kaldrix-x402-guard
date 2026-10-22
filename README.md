# kaldrix-x402-guard

**Check an x402 payment request against spending limits before the agent signs anything.**

x402 lets an AI agent pay for a web resource: the server answers `402 Payment Required` with what it wants, and the client signs a payment and tries again. Nothing in the protocol says how much an agent may spend in total, whom it may pay, or when a person must approve. This small library puts those limits between "the server asked" and "the agent signed".

It is part of the Kaldrix work on signed spending limits for AI agents. See https://kennzyoguh-lang.github.io/kaldrix-zentrix/ . It is a first version, written against the x402 specification, version 2 (version 1 messages are read as well).

## What it does

For every `402`, in this order:

1. **Reads** the payment request (`PAYMENT-REQUIRED` header, or the JSON body used by version 1) and refuses anything malformed.
2. **Decides** against a policy, before any signing:
   - only tokens you list (network and contract), only recipients you list, only websites you list
   - a limit per payment, a total cap, a speed limit
   - a maximum time the payment may stay valid
   - a person must approve payments above an amount
   - an expiry time for the whole permission
   - an identical payment made twice in a row is refused
   - amounts are exact (whole units, no floating point) and rounded **up**, so a fraction cannot slip under a limit
3. **Signs** only if the guard allowed it, by calling your own signer.
4. **Checks what was signed** against what was approved: same amount, recipient, token and network, a transfer authorisation that names the same recipient and value, an optional fixed paying wallet, and a short validity window.
5. **Sends** the signed payment. If the server still answers `402`, or the signer failed, the reserved amount is given back. If the connection dropped after sending, the amount stays counted, because the payment may have gone through.

## Use it

```ts
import { createGuard, guardedFetch } from "./src/index";

const guard = createGuard({
  allowedAssets: [{ network: "eip155:8453", asset: "0xUSDC_CONTRACT", symbol: "USDC", decimals: 6 }],
  allowedRecipients: ["0xSupplierWallet"],
  allowedHosts: ["api.supplier.com"],
  maxPerPaymentUsd: 1,
  maxTotalUsd: 20,
  speed: { windowMs: 60_000, maxUsd: 3 },
  maxTimeoutSeconds: 120,
  requireApprovalAboveUsd: 0.5,
});

const pay = guardedFetch(fetch, guard, mySigner, { approve: askAPerson });
const res = await pay("https://api.supplier.com/data");
```

`mySigner(requirement, required)` is yours: it builds and signs the payment payload with your wallet. It is only called for a payment the guard has allowed.

## Run the tests

```
npm install
npm test
```

34 tests cover reading both versions, every refusal, the money arithmetic, totals and rollbacks, a signer that tries to change the amount, a server that lies about the website, and an agent that loops.

## What it does not do. Please read this.

- **It guards the path it sits on.** If the agent, or anything else, can reach the wallet key directly, it can sign without asking this library. The strongest setup keeps the key where only the guard can use it. This library is a policy check, not a vault.
- **The policy is local.** It is a JSON object, not a signed Kaldrix permission. Using signed, narrowing-only Kaldrix permissions as the policy source (so that a person's signature, not the agent's code, sets the limits) is the planned next step. It is not built.
- **Only the `exact` scheme with EVM transfer authorisations is checked in depth.** Other schemes get the amount, recipient, asset, network and timeout checks, but not payload-level checks.
- **Totals are kept in memory** unless you supply a ledger that persists.
- **It has not had an independent security review.** Treat it as a working first version.
- It does not talk to any facilitator, does not move money, and does not claim to be affiliated with, endorsed by or a partner of the x402 project, Coinbase or any other company.

## Status and rights

First version, October 2026. All rights reserved by Oguh Chidiebube Kenneth. You may read it and run it to evaluate it. No licence to redistribute or build a product on it is granted; ask first.

Report a security problem privately through the repository's security page.
