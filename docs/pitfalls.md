# Pitfalls — three opt-in knobs on DeepSeek Harness (dsh)

Each pitfall is expanded as **Symptom → Root cause → Fix → How we found it**. The order matches the order they surfaced during the run.

---

## 1. Fan-out workers "randomly fail" on long generations

- **Symptom:** the first two fan-out runs failed with worker timeouts that looked like the fan-out mechanism itself was broken — workers reported as failed even though the work was valid.
- **Root cause, as diagnosed in the early runs:** the provider layer's default timeout (60 s) was shorter than the longest measured single generation (~200 s, the checker on the planning tier with thinking on). The early diagnosis was that a generation exceeding 60 s was judged failed and silently retried 5×. (Later review note: the request timer stops at response headers; see [Update (2026-10)](../README.md#update-2026-10) for the open question of how a streaming generation was cut.)
- **Fix used in those runs:** set one long provider timeout (`timeoutMs: 600000`) and `retryPolicy.maxRetries: 1`, applied identically to the fast/planning/long-context tier providers; the rule used then was that the total time for a call (timeout × (1 + retries) plus backoff and overhead) stays clearly smaller than the packet wall, and multiple calls in one packet need their budget summed. That arithmetic bounds the wait for headers, not a stream in progress. The wrapper's wall timeout (exit 124) catches jobs still producing content; silent streams encounter idle limits earlier. This fix covers short time-to-first-token only. For first-token latency above 300 s add pitfall 8: a silent stream is cut by two independent 300 s idle limits; see [Update (2026-10)](../README.md#update-2026-10).
- **How we found it:** root-caused explicitly as step 5 of the procedure (root-cause the first two fan-out timeouts before blaming the knob). The iteration note records that the first attempt set 900 s, which a review caught would collide with the wrapper's default wall of 1800 s (900×2), so it was lowered to 600 s (600×2=1200 stays below).

## 2. A worker's JSON answer is ignored and the agent resolves null

- **Symptom:** a worker produced a valid JSON answer, but the orchestrating agent resolved to null and the work was treated as missing.
- **Root cause:** schema-bound agents only accept delivery through the structured-output tool call; writing the JSON into the text body counts as a failed delivery and the agent returns null.
- **Fix:** workers must deliver via the structured-output tool, with one labeled retry on null. A null from the checker must throw, never pass silently.
- **How we found it:** observed during the fan-out mechanism checks (§1, row 3 of the three-knobs table) where token accounting and per-item completion telemetry exposed null resolutions that a pass-through text read would have missed.

## 3. The workflow tool rejects the call

- **Symptom:** the workflow tool rejected an otherwise well-formed call.
- **Root cause:** the model nested `args` inside `meta` instead of passing `script` / `meta` / `args` as three top-level parameters.
- **Fix:** keep `script`, `meta`, and `args` as three top-level parameters in the workflow-tool call.
- **How we found it:** surfaced while wiring the fan-out knob into the packet schema; the schema rejects nested-`args` calls outright.

## 4. Fan-out total tokens "missing" child work

- **Symptom:** fan-out total-token accounting appeared to miss the child sessions, suggesting children did not persist.
- **Root cause:** an early unit test polluted the real per-job session index with a one-event fake session, making it look as though children did not persist. In reality children persist under per-job dirs with parent-session and provider headers.
- **Fix:** count root session + all child sessions for total tokens. The unit test was fixed to clean up after itself so it can no longer pollute the real index.
- **How we found it:** the discrepancy showed up when comparing per-item telemetry against the summed token count; the fake session was traced back to the unit test that wrote into the real per-job session index.

## 5. Believing fan-out "enforces" a bounded envelope

- **Symptom:** a mistaken belief that fan-out enforces a hard bounded envelope on what the run can do.
- **Root cause:** fan-out is a prompt contract plus post-hoc telemetry assertions only; the root model could in principle rewrite the script or spawn around it.
- **Fix:** treat fan-out as an opt-in experimental knob, not a safety boundary. Real safety stays in hooks + sandbox + read-only/worktree boundaries.
- **How we found it:** recognized while defining the mechanism checks (§1, row 3) — the checks are assertions *after the fact*, not constraints enforced *during* execution.

