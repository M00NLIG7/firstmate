---
name: project-documentation-architecture
description: >-
  Create or audit a concise, agent-navigable project documentation architecture with a user-oriented README, a conditional AGENTS map, one authoritative owner per contract, audience-separated evidence, and project-native validation.
  Use when a user asks to establish, reorganize, simplify, audit, or prevent sprawl in a repository's documentation system.
user-invocable: true
---

# Project documentation architecture

Create or audit the smallest documentation system that lets users succeed, contributors find the right owner, and agents change the project without loading or duplicating every document.
Treat the roles in this skill as a decision model, not a directory template.
Adapt every owner, filename, and validation step to evidence in the target project rather than copying another repository's prose or layout.

## Guardrails

- Follow the repository's existing instructions, contribution policy, and approval boundaries before changing documentation or code.
- Treat implementation, schemas, command help, tests, CI, and repository history as evidence, not as permission to invent a retrospective contract or rationale.
- Do not create a document merely because this skill names a documentation role.
- Do not change product behavior during a documentation-only task unless the user separately authorizes that behavior change.
- Ask for a decision when two plausible owner models would create materially different user or contributor contracts and project evidence does not resolve the choice.
- Prefer a direct documentation edit over a generator, catalog service, policy engine, or other documentation control plane.

## Bounded discovery workflow

Complete one bounded discovery pass before proposing files or editing prose.

### 1. Inventory without reading everything

- Identify the repository root, active workspace or package set, and any local agent or contributor instructions.
- Enumerate tracked prose, schemas, command entry points, test runners, and CI definitions using the project's existing inventory command or version-control file list.
- Group prose by apparent role and mark generated, vendored, frozen, historical, private, or ignored material before treating it as maintained documentation.
- Read the README, AGENTS or equivalent agent instructions, contribution guide, documentation index, and the top-level build or task entry point in full when they exist.
- Read only one representative candidate for each apparent owner role at first, then expand to a linked file only when a contradiction, missing owner, or planned edit requires it.
- Read every file that may be rewritten, moved, or removed in full before changing it.

### 2. Build an evidence table

Record a compact working table with these columns:

| Path or surface | Intended audience | Claimed responsibility | Enforcing code, schema, or help | Current evidence | Proposed action |
|---|---|---|---|---|---|
| Repository-specific path | User, operator, contributor, agent, maintainer, or historical reader | One sentence naming what it owns | Exact owner or `none` | Test, CI command, history, or `unproven` | Keep, link, rewrite, prune, retire, or create |

Use `unproven` rather than filling an evidence gap with confident prose.
Do not make the table itself a new tracked document unless the repository already maintains an equivalent inventory and the task authorizes updating it.

### 3. Trace only load-bearing claims

- For each contract or invariant that the change would preserve, add, or relocate, search the repository for competing statements and identify one normative owner.
- Compare cited commands with current `--help`, task definitions, package scripts, or CI rather than trusting copied command examples.
- Inspect relevant history only when it can establish why a durable decision exists, whether a file is frozen, or where a displaced unique fact belongs.
- Check inbound and outbound links for every candidate that may move or disappear.
- Expand discovery only along a concrete contradiction, orphan, or ownership gap uncovered by these checks.

### 4. Stop discovery deliberately

Discovery is complete when every proposed change has a named audience, one owner, an evidence source, a link impact, and a validation path.
Do not keep reading unrelated documents after those questions are answered.
If the existing system already answers them concisely, finish the audit with no structural change.

## Separate audiences before choosing files

Use the project's own audience names when they exist, but preserve these boundaries:

| Audience | Give them | Keep out |
|---|---|---|
| Users and operators | Purpose, supported capabilities and limits, shortest successful setup, current configuration meaning, safe operating guidance, and next links | Contributor internals, task chronology, exhaustive protocol fields, and stale command transcripts |
| Contributors and agents | Component boundaries, dependency direction, change-area navigation, invariants, extension points, and links to implementation and tests | A second user guide, duplicated contracts, temporary task state, and exact command mechanics already owned by help |
| Maintainers verifying guarantees | Current runnable commands, prerequisites, side effects, expected evidence, supported versions when relevant, and contract-to-test mapping | Unlabeled historical success, product requirements invented from test output, and one-off delivery logs |
| Decision readers | Accepted choices, evidence-backed context, consequences, status, and supersession | Current contract details that belong to the contract owner and rationale inferred only from code shape |
| Task, incident, and acceptance readers | Scoped chronology, hypotheses, exact observations, manifests, and delivery evidence | Claims presented as current architecture without distillation and revalidation |

