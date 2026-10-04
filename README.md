![banner](docs/assets/banner.png)

# Three opt-in knobs on DeepSeek Harness (dsh) — two Dell Pro Max with GB10

> A measured test of the three community-proposed "make dsh stronger" levers — per-job tool hiding (`tools=minimal`), programmatic tool calling (`tools_mode=ptc`), and workflow fan-out — wired into the packet schema of DeepSeek Harness (dsh) at the **rc.1** baseline, on two Dell Pro Max with GB10 nodes serving V4-Flash locally over a RoCE link as head node + worker node (TP2). Each lever was tested with a same-task A/B script whose pass/fail thresholds were fixed **before** running, and negative results were recorded as-is without moving the thresholds. Only one knob was an unambiguous win; two were net losses; and two structural traps — an early timeout/retry storm attributed to provider policy and a per-agent output-budget ceiling — turned out to be the real story behind fan-out's failures. The original measurements below retain their recorded conditions; engine-level measurements can be reproduced by readers with the published flags, private-bank scores are reported only.

## Update (2026-10)

The `timeoutMs: 600000` / `retryPolicy.maxRetries: 1` policy remains the policy used in the original runs, where time to first token was short. It is not the end state for long cold prefill: two independent 300 s idle limits remain on the streaming path, and the job wall must accommodate the intended request. The original measured knob results below are unchanged.

Evidence labels: **M** = measured; **S** = source reading; **R** = scaled-down offline reproduction; **O** = observed once; **E** = estimated or derived by arithmetic from measured numbers. Historical results below are reported evidence, not fresh measurements from the published probe's tests.

### Four timeout layers

Condition (**S**, with the reproductions and probes below): DeepSeek Harness (dsh) **0.1.2-rc.1**, pi-ai **0.84.4**, OpenAI JavaScript SDK **6.40.0**, and a recent Node.js with its bundled HTTP client. The Node.js version used for the **2026-09-25** probes was not recorded.

| Layer | Behavior and limit |
|---|---|
| Client-library request timer | Provider `timeoutMs` becomes the SDK request timeout. It is cleared when response headers arrive, so it bounds the wait for headers, not a stream in progress. The adapter sets SDK retries to **0**; profile `retryPolicy.maxRetries` controls harness-layer retries. |
| Semantic stream-idle watchdog | Adapter default **300,000 ms**, configurable per provider as `streamIdleTimeoutMs`. It restarts only for a chunk converted into a harness content block; headers, SSE comments and empty keepalives do not reset it. Expiry raises a provider error of type timeout. |
| Transport header/body timers | Node.js HTTP client (undici) defaults: header timeout **300,000 ms** and body timeout **300,000 ms**. The body timer measures idle time with no body bytes after headers arrive. |
| Job wall | The dsh wrapper defaults to **1800 s**, set from the task budget; expiry kills the process tree and returns **exit 124**. |

The book's **600 s** was never the effective ceiling for a silent stream: the semantic and transport idle limits cut it at about **300 s**, while the SDK request timer stops mattering after headers. Which idle timer fires first through the complete harness path remains unverified.

### Transport probe and scaled-down reproductions

Condition (**M**, **n = 1 per row**, **2026-09-25**): a synthetic HTTP server on loopback; the real OpenAI SDK **6.40.0**, `stream: true`, request timeout **600,000 ms**, SDK retries **0**. The server delays the first body chunk by **D** seconds. In `headers` mode it explicitly calls `flushHeaders()` immediately; in `noheaders` mode it withholds headers and body. Each run records header time, first-chunk or failure time, error text and underlying cause code.

| Mode | D | Outcome | Header time | First chunk / failure time | Error, cause code |
|---|---|---|---|---|---|
| `headers` | 290 s | success | 11 ms | first chunk at 290,019 ms; total 290,019 ms | none |
| `headers` | 310 s | failure | 11 ms | failed at 301,493 ms; no chunk | `terminated`, `UND_ERR_BODY_TIMEOUT` |
| `noheaders` | 310 s | failure | no headers | failed at 301,490 ms | `Request timed out.`, no cause code captured |

