// Our AP2 payment-mandate check against Google's own reference SDK.
//
// tests/vectors/google-ap2-0.2.0.json holds cases that were each run through check_payment_constraints in Google's Python SDK
// (google-agentic-commerce/AP2, commit e1ea56d, 2026-04-29); the SDK's answer was recorded, so no expectation here is hand-written.
// make_vectors.py regenerates the file. Our verdict (allowed or not) must equal the reference's on every case, except the places where
// the reference departs from its own specification or lets something plainly wrong through. Those are named and pinned to the answer
// the specification calls for.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checkAp2PaymentConstraints, budgetLimitMinor } from "../src/index";

interface Case {
  name: string;
  open: any;
  closed: any;
  ctx: { total_amount: number; total_uses: number } | null;
  open_checkout_hash: string | null;
  expected: { parse_error: boolean; violations?: string[] };
}
const cases: Case[] = JSON.parse(readFileSync(new URL("./vectors/google-ap2-0.2.0.json", import.meta.url), "utf8")).cases;

const ours = (c: Case): string[] =>
  checkAp2PaymentConstraints(c.open, c.closed, {
    ...(c.ctx ? { totalAmountMinor: c.ctx.total_amount, totalUses: c.ctx.total_uses } : {}),
    ...(c.open_checkout_hash ? { openCheckoutHash: c.open_checkout_hash } : {}),
  });

const departure = (name: string): string | undefined => {
  if (/^budget max=(0\.29|1\.15|0\.07|19\.99)/.test(name)) return "budget: float truncation in max * 100";
  if (name.startsWith("execution_date")) return "execution_date: compared as text, not as times";
  if (name.startsWith("negative amount")) return "a negative amount is accepted";
  return undefined;
};

describe("AP2 conformance against Google's reference SDK", () => {
  it("agrees on every case except where the reference departs from its own specification", () => {
    const unexplained: string[] = [];
    let agree = 0;
    let known = 0;
    for (const c of cases) {
      const mine = ours(c);
      if (c.expected.parse_error) {
        expect(mine.length, `${c.name}: the reference refuses to parse this`).toBeGreaterThan(0);
        continue;
      }
      if ((mine.length === 0) === (c.expected.violations!.length === 0)) agree++;
      else if (departure(c.name)) known++;
      else unexplained.push(`${c.name}\n  reference: ${JSON.stringify(c.expected.violations)}\n  ours: ${JSON.stringify(mine)}`);
    }
    expect(unexplained, unexplained.join("\n")).toEqual([]);
    expect(known).toBeGreaterThan(0);
    expect(agree).toBeGreaterThan(280);
  });

  it("does what the specification says where the reference does not", () => {
    const find = (n: string) => cases.find((c) => c.name === n)!;
    // Budget: the requested amount plus earlier amounts MUST be less than or equal to max. 0.29 is 29 cents.
    expect(budgetLimitMinor(0.29)).toBe(29);
    expect(budgetLimitMinor(1.15)).toBe(115);
    expect(budgetLimitMinor(0.295)).toBe(29);
    expect(budgetLimitMinor(10)).toBe(1000);
    expect(find("budget max=0.29 spent=0 amount=29").expected.violations!.length).toBeGreaterThan(0);
    expect(ours(find("budget max=0.29 spent=0 amount=29"))).toEqual([]);
    expect(ours(find("budget max=1.15 spent=114 amount=100")).length).toBeGreaterThan(0);
    // Execution date: later than or equal to not_before, earlier than or equal to not_after. Times, not letters.
    const late = find("execution_date window=(None,2026-11-30T23:59:59Z) date=2026-11-30T23:30:00-05:00");
    expect(late.expected.violations).toEqual([]);
    expect(ours(late).some((m) => m.includes("after allowed window"))).toBe(true);
    const inside = find("execution_date window=(None,2026-11-30T23:59:59Z) date=2026-12-01T00:30:00+01:00");
    expect(inside.expected.violations!.length).toBeGreaterThan(0);
    expect(ours(inside)).toEqual([]);
    // The reference accepts a negative amount; we do not.
    expect(ours(find("negative amount")).length).toBeGreaterThan(0);
  });
});
