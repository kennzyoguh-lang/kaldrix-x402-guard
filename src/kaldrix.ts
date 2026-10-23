/**
 * Kaldrix as the authority for an x402 payment.
 *
 * Before the agent signs an x402 payment, this asks the Kaldrix service whether a signed permission the agent holds
 * allows it. Kaldrix then does what it always does: checks the exact amount, supplier and purpose against the
 * permission, counts the spend against the total cap, asks a person to approve large payments, and returns a signed
 * proof of what was authorised. The proof format is the published Kaldrix "proof of possession"; this file is checked
 * against bytes produced by the reference implementation.
 *
 * Honest limits: in the Kaldrix test service the authorised payment goes to a PRETEND bank. For x402 that stands in
 * for the real on-chain payment that follows: Kaldrix decides and records, and this library then lets the agent
 * sign. Kaldrix does not watch the blockchain settle. The recorded spend cannot be undone if the x402 payment later
 * fails, so a failed payment still counts against the cap (the safe direction).
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import type { PaymentRequirement } from "./types";

export interface KaldrixToken {
  id: string;
  blocks: Array<{ signature: string; grant: { subject: string; subject_key: string; scope: KaldrixScope } }>;
  [k: string]: unknown;
}

export interface KaldrixScope {
  resources?: Array<{ exact?: string; prefix?: string }>;
  purpose?: string | null;
  spend?: { max_minor?: number; max_total_minor?: number | null; approval_above_minor?: number | null };
  expires_at_ms?: number | null;
  not_before_ms?: number | null;
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ACTION = "payments.initiate";

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}
const bytes = (b: Buffer) => Buffer.concat([u64(b.length), b]);
const str = (s: string) => bytes(Buffer.from(s, "utf8"));
const option = (s: string | null) => (s === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), str(s)]));

export function privateKeyFromSeed(seedHex: string): KeyObject {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error("The agent key seed must be 64 hex characters.");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
}

export function publicHex(key: KeyObject): string {
  return createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
}

/** A block's short name: the first 12 bytes of the SHA-256 of its signature, in hex. */
export function leafBlockId(token: KaldrixToken): string {
  const last = token.blocks[token.blocks.length - 1];
  if (!last) throw new Error("The permission has no blocks.");
  return createHash("sha256").update(Buffer.from(last.signature, "hex")).digest().subarray(0, 12).toString("hex");
}

export function proofMessage(token: KaldrixToken, resource: string, purpose: string | null, amountMinor: number, currency: string, nonce: Buffer, issuedAtMs: number): Buffer {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error("The amount must be a whole number of cents.");
  return Buffer.concat([str("kaldrix.token.use.v2"), str(token.id), str(leafBlockId(token)), str(ACTION), str(resource), option(purpose), Buffer.from([1]), str(currency), u64(amountMinor), bytes(nonce), u64(issuedAtMs)]);
}

export interface Proof {
  nonce: string;
  issued_at_ms: number;
  signature: string;
}

/** A proof made for exactly one payment. The nonce and time can be fixed for tests. */
export function signProof(key: KeyObject, token: KaldrixToken, recipientId: string, purpose: string | null, amountMinor: number, currency = "USD", nowMs = Date.now(), nonce: Buffer = randomBytes(16)): Proof {
  const msg = proofMessage(token, `payments:recipient:${recipientId}`, purpose, amountMinor, currency, nonce, nowMs);
  return { nonce: nonce.toString("hex"), issued_at_ms: nowMs, signature: edSign(null, msg, key).toString("hex") };
}

/** The first permission that fits this payment, or the reasons each one does not. */
export function choosePermission(tokens: KaldrixToken[], myPublicHex: string, recipient: string, purpose: string, amountMinor: number, nowMs: number): { token: KaldrixToken | null; why: string[] } {
  const why: string[] = [];
  const names = (sc: KaldrixScope) =>
    (sc.resources ?? []).some((r) => r.exact === `payments:recipient:${recipient}` || (r.prefix !== undefined && `payments:recipient:${recipient}`.startsWith(r.prefix)));
  for (const t of tokens) {
    const g = t.blocks[t.blocks.length - 1]?.grant;
    if (!g) continue;
    const sc = g.scope;
    if (g.subject_key.toLowerCase() !== myPublicHex.toLowerCase()) why.push(`${t.id}: was made for a different agent key`);
    else if (sc.expires_at_ms != null && sc.expires_at_ms <= nowMs) why.push(`${t.id}: has expired`);
    else if (sc.not_before_ms != null && sc.not_before_ms > nowMs + 2000) why.push(`${t.id}: has not started yet`);
    else if (!names(sc)) why.push(`${t.id}: does not name that supplier`);
    else if (sc.purpose != null && sc.purpose !== purpose) why.push(`${t.id}: is for ${sc.purpose}, not ${purpose}`);
    else if (sc.spend?.max_minor != null && amountMinor > sc.spend.max_minor) why.push(`${t.id}: allows at most ${sc.spend.max_minor} cents a payment`);
    else return { token: t, why: [] };
  }
  return { token: null, why };
}

/** The same supplier, amount, purpose and reference is one payment, never two. */
export function paymentNumber(recipient: string, amountMinor: number, purpose: string, reference: string): string {
  return "inv-" + createHash("sha256").update(`${recipient}|${amountMinor}|${purpose}|${reference}`).digest("hex").slice(0, 24);
}

