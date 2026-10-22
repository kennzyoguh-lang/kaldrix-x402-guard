import { describe, expect, it } from "vitest";
import { createGuard, decodePaymentRequiredHeader, DecodeError, encodePaymentHeader, guardedFetch, GuardDenied, MemoryLedger, normalisePaymentRequired, type PaymentPayload, type PaymentRequired, type PaymentRequirement, type Policy } from "../src/index";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:84532";
const PAYEE = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const URL_OK = "https://api.example.com/premium-data";

const policy = (over: Partial<Policy> = {}): Policy => ({
  allowedAssets: [{ network: NET, asset: USDC, symbol: "USDC", decimals: 6 }],
  allowedRecipients: [PAYEE],
  allowedHosts: ["api.example.com"],
  maxPerPaymentUsd: 1,
  maxTotalUsd: 2,
  maxTimeoutSeconds: 120,
  ...over,
});

const req = (over: Partial<PaymentRequirement> = {}): PaymentRequirement => ({ scheme: "exact", network: NET, amount: "10000", asset: USDC, payTo: PAYEE, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" }, ...over });
const required = (accepts: PaymentRequirement[] = [req()], resourceUrl = URL_OK): PaymentRequired => ({ x402Version: 2, resource: { url: resourceUrl }, accepts });

const signedFor = (r: PaymentRequirement, over: { amount?: string; to?: string; from?: string; before?: string; after?: string } = {}): PaymentPayload => ({
  x402Version: 2,
  accepted: { ...r, amount: over.amount ?? r.amount },
  payload: { signature: "0xsig", authorization: { from: over.from ?? PAYER, to: over.to ?? r.payTo, value: over.amount ?? r.amount, validAfter: over.after ?? "1740672089", validBefore: over.before ?? "1740672154", nonce: "0x" + "ab".repeat(32) } },
});

describe("reading payment requests", () => {
  it("reads the version 2 header and rounds nothing", () => {
    const b64 = encodePaymentHeader(required());
    const r = decodePaymentRequiredHeader(b64);
    expect(r.accepts[0]).toMatchObject({ amount: "10000", payTo: PAYEE, network: NET });
    expect(r.resource?.url).toBe(URL_OK);
  });

  it("reads version 1, where the amount was called maxAmountRequired", () => {
    const r = normalisePaymentRequired({ x402Version: 1, accepts: [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", asset: USDC, payTo: PAYEE, resource: URL_OK }] });
    expect(r.accepts[0]!.amount).toBe("10000");
    expect(r.x402Version).toBe(1);
  });

  it("refuses messages that are not clearly payment requests", () => {
    for (const bad of [null, "text", {}, { accepts: [] }, { x402Version: 9, accepts: [{}] }, { accepts: [{ scheme: "exact", network: NET, amount: "1.5", asset: USDC, payTo: PAYEE }] }, { accepts: [{ scheme: "exact", network: NET, amount: "-5", asset: USDC, payTo: PAYEE }] }, { accepts: [{ scheme: "exact", network: NET, amount: "5", asset: USDC }] }]) {
      expect(() => normalisePaymentRequired(bad), JSON.stringify(bad)).toThrow(DecodeError);
    }
    expect(() => decodePaymentRequiredHeader("%%%not base64 json%%%")).toThrow(DecodeError);
    expect(() => normalisePaymentRequired({ accepts: Array.from({ length: 21 }, () => req()) })).toThrow(/too many/);
  });
});

describe("the policy decides before anything is signed", () => {
  it("allows a payment inside every limit", () => {
    const d = createGuard(policy()).evaluate(required(), { requestUrl: URL_OK });
    expect(d.decision).toBe("allow");
    if (d.decision === "allow") expect(d.usdMicro).toBe(10000n); // 0.01 dollars
  });

  it("refuses the wrong recipient, token, network and method, each with its own reason", () => {
    const g = () => createGuard(policy());
    const code = (r: PaymentRequirement) => {
      const d = g().evaluate(required([r]), { requestUrl: URL_OK });
      return d.decision === "deny" ? d.reasons.map((x) => x.code) : ["ALLOWED"];
    };
    expect(code(req({ payTo: "0x000000000000000000000000000000000000dEaD" }))).toContain("recipient_not_allowed");
    expect(code(req({ asset: "0x1111111111111111111111111111111111111111" }))).toContain("asset_not_allowed");
    expect(code(req({ network: "eip155:1" }))).toContain("asset_not_allowed");
    expect(code(req({ scheme: "upto" }))).toContain("scheme_not_allowed");
  });

  it("compares addresses without regard to upper or lower case", () => {
    const d = createGuard(policy()).evaluate(required([req({ payTo: PAYEE.toLowerCase(), asset: USDC.toLowerCase() })]), { requestUrl: URL_OK });
    expect(d.decision).toBe("allow");
  });

  it("refuses an amount over the per-payment limit, including one cent over", () => {
    const g = createGuard(policy({ maxPerPaymentUsd: 1 }));
    expect(g.evaluate(required([req({ amount: "1000000" })]), { requestUrl: URL_OK }).decision).toBe("allow"); // exactly 1 dollar
    g.release("res_x");
    const over = createGuard(policy({ maxPerPaymentUsd: 1 })).evaluate(required([req({ amount: "1000001" })]), { requestUrl: URL_OK });
    expect(over.decision).toBe("deny");
    if (over.decision === "deny") expect(over.reasons[0]!.code).toBe("over_per_payment_limit");
  });

  it("rounds up, so a tiny fraction cannot slip under a limit", () => {
    const p = policy({ allowedAssets: [{ network: NET, asset: USDC, symbol: "X", decimals: 18, usdMicroPerToken: 1_000_000 }], maxPerPaymentUsd: 0.000001 });
    expect(createGuard(p).evaluate(required([req({ amount: "1000000000000" })]), { requestUrl: URL_OK }).decision).toBe("allow"); // 1e12 / 1e18 = 1e-6 dollars
    expect(createGuard(p).evaluate(required([req({ amount: "1000000000001" })]), { requestUrl: URL_OK }).decision).toBe("deny"); // just over
  });

  it("refuses a zero amount", () => {
    const d = createGuard(policy()).evaluate(required([req({ amount: "0" })]), { requestUrl: URL_OK });
    expect(d.decision).toBe("deny");
  });

  it("enforces a total cap across payments, and gives the money back if a payment is released", () => {
    const g = createGuard(policy({ maxTotalUsd: 0.03, duplicateWindowMs: 0 }));
    const pay = (amt: string) => g.evaluate(required([req({ amount: amt })]), { requestUrl: URL_OK });
    const a = pay("10000");
    const b = pay("10000");
    const c = pay("10000");
    expect([a.decision, b.decision, c.decision]).toEqual(["allow", "allow", "allow"]);
    const d = pay("10000");
    expect(d.decision).toBe("deny");
    if (b.decision === "allow") g.release(b.reservationId);
    expect(pay("10000").decision).toBe("allow");
  });

  it("enforces a speed limit over a window", () => {
    let t = 1_000_000;
    const g = createGuard(policy({ maxTotalUsd: undefined, duplicateWindowMs: 0, speed: { windowMs: 60_000, maxUsd: 0.02 } }), { now: () => t });
    const pay = () => g.evaluate(required(), { requestUrl: URL_OK }).decision;
    expect([pay(), pay(), pay()]).toEqual(["allow", "allow", "deny"]);
    t += 61_000;
    expect(pay()).toBe("allow");
  });

  it("refuses an identical payment made twice in a row, but not after it is released", () => {
    const g = createGuard(policy({ maxTotalUsd: undefined }));
    const first = g.evaluate(required(), { requestUrl: URL_OK });
    const second = g.evaluate(required(), { requestUrl: URL_OK });
    expect(first.decision).toBe("allow");
    expect(second.decision).toBe("deny");
    if (second.decision === "deny") expect(second.reasons.map((r) => r.code)).toContain("duplicate");
    if (first.decision === "allow") g.release(first.reservationId);
    expect(g.evaluate(required(), { requestUrl: URL_OK }).decision).toBe("allow");
  });

  it("refuses websites that are not on the permission, from either the request or the claimed resource", () => {
    const g = () => createGuard(policy({ allowedHosts: ["*.example.com"] }));
    expect(g().evaluate(required(), { requestUrl: "https://api.example.com/x" }).decision).toBe("allow");
    expect(g().evaluate(required(), { requestUrl: "https://evil.example.net/x" }).decision).toBe("deny");
    expect(g().evaluate(required([req()], "https://evil.example.net/steal"), { requestUrl: "https://api.example.com/x" }).decision).toBe("deny");
    expect(g().evaluate(required([req()], "https://example.com.evil.net/x"), { requestUrl: "https://api.example.com/x" }).decision).toBe("deny");
    expect(g().evaluate({ x402Version: 2, accepts: [req()] }, {}).decision).toBe("deny"); // cannot tell who is asking
  });

  it("refuses a payment that would stay valid too long, or a request that does not say", () => {
    const g = () => createGuard(policy({ maxTimeoutSeconds: 60 }));
    expect(g().evaluate(required([req({ maxTimeoutSeconds: 600 })]), { requestUrl: URL_OK }).decision).toBe("deny");
    const noTimeout = req();
    delete noTimeout.maxTimeoutSeconds;
    expect(g().evaluate(required([noTimeout]), { requestUrl: URL_OK }).decision).toBe("deny");
  });

  it("holds large payments for a person", () => {
    const d = createGuard(policy({ requireApprovalAboveUsd: 0.005 })).evaluate(required(), { requestUrl: URL_OK });
    expect(d.decision).toBe("needs_approval");
  });

  it("refuses everything after the permission expires", () => {
    const d = createGuard(policy({ expiresAt: 5000 }), { now: () => 5000 }).evaluate(required(), { requestUrl: URL_OK });
    expect(d.decision).toBe("deny");
  });

  it("picks the cheapest acceptable option and ignores the ones that break the rules", () => {
    const d = createGuard(policy()).evaluate(required([req({ amount: "900000" }), req({ payTo: "0x000000000000000000000000000000000000dEaD", amount: "1" }), req({ amount: "20000" })]), { requestUrl: URL_OK });
    expect(d.decision).toBe("allow");
    if (d.decision === "allow") expect(d.requirement.amount).toBe("20000");
  });

  it("refuses a policy that is nonsense", () => {
    expect(() => createGuard(policy({ maxPerPaymentUsd: -1 }))).toThrow(/Invalid policy/);
    expect(() => createGuard(policy({ allowedRecipients: [] }))).toThrow(/Invalid policy/);
    expect(() => createGuard(policy({ allowedAssets: [] }))).toThrow(/Invalid policy/);
    expect(() => createGuard(policy({ maxPerPaymentUsd: Number.NaN }))).toThrow(/Invalid policy/);
  });
});

describe("what was signed must be what was approved", () => {
  const g = () => createGuard(policy({ payerAddress: PAYER }));
  it("accepts a faithful signature", () => expect(g().verifySigned(req(), signedFor(req()))).toEqual([]));
  it("catches a changed amount, both in the option and in the authorisation", () => {
    const codes = g().verifySigned(req(), signedFor(req(), { amount: "5000000" })).map((r) => r.code);
    expect(codes).toContain("signed_amount_changed");
    expect(codes).toContain("authorisation_amount");
  });
  it("catches a changed recipient, even if the option looks right", () => {
    const sneaky = signedFor(req());
    sneaky.payload.authorization!.to = "0x000000000000000000000000000000000000dEaD";
    expect(g().verifySigned(req(), sneaky).map((r) => r.code)).toContain("authorisation_recipient");
    expect(g().verifySigned(req(), signedFor(req(), { to: "0x000000000000000000000000000000000000dEaD" })).length).toBeGreaterThan(0);
  });
  it("catches a different paying wallet and a too-long validity window", () => {
    expect(g().verifySigned(req(), signedFor(req(), { from: "0x1111111111111111111111111111111111111111" })).map((r) => r.code)).toContain("authorisation_payer");
    expect(g().verifySigned(req(), signedFor(req(), { before: "1740699999" })).map((r) => r.code)).toContain("authorisation_too_long");
    expect(g().verifySigned(req(), signedFor(req(), { before: "1740672000" })).map((r) => r.code)).toContain("authorisation_window");
  });
  it("catches a different token or network", () => {
    const p = signedFor(req());
    p.accepted.asset = "0x1111111111111111111111111111111111111111";
    p.accepted.network = "eip155:1";
    const codes = g().verifySigned(req(), p).map((r) => r.code);
    expect(codes).toContain("signed_asset_changed");
    expect(codes).toContain("signed_method_changed");
  });
});

describe("the fetch wrapper", () => {
  const paidBody = "paid content";
  const makeFetch = (opts: { v1?: boolean; alwaysFail?: boolean; resource?: string } = {}) => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const f = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), headers });
      const paid = headers.has("payment-signature") || headers.has("x-payment");
      if (paid && !opts.alwaysFail) return new Response(paidBody, { status: 200 });
      const rq = required([req()], opts.resource ?? URL_OK);
      if (opts.v1) return new Response(JSON.stringify({ x402Version: 1, accepts: [{ ...req(), maxAmountRequired: "10000", amount: undefined, resource: URL_OK }] }), { status: 402, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 402, headers: { "payment-required": encodePaymentHeader(rq) } });
    }) as typeof fetch;
    return { f, calls };
  };
  const goodSigner = async (r: PaymentRequirement) => signedFor(r);

  it("passes through anything that is not a 402, without asking the guard", async () => {
    const f = (async () => new Response("free", { status: 200 })) as typeof fetch;
    let signed = 0;
    const res = await guardedFetch(f, createGuard(policy()), async (r) => { signed++; return signedFor(r); })(URL_OK);
    expect(await res.text()).toBe("free");
    expect(signed).toBe(0);
  });

  it("pays inside the limits: reads, checks, signs once, sends the signature, and counts it", async () => {
    const { f, calls } = makeFetch();
    const guard = createGuard(policy());
    let signed = 0;
    const res = await guardedFetch(f, guard, async (r) => { signed++; return goodSigner(r); })(URL_OK);
    expect(await res.text()).toBe(paidBody);
    expect(signed).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get("payment-signature")).toBeTruthy();
    expect(guard.ledger.total()).toBe(10000n);
  });

  it("uses the version 1 header name for a version 1 server", async () => {
    const { f, calls } = makeFetch({ v1: true });
    const res = await guardedFetch(f, createGuard(policy()), goodSigner)(URL_OK);
    expect(res.status).toBe(200);
    expect(calls[1]!.headers.get("x-payment")).toBeTruthy();
  });

  it("never calls the signer for a payment the policy refuses", async () => {
    const { f, calls } = makeFetch();
    let signed = 0;
    const g = createGuard(policy({ allowedRecipients: ["0x000000000000000000000000000000000000dEaD"] }));
    await expect(guardedFetch(f, g, async (r) => { signed++; return signedFor(r); })(URL_OK)).rejects.toBeInstanceOf(GuardDenied);
    expect(signed).toBe(0);
    expect(calls).toHaveLength(1); // the request was never retried with a payment
  });

  it("refuses a server that claims to be a different website than the one asked", async () => {
    const { f } = makeFetch({ resource: "https://evil.example.net/x" });
    let signed = 0;
    await expect(guardedFetch(f, createGuard(policy()), async (r) => { signed++; return signedFor(r); })(URL_OK)).rejects.toBeInstanceOf(GuardDenied);
    expect(signed).toBe(0);
  });

  it("blocks a signer that changed the amount, and never sends the payment", async () => {
    const { f, calls } = makeFetch();
    const guard = createGuard(policy());
    await expect(guardedFetch(f, guard, async (r) => signedFor(r, { amount: "900000" }))(URL_OK)).rejects.toThrow(/not what was approved/);
    expect(calls).toHaveLength(1);
    expect(guard.ledger.total()).toBe(0n); // reservation given back
  });

  it("holds a large payment for a person and respects the answer", async () => {
    const strict = () => createGuard(policy({ requireApprovalAboveUsd: 0.005 }));
    const no = makeFetch();
    await expect(guardedFetch(no.f, strict(), goodSigner)(URL_OK)).rejects.toBeInstanceOf(GuardDenied); // nobody to ask: refused
    const refuse = makeFetch();
    await expect(guardedFetch(refuse.f, strict(), goodSigner, { approve: async () => false })(URL_OK)).rejects.toBeInstanceOf(GuardDenied);
    const yes = makeFetch();
    const res = await guardedFetch(yes.f, strict(), goodSigner, { approve: async () => true })(URL_OK);
    expect(res.status).toBe(200);
  });

  it("gives the money back if the signer fails or the server still says 402", async () => {
    const g1 = createGuard(policy());
    await expect(guardedFetch(makeFetch().f, g1, async () => { throw new Error("wallet offline"); })(URL_OK)).rejects.toThrow("wallet offline");
    expect(g1.ledger.total()).toBe(0n);
    const g2 = createGuard(policy());
    const res = await guardedFetch(makeFetch({ alwaysFail: true }).f, g2, goodSigner)(URL_OK);
    expect(res.status).toBe(402);
    expect(g2.ledger.total()).toBe(0n);
  });

  it("keeps counting a payment if the network failed after sending it, because it may have gone through", async () => {
    let n = 0;
    const f = (async (_u: string | URL, init?: RequestInit) => {
      n++;
      if (n === 1) return new Response("{}", { status: 402, headers: { "payment-required": encodePaymentHeader(required()) } });
      void init;
      throw new Error("connection dropped");
    }) as typeof fetch;
    const g = createGuard(policy());
    await expect(guardedFetch(f, g, goodSigner)(URL_OK)).rejects.toThrow("connection dropped");
    expect(g.ledger.total()).toBe(10000n);
  });

  it("stops an agent from draining its budget by looping", async () => {
    const g = createGuard(policy({ maxTotalUsd: 0.05, duplicateWindowMs: 0 }));
    const paid = [];
    for (let i = 0; i < 20; i++) {
      try {
        await guardedFetch(makeFetch().f, g, goodSigner)(URL_OK);
        paid.push(i);
      } catch (e) {
        expect(e).toBeInstanceOf(GuardDenied);
      }
    }
    expect(paid).toHaveLength(5); // 5 x 0.01 = the 0.05 cap, then refused
    expect(g.ledger.total()).toBe(50000n);
  });
});

describe("the ledger", () => {
  it("adds up what is reserved or confirmed and forgets what is released", () => {
    const l = new MemoryLedger();
    l.reserve("a", 10, 5n, "k");
    l.reserve("b", 20, 7n, "k2");
    l.confirm("a");
    expect(l.total()).toBe(12n);
    expect(l.since(15)).toBe(7n);
    l.release("b");
    expect(l.total()).toBe(5n);
  });
});
