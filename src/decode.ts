import type { PaymentRequired, PaymentRequirement } from "./types";

export class DecodeError extends Error {}

const DIGITS = /^\d+$/;

function base64ToText(b64: string): string {
  const clean = b64.trim().replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(clean, "base64").toString("utf8");
}

function asString(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "") throw new DecodeError(`Missing or invalid "${name}" in the payment request.`);
  return v;
}

/** Reads one entry of "accepts". Version 1 called the amount "maxAmountRequired". */
function readRequirement(raw: unknown): PaymentRequirement {
  if (typeof raw !== "object" || raw === null) throw new DecodeError("A payment option is not an object.");
  const r = raw as Record<string, unknown>;
  const amount = r.amount ?? r.maxAmountRequired;
  const amountText = typeof amount === "number" && Number.isSafeInteger(amount) ? String(amount) : amount;
  if (typeof amountText !== "string" || !DIGITS.test(amountText)) throw new DecodeError("A payment option has an amount that is not a whole number of smallest units.");
  const out: PaymentRequirement = {
    scheme: asString(r.scheme, "scheme"),
    network: asString(r.network, "network"),
    amount: amountText.replace(/^0+(?=\d)/, ""),
    asset: asString(r.asset, "asset"),
    payTo: asString(r.payTo, "payTo"),
  };
  if (typeof r.maxTimeoutSeconds === "number") out.maxTimeoutSeconds = r.maxTimeoutSeconds;
  if (typeof r.extra === "object" && r.extra !== null) out.extra = r.extra as Record<string, unknown>;
  if (typeof r.resource === "string") out.resource = r.resource;
  return out;
}

/** Turns a parsed message into the shape the guard uses. Refuses anything that is not clearly a payment request. */
export function normalisePaymentRequired(raw: unknown): PaymentRequired {
  if (typeof raw !== "object" || raw === null) throw new DecodeError("The payment request is not an object.");
  const o = raw as Record<string, unknown>;
  const version = typeof o.x402Version === "number" ? o.x402Version : 1;
  if (version !== 1 && version !== 2) throw new DecodeError(`x402 version ${version} is not supported.`);
  if (!Array.isArray(o.accepts) || o.accepts.length === 0) throw new DecodeError("The payment request lists no way to pay.");
  if (o.accepts.length > 20) throw new DecodeError("The payment request lists too many options.");
  const out: PaymentRequired = { x402Version: version, accepts: o.accepts.map(readRequirement) };
  if (typeof o.error === "string") out.error = o.error;
  if (typeof o.resource === "object" && o.resource !== null) {
    const res = o.resource as Record<string, unknown>;
    out.resource = { url: asString(res.url, "resource.url") };
    if (typeof res.description === "string") out.resource.description = res.description;
    if (typeof res.mimeType === "string") out.resource.mimeType = res.mimeType;
  }
  return out;
}

/** Reads the PAYMENT-REQUIRED header (base64 of JSON) used by version 2 over HTTP. */
export function decodePaymentRequiredHeader(value: string): PaymentRequired {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64ToText(value));
  } catch {
    throw new DecodeError("The PAYMENT-REQUIRED header is not valid base64 JSON.");
  }
  return normalisePaymentRequired(parsed);
}

/**
 * Finds the payment request in an HTTP 402 response: the PAYMENT-REQUIRED header (version 2) first,
 * then a JSON body (version 1).
 */
export async function readPaymentRequired(res: Response): Promise<PaymentRequired> {
  const header = res.headers.get("payment-required");
  if (header) return decodePaymentRequiredHeader(header);
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    throw new DecodeError("The 402 response has no PAYMENT-REQUIRED header and no JSON body.");
  }
  return normalisePaymentRequired(body);
}

export function encodePaymentHeader(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}