## 6. Long-document agents die at max-tokens regardless of parallelism

- **Symptom:** agents auditing long documents hit max-tokens and failed under every parallelism setting (sequential, fanout-2, fanout-4), with zero coverage.
- **Root cause:** the per-agent output budget — the fast tier (thinking off) caps each agent at maxTokens 8192, and V4-Flash writes its reasoning into the content channel for "long document + open-ended judgment," burning the budget on reasoning rather than output.
- **Fix:** cap long items per agent (start at 1) or move the worker to the planning tier (these two alternatives are not yet tested). Fan-out is not a budget workaround — on the arrangements tested, the per-agent output budget stayed the binding limit.
- **How we found it:** the output-budget ladder — 15 long cookbooks run as sequential, fanout-2, and fanout-4 — failed in all three variants on max-tokens or timeout (coverage 0/15), while the same mechanism on 4 small library files passed completely. The contrast is consistent with the per-agent output budget as the cause; the ladder did not vary the budget alone, and failures mixed max-tokens and timeout, so the cause is not isolated.

## 7. Fear that automated disk reclamation silently destroys evidence

- **Symptom:** concern that an automated cleanup of the append-only work directories could silently delete evidence needed later.
- **Root cause:** untracked deletes and unresolved evidence chains — without an explicit retention rule, a directory referenced by an A/B ledger could be reclaimed along with everything else.
- **Fix:** dry-run by default (`--apply` to delete); an `intent` ledger line before every delete and a `delete` / `delete-failed` line after; each run writes a `run` summary line, so the garbage collector writes an intent record before deleting and a completion record after, meaning a deletion without a record would require both writes to fail; fail-closed refusal (exit 3) on a missing interpreter or any break in the evidence-chain parsing pipeline; NUL-safe traversal + absolute-prefix assertions on paths; an evidence retention period (`EVIDENCE_DAYS` = 180) distinct from the general one (`DAYS`). The first monitored real run deleted 84 directories at `DAYS=3` with a tar backup before automation was enabled.
- **How we found it:** designed up front as a companion decision to the output-budget work, because the ladder's long-running sessions were generating large append-only evidence that needed automatic reclamation without risking the A/B ledger's evidence chain.

## 8. Long cold prefill dies at about 300 s although `timeoutMs` is 600 s

- **Symptom:** with an SDK request timeout of **600,000 ms**, a synthetic stream with flushed headers and a **310 s** first-body delay failed at **301,493 ms** with `terminated` and `UND_ERR_BODY_TIMEOUT` (**M**, one run, **2026-09-25**).
- **Root cause:** independent **300,000 ms** semantic stream-idle and transport body-idle defaults remain on the path. The SDK request timer stops at headers. Headers and SSE comments do not reset the semantic watchdog; real harness content blocks do. Which idle timer fires first through the full adapter path is unresolved.
- **Fix as configured:** the later long-context tier used `timeoutMs: 1500000`, `streamIdleTimeoutMs: 1500000`, `retryPolicy.maxRetries: 0`, and origin-scoped transport `headersTimeout: 1500000` / `bodyTimeout: 1500000`, below the **1800 s** job wall (**O**, configuration read **2026-10**). Check gateway timers separately. The installed-package injection is lost on reinstall, and full-path acceptance remains incomplete; see [Update (2026-10)](../README.md#update-2026-10).
- **How we found it:** the **2026-09-25** bare-SDK probe explicitly flushed headers to distinguish header wait from body wait (**M**, one run per condition). A separate real-adapter reproduction scaled the watchdog to **60 ms** and compared SSE comments with real content (**S + R**, one run each). Neither the transport-only probe nor the scaled-down watchdog run proves which timer wins in the full path at **300 s**.
