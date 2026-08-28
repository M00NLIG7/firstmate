# GitLab merge request watch and guarded squash verification

This record covers GitLab merge watching alongside guarded squash routing and safe cleanup.
The live watch evidence through "Upgrade path from an existing armed watch" was collected on 2026-07-21.
The guarded routing, cleanup, and integration evidence was refreshed on 2026-08-28 through executable public interfaces with synthetic normalized provider responses and local Git repositories; no live merge was issued.

## Versions

```
$ glab --version
Current glab version: 1.53.0

$ bash --version | head -1
GNU bash, version 5.3.9(1)-release (x86_64-pc-linux-gnu)
```

The guarded routing and cleanup refresh used:

```
$ glab-axi --version
glab-axi 0.2.0 (contract glab-axi/v1)

$ jq --version
jq-1.6

$ bash --version | head -1
GNU bash, version 3.2.57(1)-release (arm64-apple-darwin25)
```

## The evidence project

All live evidence here reads <https://gitlab.com/KarotKris/gitlab-merge-watch-fixture>, a public project that exists only to be this evidence.
It holds one deliberately merged merge request and one deliberately open one, so both outcomes can be shown against real data.
Every command against it reads a public merge request and needs no credential, so a reader can rerun each one and see the same output.
Its README asks that the open merge request be left open.

A non-default host appears below only as the placeholder `gitlab.example`, which resolves nowhere.
That is deliberate: the host-agnostic property is a property of the stored record and the poll's URL reconstruction, so it is demonstrated by inspecting those rather than by reaching any private instance.

## Why the host is data rather than a constant

GitLab runs mostly on self-hosted instances, so a merge request can live under any host.
A GitLab project also sits under at least one group at no fixed depth, so no owner-and-repository pair can address one the way it can on GitHub.
The stored record therefore carries `provider`, `url`, `host`, `path`, and `number`, and every consumer rebuilds the URL from those parts and refuses any record that does not reconstruct the stored URL exactly.
`tests/fm-pr-check-security.test.sh` asserts that neither `bin/fm-pr-lib.sh` nor `bin/fm-pr-poll.sh` contains the string `gitlab.com` at all.

## How plain glab is invoked, and why

Two things about plain `glab` were established by running it, because assuming either one would have failed silently into a permanent "not merged".

First, plain `glab` has no field selector.
`gh` reads one field with `--json state -q .state`; `glab mr view` offers only `-F, --output string  Format output as: text, json`.
The byte-static poll therefore continues to read state from plain glab's field output rather than adding JSON parsing to every silent poll.
Arming, guarded merge, and cleanup separately require `jq` because they validate one complete normalized `glab-axi` JSON document and can report a missing dependency synchronously.
Only an exact `merged` wakes firstmate, so a changed poll output format produces no wake rather than a false merge.

Second, `glab` cannot take a merge request URL the way `gh pr view` can.
That form shells out to git for the current repository, and the watcher runs in no repository:

```
$ cd /tmp && glab mr view https://gitlab.com/KarotKris/gitlab-merge-watch-fixture/-/merge_requests/1
fatal: not a git repository (or any parent up to mount point /)
Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).
git: exit status 128
```

Passing the project URL to `-R` with the merge request number works from anywhere, and resolves the instance from that URL rather than from glab's configured default:

```
$ cd /tmp && glab mr view 1 -R https://gitlab.com/KarotKris/gitlab-merge-watch-fixture
title:	Add the merged example file
state:	merged
author:	KarotKris
labels:	
assignees:	
reviewers:	
comments:	0
number:	1
url:	https://gitlab.com/KarotKris/gitlab-merge-watch-fixture/-/merge_requests/1
--
This merge request is the merged half of the fixture. It is merged on purpose, so that reading its state returns merged.

$ cd /tmp && glab mr view 2 -R https://gitlab.com/KarotKris/gitlab-merge-watch-fixture | sed -n 's/^state:[[:space:]]*//p'
open
```

## End to end: arming and polling a real merge request

Three tasks were armed, two against the fixture and one against the placeholder host:

```
$ fm-pr-check.sh e1 https://gitlab.com/KarotKris/gitlab-merge-watch-fixture/-/merge_requests/1
armed: state/e1.check.sh
$ fm-pr-check.sh e2 https://gitlab.com/KarotKris/gitlab-merge-watch-fixture/-/merge_requests/2
armed: state/e2.check.sh
$ fm-pr-check.sh e3 https://gitlab.example/group/subgroup/project/-/merge_requests/7
armed: state/e3.check.sh
```

