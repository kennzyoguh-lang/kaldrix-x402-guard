import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { choosePermission, createGuard, encodePaymentHeader, guardedFetch, GuardDenied, KaldrixAuthority, leafBlockId, paymentNumber, privateKeyFromSeed, proofMessage, publicHex, signProof, type KaldrixToken, type PaymentPayload, type PaymentRequirement, type Policy } from "../src/index";

const SEED = "11".repeat(32);
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:84532";
const WALLET = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const URL_OK = "https://api.example.com/data";
const AGENT_PUB = "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";

const token = (over: Partial<{ id: string; recipients: string[]; purpose: string | null; max: number; expires: number | null; subjectKey: string }> = {}): KaldrixToken => ({
  id: over.id ?? "tok_demo_1",
  blocks: [{ signature: "ab".repeat(64), grant: { subject: "my-agent", subject_key: over.subjectKey ?? AGENT_PUB, scope: { resources: (over.recipients ?? ["acme"]).map((r) => ({ exact: `payments:recipient:${r}` })), purpose: over.purpose === undefined ? "supplier_payment" : over.purpose, spend: { max_minor: over.max ?? 100000 }, expires_at_ms: over.expires === undefined ? null : over.expires } } }],
});

describe("proofs match the reference implementation byte for byte", () => {
  // Values produced by kaldrix_connect/proof.py with seed 0x11 repeated, a fixed nonce and a fixed time.
  const nonce = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const at = 1_777_000_000_123;
  it("derives the same public key and block name", () => {
    expect(publicHex(privateKeyFromSeed(SEED))).toBe(AGENT_PUB);
    expect(leafBlockId(token())).toBe("ec65c8798ecf95902413c40f");
  });
  it("builds the same message and the same signature", () => {
    const msg = proofMessage(token(), "payments:recipient:acme", "supplier_payment", 1999, "USD", nonce, at);
    expect(msg.toString("hex")).toBe(
      "00000000000000146b616c647269782e746f6b656e2e7573652e7632000000000000000a746f6b5f64656d6f5f31000000000000001865633635633837393865636639353930323431336334306600000000000000117061796d656e74732e696e69746961746500000000000000177061796d656e74733a726563697069656e743a61636d65010000000000000010737570706c6965725f7061796d656e7401000000000000000355534400000000000007cf000000000000001000112233445566778899aabbccddeeff0000019dbd742a7b",
    );
    const p = signProof(privateKeyFromSeed(SEED), token(), "acme", "supplier_payment", 1999, "USD", at, nonce);
    expect(p.signature).toBe("3353eacd36c297efa156276b00d8ec4394b6af72b841b19387237318feb401d0e4979b2730d5477eb9ca737b6245f92514dcf468b7a4fb36eec908a20f9d1006");
  });
  it("a fresh proof verifies against the agent's public key and is different every time", () => {
    const key = privateKeyFromSeed(SEED);
    const a = signProof(key, token(), "acme", "supplier_payment", 500);
    const b = signProof(key, token(), "acme", "supplier_payment", 500);
    expect(a.nonce).not.toBe(b.nonce);
    const msg = proofMessage(token(), "payments:recipient:acme", "supplier_payment", 500, "USD", Buffer.from(a.nonce, "hex"), a.issued_at_ms);
    const pub = createPublicKey(key);
    expect(verify(null, msg, pub, Buffer.from(a.signature, "hex"))).toBe(true);
    expect(verify(null, proofMessage(token(), "payments:recipient:acme", "supplier_payment", 501, "USD", Buffer.from(a.nonce, "hex"), a.issued_at_ms), pub, Buffer.from(a.signature, "hex"))).toBe(false);
  });
  it("refuses a bad seed and a non-whole amount", () => {
    expect(() => privateKeyFromSeed("abc")).toThrow();
    expect(() => proofMessage(token(), "r", null, 1.5, "USD", nonce, at)).toThrow();
  });
  it("payment numbers match the reference", () => {
    expect(paymentNumber("acme", 1999, "supplier_payment", "x402:https://api.example.com/data:attempt-1")).toBe("inv-8b3c87f82c526de0a99fb671");
  });
});