Task or incident evidence stays in the project's issue, report, pull request, or explicitly historical acceptance area by default.
Before pruning tracked evidence, move every unique current fact into its proper owner and leave a focused regression or provenance pointer where future verification needs it.

## Assign authoritative owner roles

These are responsibilities, not mandatory filenames or folders.
One existing artifact may own several compatible roles in a small project, while a large project may split them by subsystem.

### README

The README is the user-oriented front door.
It should state purpose, primary capabilities, meaningful non-goals or limits, the shortest supported success path, and links to deeper owners.
Keep setup executable and short enough that a new user can distinguish required steps from optional paths.
Link to architecture, configuration, contracts, verification, and contributor guidance instead of summarizing each in depth.

### AGENTS or equivalent agent instructions

The agent file is a conditional navigation map and a home for only the invariants needed in nearly every coding session.
Prefer a compact change-area table that points from a subsystem to its normative owner, implementation surface, and executable evidence.
Include project-wide validation entry points and a short maintenance rule when local convention expects them.
Do not turn the agent file into a duplicate architecture guide, contract registry, task log, or command reference.
Preserve an existing agent file's stronger local role and safety rules rather than replacing it with this model wholesale.

### Architecture

The architecture owner explains current component boundaries, dependency direction, durable state, trust boundaries, and end-to-end flow.
It names where behavior lives and what each component must not own.
It links to exact contracts and runnable evidence rather than restating protocol fields or test transcripts.

### Contracts

A contract owner states a data format, state machine, protocol, invariant set, or decision procedure in full exactly once.
Machine-readable schemas may be the normative owner when they can express the contract accurately, with prose limited to cross-cutting invariants or navigation.
A contract registry is useful only when multiple contracts need a one-to-one ownership map and must not become another copy of their contents.
When a child contract is stricter than a cross-cutting contract, state which scope controls and keep each rule at only one level.

### Configuration

The configuration owner explains supported operator choices, defaults, precedence, safety implications, and current setup.
Executable schemas, parsers, or configuration definitions remain authoritative for accepted values and validation when the project already treats them that way.
Keep exact flags, generated fields, and mutation mechanics with the command or script that implements them, then link there from operator guidance.

### Verification

The verification owner maps current guarantees to runnable project commands and states prerequisites, side effects, and evidence limits.
Separate normative contracts, current executable evidence, historical acceptance evidence, and disposable output.
A past passing run never proves the current revision, and a test never silently broadens the contract it supports.
Versioned or dated observations belong here only when they support an active guarantee and include a refresh path.

### Decisions

A durable decision record owns rationale that cannot be recovered safely from the current code and contracts alone.
Create one only when repository evidence establishes the choice and its rationale, and link it to the enforcing contract, implementation, and executable evidence.
Record status and explicit supersession rather than rewriting accepted history.
Do not use a decision record for routine implementation detail, transient task reasoning, or a restatement of current behavior.

### Command and script mechanics

The executable's `--help`, task definition, or script header owns exact flags, paths, outputs, exit behavior, and mutation mechanics.
Documentation should explain when and why to use a command, then point to that executable owner for exact mechanics.
Do not create a prose command reference that will drift independently of the implementation.

## Choose the smallest correct action

Apply these actions in order to each candidate claim or document:

1. **Link** when a correct owner already exists and another audience needs only awareness or navigation.
2. **Rewrite** when the current owner is the right home but its statement is stale, ambiguous, or mixed with another audience.
3. **Prune** a duplicate or obsolete statement after preserving every unique current fact in the owner and repairing inbound links.
4. **Retire or relocate** a whole document when its only durable value belongs to another owner or to clearly labeled historical evidence.
5. **Create** a document only when no existing owner fits and all new-document checks below pass.
6. **Decline** the new document when it would only duplicate an owner, preserve temporary chronology as current guidance, copy executable help, or create a category with no stable audience.

A new document must satisfy every check:

- It has one stable responsibility that can be stated in a sentence.
- It serves a named audience that an existing owner cannot serve cleanly.
- It owns unique durable content rather than a different wording of current prose.
- A README, agent map, contributor guide, or documentation index will link to it at the point of need.
- Its enforcing source and verification path are known, or the gap is labeled explicitly.
- The project has a credible reason to maintain it after the current task ends.

If any check fails, link, rewrite, prune, or decline instead.

## Build or audit the navigation system

Use the target project's size and risks to select only the needed pieces.