The stored record for each, showing the host and the full project namespace as data:

```
$ cat state/e1.pr-poll
gitlab
https://gitlab.com/KarotKris/gitlab-merge-watch-fixture/-/merge_requests/1
gitlab.com
KarotKris/gitlab-merge-watch-fixture
1

$ cat state/e3.pr-poll
gitlab
https://gitlab.example/group/subgroup/project/-/merge_requests/7
gitlab.example
group/subgroup/project
7
```

The provenance record for the non-default host, showing the bumped version tag:

```
$ cat state/e3.pr-poll-registration
fm-pr-poll-registration-v2
e3
gitlab
https://gitlab.example/group/subgroup/project/-/merge_requests/7
gitlab.example
group/subgroup/project
7
514b7e04f0cca3e2c913c9fd504c54dfe54c8a51a7f5ebc57279bbd4db5d4a60
1817b0f95db7148246434a4afa0b2c8e7b81fd8f74ef7d473bbd62023e47c439
70:957243
70:957244
```

Running each published poll the way the watcher does, where an empty result means the poll stayed silent and produced no wake:

```
$ fm-pr-poll.sh --validated $(tr '\n' ' ' < state/e1.pr-poll)
merged
$ fm-pr-poll.sh --validated $(tr '\n' ' ' < state/e2.pr-poll)
$ fm-pr-poll.sh --validated $(tr '\n' ' ' < state/e3.pr-poll)
```

The merged fixture merge request produces exactly one `merged` line.
The open one produces nothing, and the unreachable placeholder host produces nothing rather than a false merge.

The same bytes work in the watcher's sidecar-driven mode, where the published check locates its own record:

```
$ state/e1x.check.sh
merged
```

## A missing CLI produces no wake, never a false merge

The poll is silent on every error by design, so a missing `glab` would otherwise be indistinguishable from a merge request that is never merged.
With `glab` removed from `PATH`, the poll stays silent even for the merge request that is genuinely merged:

```
$ PATH="$noglab" fm-pr-poll.sh --validated $(tr '\n' ' ' < state/e1.pr-poll)
$ PATH="$noglab" fm-pr-poll.sh --validated $(tr '\n' ' ' < state/e3.pr-poll)
```

Arming is the one point where that can be reported, so it refuses there instead of arming a watch that can never fire:

```
$ PATH="$noglab" fm-pr-check.sh e5 https://gitlab.com/KarotKris/gitlab-merge-watch-fixture/-/merge_requests/1
error: watching a GitLab merge request requires glab on PATH
$ echo $?
1
```

A GitHub task is unaffected by a missing `glab`:

```
$ PATH="$noglab" fm-pr-check.sh e6 https://github.com/kunchenguid/firstmate/pull/750
armed: state/e6.check.sh
```

Current GitLab arming requires plain glab for the internal read poll, `glab-axi` for normalized MR identity and head resolution, and `jq` for strict JSON validation.
An absent dependency refuses before publishing a watch or lifecycle record.

## Upgrade path from an existing armed watch

The stored record gained the provider tag, so its version moved to `fm-pr-poll-registration-v2` and a record written by the previous release no longer parses.
The existing non-executing migration handles that: it never runs the old artifact, and rebuilds the poll from the task's recorded pull request URL.
Starting from a poll armed exactly as the previous release wrote it:

```
$ head -1 state/t1.pr-poll-registration
fm-pr-poll-registration-v1
$ fm-pr-check-migrate.sh --checks-safe
PR_CHECK_MIGRATION: canonical polls rebuilt and armed; resume supervision for this home
$ head -2 state/t1.pr-poll-registration
fm-pr-poll-registration-v2
t1
$ cat state/.pr-check-migration.log
task t1: migration outcome tracking started before legacy poll handling
task t1: canonical legacy poll rebuilt and armed
```

The rebuilt poll works, verified against a pull request that is genuinely merged:

```
$ fm-pr-poll.sh --validated $(tr '\n' ' ' < state/t1.pr-poll)
merged
```

No armed watch is lost by upgrading.

## Guarded merge routing and squash cleanup