Reference summary under those conditions: `headers` with **290 s** delay succeeds at **290.0 s**; `headers` with **310 s** delay fails at about **301.5 s** with `UND_ERR_BODY_TIMEOUT`. The latter is the **300 s** transport default plus roughly **1.5 s** overhead despite the SDK's **600 s** timeout. The `noheaders` failure is consistent with a header timeout, but no cause code was captured, so it is not attributed to a specific timer.

The first probe version did not flush headers: on **2026-09-25**, with **n = 1 per delay**, **290 s** succeeded at **290.016 s** and **310 s** failed at **301.527 s**. It could not distinguish a header wait from a body wait. A probe for "headers sent, body late" must explicitly flush headers and record their arrival; the table above uses that corrected method.

The semantic watchdog has separate evidence (**S + R**, one run per condition, **2026-09-25**). The **300,000 ms** default appears in two adapter source locations, and an unset profile resolves to **300000**. Through the real adapter, a local synthetic server flushed headers, sent an SSE comment every **20 ms**, and scheduled first content at **150 ms**; with the idle budget scaled to **60 ms**, the result was `stream idle timeout after 60ms` at **65 ms**, with **0 chunks**. A control sending real content deltas every **20 ms** completed at **153 ms** with **11 chunks**. This demonstrates reset semantics at a reduced timescale; it was not a **300 s** watchdog run.

A separate SDK timer check (**R**, **n = 1 per condition**; run date not recorded) used timeout **60 ms** and body delay **150 ms**: withholding headers failed at **65 ms** with `Request timed out.`, while flushing headers first completed at **156 ms**. Thus `timeout × (1 + retries)` bounds the wait for headers only. A stream producing content can outlive `timeoutMs`; idle timers and the job wall still apply.

The published probe tests only the SDK plus the Node.js HTTP client against a synthetic server. It does not load the harness adapter and cannot demonstrate the semantic watchdog. Install its sole dependency and run the short tests from the repository root:

```sh
npm install openai@6.40.0
node --test scripts/test_idle_timeout_probe.mjs
```

The test uses `--sdk-timeout-ms 100` with a **0.4 s** body delay: `noheaders` must time out in less than **1 s**, while `headers` must receive headers before **100 ms** and first content at or after **400 ms**. The suite is designed to finish in under **5 s**; it does not assert the historical **300 s** transport measurements. Removing `flushHeaders()` must make the headers test fail.

To collect a measurement, run `node scripts/idle_timeout_probe.mjs <headers|noheaders> <delay_seconds> [--sdk-timeout-ms N]`. The SDK timeout defaults to **600000 ms**; decimal delays are accepted. The SDK resolves from the working directory or optional `PROBE_SDK_DIR`. Each completed measurement prints one JSON line and exits **0**, including measured failures; invalid arguments print usage and exit **2**. Runs with delay at least **60 s** warn on standard error. For the slow reference cases, use `node scripts/idle_timeout_probe.mjs headers 290` and `node scripts/idle_timeout_probe.mjs headers 310`; allow the stated delay unless a timeout ends a run earlier.

### Why cold prefill reaches these limits

Condition (**M**, one run per size, **2026-09-25**): two **Dell Pro Max with GB10** nodes, tensor-parallel **2**, a **4-bit-class V4-Flash** build, streaming, thinking off, `max_tokens: 32`, random content containing one needle sentence, and a plain client outside dsh with no **300 s** idle limit. All four responses answered the needle correctly.

| Prompt tokens | Cold-prefill time to first token |
|---|---|
| 199,838 | 102.9 s |
| 399,720 | 245.2 s |
| 699,290 | 519.6 s |
| 949,221 | 815.2 s |

Derived (**E**): the **700K** and **950K** cases exceed **300 s**, and the **950K** case also exceeds the book's **600 s** `timeoutMs` (which matters only if headers have not arrived). The gateway then in front of that engine had a **300 s** global request timeout, so the route's advertised context ceiling was kept at **262,144 tokens**. This engine ladder does not measure the different model used for the later long-context configuration.

### Long-context configuration and delivery

Condition (**O**, configuration read **2026-10**): the long-context tier was later pointed at a different locally served long-context model behind the same kind of OpenAI-compatible gateway. Its provider values were `timeoutMs: 1500000`, `streamIdleTimeoutMs: 1500000`, and `retryPolicy.maxRetries: 0`. The other tiers kept `timeoutMs: 600000` and `maxRetries: 1`.

