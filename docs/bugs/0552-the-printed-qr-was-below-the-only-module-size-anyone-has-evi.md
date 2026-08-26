## The printed QR was below the only module size anyone has evidence for [medium]

**Symptom.** The owner asked for the code on the delivery order to be SMALLER —
2026-08-27: 「我不要 16mm，只想要 10mm（太大了可能会有影响）」. Nobody had reported
a scan failure; nobody had measured the code either.

**What the measurement found.** A QR's readability is its MODULE size — the width
of one square — not its overall size, and the module count comes from the
payload. The delivery order encoded a 95-character URL (`/d/` plus a 64-hex
token) into 41 modules, printed at 16mm:

| | modules | printed | per module |
|---|---|---|---|
| Houzs, before | 41 | 16mm | **0.356mm** |
| Hookka, on a floor today | 49 | 22mm | **0.415mm** |

**0.415mm is the only number with field evidence behind it** — Hookka's delivery
QR runs at it in a warehouse. Houzs was 14% below that and had never been
compared.

**10mm was refused, with the arithmetic.** The smallest QR that exists is 21
modules square, so 10mm cannot carry a URL at a readable module size no matter
how short the link — even a hypothetical `hzs.my/xxxx` lands at 0.303mm, WORSE
than the 16mm it would replace. This was put to the owner rather than
implemented.

**Fix, and it is a pair — neither half works alone.** Shortening the token from
64 characters to 10 drops the code from 41 modules to 29, so **14mm gives
0.424mm: 12% smaller on the sheet than before AND better to scan than before.**
Making the box smaller without shortening the payload would have made a worse
code; shortening the payload without shrinking the box would have ignored what
was asked for.

**A correction I made to the owner along the way.** I first quoted 0.6mm as the
threshold and 12 characters as the token length. 0.6mm was textbook guidance, not
evidence — Hookka's working 0.415mm is better information and I replaced it. And
12 characters still needs 33 modules, which at 14mm is 0.378mm; the figure I had
given him assumed a short DOMAIN we do not own. 10 characters is what actually
reaches 29 modules with `erp.houzscentury.com`.

**Is 50 bits enough?** Yes, and the reason is that this credential is not
offline-attackable: guessing means asking this server, which admits 300 reads per
quarter-hour per address and answers a miss identically to a revoked token.
Against 32^10 ≈ 1.1e15 that is not a search anyone finishes. The 244 bits it
replaced were free when they were chosen and are not free now — they cost a
quarter of a millimetre of print.

**NOTHING ALREADY PRINTED STOPS WORKING**, and this is the part that had to be
got right rather than noticed later. The shape gate accepts BOTH forms, only the
short one is minted from now on, and `drawQrIntoPdf` now treats the requested
size as a FLOOR TO GROW FROM: a delivery order still carrying a legacy token
prints at the size that token needs instead of being squeezed into 14mm. A sheet
that looks right and does not scan is discovered at the lorry.

**The alphabet is Crockford's** — no `i`, `l`, `o` or `u`. Not decoration: a
warehouse reads these off paper and phones them in when a code will not scan, and
`1/l/I` and `0/O` are the pairs that get read back wrong.

**Three tests, each RED-checked.** The drawer's floor is swept across sizes and
both payloads (removing the floor fails it). The minter is asked for 500 tokens
rather than grepped for an expression — the old test pinned the exact source line
that built it, which had to be rewritten to change an implementation detail and
said nothing about the values. And `public-do-scan-token-shape.test.ts` reads the
page's URL parser and the server's gate and asserts they accept the same set: two
regexes in two files for one fact, whose drift is silent in the worst way — the
page would DROP a scan the server would have resolved, and the operator would see
a code that "does not scan".

**Ref.** feat/the-printed-qr-gets-smaller-and-easier-to-scan, 2026-08-27.
