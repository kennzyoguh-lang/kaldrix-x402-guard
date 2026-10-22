/**
 * AP2 (Agent Payments Protocol, version 0.2) payment-mandate constraints.
 *
 * This file does NOT check signatures or the SD-JWT chain. Do that first with a library that implements the
 * Delegate SD-JWT draft (Google's own Python SDK does). What this file does is the next step the specification
 * calls for: given a mandate chain that is already verified, decide whether the CLOSED payment mandate satisfies the
 * constraints of the OPEN payment mandate, and turn those constraints into limits that Kaldrix tools can enforce.
 *
 * The rules follow the specification (payment_mandate.md) and the evaluation order of Google's reference SDK
 * (ap2/sdk/constraints.py). Unknown constraint types fail, as the specification requires.
 */
import type { Policy } from "./types";

export interface Ap2Merchant {
  id?: string;
  name?: string;
  website?: string;
}
export interface Ap2Amount {
  /** Minor units (for example cents), a whole number. */
  amount: number;
  currency: string;
}
export interface Ap2Instrument {
  id: string;
  type?: string;
  description?: string;
}
export interface Ap2Pisp {
  legal_name?: string;
  brand_name?: string;
  domain_name?: string;
}

export type Ap2Constraint =
  | { type: "payment.amount_range"; min?: number; max?: number; currency?: string }
  | { type: "payment.allowed_payees"; allowed: Ap2Merchant[] }
  | { type: "payment.allowed_payment_instruments"; allowed: Ap2Instrument[] }
  | { type: "payment.allowed_pisps"; allowed: Ap2Pisp[] }
  | { type: "payment.budget"; max: number; currency: string }
  | { type: "payment.agent_recurrence"; frequency?: string; max_occurrences?: number }
  | { type: "payment.reference"; conditional_transaction_id: string }
  | { type: "payment.execution_date"; not_before?: string; not_after?: string }
  | { type: string; [k: string]: unknown };

/** The decoded content of an open payment mandate, after the chain has been verified. */
export interface Ap2OpenPaymentMandate {
  vct?: string;
  constraints: Ap2Constraint[];
  payee?: Ap2Merchant;
  payment_amount?: Ap2Amount;
  payment_instrument?: Ap2Instrument;
  execution_date?: string;
  iat?: number;
  exp?: number;
}

/** The decoded content of a closed payment mandate, after the chain has been verified. */
export interface Ap2ClosedPaymentMandate {
  vct?: string;
  transaction_id?: string;
  payee: Ap2Merchant;
  payment_amount: Ap2Amount;
  payment_instrument?: Ap2Instrument;
  pisp?: Ap2Pisp;
  execution_date?: string;
}

/** What has been spent under this open mandate before. The caller keeps this; AP2 requires it to be tracked. */
export interface Ap2Context {
  totalAmountMinor?: number;
  totalUses?: number;
  /** Hash of the open checkout mandate this payment belongs to (needed for payment.reference). */
  openCheckoutHash?: string;
  /** Seconds since 1970. If given, the open mandate's own time window is checked too. */
  nowSeconds?: number;
}

export function merchantMatches(candidate: Ap2Merchant, target: Ap2Merchant): boolean {
  if (candidate.id && target.id) return candidate.id === target.id;
  return Boolean(candidate.name) && candidate.name === target.name && Boolean(candidate.website) && candidate.website === target.website;
}

const isWholeNumber = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
const dateMs = (s: string | undefined): number => (s === undefined ? NaN : Date.parse(s));

function checkPresetClaims(open: Ap2OpenPaymentMandate, closed: Ap2ClosedPaymentMandate): string[] {
  const out: string[] = [];
  if (open.payee && !merchantMatches(open.payee, closed.payee)) out.push(`Pre-set payee mismatch: expected ${open.payee.name}, got ${closed.payee?.name}`);
  if (open.payment_amount && (open.payment_amount.amount !== closed.payment_amount?.amount || open.payment_amount.currency !== closed.payment_amount?.currency)) out.push("Pre-set amount mismatch");
  if (open.payment_instrument && open.payment_instrument.id !== closed.payment_instrument?.id) out.push("Pre-set payment_instrument mismatch");
  if (open.execution_date !== undefined && open.execution_date !== closed.execution_date) out.push(`Pre-set execution_date mismatch: expected ${open.execution_date}, got ${closed.execution_date}`);
  return out;
}

