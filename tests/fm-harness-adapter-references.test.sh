#!/usr/bin/env bash
# Structural interface tests for progressive harness-adapter reference loading.
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

common_for_operation() {
  case "$1" in
    start) printf '%s\n' references/common/dispatch.md ;;
    trust|skill|interrupt|exit|resume|recovery)
      printf '%s\n' references/common/control-and-recovery.md
      ;;
    primary) printf '%s\n' references/common/primary-hooks.md ;;
    model-effort) printf '%s\n' references/common/model-and-effort.md ;;
    verify)
      printf '%s\n' \
        references/common/dispatch.md \
        references/common/control-and-recovery.md \
        references/common/primary-hooks.md \
        references/common/model-and-effort.md
      ;;
    *) return 1 ;;
  esac
}

harness_reference() {
  case "$1" in
    claude) printf '%s\n' references/harness/claude.md ;;
    codex) printf '%s\n' references/harness/codex.md ;;
    opencode) printf '%s\n' references/harness/opencode.md ;;
    pi|pi-signed) printf '%s\n' references/harness/pi.md ;;
    grok) printf '%s\n' references/harness/grok.md ;;
    kimi) printf '%s\n' references/harness/kimi.md ;;
    cursor) printf '%s\n' references/harness/cursor.md ;;
    muse) printf '%s\n' references/harness/muse.md ;;
    *) return 1 ;;
  esac
}

assert_skill_relative_readable() {
  local root=$1 relative=$2 label=$3
  (
    cd "$root" || exit 1
    [ -r "$relative" ]
  ) || fail "$label did not resolve from the skill directory: $relative"
}

test_every_operation_and_harness_resolves() {
  local operation harness common tool
  for operation in start trust skill interrupt exit resume recovery primary model-effort verify; do
    for harness in claude codex opencode pi pi-signed grok kimi cursor muse; do
      tool=$(harness_reference "$harness") || fail "missing tool reference plan for $harness"
      assert_skill_relative_readable "$SKILL_ROOT" "$tool" "$operation/$harness tool reference"
      while IFS= read -r common; do
        [ -n "$common" ] || continue
        assert_skill_relative_readable "$SKILL_ROOT" "$common" "$operation/$harness common reference"
      done < <(common_for_operation "$operation")
    done
  done
  pass "every operation scenario resolves one common plan and every supported harness reference"
}

test_combined_identity_is_intentional() {
  local pi plain signed
  plain=$(harness_reference pi)
  signed=$(harness_reference pi-signed)
  [ "$plain" = "$signed" ] || fail "Pi and Pi-signed must share their genuinely common contract"
  pi=$(harness_reference pi)
  [ "$pi" = references/harness/pi.md ] || fail "unexpected Pi reference path: $pi"
  pass "Pi and Pi-signed share one tool reference without creating another skill"
}

test_shared_skill_tree_paths() {
  local canonical claude_view relative
  canonical=$(cd "$SKILL_ROOT" && pwd -P)
  claude_view=$(cd "$ROOT/.claude/skills/harness-adapters" && pwd -P)
  [ "$claude_view" = "$canonical" ] || fail "Claude skill view does not resolve to the shared .agents tree"

  for relative in \
    references/common/dispatch.md \
    references/common/control-and-recovery.md \
    references/common/primary-hooks.md \
    references/common/model-and-effort.md \
    references/harness/claude.md \
    references/harness/codex.md \
    references/harness/opencode.md \
    references/harness/pi.md \
    references/harness/grok.md \
    references/harness/kimi.md \
    references/harness/cursor.md \
    references/harness/muse.md; do
    assert_skill_relative_readable "$ROOT/.claude/skills/harness-adapters" "$relative" "Claude shared-tree reference"
  done

  [ "$(find "$SKILL_ROOT/references" -name SKILL.md -type f -print -quit)" = "" ] \
    || fail "references must not introduce separately catalogued skills"
  pass "canonical and Claude-compatible skill roots expose the same on-demand resources"
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

test_every_operation_and_harness_resolves
test_combined_identity_is_intentional
test_shared_skill_tree_paths
test_external_owner_paths_resolve_from_skill_root
