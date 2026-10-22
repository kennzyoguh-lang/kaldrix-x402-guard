import { encodePaymentHeader, readPaymentRequired } from "./decode";
import type { Guard } from "./guard";
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

/** Something the agent's own wallet code provides. It is only ever called for a payment the guard has allowed. */
export type Signer = (requirement: PaymentRequirement, required: PaymentRequired) => Promise<PaymentPayload>;

export interface GuardedFetchOptions {
  /** Called when a payment needs a person's approval. Return true to go ahead. If missing, such payments are refused. */
  approve?: (info: { requirement: PaymentRequirement; usdMicro: bigint; message: string }) => Promise<boolean>;
}

/**
 * A fetch that pays for x402 resources, but only inside the policy. The order matters:
 * 1. read the payment request, 2. ask the guard, 3. only then call the signer,
 * 4. check what was signed against what was approved, 5. only then send it.
 */
export function guardedFetch(fetchImpl: typeof fetch, guard: Guard, signer: Signer, options: GuardedFetchOptions = {}) {
  return async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const first = await fetchImpl(url, init);
    if (first.status !== 402) return first;

    const required = await readPaymentRequired(first);
    const decision = guard.evaluate(required, { requestUrl: String(url) });
    if (decision.decision === "deny") throw new GuardDenied("Payment refused: " + decision.reasons.map((r) => r.message).join(" "), decision.reasons);

    if (decision.decision === "needs_approval") {
      const yes = options.approve ? await options.approve({ requirement: decision.requirement, usdMicro: decision.usdMicro, message: decision.message }) : false;
      if (!yes) {
        guard.release(decision.reservationId);
        throw new GuardDenied("Payment refused: " + decision.message, [{ code: "approval_required", message: decision.message }]);
      }
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