function evaluateOne(c: Ap2Constraint, closed: Ap2ClosedPaymentMandate, ctx: Ap2Context): string[] {
  const amount = closed.payment_amount;
  switch (c.type) {
    case "payment.amount_range": {
      const r = c as { min?: number; max?: number; currency?: string };
      const out: string[] = [];
      if (r.currency && amount.currency !== r.currency) out.push(`Currency mismatch: expected ${r.currency}, got ${amount.currency}`);
      if (r.min !== undefined && amount.amount < r.min) out.push(`Amount ${amount.amount} below minimum ${r.min}`);
      if (r.max !== undefined && amount.amount > r.max) out.push(`Amount ${amount.amount} exceeds maximum ${r.max}`);
      return out;
    }
    case "payment.allowed_payees": {
      const allowed = (c as { allowed?: Ap2Merchant[] }).allowed ?? [];
      return allowed.some((a) => merchantMatches(a, closed.payee)) ? [] : [`Payee ${closed.payee?.name} not in allowed list`];
    }
    case "payment.allowed_payment_instruments": {
      if (!closed.payment_instrument) return ["Missing payment instrument in closed mandate"];
      const allowed = (c as { allowed?: Ap2Instrument[] }).allowed ?? [];
      return allowed.some((a) => a.id === closed.payment_instrument!.id) ? [] : [`Payment instrument ${closed.payment_instrument.id} not in allowed list`];
    }
    case "payment.allowed_pisps": {
      if (!closed.pisp) return ["Missing PISP in closed mandate"];
      const allowed = (c as { allowed?: Ap2Pisp[] }).allowed ?? [];
      const p = closed.pisp;
      return allowed.some((a) => a.domain_name === p.domain_name && a.legal_name === p.legal_name && a.brand_name === p.brand_name) ? [] : ["PISP not in allowed list"];
    }
    case "payment.budget": {
      const b = c as { max: number; currency: string };
      if (amount.currency !== b.currency) return [`Budget currency mismatch: expected ${b.currency}, got ${amount.currency}`];
      if (ctx.totalAmountMinor === undefined) return ["Missing mandate context required to evaluate budget"];
      // The budget is written in whole currency units, the amounts in minor units, as in the reference SDK.
      const limit = Math.trunc(b.max * 100);
      const total = ctx.totalAmountMinor + amount.amount;
      return total > limit ? [`Cumulative spend ${total} exceeds budget limit ${limit} (past spend: ${ctx.totalAmountMinor})`] : [];
    }
    case "payment.agent_recurrence": {
      const r = c as { max_occurrences?: number };
      if (r.max_occurrences === undefined) return [];
      if (ctx.totalUses === undefined) return ["Missing mandate context required to evaluate recurrence"];
      return ctx.totalUses >= r.max_occurrences ? [`Maximum occurrences exceeded: ${ctx.totalUses} >= ${r.max_occurrences}`] : [];
    }
    case "payment.reference": {
      const r = c as { conditional_transaction_id: string };
      if (!ctx.openCheckoutHash) return ["open_checkout_hash is required to evaluate PaymentReference constraints"];
      return ctx.openCheckoutHash === r.conditional_transaction_id ? [] : [`PaymentReference mismatch: expected open checkout hash ${r.conditional_transaction_id}, got ${ctx.openCheckoutHash}`];
    }
    case "payment.execution_date": {
      const r = c as { not_before?: string; not_after?: string };
      if (!closed.execution_date) return [];
      const when = dateMs(closed.execution_date);
      if (Number.isNaN(when)) return ["Execution date is not a valid date"];
      const out: string[] = [];
      if (r.not_before && when < dateMs(r.not_before)) out.push(`Execution date ${closed.execution_date} is before allowed window ${r.not_before}`);
      if (r.not_after && when > dateMs(r.not_after)) out.push(`Execution date ${closed.execution_date} is after allowed window ${r.not_after}`);
      return out;
    }
    default:
      // The specification: any unknown constraint MUST be treated as failing.
      return [`Unknown constraint type: ${c.type}`];
  }
}

/** Returns every reason the closed payment does not satisfy the open mandate. An empty list means it does. */
export function checkAp2PaymentConstraints(open: Ap2OpenPaymentMandate, closed: Ap2ClosedPaymentMandate, ctx: Ap2Context = {}): string[] {
  const out: string[] = [];
  if (open.vct !== undefined && open.vct !== "mandate.payment.open.1") out.push(`Unexpected open mandate type: ${open.vct}`);
  if (closed.vct !== undefined && closed.vct !== "mandate.payment.1") out.push(`Unexpected closed mandate type: ${closed.vct}`);
  if (!closed.payment_amount || !isWholeNumber(closed.payment_amount.amount) || closed.payment_amount.amount < 0) {
    out.push("The closed mandate's amount is not a whole number of minor units.");
    return out;
  }
  if (!Array.isArray(open.constraints)) return [...out, "The open mandate has no constraint list."];

  if (ctx.nowSeconds !== undefined) {
    if (open.exp !== undefined && ctx.nowSeconds >= open.exp) out.push("The open mandate has expired.");
    if (open.iat !== undefined && ctx.nowSeconds < open.iat) out.push("The open mandate is not valid yet.");
  }

  out.push(...checkPresetClaims(open, closed));

  const has = (t: string) => open.constraints.some((c) => c.type === t);
  if (has("payment.agent_recurrence")) {
    if (!has("payment.amount_range")) out.push("payment.agent_recurrence requires payment.amount_range constraint");
    if (!has("payment.budget")) out.push("payment.agent_recurrence requires payment.budget constraint");
  }
  for (const c of open.constraints) out.push(...evaluateOne(c, closed, ctx));
  return out;
}

