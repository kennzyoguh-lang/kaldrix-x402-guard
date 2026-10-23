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

## With Kaldrix in front: a signed permission decides, the guard obeys

The local policy above is a plain settings object. The stronger setup lets **Kaldrix** decide. Before the agent signs, the guard asks the Kaldrix service whether a **signed permission a person gave this agent** allows this exact payment. Kaldrix checks the amount, supplier and purpose against the permission, counts the spend against the total cap, asks a person to approve a large payment, writes it to an audit log, and returns a **signed proof** of what was authorised. If Kaldrix says no, or cannot be reached, nothing is signed.

```ts
import { createGuard, guardedFetch, KaldrixAuthority } from "./src/index";

const authority = new KaldrixAuthority({
  baseUrl: "https://kaldrix-sandbox.onrender.com",
  agentKey: process.env.KALDRIX_AGENT_KEY!,   // limited key: pays inside a permission, reads payments, nothing else
  agentSeedHex: mySeed,                        // the agent's own key, never leaves this process
  permissions: [permissionAPersonGaveMe],
  recipientByWallet: { "0xSupplierWallet": "acme" },  // which Kaldrix supplier each wallet belongs to
});

const pay = guardedFetch(fetch, createGuard(localPolicy), mySigner, {
  authority,
  approve: askAPerson,                          // called when Kaldrix says a person must approve
  onAuthorized: ({ envelope }) => keepWithMyRecords(envelope),
});
```

The order for every `402`: read the request, check the local policy, **ask Kaldrix**, only then sign, check what was signed against what was approved, send. The proof format is checked against bytes produced by the reference implementation. `examples/live-check.ts` asks the live test service about a payment without making any x402 payment.

**Be clear about what this is.** In the Kaldrix test service the authorised payment goes to a **pretend bank**. For x402 it stands in for the real on-chain payment that follows: Kaldrix decides, counts and records, and this library then lets the agent sign. Kaldrix does **not** watch the blockchain settle, and a recorded spend cannot be undone if the x402 payment later fails (so a failed payment still counts against the cap, the safe direction). A wallet that is not matched to a Kaldrix supplier is never paid.

## AP2 mandates (Google's Agent Payments Protocol, version 0.2)

AP2 describes a person's permission as a chain of signed tokens: an **open** payment mandate (the limits) and a **closed** one (one actual payment). Checking the signatures and the chain is a separate job, done by a library that implements the Delegate SD-JWT draft (Google's own Python SDK does it). **This library does not check signatures.** It does the step after that, the one the specification calls for: does the closed payment satisfy the constraints in the open mandate?

```ts
import { checkAp2PaymentConstraints, ap2ToPolicy, createGuard } from "./src/index";

// 1. After your SD-JWT library has verified the chain, you hold the decoded open and closed mandate content.
const problems = checkAp2PaymentConstraints(openMandate, closedMandate, { totalAmountMinor: spentSoFar, totalUses: uses, nowSeconds });
if (problems.length) refuse(problems);

// 2. Or turn the open mandate's limits into a policy for the x402 guard above.
const { policy, notEnforced } = ap2ToPolicy(openMandate, { allowedAssets, walletsByPayeeId });
const guard = createGuard(policy);
```

Covered, following the specification and the evaluation rules of the reference SDK: `payment.amount_range`, `payment.allowed_payees`, `payment.allowed_payment_instruments`, `payment.allowed_pisps`, `payment.budget`, `payment.agent_recurrence` (including the rule that it needs an amount range and a budget), `payment.reference`, `payment.execution_date`, and the claims fixed in an open mandate. **An unknown constraint fails**, as the specification requires. `ap2ToPolicy` never loosens a limit: anything it cannot turn into a limit is listed in `notEnforced`, and a mandate that sets no amount limit or names no payee with a known wallet is refused instead of being given an unlimited policy.

Limits of this part: it was written from the published documents and the reference SDK's source and checked by tests that follow them. It was **not** run against the reference SDK's own test suite, and it is not endorsed by Google, the FIDO Alliance or anyone else. AP2 version 0.2 is described as pre-release and may change.

## Run the tests

```
npm install
npm test
```

72 tests cover reading both versions, every refusal, the money arithmetic, totals and rollbacks, a signer that tries to change the amount, a server that lies about the website, and an agent that loops, every AP2 constraint, and the Kaldrix client (checked against bytes from the reference implementation).

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