`bin/fm-pr-merge.sh` accepts a canonical GitLab MR URL only with one explicit `captain-explicit` or `standing-yolo-green` authority class.
It rejects every caller behavior except optional explicit squash before provider access, records one exact source head through bounded `glab-axi mr view --format json`, revalidates that same URL, head, and branch pair, and invokes the guarded `glab-axi mr merge` primitive exactly once.
The provider argv binds the URL-derived host, complete nested project path, IID, canonical URL, durable expected head, exact source and target branches, authority, immediate squash, and JSON output.
Because the 0.2.0 semantic floor predates the branch flags, the merge wrapper also refuses task-scoped use unless executable `glab-axi mr merge --help` exposes both branch guards.
The wrapper never invokes plain glab for mutation, retries a merge, forwards source-deletion or auto-merge behavior, or falls back to a generic API.

A zero exit is not sufficient.
Firstmate accepts only one complete `glab-axi/ux-v1` result whose success action, MR identity, source and target branches, expected source head, successful head pipeline, authority, squash commit, and resulting target commit all match.
The accepted actions are `merged`, `already_merged`, and `reconciled_merged`, which lets the provider reconcile a prior exact mutation without Firstmate issuing a second mutation.
A validated result persists one `gitlab_guarded_squash_receipt=v1|task|url|authority|head|source|target|squash|result` field in the task record.
Re-recording the same task, canonical URL, and head preserves an existing valid receipt until a validated replacement is atomically persisted, while an identity or head change invalidates it.
Provider refusal, malformed output, duplicate output, identity drift, or any ambiguous result leaves the poll armed and records no landed outcome or cleanup receipt.

GitLab cleanup requires one canonical `pr=`, one exact `pr_head=`, and one valid task-bound guarded-squash receipt.
It re-reads one current normalized MR result, requires merged and nonconflicting state plus the exact local source branch, and binds its URL, host, nested project, IID, head, source, and target to the durable evidence.
It always fetches the exact `refs/merge-requests/<iid>/head` and target branch from the URL-derived project even if same-named objects already exist locally, never falls back to ambient `origin` for GitLab identity, and retires its task-scoped temporary refs on every exit.
The receipt's squash and result commits must both be reachable from the freshly fetched target, and the existing provider-agnostic content check must independently prove that merging local `HEAD` into that target adds nothing.
Legacy records without a head or receipt, dirty work, open or conflicting MRs, stale heads, branch mismatch, malformed JSON, unreadable exact refs, unreachable result commits, and content mismatch all preserve the isolated copy.

Workers receive the same generated prohibition on guarded merge invocation across every supported worker runtime.
The session-provider integrations (`tmux`, `herdr`, `zellij`, `orca`, and `cmux`) continue to own endpoint and worktree lifecycle only; none selects a code host or invokes provider merge behavior, so no backend-specific merge branch is applicable.
The existing plain-glab poll remains a separate read-only transport and is unchanged by the guarded mutation path.

## Executable verification

The focused public-interface regressions use fake bounded provider responses, count exact provider invocations, and exercise cleanup through the real entrypoint against local Git repositories.
They issue no live merge.

Selected exact lines from the focused run were:

```
$ bin/fm-test-run.sh tests/fm-pr-merge.test.sh
ok - fm-pr-merge requires exactly one validated merge-authority class
ok - fm-pr-merge routes exact nested GitLab MRs and accepts only verified guarded success actions
ok - fm-pr-merge refuses every non-squash GitLab behavior and override before provider access
ok - fm-pr-merge records one expected head and rejects stale or ambiguous MR views
ok - fm-pr-merge propagates provider refusals and accepts no ambiguous success result
ok - fm-pr-merge refuses before recording when a GitLab lifecycle dependency is missing
FM_TEST_END 2026-08-28T01:41:28Z tests/fm-pr-merge.test.sh exit=0 duration_ms=351678
FM_TEST_SUMMARY total=1 failed=0 skipped_gate=0 duration_ms=351822

$ bash tests/fm-teardown.test.sh --gitlab-only
ok - GitLab teardown accepts exact guarded-squash evidence plus target content proof
ok - GitLab teardown refuses dirty, unmerged, stale, malformed, mismatched, or content-unproven evidence
```

The generated-brief regression separately proves that ship and scout workers receive the bounded GitLab route and cannot invoke the guarded primitive.
