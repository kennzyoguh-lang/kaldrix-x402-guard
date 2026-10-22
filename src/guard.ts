import type { Decision, PaymentPayload, PaymentRequired, PaymentRequirement, Policy, Reason } from "./types";

const MICRO = 1_000_000;
const toMicro = (usd: number): bigint => BigInt(Math.round(usd * MICRO));
const lower = (s: string) => s.toLowerCase();
const sameAddress = (a: string, b: string) => lower(a) === lower(b);

interface Entry {
  at: number;
  micro: bigint;
  key: string;
  state: "reserved" | "confirmed";
}

/** Remembers what has been spent. This one lives in memory; supply your own to keep totals across restarts. */
export class MemoryLedger {
  private entries = new Map<string, Entry>();
  reserve(id: string, at: number, micro: bigint, key: string): void {
    this.entries.set(id, { at, micro, key, state: "reserved" });
  }
  confirm(id: string): void {
    const e = this.entries.get(id);
    if (e) e.state = "confirmed";
  }
  release(id: string): void {
    this.entries.delete(id);
  }
  total(): bigint {
    let t = 0n;
    for (const e of this.entries.values()) t += e.micro;
    return t;
  }
  since(from: number): bigint {
    let t = 0n;
    for (const e of this.entries.values()) if (e.at >= from) t += e.micro;
    return t;
  }
  hasKeySince(key: string, from: number): boolean {
    for (const e of this.entries.values()) if (e.key === key && e.at >= from) return true;
    return false;
  }
}

export interface GuardOptions {
  ledger?: MemoryLedger;
  now?: () => number;
}