export interface Ap2ToPolicyOptions {
  /** AP2 names payees by merchant; x402 pays wallet addresses. Say which wallet belongs to which merchant id. */
  walletsByPayeeId?: Record<string, string[]>;
  /** The tokens you are willing to pay with. AP2 amounts are in a fiat currency; these must be worth that currency. */
  allowedAssets: Policy["allowedAssets"];
  allowedHosts?: string[];
  /** Only this currency can be turned into dollar limits. Default "USD". */
  currency?: string;
}

export interface Ap2ToPolicyResult {
  policy: Policy;
  /** Constraints this converter could not turn into a limit. The caller must enforce them another way, or refuse. */
  notEnforced: string[];
}

/**
 * Turns the limits of an open payment mandate into a policy for the x402 guard.
 * It never loosens anything: if a constraint cannot be mapped it is reported in `notEnforced`, and a mandate that
 * names no way to bound the amount is refused with an error rather than given an unlimited policy.
 */
export function ap2ToPolicy(open: Ap2OpenPaymentMandate, o: Ap2ToPolicyOptions): Ap2ToPolicyResult {
  const currency = o.currency ?? "USD";
  const notEnforced: string[] = [];
  let maxPerPaymentUsd: number | undefined;
  let maxTotalUsd: number | undefined;
  let expiresAt: number | undefined = open.exp !== undefined ? open.exp * 1000 : undefined;
  let recipients: string[] | undefined;

  for (const c of open.constraints) {
    switch (c.type) {
      case "payment.amount_range": {
        const r = c as { max?: number; currency?: string };
        if (r.currency !== currency) throw new Error(`The amount limit is in ${r.currency ?? "no currency"}, not ${currency}, so it cannot be turned into a dollar limit.`);
        if (r.max !== undefined) maxPerPaymentUsd = r.max / 100;
        break;
      }
      case "payment.budget": {
        const b = c as { max: number; currency: string };
        if (b.currency !== currency) throw new Error(`The budget is in ${b.currency}, not ${currency}.`);
        maxTotalUsd = b.max;
        break;
      }
      case "payment.allowed_payees": {
        const list = (c as { allowed: Ap2Merchant[] }).allowed ?? [];
        const wallets: string[] = [];
        for (const m of list) {
          const found = m.id ? o.walletsByPayeeId?.[m.id] : undefined;
          if (!found || found.length === 0) notEnforced.push(`No wallet is known for payee ${m.name ?? m.id ?? "(unnamed)"}, so it will not be paid.`);
          else wallets.push(...found);
        }
        recipients = [...(recipients ?? []), ...wallets];
        break;
      }
      case "payment.execution_date": {
        const r = c as { not_after?: string };
        const t = dateMs(r.not_after);
        if (!Number.isNaN(t)) expiresAt = expiresAt === undefined ? t : Math.min(expiresAt, t);
        break;
      }
      case "payment.agent_recurrence":
        notEnforced.push("payment.agent_recurrence: the number of uses must be tracked by the caller (use checkAp2PaymentConstraints with a context).");
        break;
      case "payment.allowed_payment_instruments":
      case "payment.allowed_pisps":
      case "payment.reference":
        notEnforced.push(`${c.type}: not meaningful for an on-chain x402 payment. Enforce it where the mandate is verified.`);
        break;
      default:
        throw new Error(`Unknown constraint type: ${c.type}. The specification says an unknown constraint must fail.`);
    }
  }

  if (maxPerPaymentUsd === undefined && maxTotalUsd === undefined) throw new Error("The mandate sets no amount limit, so no safe policy can be made from it.");
  if (!recipients || recipients.length === 0) throw new Error("The mandate names no payee with a known wallet, so no safe policy can be made from it.");

  const policy: Policy = {
    allowedAssets: o.allowedAssets,
    allowedRecipients: recipients,
    maxPerPaymentUsd: maxPerPaymentUsd ?? maxTotalUsd!,
  };
  if (maxTotalUsd !== undefined) policy.maxTotalUsd = maxTotalUsd;
  if (expiresAt !== undefined) policy.expiresAt = expiresAt;
  if (o.allowedHosts && o.allowedHosts.length > 0) policy.allowedHosts = o.allowedHosts;
  return { policy, notEnforced };
}