- Keep one clear user front door.
- Keep one contributor or agent route to each change area.
- Keep one normative owner for each stable contract.
- Keep current validation discoverable from the owner it proves.
- Keep durable rationale separate from current rules.
- Keep historical evidence visibly historical and subordinate to current owners.
- Keep indexes as routing surfaces that name ownership, not summaries that mirror every destination.
- Remove or repair orphan documents, dead local links, circular ownership claims, and links that land on obsolete mechanics.

Do not create `architecture`, `contracts`, `decisions`, or `verification` directories solely to resemble another project.
A small repository may need only a concise README, a focused AGENTS map, one architecture page, and project-native tests.
A mature protocol repository may justify separate registries and evidence maps.

## Validate with project-native evidence

Discover required checks from the repository's contribution guide, CI, task runner, package metadata, and executable help before choosing commands.
Run the smallest repository-prescribed relevant documentation inventory, link, lint, and focused tests locally.
Leave broad regression to CI unless the project's documented contribution policy explicitly requires a full local suite.

At minimum, validate the applicable parts of this list:

- Maintained documentation inventory or classification through the project's existing command.
- Repository-local links and heading fragments through the existing link checker or documentation build.
- Cited setup and operator commands against current help or a safe smoke path.
- Focused executable tests for every behavior or contract changed.
- The smallest repository-required formatter, linter, documentation build, and focused test scope that covers the change.
- Broader regression in CI unless the project explicitly requires the full suite locally.
- The complete branch diff after all review, documentation, and lint fixes.

Add behavioral tests when an executable contract changes or a new executable documentation check is justified by an existing repeated need.
Exercise behavior through a public command or interface rather than asserting source strings, prose fragments, snapshots of implementation text, or the presence of policy words.
Do not invent a test that treats documentation wording as product behavior.
Do not add a link checker, inventory generator, or documentation framework for a one-time audit when existing project commands or a bounded manual check suffice.
If recurring broken-link or inventory failures justify a new check and the task authorizes it, add the smallest project-native executable and integrate it with the existing test runner and CI ownership model.

## Anti-sprawl review

Before completion, challenge the result with these questions:

- Does any stable rule appear in full in more than one place?
- Does each new file own something that can drift independently and must be maintained independently?
- Can any new paragraph become a link to a stronger owner?
- Did the README remain a user path rather than absorb contributor reference material?
- Did the AGENTS file remain a conditional map rather than absorb the skill's procedure?
- Do configuration docs explain operator meaning without copying parser or command mechanics?
- Does active verification distinguish current commands from historical observations?
- Are task paths, branches, temporary versions, failed hypotheses, and delivery proof kept out of current architecture?
- Are all moved or removed unique facts preserved in a current owner or labeled historical evidence?
- Would the architecture still make sense if every example project and filename in this skill were renamed?

If the answer exposes duplication or template-copying, revise before adding another document.

## Concrete output checklist

For an audit-only request, report:

- The bounded scope inspected and any evidence limits.
- The current audience and owner map.
- Duplicate, stale, orphaned, or missing-owner findings with exact paths and evidence.
- A smallest-first action for each finding using link, rewrite, prune, retire, create, or decline.
- Decisions that genuinely require the user and the consequence of each option.
- The project-native validation commands that would prove a change.

For an authorized change, leave and report:

- A user-oriented README with a tested shortest success path or an explicit reason no README change was needed.
- A concise conditional AGENTS map or an explicit reason the existing agent guidance already owns navigation.
- One owner for architecture, each stable contract, configuration semantics, current verification, durable decisions, and command mechanics that the project actually needs.
- Repaired indexes and local links with no orphaned new document.
- Unique facts preserved from every pruned or retired file.
- Focused tests for executable behavior changes and no source-string documentation tests.
- The exact relevant local checks run, their outcomes, CI-owned broad regression, and any unverified limitation.

## Completion criteria

The documentation architecture is complete only when:

- Every changed maintained surface has a named audience and responsibility.
- Every changed stable contract has exactly one normative owner and all other mentions are pointers.
- The README's supported success path matches current project behavior.
- Contributors and agents can route a change to its owner and executable evidence without reading the whole documentation tree.
- Exact command mechanics resolve to executable help, task definitions, or script headers.
- Durable decisions are evidence-backed, and historical or task evidence is not presented as current authority.
- The smallest relevant local inventory, link, documentation, lint, and focused test checks pass as applicable, with broader regression owned by CI unless the project explicitly requires a full local suite.
- The complete diff has passed the anti-sprawl review.
- Any failure or evidence gap is stated plainly rather than hidden behind a completion claim.
