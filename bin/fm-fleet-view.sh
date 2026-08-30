#!/usr/bin/env bash
# fm-fleet-view.sh - human renderer over fm-fleet-snapshot.sh.
#
# This command intentionally does not parse fleet state itself.
# It shells out to fm-fleet-snapshot.sh --json and renders that stable
# structured contract for humans.
#
# The default and --raw views are the complete historical human rendering.
# --compact is an explicit model-facing projection for recurring fleet reviews:
# every under-way and queued row remains in snapshot order, every state and
# endpoint error remains visible, and open decisions and hold reasons remain
# explicit.
# It never truncates output.
# Done-row detail and populated task-path cells are the only deliberate
# omissions from the historical human view; each class has an exact count and
# a complete-detail command or path in the output.
# Repeated per-task action commands collapse into exact row-id templates rather
# than disappearing.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
usage: fm-fleet-view.sh [--raw|--compact|--json]

Render a human fleet view from fm-fleet-snapshot.sh.
The default and --raw print the complete historical human view.
--compact keeps every under-way and queued row, counts every omission from
raw mode, applies no truncation, and prints exact full-detail commands.
--json prints the complete underlying snapshot.
EOF
}

MODE=raw
case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --raw|"") ;;
  --compact) MODE=compact ;;
  --json) "$SCRIPT_DIR/fm-fleet-snapshot.sh" --json; exit $? ;;
  *) usage >&2; exit 2 ;;
esac

command -v jq >/dev/null 2>&1 || { echo "fm-fleet-view: jq not found" >&2; exit 1; }

SNAPSHOT=$("$SCRIPT_DIR/fm-fleet-snapshot.sh" --json) || exit $?