describe("choosing a permission", () => {
  const pick = (t: KaldrixToken[], over: Partial<{ recipient: string; purpose: string; cents: number; now: number }> = {}) => choosePermission(t, AGENT_PUB, over.recipient ?? "acme", over.purpose ?? "supplier_payment", over.cents ?? 1000, over.now ?? 1_000);
  it("picks one that fits", () => expect(pick([token()]).token?.id).toBe("tok_demo_1"));
  it("explains each way a permission does not fit", () => {
    expect(pick([token({ subjectKey: "ff".repeat(32) })]).why[0]).toMatch(/different agent key/);
    expect(pick([token({ expires: 500 })]).why[0]).toMatch(/expired/);
    expect(pick([token({ recipients: ["other"] })]).why[0]).toMatch(/does not name that supplier/);
    expect(pick([token()], { purpose: "payroll" }).why[0]).toMatch(/is for supplier_payment, not payroll/);
    expect(pick([token({ max: 500 })], { cents: 501 }).why[0]).toMatch(/at most 500 cents/);
    expect(pick([]).token).toBeNull();
  });
});

describe("the Kaldrix authority", () => {
  const requirement = (over: Partial<PaymentRequirement> = {}): PaymentRequirement => ({ scheme: "exact", network: NET, amount: "10000", asset: USDC, payTo: WALLET, maxTimeoutSeconds: 60, ...over });
  const recorder = (responses: Array<Response | Error>) => {
    const calls: Array<{ url: string; init: RequestInit; body?: any }> = [];
    let i = 0;
    const f = (async (url: string, init: RequestInit = {}) => {
      const call: { url: string; init: RequestInit; body?: any } = { url: String(url), init };
      if (typeof init.body === "string") call.body = JSON.parse(init.body);
      calls.push(call);
      if (String(url).endsWith("/api/health")) return new Response("{}", { status: 200, headers: { date: new Date(1_777_000_000_000).toUTCString() } });
      const r = responses[Math.min(i++, responses.length - 1)]!;
      if (r instanceof Error) throw r;
      return r.clone();
    }) as unknown as typeof fetch;
    return { f, calls };
  };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const paid = (extra: Record<string, unknown> = {}) => json({ stage: "payment_submitted", payment: { transaction: { id: "txn_1", state: "successful" }, replay: false }, proof_envelope: { signed: "yes" }, correlation_id: "corr_1", ...extra }, 201);
  const make = (f: typeof fetch, over: Partial<ConstructorParameters<typeof KaldrixAuthority>[0]> = {}) =>
    new KaldrixAuthority({ baseUrl: "https://kaldrix.example.invalid/", agentKey: "agent-key-for-tests-only", agentSeedHex: SEED, permissions: [token()], recipientByWallet: { [WALLET]: "acme" }, fetch: f, now: () => 1_777_000_000_000, ...over });
  const ask = (a: KaldrixAuthority, r = requirement(), usdMicro = 10000n) => a.authorize({ requirement: r, usdMicro, resourceUrl: URL_OK, attemptId: "attempt-1" });

  it("sends a real, signed, one-payment request and returns the proof", async () => {
    const { f, calls } = recorder([paid()]);
    const r = await ask(make(f));
    expect(r).toMatchObject({ decision: "allow", transactionId: "txn_1", envelope: { signed: "yes" } });
    const pay = calls.find((c) => c.url.endsWith("/api/v1/authorized-payments"))!;
    expect(pay.url).toBe("https://kaldrix.example.invalid/api/v1/authorized-payments");
    expect((pay.init.headers as Record<string, string>).authorization).toBe("Bearer agent-key-for-tests-only");
    expect(pay.body.presenter).toBe("my-agent");
    expect(pay.body.intent).toMatchObject({ amount_minor: 1, currency: "USD", recipient: "acme", purpose: "supplier_payment" });
    expect(pay.body.proof.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(pay.body.intent.idempotency_key).toMatch(/^inv-[0-9a-f]{24}$/);
  });

  it("sends a reference the service accepts: short, plain characters only, whatever the web address looks like", async () => {
    const { f, calls } = recorder([paid()]);
    await make(f).authorize({ requirement: requirement(), usdMicro: 10000n, resourceUrl: "https://api.example.com/a b/c?token=1&x=é#frag", attemptId: "attempt-é" });
    const intent = calls.find((c) => c.body?.intent)!.body.intent;
    expect(intent.client_reference).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
    expect(intent.idempotency_key).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
    expect(intent.recipient).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  });

  it("converts to cents rounding UP, so a payment is never under-counted", async () => {
    const { f, calls } = recorder([paid()]);
    await ask(make(f), requirement(), 10001n); // 1.0001 cents
    expect(calls.find((c) => c.body?.intent)!.body.intent.amount_minor).toBe(2);
  });

  it("uses the service's clock, not this computer's, for the proof", async () => {
    const { f, calls } = recorder([paid()]);
    await ask(make(f, { now: () => 1_000 })); // this computer's clock is far behind the service's
    expect(calls.find((c) => c.body?.proof)!.body.proof.issued_at_ms).toBeGreaterThan(1_776_000_000_000);
  });

  it("never pays a wallet it does not know, and does not even call Kaldrix", async () => {
    const { f, calls } = recorder([paid()]);
    const r = await ask(make(f), requirement({ payTo: "0x000000000000000000000000000000000000dEaD" }));
    expect(r).toMatchObject({ decision: "deny", reason: "recipient_not_known" });
    expect(calls.some((c) => c.url.endsWith("authorized-payments"))).toBe(false);
  });

  it("does not call Kaldrix when no permission fits", async () => {
    const { f, calls } = recorder([paid()]);
    const r = await ask(make(f, { permissions: [token({ max: 0 })] }), requirement(), 5_000_000n); // 5 dollars against a 0 limit
    expect(r).toMatchObject({ decision: "deny", reason: "no_matching_permission" });
    expect(calls.some((c) => c.url.endsWith("authorized-payments"))).toBe(false);
  });

  it("turns Kaldrix's answers into decisions", async () => {
    expect(await ask(make(recorder([json({ stage: "authorization_denied", authorization: { reason_code: "over_limit", detail: "Over the limit." } }, 403)]).f))).toEqual({ decision: "deny", reason: "over_limit", explanation: "Over the limit." });
    expect(await ask(make(recorder([json({ stage: "approval_required", approval_id: "appr_1", message: "A person must approve." }, 202)]).f))).toEqual({ decision: "needs_approval", approvalId: "appr_1", message: "A person must approve." });
    expect(await ask(make(recorder([json({ stage: "approval_denied", reason: "no thanks" }, 403)]).f))).toMatchObject({ decision: "deny", reason: "approval_denied" });
    expect(await ask(make(recorder([paid({ payment: { transaction: { id: "t", state: "successful" }, replay: true } })]).f))).toMatchObject({ decision: "deny", reason: "replayed" });
    expect(await ask(make(recorder([paid({ payment: { transaction: { id: "t", state: "rejected", reject_code: "bad_account", detail: "No such account." }, replay: false } })]).f))).toMatchObject({ decision: "deny", reason: "bad_account" });
  });

  it("fails closed: if Kaldrix is unreachable or answers nonsense, nothing is authorised", async () => {
    expect(await ask(make(recorder([new Error("connection refused")]).f))).toMatchObject({ decision: "deny", reason: "unreachable" });
    expect(await ask(make(recorder([new Response("<html>oops</html>", { status: 502 })]).f))).toMatchObject({ decision: "deny" });
    expect(await ask(make(recorder([json({ stage: "something_new" })]).f))).toMatchObject({ decision: "deny" });
    expect(await ask(make(recorder([json({ error: { code: "invalid_key", message: "Key not accepted." } }, 401)]).f))).toMatchObject({ decision: "deny", reason: "invalid_key" });
  });
});

describe("the guard with Kaldrix in front of the signer", () => {
  const policy: Policy = { allowedAssets: [{ network: NET, asset: USDC, symbol: "USDC", decimals: 6 }], allowedRecipients: [WALLET], allowedHosts: ["api.example.com"], maxPerPaymentUsd: 5, maxTimeoutSeconds: 120, duplicateWindowMs: 0 };
  const requirement: PaymentRequirement = { scheme: "exact", network: NET, amount: "10000", asset: USDC, payTo: WALLET, maxTimeoutSeconds: 60 };
  const server = () => {
    const calls: Array<{ paid: boolean }> = [];
    const f = (async (_u: string | URL, init?: RequestInit) => {
      const paid = new Headers(init?.headers).has("payment-signature");
      calls.push({ paid });
      return paid ? new Response("content", { status: 200 }) : new Response("{}", { status: 402, headers: { "payment-required": encodePaymentHeader({ x402Version: 2, resource: { url: URL_OK }, accepts: [requirement] }) } });
    }) as typeof fetch;
    return { f, calls };
  };
  const signer = (log: string[]) => async (r: PaymentRequirement): Promise<PaymentPayload> => {
    log.push("signed");
    return { x402Version: 2, accepted: r, payload: { signature: "0xsig", authorization: { from: PAYER, to: r.payTo, value: r.amount, validAfter: "1740672089", validBefore: "1740672154", nonce: "0x" + "ab".repeat(32) } } };
  };
  const authority = (answers: Array<Awaited<ReturnType<KaldrixAuthority["authorize"]>>>) => {
    const asked: string[] = [];
    let i = 0;
    return { asked, authority: { authorize: async (info: { attemptId: string }) => (asked.push(info.attemptId), answers[Math.min(i++, answers.length - 1)]!) } };
  };
  const allow = { decision: "allow" as const, transactionId: "txn_1", envelope: { signed: "yes" } };

  it("signs and pays only after Kaldrix says yes, and hands back the proof", async () => {
    const s = server();
    const log: string[] = [];
    const a = authority([allow]);
    const got: unknown[] = [];
    const res = await guardedFetch(s.f, createGuard(policy), signer(log), { authority: a.authority, onAuthorized: (i) => got.push(i) })(URL_OK);
    expect(res.status).toBe(200);
    expect(log).toEqual(["signed"]);
    expect(got).toEqual([{ requirement, transactionId: "txn_1", envelope: { signed: "yes" } }]);
  });

  it("when Kaldrix refuses, nothing is signed and nothing is sent", async () => {
    const s = server();
    const log: string[] = [];
    await expect(guardedFetch(s.f, createGuard(policy), signer(log), { authority: authority([{ decision: "deny", reason: "over_limit", explanation: "Over the limit." }]).authority })(URL_OK)).rejects.toThrow(/refused by Kaldrix/);
    expect(log).toEqual([]);
    expect(s.calls.some((c) => c.paid)).toBe(false);
  });

  it("asks a person when Kaldrix says so, then asks Kaldrix again about the SAME payment", async () => {
    const s = server();
    const log: string[] = [];
    const a = authority([{ decision: "needs_approval", approvalId: "appr_1", message: "A person must approve." }, allow]);
    const infos: string[] = [];
    const res = await guardedFetch(s.f, createGuard(policy), signer(log), { authority: a.authority, approve: async (i) => (infos.push(`${i.source}:${i.approvalId}`), true) })(URL_OK);
    expect(res.status).toBe(200);
    expect(infos).toEqual(["kaldrix:appr_1"]);
    expect(a.asked).toHaveLength(2);
    expect(a.asked[0]).toBe(a.asked[1]); // same attempt, so Kaldrix treats it as the payment that was waiting
    expect(log).toEqual(["signed"]);
  });

  it("refuses when the person says no, or when nobody is there to ask", async () => {
    for (const approve of [async () => false, undefined]) {
      const s = server();
      const log: string[] = [];
      const a = authority([{ decision: "needs_approval", approvalId: "appr_1", message: "A person must approve." }]);
      await expect(guardedFetch(s.f, createGuard(policy), signer(log), { authority: a.authority, ...(approve ? { approve } : {}) })(URL_OK)).rejects.toBeInstanceOf(GuardDenied);
      expect(log).toEqual([]);
    }
  });

  it("refuses if the approval is still not recorded when asked again", async () => {
    const s = server();
    const log: string[] = [];
    const wait = { decision: "needs_approval" as const, approvalId: "appr_1", message: "A person must approve." };
    await expect(guardedFetch(s.f, createGuard(policy), signer(log), { authority: authority([wait, wait]).authority, approve: async () => true })(URL_OK)).rejects.toThrow(/not recorded yet/);
    expect(log).toEqual([]);
  });

  it("the local rules still apply first: Kaldrix is never asked about a payment the local policy refuses", async () => {
    const s = server();
    const a = authority([allow]);
    await expect(guardedFetch(s.f, createGuard({ ...policy, allowedRecipients: ["0x000000000000000000000000000000000000dEaD"] }), signer([]), { authority: a.authority })(URL_OK)).rejects.toBeInstanceOf(GuardDenied);
    expect(a.asked).toHaveLength(0);
  });

  it("a refusal gives back the local reservation, so a later legitimate payment is not blocked", async () => {
    const g = createGuard({ ...policy, maxTotalUsd: 0.01 });
    const s = server();
    await expect(guardedFetch(s.f, g, signer([]), { authority: authority([{ decision: "deny", reason: "x", explanation: "no" }]).authority })(URL_OK)).rejects.toBeInstanceOf(GuardDenied);
    expect(g.ledger.total()).toBe(0n);
    const res = await guardedFetch(server().f, g, signer([]), { authority: authority([allow]).authority })(URL_OK);
    expect(res.status).toBe(200);
  });
});
