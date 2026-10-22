import { describe, expect, it } from "vitest";
import { ap2ToPolicy, checkAp2PaymentConstraints, createGuard, merchantMatches, type Ap2ClosedPaymentMandate, type Ap2OpenPaymentMandate } from "../src/index";

const merchant = { id: "merchant_1", name: "Demo Merchant", website: "https://demo-merchant.example" };
const open = (over: Partial<Ap2OpenPaymentMandate> = {}): Ap2OpenPaymentMandate => ({
  vct: "mandate.payment.open.1",
  constraints: [
    { type: "payment.amount_range", currency: "USD", max: 20000, min: 0 },
    { type: "payment.allowed_payees", allowed: [merchant] },
  ],
  ...over,
});
const closed = (over: Partial<Ap2ClosedPaymentMandate> = {}): Ap2ClosedPaymentMandate => ({
  vct: "mandate.payment.1",
  transaction_id: "tx1",
  payee: merchant,
  payment_amount: { amount: 19900, currency: "USD" },
  payment_instrument: { id: "stub", type: "card" },
  ...over,
});

describe("AP2 constraint checks (follows the specification and the reference SDK)", () => {
  it("accepts the specification's own example: 199.00 USD to the allowed merchant", () => {
    expect(checkAp2PaymentConstraints(open(), closed())).toEqual([]);
  });

  it("amount range: over the maximum, under the minimum, wrong currency", () => {
    expect(checkAp2PaymentConstraints(open(), closed({ payment_amount: { amount: 20001, currency: "USD" } }))).toEqual(["Amount 20001 exceeds maximum 20000"]);
    const o = open({ constraints: [{ type: "payment.amount_range", currency: "USD", min: 1000, max: 20000 }, { type: "payment.allowed_payees", allowed: [merchant] }] });
    expect(checkAp2PaymentConstraints(o, closed({ payment_amount: { amount: 999, currency: "USD" } }))).toEqual(["Amount 999 below minimum 1000"]);
    expect(checkAp2PaymentConstraints(open(), closed({ payment_amount: { amount: 100, currency: "EUR" } }))).toEqual(["Currency mismatch: expected USD, got EUR"]);
  });

  it("exactly at the maximum is allowed", () => {
    expect(checkAp2PaymentConstraints(open(), closed({ payment_amount: { amount: 20000, currency: "USD" } }))).toEqual([]);
  });

  it("allowed payees match by id first, otherwise by name and website together", () => {
    expect(merchantMatches({ id: "a" }, { id: "a", name: "x" })).toBe(true);
    expect(merchantMatches({ id: "a" }, { id: "b" })).toBe(false);
    expect(merchantMatches({ name: "N", website: "https://w" }, { name: "N", website: "https://w" })).toBe(true);
    expect(merchantMatches({ name: "N", website: "https://w" }, { name: "N", website: "https://other" })).toBe(false);
    expect(merchantMatches({ name: "", website: "" }, { name: "", website: "" })).toBe(false);
    expect(checkAp2PaymentConstraints(open(), closed({ payee: { id: "merchant_2", name: "Other", website: "https://o" } }))).toEqual(["Payee Other not in allowed list"]);
  });

  it("budget counts what was spent before, in minor units, and needs the context", () => {
    const o = open({ constraints: [{ type: "payment.amount_range", currency: "USD", max: 20000 }, { type: "payment.budget", max: 250, currency: "USD" }] });
    expect(checkAp2PaymentConstraints(o, closed())).toEqual(["Missing mandate context required to evaluate budget"]);
    expect(checkAp2PaymentConstraints(o, closed({ payment_amount: { amount: 10000, currency: "USD" } }), { totalAmountMinor: 15000 })).toEqual([]); // 25000 = exactly 250.00
    expect(checkAp2PaymentConstraints(o, closed({ payment_amount: { amount: 10001, currency: "USD" } }), { totalAmountMinor: 15000 })[0]).toMatch(/exceeds budget limit 25000/);
    expect(checkAp2PaymentConstraints(o, closed({ payment_amount: { amount: 100, currency: "EUR" } }), { totalAmountMinor: 0 }).some((v) => /Budget currency mismatch/.test(v))).toBe(true);
  });

  it("recurrence limits the number of uses, and needs an amount range and a budget alongside it", () => {
    const base = [{ type: "payment.amount_range", currency: "USD", max: 20000 }, { type: "payment.budget", max: 1000, currency: "USD" }, { type: "payment.agent_recurrence", frequency: "MONTHLY", max_occurrences: 2 }] as const;
    const o = open({ constraints: [...base] });
    expect(checkAp2PaymentConstraints(o, closed(), { totalAmountMinor: 0, totalUses: 1 })).toEqual([]);
    expect(checkAp2PaymentConstraints(o, closed(), { totalAmountMinor: 0, totalUses: 2 })).toEqual(["Maximum occurrences exceeded: 2 >= 2"]);
    expect(checkAp2PaymentConstraints(o, closed(), { totalAmountMinor: 0 })).toContain("Missing mandate context required to evaluate recurrence");
    const lonely = open({ constraints: [{ type: "payment.agent_recurrence", max_occurrences: 2 }] });
    const v = checkAp2PaymentConstraints(lonely, closed(), { totalUses: 0 });
    expect(v).toContain("payment.agent_recurrence requires payment.amount_range constraint");
    expect(v).toContain("payment.agent_recurrence requires payment.budget constraint");
  });

  it("instruments and payment providers must be on the lists", () => {
    const o = open({ constraints: [{ type: "payment.allowed_payment_instruments", allowed: [{ id: "card_1" }] }, { type: "payment.allowed_pisps", allowed: [{ legal_name: "Ex Ltd", brand_name: "Ex", domain_name: "ex.com" }] }] });
    expect(checkAp2PaymentConstraints(o, closed())).toEqual(["Payment instrument stub not in allowed list", "Missing PISP in closed mandate"]);
    const ok = closed({ payment_instrument: { id: "card_1" }, pisp: { legal_name: "Ex Ltd", brand_name: "Ex", domain_name: "ex.com" } });
    expect(checkAp2PaymentConstraints(o, ok)).toEqual([]);
    expect(checkAp2PaymentConstraints(o, closed({ payment_instrument: { id: "card_1" }, pisp: { legal_name: "Ex Ltd", brand_name: "Ex", domain_name: "evil.com" } }))).toEqual(["PISP not in allowed list"]);
  });

  it("the reference ties the payment to its checkout, and fails without the hash", () => {
    const o = open({ constraints: [{ type: "payment.reference", conditional_transaction_id: "HASH1" }] });
    expect(checkAp2PaymentConstraints(o, closed())).toEqual(["open_checkout_hash is required to evaluate PaymentReference constraints"]);
    expect(checkAp2PaymentConstraints(o, closed(), { openCheckoutHash: "HASH1" })).toEqual([]);
    expect(checkAp2PaymentConstraints(o, closed(), { openCheckoutHash: "HASH2" })[0]).toMatch(/mismatch/);
  });

  it("execution date must fall inside the window", () => {
    const o = open({ constraints: [{ type: "payment.execution_date", not_before: "2026-03-31T00:00:00Z", not_after: "2026-04-30T23:59:59Z" }] });
    expect(checkAp2PaymentConstraints(o, closed({ execution_date: "2026-04-15T00:00:00Z" }))).toEqual([]);
    expect(checkAp2PaymentConstraints(o, closed({ execution_date: "2026-03-01T00:00:00Z" }))[0]).toMatch(/before allowed window/);
    expect(checkAp2PaymentConstraints(o, closed({ execution_date: "2026-05-01T00:00:00Z" }))[0]).toMatch(/after allowed window/);
    expect(checkAp2PaymentConstraints(o, closed({ execution_date: "not a date" }))).toEqual(["Execution date is not a valid date"]);
  });

  it("an unknown constraint fails, as the specification requires", () => {
    const o = open({ constraints: [{ type: "payment.something_new", value: 1 }] });
    expect(checkAp2PaymentConstraints(o, closed())).toEqual(["Unknown constraint type: payment.something_new"]);
  });

  it("claims fixed in the open mandate must be unchanged in the closed one", () => {
    const o = open({ payee: merchant, payment_amount: { amount: 500, currency: "USD" } });
    const v = checkAp2PaymentConstraints(o, closed({ payee: { id: "merchant_9", name: "Else" } }));
    expect(v.some((x) => /Pre-set payee mismatch/.test(x))).toBe(true);
    expect(v).toContain("Pre-set amount mismatch");
  });

  it("refuses amounts that are not whole minor units, and the wrong mandate types", () => {
    expect(checkAp2PaymentConstraints(open(), closed({ payment_amount: { amount: 19.5, currency: "USD" } }))[0]).toMatch(/whole number/);
    expect(checkAp2PaymentConstraints(open(), closed({ payment_amount: { amount: -1, currency: "USD" } }))[0]).toMatch(/whole number/);
    expect(checkAp2PaymentConstraints(open({ vct: "mandate.payment.open.2" }), closed())[0]).toMatch(/Unexpected open mandate type/);
    expect(checkAp2PaymentConstraints(open(), closed({ vct: "mandate.checkout.1" }))[0]).toMatch(/Unexpected closed mandate type/);
  });

  it("checks the open mandate's own time window when the clock is given", () => {
    const o = open({ iat: 1000, exp: 2000 });
    expect(checkAp2PaymentConstraints(o, closed(), { nowSeconds: 1500 })).toEqual([]);
    expect(checkAp2PaymentConstraints(o, closed(), { nowSeconds: 2000 })).toEqual(["The open mandate has expired."]);
    expect(checkAp2PaymentConstraints(o, closed(), { nowSeconds: 999 })).toEqual(["The open mandate is not valid yet."]);
  });
});

