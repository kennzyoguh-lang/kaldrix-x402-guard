import { randomUUID } from "node:crypto";
import { encodePaymentHeader, readPaymentRequired } from "./decode";
import type { Guard } from "./guard";
import type { Authority } from "./kaldrix";
import type { PaymentPayload, PaymentRequired, PaymentRequirement, Reason } from "./types";

export class GuardDenied extends Error {
  constructor(
    message: string,
    readonly reasons: Reason[],
  ) {
    super(message);
    this.name = "GuardDenied";
  }
}

/** Something the agent's own wallet code provides. It is only ever called for a payment that was allowed. */
export type Signer = (requirement: PaymentRequirement, required: PaymentRequired) => Promise<PaymentPayload>;

export interface ApprovalInfo {
  /** "local" is the guard's own rule; "kaldrix" means a person must approve in the Kaldrix dashboard. */
  source: "local" | "kaldrix";
  requirement: PaymentRequirement;
  usdMicro: bigint;
  message: string;
  approvalId?: string;
}

export interface AuthorizedInfo {
  requirement: PaymentRequirement;
  transactionId: string;
  /** The signed Kaldrix proof for exactly this payment. Keep it with your records. */
  envelope: unknown;
}

export interface GuardedFetchOptions {
  /** Called when a person must approve. Return true once they have. If missing, such payments are refused. */
  approve?: (info: ApprovalInfo) => Promise<boolean>;
  /** Ask this authority (for example Kaldrix) before anything is signed. */
  authority?: Authority;
  /** Called after the authority allowed a payment, with its signed proof. */
  onAuthorized?: (info: AuthorizedInfo) => void;
}

/**
 * A fetch that pays for x402 resources, but only inside the policy. The order matters:
 * 1. read the payment request, 2. ask the local guard, 3. ask the authority (Kaldrix), if one is set,
 * 4. only then call the signer, 5. check what was signed against what was approved, 6. send it.
 */
export function guardedFetch(fetchImpl: typeof fetch, guard: Guard, signer: Signer, options: GuardedFetchOptions = {}) {
  return async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const first = await fetchImpl(url, init);
    if (first.status !== 402) return first;

    const required = await readPaymentRequired(first);
    const decision = guard.evaluate(required, { requestUrl: String(url) });
    if (decision.decision === "deny") throw new GuardDenied("Payment refused: " + decision.reasons.map((r) => r.message).join(" "), decision.reasons);

    const drop = (message: string, reasons: Reason[]): never => {
      guard.release(decision.reservationId);
      throw new GuardDenied(message, reasons);
    };

    if (decision.decision === "needs_approval") {
      const yes = options.approve ? await options.approve({ source: "local", requirement: decision.requirement, usdMicro: decision.usdMicro, message: decision.message }) : false;
      if (!yes) drop("Payment refused: " + decision.message, [{ code: "approval_required", message: decision.message }]);
    }

    if (options.authority) {
      const attemptId = randomUUID();
      const ask = () => options.authority!.authorize({ requirement: decision.requirement, usdMicro: decision.usdMicro, resourceUrl: String(url), attemptId });
      let result = await ask();
      if (result.decision === "needs_approval") {
        const yes = options.approve ? await options.approve({ source: "kaldrix", requirement: decision.requirement, usdMicro: decision.usdMicro, message: result.message, approvalId: result.approvalId }) : false;
        if (!yes) drop("Payment refused: " + result.message, [{ code: "approval_required", message: result.message }]);
        result = await ask(); // the same payment again: Kaldrix recognises it as the one that was waiting
      }
      if (result.decision === "needs_approval") drop("Payment refused: the approval is not recorded yet.", [{ code: "approval_pending", message: "The approval is not recorded yet." }]);
      if (result.decision === "deny") drop(`Payment refused by Kaldrix: ${result.explanation}`, [{ code: result.reason, message: result.explanation }]);
      if (result.decision === "allow") options.onAuthorized?.({ requirement: decision.requirement, transactionId: result.transactionId, envelope: result.envelope });
    }

    let payload: PaymentPayload;
    try {
      payload = await signer(decision.requirement, required);
    } catch (e) {
      guard.release(decision.reservationId);
      throw e;
    }

    const problems = guard.verifySigned(decision.requirement, payload);
    if (problems.length > 0) {
      guard.release(decision.reservationId);
      throw new GuardDenied("Payment not sent: what was signed is not what was approved. " + problems.map((p) => p.message).join(" "), problems);
    }

    const header = required.x402Version === 1 ? "X-PAYMENT" : "PAYMENT-SIGNATURE";
    const headers = new Headers(init.headers);
    headers.set(header, encodePaymentHeader(payload));
    let second: Response;
    try {
      second = await fetchImpl(url, { ...init, headers });
    } catch (e) {
      // We cannot know whether the server saw the payment, so the amount stays counted (it is NOT released).
      guard.confirm(decision.reservationId);
      throw e;
    }
    if (second.status === 402) guard.release(decision.reservationId);
    else guard.confirm(decision.reservationId);
    return second;
  };
}