function hostAllowed(host: string, allowed: string[]): boolean {
  const h = lower(host);
  return allowed.some((a) => {
    const p = lower(a);
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function validatePolicy(p: Policy): void {
  const bad = (m: string): never => {
    throw new Error(`Invalid policy: ${m}`);
  };
  if (!Number.isFinite(p.maxPerPaymentUsd) || p.maxPerPaymentUsd <= 0) bad("maxPerPaymentUsd must be a positive number.");
  if (p.maxTotalUsd !== undefined && (!Number.isFinite(p.maxTotalUsd) || p.maxTotalUsd <= 0)) bad("maxTotalUsd must be a positive number.");
  if (!Array.isArray(p.allowedAssets) || p.allowedAssets.length === 0) bad("allowedAssets must list at least one token.");
  if (!Array.isArray(p.allowedRecipients) || p.allowedRecipients.length === 0) bad("allowedRecipients must list at least one address.");
  for (const a of p.allowedAssets) if (!Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > 36) bad(`decimals for ${a.symbol} must be a whole number from 0 to 36.`);
  if (p.speed && (!(p.speed.windowMs > 0) || !(p.speed.maxUsd > 0))) bad("speed needs a positive window and a positive amount.");
}

let counter = 0;

export function createGuard(policy: Policy, options: GuardOptions = {}) {
  validatePolicy(policy);
  const ledger = options.ledger ?? new MemoryLedger();
  const now = options.now ?? (() => Date.now());
  const schemes = (policy.allowedSchemes ?? ["exact"]).map(lower);
  const dupWindow = policy.duplicateWindowMs ?? 5 * 60_000;

  function usdMicroOf(req: PaymentRequirement, rule: { decimals: number; usdMicroPerToken?: number }): bigint {
    const rate = BigInt(rule.usdMicroPerToken ?? MICRO);
    const den = 10n ** BigInt(rule.decimals);
    return (BigInt(req.amount) * rate + den - 1n) / den; // rounded up, so a limit is never slipped under by rounding
  }

  function checkOption(req: PaymentRequirement, t: number): { reasons: Reason[]; usdMicro?: bigint; key: string } {
    const reasons: Reason[] = [];
    const add = (code: string, message: string) => reasons.push({ code, message });
    const key = [req.network, lower(req.asset), lower(req.payTo), req.amount].join("|");
    if (!schemes.includes(lower(req.scheme))) add("scheme_not_allowed", `The payment method "${req.scheme}" is not allowed.`);
    if (!policy.allowedRecipients.some((r) => sameAddress(r, req.payTo))) add("recipient_not_allowed", `The recipient ${req.payTo} is not on the permission.`);
    const rule = policy.allowedAssets.find((a) => a.network === req.network && sameAddress(a.asset, req.asset));
    if (!rule) {
      add("asset_not_allowed", `The token ${req.asset} on ${req.network} is not allowed.`);
      return { reasons, key };
    }
    const amount = BigInt(req.amount);
    if (amount <= 0n) add("amount_zero", "The amount is zero.");
    const usdMicro = usdMicroOf(req, rule);
    if (usdMicro > toMicro(policy.maxPerPaymentUsd)) add("over_per_payment_limit", `This payment is worth more than the ${policy.maxPerPaymentUsd} dollar limit for one payment.`);
    if (policy.maxTotalUsd !== undefined && ledger.total() + usdMicro > toMicro(policy.maxTotalUsd)) add("over_total_cap", `This payment would take the total past the ${policy.maxTotalUsd} dollar cap.`);
    if (policy.speed && ledger.since(t - policy.speed.windowMs) + usdMicro > toMicro(policy.speed.maxUsd)) add("over_speed_limit", `Too much has been spent in the last ${Math.round(policy.speed.windowMs / 1000)} seconds.`);
    if (policy.maxTimeoutSeconds !== undefined && (req.maxTimeoutSeconds === undefined || req.maxTimeoutSeconds > policy.maxTimeoutSeconds)) add("timeout_too_long", `The payment would stay valid for longer than ${policy.maxTimeoutSeconds} seconds.`);
    if (dupWindow > 0 && ledger.hasKeySince(key, t - dupWindow)) add("duplicate", "An identical payment was just made. Refused so it is not paid twice.");
    return { reasons, usdMicro, key };
  }

  return {
    ledger,

    /** Decides whether the agent may sign. Nothing is signed or sent by this call. */
    evaluate(required: PaymentRequired, ctx: { requestUrl?: string } = {}): Decision {
      const t = now();
      if (policy.expiresAt !== undefined && t >= policy.expiresAt) return { decision: "deny", reasons: [{ code: "expired", message: "The permission has expired." }] };

      if (policy.allowedHosts && policy.allowedHosts.length > 0) {
        const hosts = [hostOf(ctx.requestUrl), hostOf(required.resource?.url)].filter((h): h is string => h !== null);
        if (hosts.length === 0) return { decision: "deny", reasons: [{ code: "host_unknown", message: "Cannot tell which website is asking to be paid." }] };
        const bad = hosts.find((h) => !hostAllowed(h, policy.allowedHosts!));
        if (bad) return { decision: "deny", reasons: [{ code: "host_not_allowed", message: `The website ${bad} is not on the permission.` }] };
      }

      const ok: Array<{ req: PaymentRequirement; usdMicro: bigint; key: string }> = [];
      const reasons: Reason[] = [];
      for (const req of required.accepts) {
        const r = checkOption(req, t);
        if (r.reasons.length === 0 && r.usdMicro !== undefined) ok.push({ req, usdMicro: r.usdMicro, key: r.key });
        else for (const x of r.reasons) if (!reasons.some((y) => y.code === x.code && y.message === x.message)) reasons.push(x);
      }
      if (ok.length === 0) return { decision: "deny", reasons };

      // Of the acceptable ways to pay, take the cheapest.
      const best = ok.reduce((a, b) => (b.usdMicro < a.usdMicro ? b : a));
      const id = `res_${t}_${++counter}`;
      ledger.reserve(id, t, best.usdMicro, best.key);
      if (policy.requireApprovalAboveUsd !== undefined && best.usdMicro > toMicro(policy.requireApprovalAboveUsd)) {
        return { decision: "needs_approval", requirement: best.req, usdMicro: best.usdMicro, reservationId: id, message: `A person must approve payments above ${policy.requireApprovalAboveUsd} dollars.` };
      }
      return { decision: "allow", requirement: best.req, usdMicro: best.usdMicro, reservationId: id };
    },

    /**
     * Checks that what the signer produced is exactly what was approved: the same amount, recipient, token and
     * network, a transfer authorisation that matches, and a payment that is only valid for a short time.
     */
    verifySigned(approved: PaymentRequirement, payload: PaymentPayload): Reason[] {
      const out: Reason[] = [];
      const add = (code: string, message: string) => out.push({ code, message });
      const a = payload.accepted;
      if (!a) return [{ code: "no_accepted", message: "The signed payment does not say which option it accepted." }];
      if (a.scheme !== approved.scheme || a.network !== approved.network) add("signed_method_changed", "The signed payment uses a different method or network than the one approved.");
      if (String(a.amount ?? "") !== approved.amount) add("signed_amount_changed", "The signed payment has a different amount than the one approved.");
      if (!a.asset || !sameAddress(a.asset, approved.asset)) add("signed_asset_changed", "The signed payment uses a different token than the one approved.");
      if (!a.payTo || !sameAddress(a.payTo, approved.payTo)) add("signed_recipient_changed", "The signed payment goes to a different recipient than the one approved.");
      const auth = payload.payload?.authorization;
      if (auth) {
        if (!auth.to || !sameAddress(auth.to, approved.payTo)) add("authorisation_recipient", "The transfer authorisation names a different recipient.");
        if (String(auth.value ?? "") !== approved.amount) add("authorisation_amount", "The transfer authorisation is for a different amount.");
        if (policy.payerAddress && (!auth.from || !sameAddress(auth.from, policy.payerAddress))) add("authorisation_payer", "The transfer authorisation comes from a different wallet than the one allowed.");
        const after = Number(auth.validAfter);
        const before = Number(auth.validBefore);
        const limit = Math.min(approved.maxTimeoutSeconds ?? Infinity, policy.maxTimeoutSeconds ?? Infinity);
        if (!Number.isFinite(after) || !Number.isFinite(before) || before <= after) add("authorisation_window", "The transfer authorisation has an invalid validity window.");
        else if (Number.isFinite(limit) && before - after > limit + 30) add("authorisation_too_long", "The transfer authorisation stays valid for longer than allowed.");
      }
      return out;
    },

    confirm(id: string): void {
      ledger.confirm(id);
    },
    release(id: string): void {
      ledger.release(id);
    },
  };
}

export type Guard = ReturnType<typeof createGuard>;
