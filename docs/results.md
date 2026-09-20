# Results — three opt-in knobs on DeepSeek Harness (dsh)

Every table below is the result recorded for this run. Each table is preceded by a one-line note of its measurement conditions; engine-level measurements can be reproduced by readers with the published flags, private-bank scores are reported only.

## 1. The three knobs

Baseline = rc.1 defaults: `tools` standard, `tools_mode` native, no `fanout`. Measurements taken on a single local endpoint of the two-node (head node + worker node, TP2 over RoCE) Dell Pro Max with GB10 cluster serving V4-Flash locally.

| Knob | Measurement condition | Result | Verdict |
|---|---|---|---|
| `tools=minimal` | first request of one fixed task, two runs, prompt size verbatim-identical | tool set 24→10; prompt −41% | Recommended for read-only audit packets, only if the packet needs no iterative-loop tool / sub-agent delegation |
| `tools_mode=ptc` | one fixed multi-step task, 12 rounds each, native vs ptc, correctness by a deterministic check (not published) | correctness native 9/12 vs ptc 11/12 — but the last 8 rounds were 8/8 for both sides; median tokens +33%; wall +45% | Not default: on this task the accuracy edge of ptc did not hold in the last eight rounds (8/8 both) while the token cost stayed +33%; enable per-need only for batch-statistics tasks where the native model would guess numbers |
| `fanout` | "review four small files for one risk each"; 4 fast-tier workers + 1 planning-tier checker, single local endpoint, one run per arm; wall and total tokens summed over root + worker sessions; mechanism checks: workflow called exactly once, plain sub-agent calls 0, per-item retries ≤1, no unfinished items, checker completed, peak concurrency ≤4 | mechanism fully worked; wall 2.0×; total tokens 4.8× | Not default: on one local endpoint fan-out did not save wall time on this small task (checker long-tail thinking + each worker re-reads context); whether a single endpoint benefits from fan-out depends on item count and is not established by this one four-file run |

## 2. The provider-layer timeout/retry trap (fan-out root cause)

Condition: applied identically to the fast/planning/long-context tier providers; the longest single generation measured was ~200 s (the checker, planning tier, thinking on).

| Item | Value |
|---|---|
| pi-ai provider-layer defaults | timeout 60 s, retries 5 — a single generation over the default was judged failed and silently retried 5×; this was the first true root cause of the two early fan-out timeouts |
| Longest single generation actually measured | ~200 s (the checker, planning tier, thinking on) |
| Final policy (applied identically to the fast/planning/long-context tier providers) | `timeoutMs: 600000`, `retryPolicy.maxRetries: 1`; rule: the total time for a call (timeout × (1 + retries) plus backoff and overhead) must stay clearly smaller than the packet wall; multiple calls in one packet need their budget summed |
| Iteration note | first version set 900 s; a review caught that 900×2 would collide with the wrapper's default wall of 1800 s (600×2=1200 stays below), so it was lowered to 600 s |
| Real hangs | handled by the wrapper's wall timeout (exit 124), not by provider-layer retries |
| Rollback | `git checkout` the three per-profile provider config files restores the old default pair |

## 3. GC retention

Condition: dry-run-by-default reclamation over three append-only directories; first monitored real run before enabling the weekly schedule.

| Item | Value / condition |
|---|---|
| Targets | three append-only directories (worktrees, per-job session evidence, outputs), reclaimed by directory mtime; script defaults to dry-run, `--apply` deletes |
| Evidence-chain rule | directories referenced by the A/B ledger, plus the session dirs whose job ids appear in their JSONs, are kept for `EVIDENCE_DAYS` = 180 days; everything else by `DAYS` (a permanent exemption was unanimously rejected on review) |
| Traceability | every dir gets an `intent` ledger line before deletion, then a `delete` / `delete-failed` line after; each run writes a `run` summary line — the garbage collector writes an intent record before deleting and a completion record after, so a deletion without a record would require both writes to fail |
| Fail-closed | missing interpreter or any break in the evidence-chain parsing pipeline → refuse to run (exit 3, better not to delete); paths use NUL-safe traversal + absolute-prefix assertions |
| First monitored real run | `DAYS=3` deleted 84 directories (with a tar backup), then automation was enabled |
| Schedule | weekly scheduled job, Sunday 04:30, `DAYS=30`; rollback = remove the job label |

## 4. The per-agent output-budget limit (fan-out hard constraint)

Condition: same mechanism across variants; control = the same mechanism on 4 small library files; fast tier with thinking off.

| Item | Value / condition |
|---|---|
| Budget | fast tier (thinking off) caps each agent at maxTokens 8192; V4-Flash writes its reasoning into the content channel for "long document + open-ended judgment," burning the budget |
| 15-cookbook audit | the 15-document audit failed under every arrangement we tried (sequential, fan-out 2, fan-out 4) within an 8,192-token per-agent output budget; smaller allocations per agent were not tested; coverage 0/15 |
| Control | the same mechanism on 4 small library files passed completely |
| Cost scale | 1.3–1.8M tokens per variant (no external API token cost; local run cost not recorded) — 10× the small-task fan-out |
| Honest conclusion boundary | data supports only "fast tier ≥ 4 long READMEs per agent is infeasible"; 1–2 books per agent and planning-tier workers are undecided (the exploratory run was masked by a root-model allocation error; root cause not fully investigated). No threshold was written into any capability or template; next real task: dispatch 1 long item per agent, or prove a single planning-tier item first |
| Outcome note | the risk table for that run was not produced (no fabrication) |

## 5. What did not work (summary index)

Condition: each negative result referenced to its table above; no thresholds were moved after the fact.

| Negative result | Where the numbers are |
|---|---|
| ptc correctness advantage (native 9/12 vs ptc 11/12 collapses to a tie on the last 8 rounds) while median token and wall costs rise | §1 |
| fan-out as a wall-time saver on small tasks on a single local endpoint (and its token blow-up) | §1 |
| The first two fan-out runs (provider-layer timeout + silent retry storm) | §2 |
| The initial 900 s timeout value (would collide with the wrapper wall) | §2 |
| 15-book audit under every parallelism setting (max-tokens / timeout, zero coverage) | §4 |
| Any threshold generalization from the ladder — explicitly declined for lack of data | §4 |
