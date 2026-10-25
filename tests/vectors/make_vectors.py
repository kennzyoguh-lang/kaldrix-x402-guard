"""Run a wide set of mandate cases through Google's own AP2 reference SDK and record what it says.

The recorded answers become test vectors for our own implementation. Nothing here is hand-written as an expectation: the
expected output of every case is whatever the reference SDK returned.
"""
import itertools
import json
import sys

sys.path.insert(0, "repo/code/sdk/python")

from ap2.sdk.constraints import MandateContext, check_payment_constraints  # noqa: E402
from ap2.sdk.generated.open_payment_mandate import OpenPaymentMandate  # noqa: E402
from ap2.sdk.generated.payment_mandate import PaymentMandate  # noqa: E402

CNF = {"jwk": {"kty": "EC", "crv": "P-256", "x": "x", "y": "y"}}
cases = []


def closed(amount=1000, currency="USD", payee=None, instrument=None, pisp=None, execution_date=None):
    c = {
        "transaction_id": "tx_1",
        "payee": payee or {"id": "s-1", "name": "Shop", "website": "https://shop.com"},
        "payment_amount": {"amount": amount, "currency": currency},
        "payment_instrument": instrument or {"id": "pi-1", "type": "credit"},
    }
    if pisp is not None:
        c["pisp"] = pisp
    if execution_date is not None:
        c["execution_date"] = execution_date
    return c


def add(name, constraints, closed_mandate, ctx=None, hash_=None, open_extra=None):
    open_mandate = {"constraints": constraints, "cnf": CNF}
    open_mandate.update(open_extra or {})
    rec = {"name": name, "open": open_mandate, "closed": closed_mandate, "ctx": ctx, "open_checkout_hash": hash_}
    try:
        o = OpenPaymentMandate(**open_mandate)
        c = PaymentMandate(**closed_mandate)
    except Exception as e:  # the reference refuses to even build the mandate
        rec["expected"] = {"parse_error": True, "detail": type(e).__name__}
        cases.append(rec)
        return
    context = MandateContext(total_amount=ctx["total_amount"], total_uses=ctx["total_uses"]) if ctx is not None else None
    violations = check_payment_constraints(o, c, open_checkout_hash=hash_, mandate_context=context)
    rec["expected"] = {"parse_error": False, "violations": violations}
    cases.append(rec)


# ---- amount range
for mx, mn, amt, cur in itertools.product([1000], [None, 500], [0, 499, 500, 1000, 1001], ["USD", "EUR"]):
    k = {"type": "payment.amount_range", "max": mx, "currency": "USD"}
    if mn is not None:
        k["min"] = mn
    add(f"amount_range max={mx} min={mn} amount={amt} cur={cur}", [k], closed(amt, cur))

# ---- payees (by id, by name+website, name only)
payees = {
    "by_id": [{"id": "s-1", "name": "Other"}],
    "by_name_site": [{"id": "", "name": "Shop", "website": "https://shop.com"}],
    "name_only": [{"id": "", "name": "Shop"}],
    "none_match": [{"id": "z-9", "name": "Zed", "website": "https://z.com"}],
}
payee_in = {
    "id_match": {"id": "s-1", "name": "Shop", "website": "https://shop.com"},
    "id_differs": {"id": "s-2", "name": "Shop", "website": "https://shop.com"},
    "no_id_name_site": {"id": "", "name": "Shop", "website": "https://shop.com"},
    "no_id_no_site": {"id": "", "name": "Shop"},
}
for (pn, allowed), (qn, payee) in itertools.product(payees.items(), payee_in.items()):
    add(f"payees {pn} vs {qn}", [{"type": "payment.allowed_payees", "allowed": allowed}], closed(payee=payee))

# ---- budget: whole units against minor units, with float maths
for mx, spent, amt in itertools.product([10, 0.29, 1.15, 100.5, 0.07, 19.99], [0, 28, 29, 114, 115, 1998, 1999], [1, 28, 29, 100]):
    add(f"budget max={mx} spent={spent} amount={amt}", [{"type": "payment.budget", "max": mx, "currency": "USD"}], closed(amt), ctx={"total_amount": spent, "total_uses": 0})
add("budget no context", [{"type": "payment.budget", "max": 10, "currency": "USD"}], closed(100))
add("budget wrong currency", [{"type": "payment.budget", "max": 10, "currency": "EUR"}], closed(100), ctx={"total_amount": 0, "total_uses": 0})

# ---- recurrence
for mo, uses, with_range, with_budget in itertools.product([None, 1, 2], [0, 1, 2], [True, False], [True, False]):
    cs = [{"type": "payment.agent_recurrence", "frequency": "DAILY", "max_occurrences": mo}] if mo is not None else [{"type": "payment.agent_recurrence", "frequency": "DAILY"}]
    if with_range:
        cs.append({"type": "payment.amount_range", "max": 5000, "currency": "USD"})
    if with_budget:
        cs.append({"type": "payment.budget", "max": 1000, "currency": "USD"})
    add(f"recurrence max={mo} uses={uses} range={with_range} budget={with_budget}", cs, closed(100), ctx={"total_amount": 0, "total_uses": uses})
