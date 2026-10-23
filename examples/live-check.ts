/**
 * Ask the LIVE Kaldrix test service whether a payment is allowed, without making any x402 payment.
 *
 *   KALDRIX_AGENT_KEY=...  (the limited key from "Connect your own AI assistant" in your Kaldrix dashboard)
 *   KALDRIX_URL=https://kaldrix-sandbox.onrender.com   (optional)
 *   KALDRIX_WALLET=0x...   the wallet address that stands for your supplier
 *   KALDRIX_SUPPLIER=acme  the id of that supplier in your Kaldrix account
 *   AMOUNT_MICRO_USD=10000 (optional, millionths of a dollar; default 10000 = one cent)
 *
 * It reads the agent's key and the permissions you gave it from the Kaldrix connector's own file
 * (~/.kaldrix/connector.json, or $KALDRIX_HOME). Run:  npx tsx examples/live-check.ts
 *
 * This records a payment to a PRETEND bank in your own test account. No real money, no blockchain.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { KaldrixAuthority } from "../src/index";

const need = (n: string): string => {
  const v = process.env[n];
  if (!v) {
    console.error(`Set ${n} first (see the top of this file).`);
    process.exit(1);
  }
  return v;
};

const home = process.env.KALDRIX_HOME ?? path.join(homedir(), ".kaldrix");
const state = JSON.parse(readFileSync(path.join(home, "connector.json"), "utf8")) as { agent_seed_hex: string; permissions: never[] };
const wallet = need("KALDRIX_WALLET");

const authority = new KaldrixAuthority({
  baseUrl: process.env.KALDRIX_URL ?? "https://kaldrix-sandbox.onrender.com",
  agentKey: need("KALDRIX_AGENT_KEY"),
  agentSeedHex: state.agent_seed_hex,
  permissions: state.permissions,
  recipientByWallet: { [wallet]: need("KALDRIX_SUPPLIER") },
});

const usdMicro = BigInt(process.env.AMOUNT_MICRO_USD ?? "10000");
const answer = await authority.authorize({
  requirement: { scheme: "exact", network: "eip155:84532", amount: String(usdMicro), asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: wallet, maxTimeoutSeconds: 60 },
  usdMicro,
  resourceUrl: "https://api.example.com/demo",
  attemptId: `live-check-${Date.now()}`,
});
console.log(JSON.stringify(answer, null, 2));
