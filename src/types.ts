/** The parts of the x402 message formats this library reads. Version 2 is the current one; version 1 is read too. */

export interface PaymentRequirement {
  scheme: string;
  /** CAIP-2 network id, for example "eip155:84532". */
  network: string;
  /** Amount in the asset's smallest unit, as a string of digits. */
  amount: string;
  /** Token contract address, or a currency code for fiat. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  /** Set only when read from a version 1 message. */
  resource?: string;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource?: ResourceInfo;
  accepts: PaymentRequirement[];
}

export interface EvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirement;
  payload: { signature?: string; authorization?: EvmAuthorization; [k: string]: unknown };
}

/** A token the policy accepts. Anything not listed is refused. */
export interface AssetRule {
  network: string;
  asset: string;
  symbol: string;
  decimals: number;
  /** Millionths of a US dollar that one whole token is worth. Defaults to 1,000,000 (a dollar stablecoin). */
  usdMicroPerToken?: number;
}

export interface Policy {
  allowedAssets: AssetRule[];
  /** Recipient addresses. Compared without regard to upper or lower case. */
  allowedRecipients: string[];
  /** Websites the agent may pay. "api.example.com" or "*.example.com". Empty or missing means any website. */
  allowedHosts?: string[];
  /** Defaults to ["exact"]. */
  allowedSchemes?: string[];
  maxPerPaymentUsd: number;
  maxTotalUsd?: number;
  speed?: { windowMs: number; maxUsd: number };
  /** Refuse a request that leaves the payment valid for longer than this. */
  maxTimeoutSeconds?: number;
  /** A payment above this waits for a person. */
  requireApprovalAboveUsd?: number;
  /** After this time (milliseconds since 1970) every payment is refused. */
  expiresAt?: number;
  /** If set, a signed payment must come from this address. */
  payerAddress?: string;
  /** Refuse an identical payment (same site, recipient, asset and amount) within this window. Default 5 minutes. Use 0 to switch off. */
  duplicateWindowMs?: number;
}

export type Reason = { code: string; message: string };

export type Decision =
  | { decision: "allow"; requirement: PaymentRequirement; usdMicro: bigint; reservationId: string }
  | { decision: "needs_approval"; requirement: PaymentRequirement; usdMicro: bigint; reservationId: string; message: string }
  | { decision: "deny"; reasons: Reason[] };
