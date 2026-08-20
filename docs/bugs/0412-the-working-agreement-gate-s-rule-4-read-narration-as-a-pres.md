## The working-agreement gate's rule 4 read narration as a prescription, and turned `main` red [medium]

**Symptom.** Hours after the Chinese patterns landed, every PR failed
`working-agreement` on its own noise-isolation test. The offending line was
ordinary repo prose in `BUG-HISTORY.md`:

    ...独立轻接口补上。功能不变。至此「列表白跑 MRP」这个病的四处...

**Root cause (traced, not guessed).** 「跑 MRP」 matches the 跑 + latin-token
pattern (added so 「跑 all 模式」 would be caught) and 「补上」 matches the promise
vocabulary. The detector searched the whole window for a promise, so it did not
notice that **补上 sits BEFORE 跑 MRP**, in a different clause. The sentence
describes a disease already cured; it prescribes nothing.

**Fix.** The rule that was missing holds in both languages: a remedy claim reads
**instruction, then promise** — "Run X and it collects Y", 「跑这个就能补回来」. The
promise is now sought only in the text AFTER the instruction ends, so
`prescribes()` returns the match rather than a boolean.

**What makes this entry worth reading later:** the gate was NOT caught by review.
It was caught by the noise-isolation test shipped in the same PR as the Chinese
patterns, whose only job was to stop them getting chatty — and which failed on
real repo prose within hours of the corpus growing. The `BUG-HISTORY` sentence is
now pinned verbatim as a fixture alongside the two orderings that must STILL read
as claims, so the gate cannot later be "fixed" by quietly switching it off.

**Ref.** `fix/remedy-claim-promise-must-follow`, 2026-08-19.
