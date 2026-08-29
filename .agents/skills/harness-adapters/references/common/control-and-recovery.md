# Control and recovery

Load this with the running or recorded tool reference for trust, skill invocation, interrupt, exit, resume, or recovery.

## Typed data and lifecycle control

Conversation and harness-native skill invocation use `../../../bin/fm-send.sh`; lifecycle uses only `../../../bin/fm-control.sh <task-id> interrupt|exit|relaunch`.
Never send lifecycle text through the marked secondmate data plane.
`../../../docs/agent-control.md` owns the split, and `../../../bin/fm-control-lib.sh` owns executable capabilities.
Tool-reference exit and interrupt values are empirical records, not keys to improvise; a new adapter remains uncontrollable until they land in that owner.
Always select them from `harness=` in `state/<id>.meta` and let the control plane verify postconditions.

## Trust and skill submission

Inspect after spawn within the tool's readiness window.
Select only its documented trust choice from the active firstmate home, binding `FM_HOME` unless already correct, then inspect again and prove instructions started.
No observed dialog proves only that launch.

Use the tool's exact skill form, or natural language only when no separate command is verified or the form remains uncertain.
A successful send or key return is not proof of submission; require the tool-specific postcondition.
Popup, queued-input, and readiness handling belongs to `../../../bin/fm-composer-lib.sh` and the selected backend.

## Interrupt and exit

Use the control plane so capabilities are checked first.
Interrupt preserves the agent and work; exit stops only the agent and preserves its endpoint, isolated copy, and uncommitted changes.
Cleanup and discard are not lifecycle verbs.
The tool reference records repeat, acknowledgement, and clearing behavior, while the executable owner sends or refuses the sequence.

## Resume and recovery

Native resume is not a control verb because it varies: Codex and Grok need an exit-printed id, OpenCode continues the current directory's latest session, Claude, Pi, Pi-signed, and Kimi have no verified pane-resume contract, and Muse records its own forms.
Use it only when both the tool reference and recovery procedure call for it.
Deterministic relaunch instead trusts instructions on disk, not a private session.

`../stuck-crewmate-recovery/SKILL.md` owns worker recovery and `../secondmate-provisioning/SKILL.md` owns secondmate recovery; both preserve recorded work.
Read `harness=` before acting.
Add `references/common/dispatch.md` and `references/common/model-and-effort.md` only for a replacement profile, and `references/common/primary-hooks.md` for a secondmate.
