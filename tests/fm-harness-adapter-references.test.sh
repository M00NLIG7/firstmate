#!/usr/bin/env bash
# Semantic interface tests for progressive harness-adapter reference loading.
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_ROOT="$ROOT/.agents/skills/harness-adapters"

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

routing_contract() {
  awk '
    /^```json harness-adapter-routing-v1$/ { capture = 1; next }
    capture && /^```$/ { exit }
    capture { print }
  ' "$SKILL_ROOT/SKILL.md"
}

ROUTING_JSON=$(routing_contract)
printf '%s\n' "$ROUTING_JSON" | jq -e . >/dev/null \
  || fail "router did not emit a valid harness-adapter-routing-v1 contract"

reference_plan() {
  local operation=$1 harness=$2 scenario=${3:-default}
  printf '%s\n' "$ROUTING_JSON" | jq -er \
    --arg operation "$operation" \
    --arg scenario "$scenario" \
    --arg harness "$harness" '
      .operations[$operation][$scenario] as $common
      | .harnesses[$harness] as $tool
      | if ($common | type) != "array" or ($tool | type) != "string" then
          error("unknown routing scenario")
        else
          $common[], $tool
        end
    '
}

assert_plan() {
  local operation=$1 harness=$2 scenario=$3 expected=$4 actual
  actual=$(reference_plan "$operation" "$harness" "$scenario") \
    || fail "$operation/$scenario/$harness did not produce a reference plan"
  [ "$actual" = "$expected" ] \
    || fail "$operation/$scenario/$harness produced an unexpected plan: $actual"
}

assert_skill_relative_readable() {
  local root=$1 relative=$2 label=$3
  (
    cd "$root" || exit 1
    [ -r "$relative" ]
  ) || fail "$label did not resolve from the skill directory: $relative"
}

test_contract_covers_required_scenarios() {
  local operations harnesses
  operations=$(printf '%s\n' "$ROUTING_JSON" | jq -r '.operations | keys | join(" ")')
  harnesses=$(printf '%s\n' "$ROUTING_JSON" | jq -r '.harnesses | keys | join(" ")')
  [ "$operations" = "exit interrupt model-effort primary recovery resume skill start trust verify" ] \
    || fail "routing operations are incomplete: $operations"
  [ "$harnesses" = "claude codex cursor grok kimi muse opencode pi pi-signed" ] \
    || fail "supported harness identities are incomplete: $harnesses"

  assert_plan start claude default \
    $'references/common/dispatch.md\nreferences/common/model-and-effort.md\nreferences/harness/claude.md'
  assert_plan start codex trust-dialog \
    $'references/common/control-and-recovery.md\nreferences/harness/codex.md'
  assert_plan recovery opencode replacement-profile \
    $'references/common/control-and-recovery.md\nreferences/common/dispatch.md\nreferences/common/model-and-effort.md\nreferences/harness/opencode.md'
  assert_plan recovery pi secondmate \
    $'references/common/control-and-recovery.md\nreferences/common/primary-hooks.md\nreferences/harness/pi.md'
  assert_plan recovery pi-signed replacement-secondmate \
    $'references/common/control-and-recovery.md\nreferences/common/dispatch.md\nreferences/common/model-and-effort.md\nreferences/common/primary-hooks.md\nreferences/harness/pi.md'
  assert_plan model-effort grok configured-profile \
    $'references/common/model-and-effort.md\nreferences/common/dispatch.md\nreferences/harness/grok.md'
  assert_plan verify muse default \
    $'references/common/dispatch.md\nreferences/common/control-and-recovery.md\nreferences/common/primary-hooks.md\nreferences/common/model-and-effort.md\nreferences/harness/muse.md'
  pass "router contract covers base and conditional operation scenarios"
}

test_every_scenario_and_harness_resolves() {
  local operation scenario harness relative
  while IFS=$'\t' read -r operation scenario; do
    while IFS= read -r harness; do
      while IFS= read -r relative; do
        assert_skill_relative_readable \
          "$SKILL_ROOT" "$relative" "$operation/$scenario/$harness reference"
      done < <(reference_plan "$operation" "$harness" "$scenario")
    done < <(printf '%s\n' "$ROUTING_JSON" | jq -r '.harnesses | keys[]')
  done < <(printf '%s\n' "$ROUTING_JSON" | jq -r '
    .operations | to_entries[] as $operation
    | $operation.value | keys[]
    | [$operation.key, .] | @tsv
  ')
  pass "every router-emitted scenario resolves across every supported harness"
}

test_combined_identity_is_intentional() {
  local plain signed
  plain=$(printf '%s\n' "$ROUTING_JSON" | jq -r '.harnesses.pi')
  signed=$(printf '%s\n' "$ROUTING_JSON" | jq -r '.harnesses["pi-signed"]')
  [ "$plain" = "$signed" ] \
    || fail "Pi and Pi-signed must share their genuinely common contract"
  pass "Pi and Pi-signed share one tool reference without creating another skill"
}

test_shared_skill_tree_paths() {
  local canonical claude_view relative
  canonical=$(cd "$SKILL_ROOT" && pwd -P)
  claude_view=$(cd "$ROOT/.claude/skills/harness-adapters" && pwd -P)
  [ "$claude_view" = "$canonical" ] \
    || fail "Claude skill view does not resolve to the shared .agents tree"

  while IFS= read -r relative; do
    assert_skill_relative_readable \
      "$ROOT/.claude/skills/harness-adapters" "$relative" "Claude shared-tree reference"
  done < <(printf '%s\n' "$ROUTING_JSON" | jq -r '
    [.operations[][][], .harnesses[]] | unique[]
  ')

  [ "$(find "$SKILL_ROOT/references" -name SKILL.md -type f -print -quit)" = "" ] \
    || fail "references must not introduce separately catalogued skills"
  pass "canonical and Claude-compatible skill roots expose the routed resources"
}

test_external_owner_paths_resolve_from_skill_root() {
  local relative
  for relative in \
    ../../../bin/fm-harness.sh \
    ../../../bin/fm-spawn.sh \
    ../../../bin/fm-busy-lib.sh \
    ../../../bin/fm-composer-lib.sh \
    ../../../bin/fm-control-lib.sh \
    ../../../bin/fm-control.sh \
    ../../../bin/fm-send.sh \
    ../../../bin/fm-session-start.sh \
    ../../../bin/fm-supervise-daemon.sh \
    ../../../bin/fm-supervision-instructions.sh \
    ../../../docs/agent-control.md \
    ../../../docs/arm-pretool-check.md \
    ../../../docs/sessionstart-nudge.md \
    ../../../docs/subagent-guard.md \
    ../../../docs/supervision-protocols \
    ../../../docs/turnend-guard.md \
    ../firstmate-coding-guidelines/SKILL.md \
    ../secondmate-provisioning/SKILL.md \
    ../stuck-crewmate-recovery/SKILL.md; do
    assert_skill_relative_readable "$SKILL_ROOT" "$relative" "external owner"
  done
  pass "shared executable, documentation, and sibling-skill owners resolve from the skill root"
}

test_contract_covers_required_scenarios
test_every_scenario_and_harness_resolves
test_combined_identity_is_intentional
test_shared_skill_tree_paths
test_external_owner_paths_resolve_from_skill_root