describe("turning an AP2 mandate into limits for the x402 guard", () => {
  const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const WALLET = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
  const assets = [{ network: "eip155:84532", asset: USDC, symbol: "USDC", decimals: 6 }];
  const mandate = open({ exp: 4_000_000_000, constraints: [{ type: "payment.amount_range", currency: "USD", max: 500 }, { type: "payment.budget", max: 20, currency: "USD" }, { type: "payment.allowed_payees", allowed: [merchant] }] });

  it("maps amount, budget, payee and expiry, and the guard then enforces them", () => {
    const { policy, notEnforced } = ap2ToPolicy(mandate, { allowedAssets: assets, walletsByPayeeId: { merchant_1: [WALLET] }, allowedHosts: ["api.demo-merchant.example"] });
    expect(policy).toMatchObject({ maxPerPaymentUsd: 5, maxTotalUsd: 20, allowedRecipients: [WALLET], expiresAt: 4_000_000_000_000 });
    expect(notEnforced).toEqual([]);
    const g = createGuard(policy, { now: () => 1000 });
    const req = (amount: string) => ({ x402Version: 2, resource: { url: "https://api.demo-merchant.example/x" }, accepts: [{ scheme: "exact", network: "eip155:84532", amount, asset: USDC, payTo: WALLET, maxTimeoutSeconds: 60 }] });
    expect(g.evaluate(req("5000000"), { requestUrl: "https://api.demo-merchant.example/x" }).decision).toBe("allow"); // 5 dollars: at the limit
    expect(g.evaluate(req("5000001"), { requestUrl: "https://api.demo-merchant.example/x" }).decision).toBe("deny"); // one micro-dollar over
  });

  it("reports what it cannot enforce instead of silently dropping it", () => {
    const m = open({ constraints: [...mandate.constraints, { type: "payment.allowed_payment_instruments", allowed: [{ id: "c" }] }, { type: "payment.agent_recurrence", max_occurrences: 3 }] });
    const { notEnforced } = ap2ToPolicy(m, { allowedAssets: assets, walletsByPayeeId: { merchant_1: [WALLET] } });
    expect(notEnforced).toHaveLength(2);
  });

  it("refuses to make a policy that would be unlimited, unknown, or for the wrong currency", () => {
    expect(() => ap2ToPolicy(open({ constraints: [{ type: "payment.allowed_payees", allowed: [merchant] }] }), { allowedAssets: assets, walletsByPayeeId: { merchant_1: [WALLET] } })).toThrow(/no amount limit/);
    expect(() => ap2ToPolicy(mandate, { allowedAssets: assets, walletsByPayeeId: {} })).toThrow(/no payee with a known wallet/);
    expect(() => ap2ToPolicy(open({ constraints: [{ type: "payment.amount_range", currency: "EUR", max: 500 }] }), { allowedAssets: assets })).toThrow(/not USD/);
    expect(() => ap2ToPolicy(open({ constraints: [{ type: "payment.future_thing" }] }), { allowedAssets: assets })).toThrow(/Unknown constraint type/);
  });

  it("the earliest end date wins between the token's expiry and the execution window", () => {
    const m = open({ exp: 4_000_000_000, constraints: [...mandate.constraints, { type: "payment.execution_date", not_after: "2030-01-01T00:00:00Z" }] });
    const { policy } = ap2ToPolicy(m, { allowedAssets: assets, walletsByPayeeId: { merchant_1: [WALLET] } });
    expect(policy.expiresAt).toBe(Date.parse("2030-01-01T00:00:00Z"));
  });
});