The profile cannot set transport timers. A dedicated undici Agent, package **8.10.1**, uses `headersTimeout: 1500000` and `bodyTimeout: 1500000` through the client library's fetch option; injection is scoped to the gateway's origin, with stock fetch for every other origin. The request, semantic idle and transport budgets are each **1,500,000 ms**, below the **1800 s** job wall. The only recorded rationale for the exact value was "at least **1200 s** and below the wall"; a more specific derivation was not recorded.

The injection is a one-line connection inside the installed third-party client library to a small module that builds the Agent; it is not a published package change. Dependency reinstall overwrites it; the original file and full diff were backed up, and a unit test asserts injection presence, but no upstream change is recorded.

### Verification and acceptance remain incomplete

Observed once (**O**, **2026-09-26**): a synthetic request of a few hundred thousand tokens, containing one needle, passed through the configured path end to end and answered correctly. Its longest silent gap after headers was far below **300 s**, so it demonstrated request delivery, not the raised limits. Configuration evidence (**M**, reported with the fix; test date not recorded) showed live dispatcher `headersTimeout: 1500000` and `bodyTimeout: 1500000`; five new unit tests were added and the suite passed **34/34** (**29** existing plus **5** new), including exact profile values, unchanged other providers, large task passing, and origin-scoped fetch timeouts. These are historical configuration tests, not the published probe's test results.

For large task arguments (**O**, observed with that verification), a body larger than **65,536 bytes** is passed through a configuration file instead of the command line to avoid the operating-system argument-size limit (`E2BIG` on macOS). A request body of about **2 MB** reached the gateway intact.

**Acceptance: not fully passed.** The three acceptance gaps are:

1. **The raised limits were not exercised.** No verification request was silent for longer than **300 s**. Configuration values and unit tests were checked, but a request with a silent gap over **300 s** through the full harness path has not been run.
2. **The strict acceptance script failed.** It required the response `model` field to equal the literal backend model name; the gateway returned its long-context route alias. The gateway configuration readback was consistent with the alias mapping and the answer was correct, but the acceptance contract was not met as written.
3. **The full advertised context window was not tested.** The verified request was only a fraction of it. The context ceiling advertised to the router for cold-prefill planning was left unchanged.

Further unresolved or unverified items:

- The semantic watchdog's **300 s** default has source and scaled-down reproduction evidence only. The **310 s** body-timeout probe used the bare SDK, so it cannot determine which **300 s** timer fires first through the complete adapter path; that acceptance run remains open.
- Harness-layer retry behavior after a watchdog timeout was not tested. If it retries, a silent request can wait for the idle limit multiplied by one plus the retry count; the long tier therefore uses **0 retries**.
- Gateway request and stream timers need separate verification. A candidate configuration from **2026-09-25** had a **300 s** global request timeout and some much shorter per-entry limits. Live values for the long-context route were not re-read, and the verification request finished well below the smaller candidate limits; check the gateway's limits separately.
- The mechanism cutting streaming generations longer than **60 s** in the first fan-out runs was not re-verified against the finding that the request timer stops at headers. The original fix worked under its recorded conditions; its explanation may be incomplete.
- The installed-package transport patch is lost on reinstall; no upstream fix is recorded. The patch and its diff are not distributed here.
- The wrapper rollback script was run in dry-run mode only, never applied; a full rollback is not demonstrated.
- The Node.js version for the **2026-09-25** probes was not recorded.
- The `noheaders` failure has no captured cause code and remains unattributed to a specific timer.

## Why this matters

Opt-in knobs are only useful if you know which ones pay for themselves. `tools=minimal` quietly saves ~41% of the first-request prompt and drops the exposed tool set from 24 to 10 — a real win for read-only audit packets. But `tools_mode=ptc` and `fanout` both *cost* more than they give on this hardware, and the reasons are structural rather than fixable by tuning: a single local endpoint means fan-out parallelism cannot save wall time, and a per-agent output budget means fan-out could not rescue the 15-document audit under every arrangement we tried (sequential, fan-out 2, fan-out 4). Fan-out's first two runs *looked* like knob failures and were attributed at the time to a provider-layer timeout shorter than the longest measured generation, multiplied by silent retries. The exact streaming cutoff mechanism remains unverified; see the October update. This cookbook records the levers, the negative results, and the two traps so the defaults (all off) are defensible.

