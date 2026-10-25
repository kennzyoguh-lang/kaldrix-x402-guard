"""Reproduces three behaviours of google-agentic-commerce/AP2 `ap2.sdk.constraints.check_payment_constraints` (checked at e1ea56d).

Run from a checkout of the AP2 repository, with its dependencies installed:

    PYTHONPATH=code/sdk/python python repro_reference_findings.py
"""
from ap2.sdk.constraints import MandateContext, check_payment_constraints
from ap2.sdk.generated.open_payment_mandate import OpenPaymentMandate
from ap2.sdk.generated.payment_mandate import PaymentMandate

CNF = {"jwk": {"kty": "EC", "crv": "P-256", "x": "x", "y": "y"}}


def closed(amount=1000, execution_date=None):
    c = {
        "transaction_id": "tx_1",
        "payee": {"id": "s-1", "name": "Shop"},
        "payment_amount": {"amount": amount, "currency": "USD"},
        "payment_instrument": {"id": "pi-1", "type": "credit"},
    }
    if execution_date:
        c["execution_date"] = execution_date
    return PaymentMandate(**c)


def run(constraints, closed_mandate, ctx=None):
    return check_payment_constraints(OpenPaymentMandate(constraints=constraints, cnf=CNF), closed_mandate, mandate_context=ctx)


print("1. A budget of 0.29 USD (29 cents) and a payment of exactly 29 cents. The specification says the total MUST be <= max.")
print("   violations:", run([{"type": "payment.budget", "max": 0.29, "currency": "USD"}], closed(29), MandateContext(total_amount=0, total_uses=0)))
print("   int(0.29 * 100) =", int(0.29 * 100), "| int(1.15 * 100) =", int(1.15 * 100))

window = {"type": "payment.execution_date", "not_after": "2026-11-30T23:59:59Z"}
print()
print("2. not_after = 2026-11-30T23:59:59Z. 23:30 on 30 Nov at UTC-5 is 04:30Z on 1 Dec: AFTER the window.")
print("   violations:", run([window], closed(execution_date="2026-11-30T23:30:00-05:00")))
print("   00:30 on 1 Dec at UTC+1 is 23:30Z on 30 Nov: INSIDE the window.")
print("   violations:", run([window], closed(execution_date="2026-12-01T00:30:00+01:00")))
print("   not_before = 2026-11-30T00:00:00Z, and a date written with a space instead of T, at noon that day:")
print("   violations:", run([{"type": "payment.execution_date", "not_before": "2026-11-30T00:00:00Z"}], closed(execution_date="2026-11-30 12:00:00")))

print()
print("3. A negative payment amount against an amount_range with no minimum:")
print("   violations:", run([{"type": "payment.amount_range", "max": 1000, "currency": "USD"}], closed(-5)))