export type AuthorityResult =
  | { decision: "allow"; transactionId: string; envelope: unknown; correlationId?: string }
  | { decision: "needs_approval"; approvalId: string; message: string }
  | { decision: "deny"; reason: string; explanation: string };

/** Anything that can say yes or no to an x402 payment before it is signed. */
export interface Authority {
  authorize(info: { requirement: PaymentRequirement; usdMicro: bigint; resourceUrl: string; attemptId: string }): Promise<AuthorityResult>;
}

export interface KaldrixAuthorityOptions {
  /** For example https://kaldrix-sandbox.onrender.com */
  baseUrl: string;
  /** The limited key made for the agent in the Kaldrix dashboard. It can pay inside a permission and read payments, nothing else. */
  agentKey: string;
  /** The agent's own private key seed (64 hex characters). It never leaves this process. */
  agentSeedHex: string;
  /** The permissions a person gave this agent. */
  permissions: KaldrixToken[];
  /** Which Kaldrix supplier each wallet address belongs to. A wallet not listed here is never paid. */
  recipientByWallet: Record<string, string>;
  /** What the payment is for. Must be one the permission allows. Default "supplier_payment". */
  purpose?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const centsFromMicro = (m: bigint) => Number((m + 9999n) / 10000n); // rounded up: never under-counts

export class KaldrixAuthority implements Authority {
  private readonly key: KeyObject;
  private readonly me: string;
  private readonly wallets: Map<string, string>;
  private offset = 0;
  private offsetAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly o: KaldrixAuthorityOptions) {
    this.key = privateKeyFromSeed(o.agentSeedHex);
    this.me = publicHex(this.key);
    this.wallets = new Map(Object.entries(o.recipientByWallet).map(([w, r]) => [w.toLowerCase(), r]));
  }

  private get f(): typeof fetch {
    return this.o.fetch ?? fetch;
  }

  /** A permission starts and ends by the service's clock, so proofs use the service's time. */
  private async serverNow(): Promise<number> {
    const local = (this.o.now ?? Date.now)();
    if (local - this.offsetAt > 5 * 60_000) {
      this.offsetAt = local;
      try {
        const r = await this.f(this.o.baseUrl.replace(/\/$/, "") + "/api/health", { headers: { accept: "application/json" } });
        const d = r.headers.get("date");
        if (d) this.offset = Date.parse(d) - local;
      } catch {
        /* keep the last offset */
      }
    }
    return (this.o.now ?? Date.now)() + this.offset;
  }

  async authorize(info: { requirement: PaymentRequirement; usdMicro: bigint; resourceUrl: string; attemptId: string }): Promise<AuthorityResult> {
    const no = (reason: string, explanation: string): AuthorityResult => ({ decision: "deny", reason, explanation });
    const recipient = this.wallets.get(info.requirement.payTo.toLowerCase());
    if (!recipient) return no("recipient_not_known", `The wallet ${info.requirement.payTo} is not matched to any Kaldrix supplier, so it will not be paid.`);
    const cents = centsFromMicro(info.usdMicro);
    if (cents <= 0) return no("invalid_amount", "The amount is too small to record.");
    const purpose = this.o.purpose ?? "supplier_payment";
    const now = await this.serverNow();
    const { token, why } = choosePermission(this.o.permissions, this.me, recipient, purpose, cents, now);
    if (!token) return no("no_matching_permission", why.length ? why.join("; ") : "This agent holds no permission yet.");

    const grant = token.blocks[token.blocks.length - 1]!.grant;
    // The service accepts only short plain references (letters, digits, - _ . :), so the web address is hashed, never included.
    const reference = "x402-" + createHash("sha256").update(`${info.resourceUrl}|${info.attemptId}`).digest("hex").slice(0, 32);
    const body = {
      token,
      presenter: grant.subject,
      proof: signProof(this.key, token, recipient, purpose, cents, "USD", now),
      intent: { amount_minor: cents, currency: "USD", recipient, purpose, client_reference: reference, idempotency_key: paymentNumber(recipient, cents, purpose, reference) },
    };

    let res: Response;
    try {
      res = await this.f(this.o.baseUrl.replace(/\/$/, "") + "/api/v1/authorized-payments", {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.agentKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Fail closed: if Kaldrix cannot be reached, nothing is signed.
      return no("unreachable", `Could not reach Kaldrix: ${e instanceof Error ? e.message : String(e)}`);
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, any>;
    switch (j.stage) {
      case "payment_submitted": {
        if (j.payment?.replay) return no("replayed", "Kaldrix already recorded this exact payment, so it will not be authorised twice.");
        const state = j.payment?.transaction?.state;
        if (state === "rejected") return no(j.payment?.transaction?.reject_code ?? "rejected", j.payment?.transaction?.detail ?? "The payment was rejected.");
        return { decision: "allow", transactionId: String(j.payment?.transaction?.id ?? ""), envelope: j.proof_envelope ?? null, correlationId: j.correlation_id };
      }
      case "approval_required":
        return { decision: "needs_approval", approvalId: String(j.approval_id ?? ""), message: String(j.message ?? "A person must approve this payment in the Kaldrix dashboard.") };
      case "authorization_denied":
        return no(String(j.authorization?.reason_code ?? "denied"), String(j.authorization?.detail ?? "Kaldrix refused this payment."));
      case "approval_denied":
        return no("approval_denied", String(j.reason ?? "A person said no to this payment."));
      default:
        return no(String(j.error?.code ?? `http_${res.status}`), String(j.error?.message ?? "Kaldrix gave an answer that could not be understood, so nothing is signed."));
    }
  }
}
