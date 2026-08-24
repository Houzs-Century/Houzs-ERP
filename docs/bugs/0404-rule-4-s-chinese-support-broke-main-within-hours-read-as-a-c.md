## Rule 4's Chinese support broke main within hours — 白跑 read as a command [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**白话.** 下午刚教会检查器看中文的「跑一下就能修好」这类空头承诺，晚上它自己就红了。
原因:同一天另一条修复记录里写了「列表**白跑** MRP」—— 意思是列表**白白地**跑了一次
MRP,纯粹在描述浪费 —— 但检查器看到「跑 + 英文词」就当成是在叫人跑命令,再配上同段
后面的「补上」,就凑成了一条「承诺」。它自己的「中文模式不能带来杂音」测试当场失败,
主干上每一个 PR 的 working-agreement 检查从此全红。修法是一个字:跑 前面是 白 或 空
的,不算命令。

**Symptom.** Every PR's `working-agreement` check fails on main with
`not ok — the Chinese patterns add NO noise to the existing corpus`, pointing at
a line of #2488's entry. Nothing any PR author did causes or can avoid it.

**Root cause (traced).** Two same-day merges interacting. #2489 taught rule 4 to
read Chinese remedy claims; its `跑 + Latin-token` exception ("a command being
named") documents why the RIGHT side cannot collide — 跑了/跑得/跑步 continue in
CJK. #2488's entry then collided from the LEFT: 「列表白跑 MRP」 — the list ran
MRP *for nothing* — is narration about waste, and 白跑 + `MRP` matched the
exception. With 「补上」 later in the same 白话 passage, the pair read as
prescription + outcome, i.e. a claim. The corpus test — kept precisely so "a
later pattern edit cannot quietly make the gate chatty" — did its job and went
red; it just went red for the author's own next entry, on every PR after it.

**Fix.** The exception refuses a vain-run prefix: `(?<![白空])跑\s*[A-Za-z…]`.
白跑/空跑 state that a run achieved nothing, which is as far from prescribing
one as Chinese gets. Three-case regression pin beside the corpus test: the real
#2488 sentence is not a claim, 空跑 likewise, and a genuine run-this-mode
command still fires (the quoted shapes live in the TEST, deliberately — writing
one out verbatim HERE would itself be corpus noise, which the first draft of
this entry proved by failing the very test it describes). Self-test 42/42.

**Ref.** fix/cn-prescription-vain-run, 2026-08-19. Unblocks every open PR.