if [ "$MODE" = compact ]; then
  printf '%s\n' "$SNAPSHOT" | jq -r --arg view_script "$SCRIPT_DIR/fm-fleet-view.sh" '
    def dash($v): if $v == null or $v == "" then "-" else $v end;
    def endpoint_exists($t):
      if $t.endpoint.exists == null then "unknown"
      elif $t.endpoint.exists then "present"
      else "absent" end;
    def endpoint_of($t):
      if $t.kind == "secondmate" then "\(endpoint_exists($t))/\($t.endpoint.agent_alive)"
      else endpoint_exists($t) end;
    def artifact($t):
      if $t.pr.url != null then $t.pr.url
      elif $t.paths.report.present then $t.paths.report.path
      else null end;
    def path_of($t):
      if $t.paths.home.present then $t.paths.home.path
      elif $t.paths.home.path != null then $t.paths.home.path + " (absent)"
      elif $t.paths.worktree.present then $t.paths.worktree.path
      elif $t.paths.worktree.path != null then $t.paths.worktree.path + " (absent)"
      else "-" end;
    def home_path($v; $home):
      if $v == null or $v == "-" then dash($v)
      elif $v == $home then "$FM_HOME"
      elif ($v | startswith($home + "/")) then "$FM_HOME/" + ($v | ltrimstr($home + "/"))
      else $v end;
    def attention($t):
      ($t.current_state.state != "working")
      or ($t.endpoint.exists != true)
      or ($t.kind == "secondmate" and $t.endpoint.agent_alive != "alive")
      or ((($t.hints.open_decisions // []) | length) > 0);
    def task_action($t): if $t.kind == "secondmate" then "return" else "peek" end;
    def task_row($t; $home):
      (if attention($t) then "! " else "- " end)
      + "\($t.id): \($t.current_state.state)/\($t.current_state.source)"
      + "; \($t.kind) \(dash($t.backlog.repo // $t.project))"
      + "; \($t.backend) \(endpoint_of($t))"
      + (if $t.current_state.state != "working" and (($t.current_state.detail // "") != "")
         then "; detail=\($t.current_state.detail)" else "" end)
      + (if artifact($t) == null then "" else "; artifact=\(home_path(artifact($t); $home))" end)
      + "; action=\(task_action($t))";
    def decision_row($t; $d):
      "  ! decision \($t.id)[key=\($d.key)]: \($d.verb): \($d.summary)";
    def blocker($r):
      if ($r.blocked_by // "") == "" then "-"
      elif ($r.blocked_reason // "") == "" then $r.blocked_by
      else "\($r.blocked_by) - \($r.blocked_reason)" end;
    def backlog_artifact($r): $r.pr_url // $r.report_path // $r.local_note;
    def hold_detail($r):
      if ($r.hold_reason // "") == "" then null
      else "\(dash($r.hold_kind)): \($r.hold_reason)"
        + (if ($r.hold_until // "") == "" then "" else " until \($r.hold_until)" end)
      end;
    def backlog_row($r; $home):
      (if (($r.captain_actionable // false) or ($r.structured == false)) then "! " else "- " end)
      + (if $r.structured then
          "\($r.id): \($r.title); \(dash($r.repo)) \(dash($r.kind))"
          + (if blocker($r) == "-" then "" else "; blocked=\(blocker($r))" end)
          + (if hold_detail($r) == null then "" else "; hold=\(hold_detail($r))" end)
          + (if backlog_artifact($r) == null then "" else "; artifact=\(home_path(backlog_artifact($r); $home))" end)
        else "unstructured: \($r.raw)" end);

    .fm_home as $home
    | (.tasks | length) as $tasks
    | ([.backlog.records[]? | select(.state == "queued")] | length) as $queued
    | ([.backlog.records[]? | select(.state == "done")] | length) as $done
    | ([.tasks[] | select(path_of(.) != "-")] | length) as $paths_omitted
    | "# Fleet View (compact)",
      "",
      "Home: \($home)",
      "Rows shown/total: under-way=\($tasks)/\($tasks); queued=\($queued)/\($queued); done=0/\($done).",
      "Raw-view omissions: done detail rows=\($done); task path cells=\($paths_omitted).",
      "Truncation: none.",
      "Full human detail: FM_HOME=\($home | @sh) \($view_script | @sh) --raw",
      "Complete raw snapshot: FM_HOME=\($home | @sh) \($view_script | @sh) --json",
      "Full queued hold detail: tasks-axi show <id> --full, or \(($home + "/data/backlog.md") | @sh).",
      "Actions: peek = bin/fm-peek.sh fm-<row-id>; return = bin/fm-send.sh fm-<row-id> \u0027<request>\u0027, then read status/doc and do not routinely peek a secondmate.",
      "Attention marker: ! means a non-working task, endpoint problem, open decision, captain-actionable row, unstructured row, or inventory error.",
      (if .main_inventory.valid then empty
       else "! inventory error: \(.main_inventory.reason); orphan in-flight=\(.main_inventory.orphan_in_flight | join(",")); unstructured current=\(.main_inventory.unstructured_current_count)"
       end),
      (.backlog.records[]?
       | select(.state == "in_flight" and (.structured | not))
       | "! inventory item: unstructured in-flight: \(.raw)"),
      "",
      "## Under Way",
      (if $tasks == 0 then "None."
       else (.tasks[] | . as $task
         | task_row($task; $home),
           ($task.hints.open_decisions[]? | decision_row($task; .)))
       end),
      "",
      "## Queued",
      (if $queued == 0 then "None."
       else (.backlog.records[] | select(.state == "queued") | backlog_row(.; $home))
       end),
      "",
      "## Done",
      "\($done) detail row(s) omitted; use the full-human-detail command above.",
      "",
      "## Secondmates",
      .secondmate_guidance.note
  '
  exit $?
fi

printf '%s\n' "$SNAPSHOT" | jq -r '
  def dash($v): if $v == null or $v == "" then "-" else $v end;
  def endpoint_exists($t):
    if $t.endpoint.exists == null then "unknown"
    elif $t.endpoint.exists then "present"
    else "absent" end;
  def endpoint_of($t):
    if $t.kind == "secondmate" then "\(endpoint_exists($t)) / \($t.endpoint.agent_alive)"
    else endpoint_exists($t) end;
  def artifact($t):
    if $t.pr.url != null then $t.pr.url
    elif $t.paths.report.present then $t.paths.report.path
    else "-" end;
  def path_of($t):
    if $t.paths.home.present then $t.paths.home.path
    elif $t.paths.home.path != null then $t.paths.home.path + " (absent)"
    elif $t.paths.worktree.present then $t.paths.worktree.path
    elif $t.paths.worktree.path != null then $t.paths.worktree.path + " (absent)"
    else "-" end;
  def action_of($t):
    if $t.kind == "secondmate" then "\($t.actions.send) - \($t.actions.watch)"
    else $t.actions.watch end;
  def task_row($t):
    "| \($t.id) | \($t.current_state.state) / \($t.current_state.source) | \($t.kind) | \(dash($t.backlog.repo // $t.project)) | \($t.backend) | \(endpoint_of($t)) | \(artifact($t)) | \(path_of($t)) | \(action_of($t)) |";
  def blocker($r):
    if ($r.blocked_by // "") == "" then "-"
    elif ($r.blocked_reason // "") == "" then $r.blocked_by
    else "\($r.blocked_by) - \($r.blocked_reason)" end;
  def backlog_row($r):
    "| \($r.id // "-") | \(dash($r.title // $r.raw)) | \(dash($r.repo)) | \(dash($r.kind)) | \(blocker($r)) | \(dash($r.pr_url // $r.report_path // $r.local_note)) |";

  "# Fleet View",
  "",
  "Schema: \(.schema)",
  "Home: \(.fm_home)",
  "",
  "## Under Way",
  (if (.tasks | length) == 0 then
    "No live task metadata found."
   else
    "| ID | Current | Kind | Repo/Project | Backend | Endpoint | Artifact | Path | Watch / return channel |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    (.tasks[] | task_row(.))
   end),
  "",
  "## Queued",
  (if ([.backlog.records[]? | select(.state == "queued")] | length) == 0 then
    "No queued backlog records found."
   else
    "| ID | Title | Repo | Kind | Blocked By | Artifact |",
    "| --- | --- | --- | --- | --- | --- |",
    (.backlog.records[] | select(.state == "queued") | backlog_row(.))
   end),
  "",
  "## Done",
  (if ([.backlog.records[]? | select(.state == "done")] | length) == 0 then
    "No done backlog records found."
   else
    "| ID | Title | Repo | Kind | Blocked By | Artifact |",
    "| --- | --- | --- | --- | --- | --- |",
    (.backlog.records[] | select(.state == "done") | backlog_row(.))
   end),
  "",
  "## Secondmates",
  .secondmate_guidance.note
'
