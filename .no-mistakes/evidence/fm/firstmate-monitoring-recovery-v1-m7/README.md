# Monitoring fix live validation

Scope: the three prepared fixes in target `58f4c62c727480bde73e11ed7f4936831445eb9e`, compared with base `8d2ee291107d14f37ca7ef280199bebed22578c4`. No startup, primary-harness, or Pi successor-readiness recovery claim is made.

## Product evidence

`monitoring-live.py` drives the actual shell product in fresh, marked, worktree-local lab homes. It does not mock commands, backends, clocks, or production functions. No real fleet records are read or mutated. No primary harness or Herdr session is needed for these file-channel/CLI scenarios.

`monitoring-live.log` records the following completed checks:

- **Settled history does not block new reports:** 32 terminal pending-reply records, including never-escalated and escalation-closed records, with two real live locks held. The baseline watcher stopped refreshing its beacon and left a new reply awaiting processing throughout the observation window. The target refreshed its beacon, resolved the new correlation, and emitted the durable wake in 7.313 seconds after the report append. `notification-drain.txt` shows the delivered reply with literal `=` and backslash intact. All old record hashes stayed unchanged while the lock holder remained alive.
- **An interrupted escalation close remains retryable:** a real mode-400 status file prevented the close write after resolution. Restoring write permission and running the watcher produced exactly one close, preserving the existing log prefix and an unrelated open decision. The production drain and decision fold show that unrelated decision still open.
- **Notification cursors preserve delivery:** with 24 task status files, the real drain delivered both an answer buried before a routine note and an uncovered completion. The next drain printed nothing, and a subsequent append delivered only the new answer. Persisted independent presentation/backstop offsets are included. Elapsed drain times were 24.455, 31.023, 55.921, and 36.380 seconds; these are observed timings, not a throughput guarantee.
- **Legacy history migration:** labels containing spaces, traversal, an absolute path, a tab, and a trailing newline failed index migration on the baseline. The target rebuilt only valid task indexes, kept the original store byte-for-byte, preserved read/processed markers, retained the historical decision in `unprocessed`, and refused a new traversal label without appending it. Deleting the derived ready marker and invoking the actual drain self-healed the index and delivered a later completion.

## Driver corrections and supporting tests

An initial four-second beacon observation was too short for a complete watcher cycle, and a report can arrive after the cycle's pending-reply reconciliation but before its signal scan. The driver now waits for an observed full cycle and permits the next ordinary arm to reconcile such a report. A 30-second multi-task drain deadline was also too short; it was raised to 180 seconds. The watcher and closure checks passed on the second invocation; `--remaining` completed the cursor and migration checks. The initial attempt is retained in `monitoring-initial-timing-attempt.log`; the main transcript includes both the interrupted second invocation and the successful continuation. These driver deadlines were not changed in product code.

The following focused behavioral suites passed. Their fixtures/mocks are supporting evidence, not the basis for calling the scenarios live:

- `TMPDIR="$PWD/.monitor-test-tmp" bash tests/fm-pending-reply.test.sh`
- `TMPDIR="$PWD/.monitor-test-tmp" bash tests/fm-branch-supervision.test.sh`
- `TMPDIR="$PWD/.monitor-test-tmp" bash tests/fm-wake-drain-unread-status.test.sh`
- `TMPDIR="$PWD/.monitor-test-tmp" bash tests/fm-wake-drain-outcome-backstop.test.sh`

No full-suite run, lint, static analysis, push, PR, or pipeline-control operation was performed. No source files changed. All lab homes, baseline copies, and owned watcher/lock-holder process groups were removed. Evidence remains only in this directory. This is a CLI-only change, so screenshots are not applicable.