## Hardware and stack

| | |
|---|---|
| Nodes | Head node and worker node, each a **Dell Pro Max with GB10**; the two-node layout is head node + worker node, TP2 over RoCE. The knob measurements ran on a single local endpoint. |
| Work layer | DeepSeek Harness (dsh), package `@deepseek-ai/dsh`, baseline behavior at **rc.1** |
| Served model | V4-Flash, served locally on the GB10 nodes |
| Provider tiers | three tiers: a fast tier, a planning tier and a long-context tier, kept in sync in these runs |
| Pass-through surface | packet schema fields `tools` / `tools_mode` / `fanout`; capability cards; CLI flags `--tools`, `--tools-mode`, `--fanout`; board-card body lines |
| Provider timeout/retry policy used in these runs | `timeoutMs: 600000`, `retryPolicy.maxRetries: 1` — applied identically to the fast/planning/long-context tier providers in the runs reported here. This is sufficient only while the first streamed token arrives well inside 300 s; see [Update (2026-10)](#update-2026-10) for the two further 300 s limits that apply to long cold prefill. |
| Output budget / retention tooling | fast tier (thinking off) caps each agent at maxTokens 8192 |
| Image digests | none present in sources |

If a launch command or prerequisite is not recorded, this cookbook says so explicitly rather than guessing.

## Procedure as run

1. Fix an A/B pass/fail threshold per lever **before** running anything; write one same-task A/B script per lever. Do not move the thresholds after seeing results.
2. **`tools=minimal` vs standard**: measured on the first request of one fixed task, two runs, with the prompt size verbatim-identical between runs. Count the exposed tools and the first-request prompt size on each side. (The exact CLI invocation used to dump the prompt size is not recorded — reproduce by running the same packet with `--tools minimal` vs default and diffing the first request.)
3. **`tools_mode=ptc` vs native**: one fixed multi-step task, 12 rounds on each side, correctness judged by a deterministic check (the check definition is not published). Compare correctness (rounds passed) and median token/wall cost.
4. **`fanout`**: task = "review four small files for one risk each"; one run per arm. Workers run on the fast tier (peak concurrency observed 4); a checker runs on the planning tier with thinking on; plain sub-agents are forbidden. Assert the mechanism with post-hoc telemetry (see the `fanout` row conditions in Results).
5. Root-cause any fan-out timeouts **before** blaming the knob: the first two fan-out timeouts were attributed to the provider-layer default timeout + silent retries; the later request-timer finding leaves the exact streaming cutoff mechanism open. Apply the timeout/retry policy in §Results before re-running.
6. **Output-budget ladder**: with the same mechanism, task = audit 15 long cookbooks, run as sequential, fan-out 2, and fan-out 4. Control = the same mechanism on the original 4-small-files task. Results in §Results.
7. **Retention**: run reclamation in dry-run-by-default mode over the three append-only directories; perform one monitored real delete first, then enable the weekly scheduled job. Rollback is documented in §Results.

Exact per-tier provider config file paths, hook file names, scheduler job labels, and internal directory layouts are not published here; the policy values and the rollback method are recorded in §Results, which are what matter for reproduction.

## Results

Baseline for all three knobs = rc.1 defaults: `tools` standard, `tools_mode` native, no `fanout`. Full tables with measurement conditions are in `docs/results.md`; the summary:

### The three knobs

| Knob | Measurement condition | Result | Verdict |
|---|---|---|---|
| `tools=minimal` | first request of one fixed task, two runs, prompt size verbatim-identical | tool set 24→10; prompt −41% | Recommended for read-only audit packets, only if the packet needs no iterative-loop tool / sub-agent delegation |
| `tools_mode=ptc` | one fixed multi-step task, 12 rounds each, native vs ptc, correctness by a deterministic check (not published) | correctness native 9/12 vs ptc 11/12 — but the last 8 rounds were 8/8 for both sides; median tokens +33%; wall +45% | Not default: on this task the accuracy edge of ptc did not hold in the last eight rounds (8/8 both) while the token cost stayed +33%; enable per-need only for batch-statistics tasks where the native model would guess numbers |
| `fanout` | "review four small files for one risk each"; 4 fast-tier workers + 1 planning-tier checker, single local endpoint, one run per arm; wall and total tokens summed over root + worker sessions; mechanism checks: workflow called exactly once, plain sub-agent calls 0, per-item retries ≤1, no unfinished items, checker completed, peak concurrency ≤4 | mechanism fully worked; wall 2.0×; total tokens 4.8× | Not default: on one local endpoint fan-out did not save wall time on this small task (checker long-tail thinking + each worker re-reads context); whether a single endpoint benefits from fan-out depends on item count and is not established by this one four-file run |

### The provider-layer timeout/retry trap (fan-out root cause)

| Item | Value |
|---|---|
| pi-ai provider-layer defaults | Early-run attribution: timeout 60 s, retries 5 — a single generation over the default was judged failed and silently retried 5×; originally diagnosed as the cause of the two early fan-out timeouts. Caveat added 2026-10: the client-library request timer behind `timeoutMs` stops once the response headers arrive, so it bounds the wait for headers, not the duration of a stream that has started. The mechanism by which a streaming generation longer than 60 s was cut in the early runs was not re-verified. |
| Longest single generation measured | ~200 s (the checker, planning tier, thinking on) |
| Policy used in these runs (short time-to-first-token) | `timeoutMs: 600000`, `retryPolicy.maxRetries: 1`; rule used in those runs: the total time for a call (timeout × (1 + retries) plus backoff and overhead) must stay clearly smaller than the packet wall; multiple calls in one packet need their budget summed. The rule is incomplete: timeout × (1 + retries) bounds only the wait for response headers, not a stream in progress. Two other idle timers (a 300 s semantic stream-idle watchdog and a 300 s transport body-idle timeout) also have to be set above the longest silent gap you expect, and all of them must stay below the job wall. See [Update (2026-10)](#update-2026-10). |
| Iteration note | first version set 900 s; a review caught that 900×2 would collide with the wrapper's default wall of 1800 s (600×2=1200 stays below), so it was lowered to 600 s |
| Real hangs | Real hangs that produce no streamed content for 300 s are cut earlier by the stream-idle watchdog (default 300 s) and surface as a provider timeout error, not as exit 124. Exit 124 applies when the stream keeps producing content but the job exceeds its wall. This watchdog behavior is supported by source reading and a scaled-down reproduction, not a 300 s run; which idle timer fires first through the full path remains open. |
| Rollback | `git checkout` the three per-profile provider config files restores the old default pair |

### The per-agent output-budget limit (fan-out hard constraint)

| Item | Value / condition |
|---|---|
| Budget | fast tier (thinking off) caps each agent at maxTokens 8192; V4-Flash writes its reasoning into the content channel for "long document + open-ended judgment," burning the budget |
| 15-cookbook audit | the 15-document audit failed under every arrangement we tried (sequential, fan-out 2, fan-out 4) within an 8,192-token per-agent output budget; smaller allocations per agent were not tested; coverage 0/15 |
| Control | the same mechanism on 4 small library files passed completely |
| Cost scale | 1.3–1.8M tokens per variant (no external API token cost; local run cost not recorded) — 10× the small-task fan-out |
| Honest conclusion boundary | data supports only "fast tier ≥ 4 long READMEs per agent is infeasible"; 1–2 books per agent and planning-tier workers are undecided (the exploratory run was masked by a root-model allocation error; root cause not fully investigated). No threshold was written into any capability or template; next real task: dispatch 1 long item per agent, or prove a single planning-tier item first |
| Outcome note | the risk table for that run was not produced (no fabrication) |

### GC retention

| Item | Value / condition |
|---|---|
| Targets | three append-only directories (worktrees, per-job session evidence, outputs), reclaimed by directory mtime; cleanup defaults to dry-run, `--apply` deletes |
| Evidence-chain rule | directories referenced by the A/B ledger, plus the session dirs whose job ids appear in their JSONs, are kept for `EVIDENCE_DAYS` = 180 days; everything else by `DAYS` (a permanent exemption was unanimously rejected on review) |
| Traceability | every dir gets an `intent` ledger line before deletion, then a `delete` / `delete-failed` line after; each run writes a `run` summary line — the garbage collector writes an intent record before deleting and a completion record after, so a deletion without a record would require both writes to fail |
| Fail-closed | missing interpreter or any break in the evidence-chain parsing pipeline → refuse to run (exit 3, better not to delete); paths use NUL-safe traversal + absolute-prefix assertions |
| First monitored real run | `DAYS=3` deleted 84 directories (with a tar backup), then automation was enabled |
| Schedule | weekly scheduled job, Sunday 04:30, `DAYS=30`; rollback = remove the job label |

## What did not work

| Negative result | Where the numbers are |
|---|---|
| ptc correctness advantage (native 9/12 vs ptc 11/12 collapses to a tie on the last 8 rounds) while median token and wall costs rise | three-knobs table |
| fan-out as a wall-time saver on small tasks on a single local endpoint (and its token blow-up) | three-knobs table |
| The first two fan-out runs (early attribution: provider-layer timeout + silent retry storm; exact cutoff mechanism open) | timeout/retry table |
| The initial 900 s timeout value (would collide with the wrapper wall) | timeout/retry table |
| 15-book audit under every parallelism setting (max-tokens / timeout, zero coverage) | output-budget table |
| Any threshold generalization from the ladder — explicitly declined for lack of data | output-budget table |

## Pitfalls

Symptom → root cause → fix, expanded with how each was found in `docs/pitfalls.md`. Summary:

- Fan-out workers "randomly fail" on long generations → early diagnosis: provider-layer default timeout shorter than the longest measured generation × silent retries; the exact streaming cutoff mechanism remains open → one long provider timeout, max-retries 1 for the original short-time-to-first-token runs; budget header waits, idle limits and retries below the packet wall. The wall catches jobs that continue streaming beyond their budget. If the time to first token can exceed 300 s (long cold prefill), a long provider timeout is not enough: also raise the stream-idle watchdog and the transport header/body timeouts (see [Update (2026-10)](#update-2026-10)).
- A worker's JSON answer is ignored and the agent resolves null → schema-bound agents only accept tool-call delivery; JSON in the text body counts as failed → deliver via the structured-output tool, one labeled retry on null; a null checker must throw, never pass silently.
- The workflow tool rejects the call → the model nested `args` inside `meta` → keep `script` / `meta` / `args` as three top-level parameters.
- Fan-out total tokens "missing" child work → an early unit test polluted the real per-job session index with a one-event fake session → count root + all child sessions (children persist under per-job dirs); the unit test now cleans up.
- Believing fan-out "enforces" a bounded envelope → it is a prompt contract plus post-hoc telemetry assertions only → treat it as opt-in experimental; real safety stays in hooks + sandbox + read-only/worktree boundaries.
- Long-document agents die at max-tokens regardless of parallelism → per-agent output budget, reasoning written into the content channel → cap long items per agent (start at 1) or move the worker to the planning tier; fan-out is not a budget workaround.
- Fear that automated disk reclamation silently destroys evidence → untracked deletes and unresolved evidence chains → dry-run default, ledger lines around every delete, fail-closed refusal on parse breakage, evidence retention period distinct from the general one.
- Long cold prefill dies at about 300 s despite `timeoutMs: 600000` → independent semantic and transport idle limits → align request, stream-idle and transport budgets below the job wall and check gateway limits separately; acceptance remains incomplete (see the October update).

## Files

- `README.md` — this cookbook
- `docs/results.md` — every results table from the run, complete, with a one-line measurement-condition note above each
- `docs/pitfalls.md` — the pitfalls expanded (symptom / root cause / fix / how we found it)
- `scripts/idle_timeout_probe.mjs` — synthetic transport-only SDK timeout probe
- `scripts/test_idle_timeout_probe.mjs` — scaled-down `node --test` checks; requires `npm install openai@6.40.0` only
- `docs/make_banner.py` — pure-PIL banner generator (house style); run it to write `docs/assets/banner.png`
- `docs/assets/banner.png` — generated by `docs/make_banner.py`

## License

Apache-2.0.
