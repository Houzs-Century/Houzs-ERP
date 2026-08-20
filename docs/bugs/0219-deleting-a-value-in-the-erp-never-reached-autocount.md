## Deleting a value in the ERP never reached AutoCount [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Shown the four transitions an edit can make, the owner stopped at
the last one:

| ERP | sent | AutoCount |
|---|---|---|
| blank -> blank | no | unchanged |
| blank -> 8/25 | yes | 8/25 |
| 8/20 -> 8/25 | yes | 8/25 |
| **8/20 -> blank** | **no** | **still 8/20** |

*"这个也是要跟啊 为什么不跟?"* — and then the rule for everything:
*"任何情况 ERP update 就是都要跟就对了，无论什么，除非 update 不进去."*

**Root cause.** `soEditHeader` omits any key whose ERP column is empty, and that
rule was RIGHT for the case it was written for. On 2026-08-14 the opposite had
just been fixed: eight header keys were emitted as `x ?? null` unconditionally,
and since `Str` turns a present-null into `""`, every edit blanked whatever the
account book held wherever the ERP's column was empty — `ref` on 112 of 115
orders, `address3`/`address4` on 94.

Omitting fixed that and created this: the composer reads the SAVED row, where
*never had a value* and *just deleted the value* are the same empty column. It
cannot tell them apart, so it chose the side that cannot destroy data, and
clearing became inexpressible.

**Fix, and it is a shape this repo already had.** `enqueueEdit` grows
`touchedFields` — the ERP columns THIS REQUEST wrote — exactly as it already
carries `newLineIds`, and for the same stated reason: a keyless line means two
opposite things and *"the ERP is therefore not allowed to infer it: the route
that did the adding says so"*. The header PATCH is the only caller that passes
any, and `Object.keys(updates)` is precisely the set, because that loop only
adds a key the request body carried.

A key is nulled only when the route says it was WRITTEN and the saved value is
now empty. Written-and-still-empty is a deletion; not written is silence.

**What may NOT be cleared, which is the load-bearing half:**

| field | why |
|---|---|
| `agent` | `FK_SO_SalesAgent`. A blank Agent is not an empty field, it is a foreign-key failure that loses the whole document |
| `sales_location` | same shape, and company 1 cannot save an order without one anyway (`so-location-gate.ts`) |
| `debtor_name` | also travels as `Attention`; an order with no customer name is not a state the ERP can produce |
| line `ItemCode` | never re-sent on a line the book already owns |

The address is treated as ONE package: `soInvoiceAddress` folds five ERP columns
into four lines, so clearing one re-shuffles the rest and there is no
field-by-field answer. Touching any of them sends all four `InvAddr` keys.

A UDF clears with `""` rather than a null, because `ApplyUdf` writes
`kv.Value == null ? "" : kv.Value.ToString()` and `""` is what the book stores.

`touchedFields` is OPTIONAL, which the optional-param-noop rule normally
forbids. It is allowed here on the exemption that rule names: its absence is the
STRICTER direction — nothing is cleared, which is the behaviour before this
existed — and every other caller is a line operation that did not touch the
header, so `[]` is the honest value and not a default standing in for one.

No C# change: `Str` already turns a present-null into `""`, which is the clear.

Three of the new cases were observed RED with the rule neutralised.

**Ref.** 2026-08-15, PR #2249.