add("recurrence no context", [{"type": "payment.agent_recurrence", "frequency": "DAILY", "max_occurrences": 2}, {"type": "payment.amount_range", "max": 5000, "currency": "USD"}, {"type": "payment.budget", "max": 1000, "currency": "USD"}], closed(100))
for f in ["ON_DEMAND", "DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "ANNUALLY"]:
    add(f"recurrence frequency {f} is not what limits it", [{"type": "payment.agent_recurrence", "frequency": f, "max_occurrences": 1}, {"type": "payment.amount_range", "max": 5000, "currency": "USD"}, {"type": "payment.budget", "max": 1000, "currency": "USD"}], closed(100), ctx={"total_amount": 0, "total_uses": 1})

# ---- execution dates: the reference compares the TEXT of the dates
windows = [
    ("2026-11-01", "2026-11-30T23:59:59Z"),
    ("2026-11-30T00:00:00Z", None),
    (None, "2026-11-30T23:59:59Z"),
    ("2026-11-01T00:00:00Z", "2026-11-30T23:59:59Z"),
]
dates = [
    "2026-11-15", "2026-10-31", "2026-12-01", "2026-11-30", "2026-11-30T23:30:00-05:00", "2026-12-01T00:30:00+01:00",
    "2026-11-30T23:59:59Z", "2026-11-30T23:59:59.500Z", "2026-11-30T12:00:00Z", "2026-11-30T12:00:00+00:00", "2026-11-30 12:00:00", "not a date", "20261130",
]
for (nb, na), d in itertools.product(windows, dates):
    k = {"type": "payment.execution_date"}
    if nb:
        k["not_before"] = nb
    if na:
        k["not_after"] = na
    add(f"execution_date window=({nb},{na}) date={d}", [k], closed(execution_date=d))
add("execution_date absent on the closed mandate", [{"type": "payment.execution_date", "not_before": "2026-11-01"}], closed())

# ---- instruments, PISPs, references, pre-set claims, unknown types
for inst in [{"id": "pi-1", "type": "credit"}, {"id": "pi-2", "type": "credit"}]:
    add(f"instrument {inst['id']}", [{"type": "payment.allowed_payment_instruments", "allowed": [{"id": "pi-1", "type": "credit"}]}], closed(instrument=inst))
pisp = {"domain_name": "pay.example", "legal_name": "Pay Ltd", "brand_name": "Pay"}
for name, p in [("same", pisp), ("other brand", {**pisp, "brand_name": "Other"}), ("missing", None)]:
    add(f"pisp {name}", [{"type": "payment.allowed_pisps", "allowed": [pisp]}], closed(pisp=p))
for h in [None, "", "abc", "def"]:
    add(f"reference hash={h!r}", [{"type": "payment.reference", "conditional_transaction_id": "abc"}], closed(), hash_=h)
add("preset payee mismatch", [], closed(), open_extra={"payee": {"id": "z-1", "name": "Zed", "website": "https://z.com"}})
add("preset payee match", [], closed(), open_extra={"payee": {"id": "s-1", "name": "Shop"}})
add("preset amount mismatch", [], closed(1000), open_extra={"payment_amount": {"amount": 999, "currency": "USD"}})
add("preset amount match", [], closed(1000), open_extra={"payment_amount": {"amount": 1000, "currency": "USD"}})
add("preset instrument mismatch", [], closed(), open_extra={"payment_instrument": {"id": "pi-9", "type": "credit"}})
add("preset instrument same id different type", [], closed(), open_extra={"payment_instrument": {"id": "pi-1", "type": "debit"}})
add("preset execution date mismatch", [], closed(execution_date="2026-11-15"), open_extra={"execution_date": "2026-11-16"})
add("preset execution date match", [], closed(execution_date="2026-11-15"), open_extra={"execution_date": "2026-11-15"})
add("preset instrument same id and type, different description", [], closed(instrument={"id": "pi-1", "type": "credit", "description": "Visa 4242"}), open_extra={"payment_instrument": {"id": "pi-1", "type": "credit"}})
add("preset instrument absent on the closed side is not allowed to be skipped", [], closed(), open_extra={"payment_instrument": {"id": "pi-1", "type": "credit", "description": "Visa"}})
add("negative amount with a budget and a range", [{"type": "payment.amount_range", "max": 1000, "currency": "USD"}, {"type": "payment.budget", "max": 10, "currency": "USD"}], closed(-500), ctx={"total_amount": 1000, "total_uses": 0})
add("unknown constraint type", [{"type": "payment.something_new"}], closed())
add("no constraints", [], closed())
add("expired open mandate (reference does not check)", [], closed(), open_extra={"exp": 1, "iat": 1})
add("negative amount", [{"type": "payment.amount_range", "max": 1000, "currency": "USD"}], closed(-5))

json.dump({"source": "google-agentic-commerce/AP2 code/sdk/python/ap2/sdk/constraints.py", "cases": cases}, open("vectors.json", "w"), indent=1)
print(len(cases), "cases;", sum(1 for c in cases if c["expected"].get("parse_error")), "refused at parse")
