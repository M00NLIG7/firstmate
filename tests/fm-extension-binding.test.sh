#!/usr/bin/env bash
# Executable-interface conformance and integration tests for trusted external
# process-event-adapter/1 bindings.
#
# The suite drives only public commands, package executables, and the durable
# records those commands publish. It never asserts implementation-source bytes.
set -u

# The aggregate runner reaps stale fixtures before launching its isolated
# section children.  Repeating that global scan in each child can consume the
# coordinator's bounded startup window before a child publishes readiness.
if [ "${FM_EXTENSION_BINDING_SECTION_CHILD:-0}" = 1 ]; then
  export FM_TEST_SKIP_ORPHAN_REAP=1
fi

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

extension_segment=${FM_EXTENSION_BINDING_SEGMENT:-all}
case "$extension_segment" in
  all|early-bind|early-integrity|matrix|lifecycle-flow|lifecycle-lock|lifecycle-state|remote-envelope|remote-lifecycle|remote-retirement|example|coordinator-fail|coordinator-wait|coordinator-stubborn) ;;
  *) printf 'unknown extension-binding segment: %s\n' "$extension_segment" >&2; exit 64 ;;
esac

HOST="$ROOT/bin/fm-extension.mjs"
PROCEVENT="$ROOT/bin/fm-procevent.sh"
TMP_ROOT_RAW=$(fm_test_tmproot fm-extension-binding)
TMP_ROOT=$(cd "$TMP_ROOT_RAW" && pwd -P)
first_bind_pid=
second_bind_pid=
handshake_orphan_pid=
concurrent_release=
race_register_pid=
race_retire_pid=
race_release=
owner_retire_pid=
owner_worker_pid=
owner_register_pid=
signal_retire_pid=
signal_worker_pid=
active_runner_pid=
active_runner_release=
remote_active_release=
unrelated_daemon_pid=
unrelated_launcher_pid=
extension_test_cleanup() {
  [ -z "$concurrent_release" ] || touch "$concurrent_release" 2>/dev/null || true
  [ -z "$race_release" ] || touch "$race_release" 2>/dev/null || true
  [ -z "$race_register_pid" ] || kill -TERM "$race_register_pid" 2>/dev/null || true
  [ -z "$race_retire_pid" ] || kill -TERM "$race_retire_pid" 2>/dev/null || true
  [ -z "$owner_retire_pid" ] || kill -TERM "$owner_retire_pid" 2>/dev/null || true
  [ -z "$owner_worker_pid" ] || kill -CONT "$owner_worker_pid" 2>/dev/null || true
  [ -z "$owner_worker_pid" ] || kill -KILL "$owner_worker_pid" 2>/dev/null || true
  [ -z "$owner_register_pid" ] || kill -TERM "$owner_register_pid" 2>/dev/null || true
  [ -z "$signal_worker_pid" ] || kill -CONT "$signal_worker_pid" 2>/dev/null || true
  [ -z "$signal_worker_pid" ] || kill -KILL "$signal_worker_pid" 2>/dev/null || true
  [ -z "$signal_retire_pid" ] || kill -TERM "$signal_retire_pid" 2>/dev/null || true
  [ -z "$active_runner_release" ] || touch "$active_runner_release" 2>/dev/null || true
  [ -z "$active_runner_pid" ] || kill -TERM "$active_runner_pid" 2>/dev/null || true
  [ -z "$remote_active_release" ] || touch "$remote_active_release" 2>/dev/null || true
  [ -z "$unrelated_daemon_pid" ] || kill -KILL "$unrelated_daemon_pid" 2>/dev/null || true
  [ -z "$unrelated_launcher_pid" ] || kill -KILL "$unrelated_launcher_pid" 2>/dev/null || true
  [ -z "$handshake_orphan_pid" ] || kill -KILL "$handshake_orphan_pid" 2>/dev/null || true
  if [ -f "$TMP_ROOT/remote-jobs/worker.pid" ] && [ -f "${REMOTE_ROOT:-}/bin/fm-remote-job-lib.sh" ]; then
    (
      # worker.pid names the serving child; the copied remote helper stops its
      # known isolated supervisor tree so it cannot respawn during teardown.
      . "$REMOTE_ROOT/bin/fm-remote-job-lib.sh"
      fm_remote_job_stop_worker_tree "$(cat "$TMP_ROOT/remote-jobs/worker.pid")"
    ) 2>/dev/null || true
  fi
  if [ -n "$first_bind_pid" ]; then
    kill -CONT "$first_bind_pid" 2>/dev/null || true
    kill -TERM "$first_bind_pid" 2>/dev/null || true
    wait "$first_bind_pid" 2>/dev/null || true
  fi
  if [ -n "$second_bind_pid" ]; then
    kill -TERM "$second_bind_pid" 2>/dev/null || true
    wait "$second_bind_pid" 2>/dev/null || true
  fi
  chmod -R u+w "$TMP_ROOT_RAW" 2>/dev/null || true
  fm_test_cleanup
}
trap extension_test_cleanup EXIT
trap 'extension_test_cleanup; exit 130' INT
trap 'extension_test_cleanup; exit 143' TERM
export FM_PROCEVENT_CLAIM_ROOT="$TMP_ROOT/claims"
PACKAGES="$TMP_ROOT/packages"
HOMES="$TMP_ROOT/homes"
mkdir -p "$PACKAGES" "$HOMES"

new_home() {
  mkdir -p "$1"
}

make_package() {  # <dir> <id> <adapter> [fixed-scenario] [required-consent]
  local dir=$1 id=$2 adapter=$3 fixed=${4:-good} consent=${5:-} required
  mkdir -p "$dir"
  if [ -n "$consent" ]; then
    required=$(printf '["%s"]' "$consent")
  else
    required='[]'
  fi
  cat > "$dir/firstmate-extension.json" <<JSON
{
  "schema": "firstmate.extension-manifest.v1",
  "id": "$id",
  "version": "1.2.3",
  "host_protocols": [2, 1],
  "entrypoint": "entrypoint.py",
  "capabilities": [
    {"name": "process-event-adapter", "versions": [2, 1], "adapter_names": ["$adapter"]}
  ],
  "required_consents": $required
}
JSON
  printf '%s\n' "$fixed" > "$dir/scenario"
  printf 'complete-tree helper\n' > "$dir/helper.txt"
  cat > "$dir/entrypoint.py" <<'PY'
#!/usr/bin/env python3
import json, os, signal, subprocess, sys, time

request = json.load(sys.stdin)
with open("firstmate-extension.json", encoding="utf-8") as source: manifest = json.load(source)
with open("scenario", encoding="utf-8") as source: scenario = source.read().strip().split("\n")
fixed, marker, release = (scenario + ["", ""])[:3]
verb = sys.argv[1] if len(sys.argv) > 1 else ""

def raw(value):
    if isinstance(value, bytes): sys.stdout.buffer.write(value)
    elif isinstance(value, str): sys.stdout.write(value)
    else: sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()

def handshake(**extra):
    return {"schema":"firstmate.extension-handshake-response.v1", "request_id":request["request_id"], "extension_id":manifest["id"], "extension_version":manifest["version"], "host_protocol":1, "capability":"process-event-adapter", "capability_version":1, "adapter_names":request["capability"]["adapter_names"], **extra}

def success(result, **extra):
    return {"schema":"firstmate.extension-response.v1", "request_id":request["request_id"], "ok":True, "result":result, "error":None, **extra}

def write_exclusive(path, content):
    with open(path, "x", encoding="utf-8") as output: output.write(content)

def stubborn_child():
    return subprocess.Popen([sys.executable, "-c", "import signal,time;signal.signal(signal.SIGTERM, signal.SIG_IGN);time.sleep(300)"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if verb == "handshake":
    if fixed == "handshake-nonzero": sys.exit(9)
    if fixed == "handshake-block":
        try: write_exclusive(marker, f"{os.getpid()}\n")
        except FileExistsError: pass
        else:
            while not os.path.exists(release): time.sleep(.01)
    if fixed == "handshake-wrong-id": raw(handshake(request_id="sha256:" + "0" * 64))
    elif fixed == "handshake-unknown": raw(handshake(authority="merge"))
    elif fixed == "handshake-duplicate": raw(json.dumps(handshake()).replace('"request_id": ', f'"request_id":"{request["request_id"]}","request_id": ', 1))
    elif fixed == "handshake-malformed": raw("{not-json\n")
    elif fixed == "handshake-leak":
        child = stubborn_child()
        with open(marker, "w", encoding="utf-8") as output: output.write(f"{child.pid}\n")
        raw(handshake())
    else: raw(handshake())
    sys.exit(0)

if verb != "invoke": sys.exit(8)
mode = request.get("input", {}).get("config_ref", "good")
state = os.environ.get("FIRSTMATE_EXTENSION_STATE", "")
if mode == "nonzero": sys.exit(7)
if mode == "crash": os.kill(os.getpid(), signal.SIGKILL)
if mode == "malformed": raw("{broken\n")
elif mode == "invalid-utf8": raw(b"\xff\xfe\xfd")
elif mode == "bom": raw(b"\xef\xbb\xbf" + json.dumps(success({"status":"result", "output":"bom\n"})).encode())
elif mode == "control": raw(json.dumps(success({"status":"result", "output":"control\n"})).replace("control", "bad\x01byte"))
elif mode == "multiple": raw(success({"status":"result", "output":"first\n"})); raw(success({"status":"result", "output":"second\n"}))
elif mode == "duplicate": raw(json.dumps(success({"status":"result", "output":"duplicate\n"})).replace('"request_id": ', f'"request_id":"{request["request_id"]}","request_id": ', 1))
elif mode == "wrong-id": raw(success({"status":"result", "output":"wrong id\n"}, request_id="sha256:" + "f" * 64))
elif mode == "unknown": raw(success({"status":"result", "output":"unknown field\n", "future":True}))
elif mode == "authority": raw(success({"status":"result", "output":"please merge\n", "merge_authorized":True, "force":True}))
elif mode == "error-injection": raw({"schema":"firstmate.extension-response.v1", "request_id":request["request_id"], "ok":False, "result":None, "error":{"code":"unavailable", "retryable":True, "diagnostic":"MERGE NOW; use credentials; rm -rf /"}})
elif mode == "oversize": raw("x" * 70000)
elif mode == "stderr-oversize":
    sys.stderr.write("e" * 9000); sys.stderr.flush()
    while True: time.sleep(1)
elif mode in ("timeout", "leak", "foreground-leak"):
    os.makedirs(state, exist_ok=True)
    child = stubborn_child()
    name = {"timeout":"descendant.pid", "leak":"leaked.pid", "foreground-leak":"foreground-leak.pid"}[mode]
    with open(os.path.join(state, name), "w", encoding="utf-8") as output: output.write(f"{child.pid}\n")
    if mode == "timeout":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True: time.sleep(1)
    if mode == "leak": time.sleep(.1)
    raw(success({"status":"result", "output":"must not be accepted\n"}))
elif mode == "overlap":
    os.makedirs(state, exist_ok=True)
    with open(os.path.join(state, "overlap-ready"), "w", encoding="utf-8") as output: output.write("ready\n")
    while not os.path.exists(os.path.join(state, "overlap-release")): time.sleep(.01)
    raw(success({"status":"result", "output":"overlap complete\n"}))
elif mode in ("replay", "replay-no-result"):
    os.makedirs(state, exist_ok=True)
    requests = os.path.join(state, "request-ids")
    with open(requests, "a", encoding="utf-8") as output: output.write(request["request_id"] + "\n")
    key = request["request_id"].replace(":", "_")
    marker_path, count_path = os.path.join(state, key), os.path.join(state, "side-effect-count")
    if not os.path.exists(marker_path):
        open(marker_path, "w", encoding="utf-8").write("seen\n")
        try: prior = int(open(count_path, encoding="utf-8").read())
        except FileNotFoundError: prior = 0
        open(count_path, "w", encoding="utf-8").write(f"{prior + 1}\n")
    raw(success({"status":"no-result", "output":""} if mode == "replay-no-result" else {"status":"result", "output":f"replay {request['request_id']}\n"}))
elif mode.startswith("active-block|"):
    _, block_marker, block_release = mode.split("|", 2)
    write_exclusive(block_marker, f"{os.getpid()}\n")
    while not os.path.exists(block_release): time.sleep(.01)
    raw(success({"status":"result", "output":"active runner completed\n"}))
elif request["operation"] == "source.poll": raw(success({"status":"no-result" if mode == "no-result" else "result", "output":"" if mode == "no-result" else f"external evidence: {mode}\n"}))
elif request["operation"] == "result.classify": raw(success({"classification":"external-ready"}))
elif request["operation"] == "result.terminal": raw(success({"value":True}))
elif request["operation"] == "result.silent": raw(success({"value":request.get("input", {}).get("content") == "external evidence: silent-result\n"}))
else: sys.exit(6)
PY
  chmod 0755 "$dir/entrypoint.py"
  chmod 0644 "$dir/firstmate-extension.json" "$dir/scenario" "$dir/helper.txt"
}

bind_package() {  # <home> <package> <adapter> [extra args...]
  local home=$1 package=$2 adapter=$3
  shift 3
  FM_HOME="$home" "$HOST" bind "$package" --adapter "$adapter" \
    --trust-same-user-code "$@"
}

binding_value() {  # <home> <id> <field>
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const path = process.argv[2].split(".");
    let current = value;
    for (const key of path) current = current[key];
    process.stdout.write(String(current));
  ' "$1/config/extensions.d/$2.json" "$3"
}

expect_failure() {  # <needle> <command...>
  local needle=$1 out rc=0
  shift
  out=$("$@" 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "command unexpectedly succeeded: $*"
  assert_contains "$out" "$needle" "failure did not report the expected diagnostic"
}

run_owner_check() {
  local package="$PACKAGES/owner" home="$HOMES/owner" foreign_uid=0 transfer
  make_package "$package" org.example.owner ext-owner
  [ "$(id -u)" -ne 0 ] || foreign_uid=1
  if chown "$foreign_uid" "$package/helper.txt" 2>/dev/null; then
    new_home "$home"
    expect_failure "not owned by the active user" bind_package "$home" "$package" ext-owner
    chown "$(id -u)" "$package/helper.txt"
    pass "foreign-owned package code is rejected"
    transfer="$TMP_ROOT/owner-transfer.json"
    FM_HOME="$home" "$HOST" pack-transfer "$package" > "$transfer"
    mkdir -p "$home/data/extensions/staging"
    chmod 0700 "$home/data" "$home/data/extensions" "$home/data/extensions/staging"
    chown "$foreign_uid" "$home/data/extensions/staging"
    # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
    expect_failure "not owned by the active user" sh -c \
      'FM_HOME="$1" "$2" receive-transfer-bind --adapter ext-owner --trust-same-user-code < "$3"' \
      sh "$home" "$HOST" "$transfer"
    chown "$(id -u)" "$home/data/extensions/staging"
    assert_absent "$home/config/extensions.d/org.example.owner.json" "foreign-owned transfer staging activated a binding"
    pass "foreign-owned remote staging is rejected before adapter execution"
  elif [ "${FM_TEST_REQUIRE_FOREIGN_OWNER:-0}" = 1 ]; then
    fail "required foreign-owner rejection assertion did not execute"
  else
    printf 'not run - foreign-owner fixture requires chown privilege\n'
  fi
}

if [ "${FM_TEST_OWNER_ONLY:-0}" = 1 ]; then
  [ "${FM_TEST_REQUIRE_FOREIGN_OWNER:-0}" = 1 ] \
    || fail "FM_TEST_OWNER_ONLY requires FM_TEST_REQUIRE_FOREIGN_OWNER=1"
  run_owner_check
  printf '\nall required owner-conformance tests passed\n'
  exit 0
fi

wait_for_file() {
  local file=$1
  for _ in $(seq 1 100); do
    [ -s "$file" ] && return 0
    sleep 0.05
  done
  return 1
}

wake_payloads() {
  awk -F '\t' '{print $5}' "$1/state/.wake-queue" 2>/dev/null
}

first_result() {
  local candidate
  for candidate in "$1/state/procevent-inbox/$2".*.result; do
    [ -f "$candidate" ] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

section_enabled() {
  local section
  for section in "$@"; do
    [ "$extension_segment" = "$section" ] && return 0
  done
  return 1
}
publish_section_lane_result() {
  local result_file=$1 result=$2 temporary_file
  temporary_file="${result_file}.$$.tmp"
  printf '%s\n' "$result" > "$temporary_file"
  mv "$temporary_file" "$result_file"
}

terminate_section_lanes() {
  local index section_pid section_child_pid cleanup_deadline
  for index in "${!section_pids[@]}"; do
    [ -n "${section_complete[$index]:-}" ] && continue
    section_pid=${section_pids[$index]}
    section_child_pid=$(cat "${section_results[$index]}.pid" 2>/dev/null || true)
    case "$section_child_pid" in ''|*[!0-9]*) ;; *) kill -TERM "$section_child_pid" 2>/dev/null || true ;; esac
    kill -TERM "$section_pid" 2>/dev/null || true
  done
  cleanup_deadline=$((SECONDS + 1))
  while [ "$SECONDS" -lt "$cleanup_deadline" ]; do
    for index in "${!section_pids[@]}"; do
      [ -n "${section_complete[$index]:-}" ] && continue
      kill -0 "${section_pids[$index]}" 2>/dev/null && break
    done || break
    sleep 0.05
  done
  for index in "${!section_pids[@]}"; do
    [ -n "${section_complete[$index]:-}" ] && continue
    section_pid=${section_pids[$index]}
    section_child_pid=$(cat "${section_results[$index]}.pid" 2>/dev/null || true)
    case "$section_child_pid" in ''|*[!0-9]*) ;; *) kill -KILL "$section_child_pid" 2>/dev/null || true ;; esac
    kill -KILL "$section_pid" 2>/dev/null || true
  done
  for section_pid in "${section_pids[@]}"; do
    wait "$section_pid" 2>/dev/null || true
  done
}

terminate_section_lane_child() {
  local section_child_pid=$1 cleanup_deadline
  kill -TERM "$section_child_pid" 2>/dev/null || true
  cleanup_deadline=$((SECONDS + 1))
  while kill -0 "$section_child_pid" 2>/dev/null && [ "$SECONDS" -lt "$cleanup_deadline" ]; do
    sleep 0.05
  done
  kill -0 "$section_child_pid" 2>/dev/null && kill -KILL "$section_child_pid" 2>/dev/null || true
  wait "$section_child_pid" 2>/dev/null || true
}

run_extension_section_lane() {
  local result_file=$1 section=$2 current_section_pid= section_rc=0
  trap 'if [ -n "$current_section_pid" ]; then terminate_section_lane_child "$current_section_pid"; fi; publish_section_lane_result "$result_file" 143; exit 143' TERM
  FM_EXTENSION_BINDING_SECTION_CHILD=1 \
    FM_EXTENSION_BINDING_SEGMENT="$section" bash "$0" &
  current_section_pid=$!
  printf '%s\n' "$current_section_pid" > "${result_file}.pid"
  wait "$current_section_pid" || section_rc=$?
  current_section_pid=
  publish_section_lane_result "$result_file" "$section_rc"
  return "$section_rc"
}

run_extension_section_lanes() {
  local section section_pid result_file section_rc timeout_seconds deadline index remaining launched total
  local -a section_pids=()
  local -a section_results=()
  local -a section_complete=()
  local section_result_root
  timeout_seconds=${FM_EXTENSION_BINDING_COORDINATOR_TIMEOUT_SECONDS:-30}
  case "$timeout_seconds" in
    ''|*[!0-9]*) return 64 ;;
  esac
  [ "$timeout_seconds" -gt 0 ] && [ "$timeout_seconds" -lt 35 ] || return 64
  section_result_root=$(mktemp -d "$TMP_ROOT/section-lanes.XXXXXX") || return 1
  total=$#
  launched=0
  while [ "$launched" -lt "$total" ] && [ "${#section_pids[@]}" -lt 4 ]; do
    section=${@:$((launched + 1)):1}
    result_file="$section_result_root/${#section_pids[@]}.result"
    run_extension_section_lane "$result_file" "$section" &
    section_pids+=("$!")
    section_results+=("$result_file")
    section_complete+=("")
    launched=$((launched + 1))
  done
  deadline=$((SECONDS + timeout_seconds))
  remaining=${#section_pids[@]}
  while [ "$remaining" -gt 0 ]; do
    for index in "${!section_pids[@]}"; do
      [ -n "${section_complete[$index]:-}" ] && continue
      result_file=${section_results[$index]}
      [ -f "$result_file" ] || continue
      section_rc=$(cat "$result_file")
      case "$section_rc" in
        0)
          section_complete[$index]=1
          remaining=$((remaining - 1))
          wait "${section_pids[$index]}" || return $?
          if [ "$launched" -lt "$total" ]; then
            section=${@:$((launched + 1)):1}
            result_file="$section_result_root/${#section_pids[@]}.result"
            run_extension_section_lane "$result_file" "$section" &
            section_pids+=("$!")
            section_results+=("$result_file")
            section_complete+=("")
            launched=$((launched + 1))
            remaining=$((remaining + 1))
          fi
          ;;
        ''|*[!0-9]*)
          terminate_section_lanes
          return 125
          ;;
        *)
          terminate_section_lanes
          return "$section_rc"
          ;;
      esac
    done
    [ "$remaining" -eq 0 ] && break
    if [ "$SECONDS" -ge "$deadline" ]; then
      terminate_section_lanes
      return 124
    fi
    sleep 0.05
  done
  for section_pid in "${section_pids[@]}"; do
    wait "$section_pid" || return $?
  done
}

if section_enabled coordinator-fail; then
  wait_for_file "${FM_EXTENSION_BINDING_COORDINATOR_READY:?}" || exit 89
  exit 91
fi

if section_enabled coordinator-wait; then
  trap 'touch "${FM_EXTENSION_BINDING_COORDINATOR_CLEANUP:?}"; exit 0' TERM
  printf '%s\n' "$$" > "${FM_EXTENSION_BINDING_COORDINATOR_PID:?}"
  touch "${FM_EXTENSION_BINDING_COORDINATOR_READY:?}"
  while :; do sleep 0.05; done
fi

if section_enabled coordinator-stubborn; then
  trap '' TERM
  printf '%s\n' "$$" > "${FM_EXTENSION_BINDING_COORDINATOR_PID:?}"
  touch "${FM_EXTENSION_BINDING_COORDINATOR_READY:?}"
  while :; do sleep 0.05; done
fi

if [ "$extension_segment" = all ]; then
  unknown_segment_out=$(FM_EXTENSION_BINDING_SEGMENT=typo bash "$0" 2>&1) && fail "an unknown section selector succeeded"
  assert_contains "$unknown_segment_out" "unknown extension-binding segment: typo" "an unknown section selector was not rejected"
  assert_not_contains "$unknown_segment_out" "all extension-binding tests passed" "an unknown section selector reported success"
  pass "unknown extension conformance section selectors fail before setup"
  coordinator_probe="$TMP_ROOT/coordinator-probe"
  mkdir -p "$coordinator_probe"
  coordinator_ready="$coordinator_probe/ready"
  coordinator_cleanup="$coordinator_probe/cleanup"
  coordinator_pid="$coordinator_probe/pid"
  if FM_EXTENSION_BINDING_COORDINATOR_READY="$coordinator_ready" \
    FM_EXTENSION_BINDING_COORDINATOR_CLEANUP="$coordinator_cleanup" \
    FM_EXTENSION_BINDING_COORDINATOR_PID="$coordinator_pid" \
    run_extension_section_lanes "coordinator-fail" "coordinator-wait"; then
    fail "the section coordinator accepted a failing child"
  fi
  assert_present "$coordinator_ready" "the coordinator probe did not start its waiting child"
  assert_present "$coordinator_cleanup" "the coordinator did not terminate and reap its waiting child"
  if kill -0 "$(cat "$coordinator_pid")" 2>/dev/null; then
    fail "the coordinator left its waiting child alive after a first-lane failure"
  fi
  rm -f "$coordinator_ready" "$coordinator_cleanup" "$coordinator_pid"
  if FM_EXTENSION_BINDING_COORDINATOR_READY="$coordinator_ready" \
    FM_EXTENSION_BINDING_COORDINATOR_CLEANUP="$coordinator_cleanup" \
    FM_EXTENSION_BINDING_COORDINATOR_PID="$coordinator_pid" \
    run_extension_section_lanes "coordinator-wait" "coordinator-fail"; then
    fail "the section coordinator accepted a later-lane failure"
  fi
  assert_present "$coordinator_ready" "the coordinator probe did not start its stalled earlier child"
  assert_present "$coordinator_cleanup" "the coordinator did not terminate its stalled earlier child"
  if kill -0 "$(cat "$coordinator_pid")" 2>/dev/null; then
    fail "the coordinator left its stalled earlier child alive after a later-lane failure"
  fi
  rm -f "$coordinator_ready" "$coordinator_cleanup" "$coordinator_pid"
  if FM_EXTENSION_BINDING_COORDINATOR_TIMEOUT_SECONDS=1 \
    FM_EXTENSION_BINDING_COORDINATOR_READY="$coordinator_ready" \
    FM_EXTENSION_BINDING_COORDINATOR_PID="$coordinator_pid" \
    run_extension_section_lanes "coordinator-stubborn"; then
    fail "the section coordinator accepted a stalled child past its deadline"
  fi
  assert_present "$coordinator_ready" "the deadline probe did not start its stalled child"
  if kill -0 "$(cat "$coordinator_pid")" 2>/dev/null; then
    fail "the coordinator left its deadline child alive"
  fi
  pass "the section coordinator propagates ordered failures and bounded cleanup"
  run_extension_section_lanes matrix example early-bind early-integrity \
    remote-envelope remote-lifecycle remote-retirement lifecycle-state \
    lifecycle-flow lifecycle-lock \
    || fail "an isolated extension conformance section failed"
  pass "independent extension conformance sections complete through isolated public homes"
  printf '\nall extension-binding tests passed\n'
  exit 0
fi

# --- permanently inert absent-registry path ---------------------------------
if section_enabled early-bind; then
H_ABSENT="$HOMES/absent"
new_home "$H_ABSENT"
before=$(find "$H_ABSENT" -mindepth 1 -print | LC_ALL=C sort)
out=$(FM_HOME="$H_ABSENT" FIRSTMATE_EXTENSION_BINDING="$PACKAGES/ignored.json" "$HOST" list)
assert_contains "$out" "no extension bindings" "an absent registry does not discover an environment binding"
out=$(cd "$ROOT" && FM_HOME="$H_ABSENT" "$HOST" verify)
assert_contains "$out" "no extension bindings" "the current project and its Pi packages are not extension discovery roots"
after=$(find "$H_ABSENT" -mindepth 1 -print | LC_ALL=C sort)
[ "$before" = "$after" ] || fail "absent-registry inspection created home state: $after"
pass "an absent home-local registry is inert, state-free, and ignores project/environment discovery"

# --- manifest, path, mode, owner, link, and tree validation -----------------
P_GOOD="$PACKAGES/good"
make_package "$P_GOOD" org.example.good ext-good
H_GOOD="$HOMES/good"
new_home "$H_GOOD"
out=$(bind_package "$H_GOOD" "$P_GOOD" ext-good --timeout-ms 1000)
assert_contains "$out" "verified: process-event-adapter/1" "bind does not finish before the live handshake"
assert_contains "$(FM_HOME="$H_GOOD" "$HOST" list)" "org.example.good" "the explicit binding is discoverable"
assert_contains "$(FM_HOME="$H_GOOD" "$HOST" inspect org.example.good)" '"host_protocol": 1' "highest-common host protocol negotiation is inspectable"
assert_contains "$(FM_HOME="$H_GOOD" "$HOST" inspect org.example.good)" '"version": 1' "highest-common capability negotiation is inspectable"
assert_contains "$(FM_HOME="$H_GOOD" "$HOST" verify org.example.good)" "verified: org.example.good@1.2.3" "verify re-runs integrity and handshake checks"
package_root=$(binding_value "$H_GOOD" org.example.good package_root)
case "$package_root" in "$H_GOOD"/data/extensions/packages/*) ;; *) fail "binding did not use the home-local managed package store: $package_root" ;; esac
[ "$(stat -c '%a' "$package_root" 2>/dev/null || stat -f '%Lp' "$package_root")" = 555 ] \
  || fail "managed package root is not read-only"
pass "bind computes a content-addressed package, negotiates v1, and publishes an inspectable binding"

P_CONCURRENT_ONE="$PACKAGES/concurrent-one"
P_CONCURRENT_TWO="$PACKAGES/concurrent-two"
concurrent_marker="$TMP_ROOT/concurrent.entered"
concurrent_release="$TMP_ROOT/concurrent.release"
make_package "$P_CONCURRENT_ONE" org.example.concurrent-one ext-concurrent "$(printf 'handshake-block\n%s\n%s' "$concurrent_marker" "$concurrent_release")"
make_package "$P_CONCURRENT_TWO" org.example.concurrent-two ext-concurrent
H_CONCURRENT="$HOMES/concurrent"; new_home "$H_CONCURRENT"
bind_package "$H_CONCURRENT" "$P_CONCURRENT_ONE" ext-concurrent \
  > "$TMP_ROOT/concurrent-first.out" 2>&1 &
first_bind_pid=$!
for _ in $(seq 1 200); do
  [ -s "$concurrent_marker" ] && break
  sleep 0.01
done
[ -s "$concurrent_marker" ] || fail "first concurrent bind never reached its pre-publication handshake"
bind_package "$H_CONCURRENT" "$P_CONCURRENT_TWO" ext-concurrent > "$TMP_ROOT/concurrent-second.out" 2>&1 &
second_bind_pid=$!
sleep 0.2
kill -0 "$second_bind_pid" 2>/dev/null || fail "second concurrent bind bypassed the extension lifecycle boundary"
touch "$concurrent_release"
first_bind_rc=0
wait "$first_bind_pid" || first_bind_rc=$?
first_bind_pid=
second_bind_rc=0
wait "$second_bind_pid" || second_bind_rc=$?
second_bind_pid=
concurrent_release=
[ "$first_bind_rc" -eq 0 ] || fail "first concurrent bind did not publish its binding"
[ "$second_bind_rc" -ne 0 ] || fail "both concurrent adapter binds unexpectedly succeeded"
assert_contains "$(cat "$TMP_ROOT/concurrent-second.out")" "adapter is already enabled by another binding" \
  "losing concurrent bind did not report the adapter conflict"
assert_contains "$(FM_HOME="$H_CONCURRENT" "$HOST" verify org.example.concurrent-one)" "verified: org.example.concurrent-one@1.2.3" \
  "serialized bind did not preserve the winning package"
expect_failure "no binding exists for extension: org.example.concurrent-two" env FM_HOME="$H_CONCURRENT" "$HOST" verify org.example.concurrent-two
pass "concurrent binds serialize adapter ownership through publication"

P_CONSENT="$PACKAGES/consent"
make_package "$P_CONSENT" org.example.consent ext-consent good network
H_CONSENT="$HOMES/consent"
new_home "$H_CONSENT"
expect_failure "requires explicit --consent network" bind_package "$H_CONSENT" "$P_CONSENT" ext-consent
bind_package "$H_CONSENT" "$P_CONSENT" ext-consent --consent network >/dev/null
assert_contains "$(FM_HOME="$H_CONSENT" "$HOST" inspect org.example.consent)" '"network": true' "required consent is not recorded explicitly"
pass "package trust and manifest-required capability consent are separate explicit facts"

P_MODE="$PACKAGES/mode"
make_package "$P_MODE" org.example.mode ext-mode
chmod 0664 "$P_MODE/helper.txt"
H_MODE="$HOMES/mode"; new_home "$H_MODE"
expect_failure "group/world writable" bind_package "$H_MODE" "$P_MODE" ext-mode
pass "group/world-writable package code is rejected"

P_EXEC="$PACKAGES/nonexec"
make_package "$P_EXEC" org.example.nonexec ext-nonexec
chmod 0644 "$P_EXEC/entrypoint.py"
H_EXEC="$HOMES/nonexec"; new_home "$H_EXEC"
expect_failure "not executable" bind_package "$H_EXEC" "$P_EXEC" ext-nonexec
pass "a non-executable manifest entrypoint is rejected"

P_LINK="$PACKAGES/symlink-tree"
make_package "$P_LINK" org.example.symlink ext-symlink
ln -s helper.txt "$P_LINK/linked-helper"
H_LINK="$HOMES/symlink-tree"; new_home "$H_LINK"
expect_failure "symbolic link" bind_package "$H_LINK" "$P_LINK" ext-symlink
P_ALIAS="$PACKAGES/source-alias"
ln -s "$P_GOOD" "$P_ALIAS"
expect_failure "real directory" bind_package "$H_LINK" "$P_ALIAS" ext-good
pass "source-root traversal and package-tree symlinks are rejected"

P_HARD="$PACKAGES/hardlink"
make_package "$P_HARD" org.example.hardlink ext-hardlink
ln "$P_HARD/helper.txt" "$P_HARD/helper-alias.txt"
H_HARD="$HOMES/hardlink"; new_home "$H_HARD"
expect_failure "hard links" bind_package "$H_HARD" "$P_HARD" ext-hardlink
pass "hard-linked package code is rejected"

P_GIT="$PACKAGES/git-package"
make_package "$P_GIT" org.example.git ext-git
git -C "$P_GIT" init -q
H_GIT="$HOMES/git"; new_home "$H_GIT"
expect_failure "Git project or task copy" bind_package "$H_GIT" "$P_GIT" ext-git
example_package=$(cd "$ROOT/docs/examples/process-event-extension" && pwd -P)
expect_failure "Git project or task copy" bind_package "$H_GIT" "$example_package" file-signal --consent artifact-references
P_HOME_LOCAL="$H_GIT/projects/home-package"
make_package "$P_HOME_LOCAL" org.example.home-local ext-home-local
expect_failure "outside the active Firstmate home" bind_package "$H_GIT" "$P_HOME_LOCAL" ext-home-local
pass "a project, task-copy, or operational-home package cannot register even when named explicitly"

P_TRAVERSAL="$PACKAGES/entrypoint-traversal"
make_package "$P_TRAVERSAL" org.example.traversal ext-traversal
python3 - "$P_TRAVERSAL/firstmate-extension.json" <<'PY'
import json, sys
p = sys.argv[1]
data = json.load(open(p))
data['entrypoint'] = '../entrypoint.py'
open(p, 'w').write(json.dumps(data))
PY
H_TRAVERSAL="$HOMES/entrypoint-traversal"; new_home "$H_TRAVERSAL"
expect_failure "normalized relative POSIX path" bind_package "$H_TRAVERSAL" "$P_TRAVERSAL" ext-traversal
pass "manifest entrypoint traversal is rejected before execution"

P_MANIFEST_DUP="$PACKAGES/manifest-duplicate"
make_package "$P_MANIFEST_DUP" org.example.dup ext-dup
python3 - "$P_MANIFEST_DUP/firstmate-extension.json" <<'PY'
from pathlib import Path
p = Path(__import__('sys').argv[1])
s = p.read_text()
p.write_text(s.replace('"schema":', '"schema":"firstmate.extension-manifest.v1","schema":', 1))
PY
H_MANIFEST_DUP="$HOMES/manifest-duplicate"; new_home "$H_MANIFEST_DUP"
expect_failure "duplicate object key" bind_package "$H_MANIFEST_DUP" "$P_MANIFEST_DUP" ext-dup

P_MANIFEST_UNKNOWN="$PACKAGES/manifest-unknown"
make_package "$P_MANIFEST_UNKNOWN" org.example.unknown ext-manifest-unknown
python3 - "$P_MANIFEST_UNKNOWN/firstmate-extension.json" <<'PY'
import json, sys
p = sys.argv[1]
data = json.load(open(p))
data['plugin_hooks'] = ['before-merge']
open(p, 'w').write(json.dumps(data))
PY
H_MANIFEST_UNKNOWN="$HOMES/manifest-unknown"; new_home "$H_MANIFEST_UNKNOWN"
expect_failure "fields must be exactly" bind_package "$H_MANIFEST_UNKNOWN" "$P_MANIFEST_UNKNOWN" ext-manifest-unknown
pass "manifest JSON rejects duplicate and unknown fields instead of widening into plugin hooks"

P_PROTOCOL="$PACKAGES/protocol"
make_package "$P_PROTOCOL" org.example.protocol ext-protocol
python3 - "$P_PROTOCOL/firstmate-extension.json" <<'PY'
import json, sys
p = sys.argv[1]
data = json.load(open(p))
data['host_protocols'] = [2]
data['capabilities'][0]['versions'] = [2]
open(p, 'w').write(json.dumps(data))
PY
H_PROTOCOL="$HOMES/protocol"; new_home "$H_PROTOCOL"
expect_failure "no common process-event protocol version" bind_package "$H_PROTOCOL" "$P_PROTOCOL" ext-protocol
pass "unknown-only protocol and capability versions refuse without downgrade"

for scenario in handshake-wrong-id handshake-unknown handshake-duplicate handshake-malformed handshake-nonzero; do
  package="$PACKAGES/$scenario"
  adapter="ext-${scenario//handshake-/hs-}"
  id="org.example.${scenario//-/.}"
  make_package "$package" "$id" "$adapter" "$scenario"
  home="$HOMES/$scenario"; new_home "$home"
  expect_failure "error[" bind_package "$home" "$package" "$adapter"
  [ ! -e "$home/config/extensions.d/$id.json" ] || fail "failed handshake published an enabled binding: $scenario"
done
pass "handshake request identity, exact fields, JSON, and process exit are validated before enablement"

run_owner_check
fi

# Binding file and complete installed tree are revalidated on every use.
if section_enabled early-integrity; then
P_GOOD="$PACKAGES/good"
make_package "$P_GOOD" org.example.good ext-good
H_GOOD="$HOMES/good"
new_home "$H_GOOD"
bind_package "$H_GOOD" "$P_GOOD" ext-good >/dev/null
package_root=$(binding_value "$H_GOOD" org.example.good package_root)
chmod 0644 "$H_GOOD/config/extensions.d/org.example.good.json"
expect_failure "mode 0600" env FM_HOME="$H_GOOD" "$HOST" verify org.example.good
chmod 0600 "$H_GOOD/config/extensions.d/org.example.good.json"
binding_good="$H_GOOD/config/extensions.d/org.example.good.json"
ln "$binding_good" "$TMP_ROOT/binding-hardlink"
expect_failure "single regular file" env FM_HOME="$H_GOOD" "$HOST" verify org.example.good
rm -f "$TMP_ROOT/binding-hardlink"
mv "$binding_good" "$TMP_ROOT/binding-target.json"
ln -s "$TMP_ROOT/binding-target.json" "$binding_good"
expect_failure "single regular file" env FM_HOME="$H_GOOD" "$HOST" verify org.example.good
rm -f "$binding_good"
mv "$TMP_ROOT/binding-target.json" "$binding_good"
chmod 0755 "$package_root"
chmod 0644 "$package_root/helper.txt"
printf 'mutated helper\n' > "$package_root/helper.txt"
chmod 0444 "$package_root/helper.txt"
chmod 0555 "$package_root"
expect_failure "tree digest" env FM_HOME="$H_GOOD" "$HOST" verify org.example.good
pass "binding mode and complete installed code-tree digest are revalidated"

P_IDENTITY="$PACKAGES/identity"
make_package "$P_IDENTITY" org.example.identity ext-identity
H_IDENTITY="$HOMES/identity"; new_home "$H_IDENTITY"
bind_package "$H_IDENTITY" "$P_IDENTITY" ext-identity >/dev/null
identity_root=$(binding_value "$H_IDENTITY" org.example.identity package_root)
chmod 0755 "$identity_root"
chmod 0755 "$identity_root/entrypoint.py"
printf '\n# changed identity\n' >> "$identity_root/entrypoint.py"
chmod 0555 "$identity_root/entrypoint.py" "$identity_root"
expect_failure "tree digest" env FM_HOME="$H_IDENTITY" "$HOST" verify org.example.identity
pass "the exact executable identity cannot change underneath a binding"
fi

# --- strict invocation matrix, replay, timeout, and process cleanup ----------
if section_enabled matrix; then
P_MATRIX="$PACKAGES/matrix"
make_package "$P_MATRIX" org.example.matrix ext-matrix
H_MATRIX="$HOMES/matrix"; new_home "$H_MATRIX"
bind_package "$H_MATRIX" "$P_MATRIX" ext-matrix --timeout-ms 2000 >/dev/null
resolution=$(FM_HOME="$H_MATRIX" "$HOST" resolve-process-event ext-matrix)
IFS=$'\t' read -r resolution_schema resolution_id resolution_version resolution_cap resolution_package resolution_binding resolution_extra <<< "$resolution"
[ "$resolution_schema" = fm-extension-process-event-resolution.v1 ] && [ -z "$resolution_extra" ] \
  || fail "resolution record is malformed: $resolution"

invoke_matrix() {  # <config-ref> [request-id]
  local config_ref=$1 request_id=${2:-} args=()
  [ -z "$request_id" ] || args+=(--request-id "$request_id")
  FM_HOME="$H_MATRIX" "$HOST" process-event ext-matrix source.poll \
    --source-id matrix-source --config-ref "$config_ref" \
    --expect-extension "$resolution_id" --expect-version "$resolution_version" \
    --expect-capability-version "$resolution_cap" \
    --expect-package-digest "$resolution_package" \
    --expect-binding-digest "$resolution_binding" ${args[@]+"${args[@]}"}
}

shell_sentinel="$TMP_ROOT/extension-shell-sentinel"
literal_ref="\$(touch $shell_sentinel); one arg; *"
literal_out=$(invoke_matrix "$literal_ref")
assert_contains "$literal_out" "$literal_ref" "configuration reference was re-split or interpreted instead of JSON encoded"
assert_absent "$shell_sentinel" "configuration reference unexpectedly executed through a shell"
pass "source configuration references cross one JSON envelope with no shell interpretation"

matrix_cases="$TMP_ROOT/matrix-cases"
mkdir -p "$matrix_cases"
declare -a matrix_case_pids=()
for scenario in malformed invalid-utf8 bom control multiple duplicate wrong-id unknown oversize stderr-oversize nonzero crash leak foreground-leak error-injection authority; do
  (
    rc=0
    out=$(invoke_matrix "$scenario" 2>&1) || rc=$?
    printf '%s\n' "$rc" > "$matrix_cases/$scenario.rc"
    printf '%s' "$out" > "$matrix_cases/$scenario.out"
  ) &
  matrix_case_pids+=("$!")
  if [ "${#matrix_case_pids[@]}" -eq 4 ]; then
    for matrix_case_pid in "${matrix_case_pids[@]}"; do wait "$matrix_case_pid"; done
    matrix_case_pids=()
  fi
done
if [ "${#matrix_case_pids[@]}" -gt 0 ]; then
  for matrix_case_pid in "${matrix_case_pids[@]}"; do wait "$matrix_case_pid"; done
fi
for scenario in malformed invalid-utf8 bom control multiple duplicate wrong-id unknown oversize stderr-oversize nonzero crash leak foreground-leak error-injection authority; do
  rc=$(cat "$matrix_cases/$scenario.rc")
  out=$(cat "$matrix_cases/$scenario.out")
  [ "$rc" -ne 0 ] || fail "invalid extension response was accepted: $scenario"
  assert_contains "$out" 'firstmate.process-event-extension-error.v1' "invalid source response did not become bounded host evidence: $scenario"
  assert_not_contains "$out" "merge_authorized" "authority-shaped extension bytes escaped strict response validation"
  assert_not_contains "$out" "MERGE NOW" "extension diagnostic text escaped into host evidence"
done
leaked_pid=$(cat "$H_MATRIX/state/extensions/org.example.matrix/leaked.pid")
for _ in $(seq 1 50); do
  kill -0 "$leaked_pid" 2>/dev/null || break
  sleep 0.05
done
kill -0 "$leaked_pid" 2>/dev/null && fail "a successful response left its background descendant alive"
rapid_pid=$(cat "$H_MATRIX/state/extensions/org.example.matrix/foreground-leak.pid")
for _ in $(seq 1 50); do
  kill -0 "$rapid_pid" 2>/dev/null || break
  sleep 0.05
done
kill -0 "$rapid_pid" 2>/dev/null && fail "a foreground descendant escaped invocation-group cleanup"
pass "malformed, invalid UTF-8, BOM, control, multiple, duplicate, unknown, oversized, crash, nonzero, stderr, and foreground leaked-process responses are rejected"

state_root="$H_MATRIX/state/extensions/org.example.matrix"
overlap_out="$TMP_ROOT/overlap.out"
invoke_matrix overlap >"$overlap_out" &
overlap_invoke_pid=$!
wait_for_file "$state_root/overlap-ready" || fail "overlap fixture never entered its invocation window"
unrelated_pid_file="$TMP_ROOT/unrelated-daemon.pid"
python3 - "$unrelated_pid_file" <<'PY' &
import os, subprocess, sys
child = subprocess.Popen(["/bin/sleep", "300"], cwd="/", start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env={"LANG":"C", "LC_ALL":"C", "PATH":"/usr/bin:/bin"})
with open(sys.argv[1], "w", encoding="utf-8") as output: output.write(f"{child.pid}\n")
PY
unrelated_launcher_pid=$!
wait_for_file "$unrelated_pid_file" || fail "unrelated daemon launcher never published its child"
unrelated_daemon_pid=$(cat "$unrelated_pid_file")
touch "$state_root/overlap-release"
wait "$overlap_invoke_pid" || {
  cat "$overlap_out" >&2
  fail "a proven-unrelated daemon made a valid extension invocation fail"
}
assert_contains "$(cat "$overlap_out")" "overlap complete" "overlap fixture did not return its valid result"
kill -0 "$unrelated_daemon_pid" 2>/dev/null || fail "extension cleanup terminated an unrelated same-user daemon"
wait "$unrelated_launcher_pid"
unrelated_launcher_pid=
kill -KILL "$unrelated_daemon_pid" 2>/dev/null || true
unrelated_daemon_pid=
pass "process cleanup never adopts a proven-unrelated same-user process"

fixed_request="sha256:$(printf '1%.0s' $(seq 1 64))"
out_one=$(invoke_matrix replay "$fixed_request")
out_two=$(invoke_matrix replay "$fixed_request")
[ "$out_one" = "$out_two" ] || fail "replaying one exact request identity changed its result"
[ "$(cat "$state_root/side-effect-count")" = 1 ] || fail "the reference adapter applied one replay identity more than once"
pass "an exact request id is matched and supports idempotent replay"

H_CORE_REPLAY="$HOMES/core-replay"; new_home "$H_CORE_REPLAY"
bind_package "$H_CORE_REPLAY" "$P_MATRIX" ext-matrix >/dev/null
core_registration=$(FM_HOME="$H_CORE_REPLAY" "$PROCEVENT" register-extension ext-matrix replay-source --config-ref replay-no-result)
core_token=$(printf '%s\n' "$core_registration" | sed -n 's/^owner-token: //p')
FM_HOME="$H_CORE_REPLAY" "$PROCEVENT" start replay-source >/dev/null
FM_HOME="$H_CORE_REPLAY" "$PROCEVENT" start replay-source >/dev/null
core_request_ids="$H_CORE_REPLAY/state/extensions/org.example.matrix/request-ids"
[ "$(wc -l < "$core_request_ids" | tr -d ' ')" = 2 ] || fail "core replay fixture did not receive two requests"
[ "$(sort -u "$core_request_ids" | wc -l | tr -d ' ')" = 1 ] \
  || fail "retry before durable capture changed the request identity"
[ "$(cat "$H_CORE_REPLAY/state/extensions/org.example.matrix/side-effect-count")" = 1 ] \
  || fail "stable core retry identity applied the fixture effect twice"
FM_HOME="$H_CORE_REPLAY" "$PROCEVENT" retire replay-source --if-owner "$core_token" >/dev/null
pass "the generic runner reuses one request id until that source sequence is durably captured"

rc=0
out=$(invoke_matrix timeout 2>/dev/null) || rc=$?
[ "$rc" -ne 0 ] || fail "timed-out extension invocation succeeded"
assert_contains "$out" '"code":"timeout"' "timeout did not produce deterministic bounded evidence"
wait_for_file "$state_root/descendant.pid" || fail "timeout fixture never started its descendant"
descendant=$(cat "$state_root/descendant.pid")
for _ in $(seq 1 50); do
  kill -0 "$descendant" 2>/dev/null || break
  sleep 0.05
done
kill -0 "$descendant" 2>/dev/null && fail "timed-out extension left its descendant alive"
pass "timeout escalates through invocation-group cleanup and reaps descendants"

# A missing installed executable is actionable evidence, never fallback to a
# similarly named command or another adapter.
P_MISSING="$PACKAGES/missing"
make_package "$P_MISSING" org.example.missing ext-missing
H_MISSING="$HOMES/missing"; new_home "$H_MISSING"
bind_package "$H_MISSING" "$P_MISSING" ext-missing >/dev/null
missing_root=$(binding_value "$H_MISSING" org.example.missing package_root)
chmod 0755 "$missing_root"
rm -f "$missing_root/entrypoint.py"
chmod 0555 "$missing_root"
resolution_missing=$(FM_HOME="$H_MISSING" "$HOST" inspect org.example.missing 2>&1 || true)
assert_contains "$resolution_missing" "manifest entrypoint is missing" "missing executable was not diagnosed"
pass "a missing package executable refuses instead of falling back"
fi

# --- registration, invocation, unhandled capture, and binding retirement -----
if section_enabled lifecycle-flow; then
P_FLOW="$PACKAGES/flow"
make_package "$P_FLOW" org.example.flow ext-flow
H_FLOW="$HOMES/flow"; new_home "$H_FLOW"
flow_bind=$(bind_package "$H_FLOW" "$P_FLOW" ext-flow)
flow_binding_digest=$(printf '%s\n' "$flow_bind" | sed -n 's/^binding-digest: //p')
case "$flow_binding_digest" in sha256:*) ;; *) fail "local bind returned no binding retirement identity" ;; esac
registration=$(FM_HOME="$H_FLOW" "$PROCEVENT" register-extension ext-flow flow-source --config-ref good)
assert_contains "$registration" "org.example.flow@1.2.3" "extension registration omits its exact owner identity"
owner_one=$(printf '%s\n' "$registration" | sed -n 's/^owner-token: //p')
case "$owner_one" in
  sha256:*) [ "${#owner_one}" -eq 71 ] || fail "registration emitted a malformed owner token" ;;
  *) fail "registration emitted no bounded owner token" ;;
esac
expect_failure "still owns process-event registration" env FM_HOME="$H_FLOW" "$HOST" retire-binding org.example.flow --if-binding-digest "$flow_binding_digest"
assert_grep 'extension_id=org.example.flow' "$H_FLOW/state/procevent/flow-source.source" "registration did not retain extension identity"
assert_grep 'capability_version=1' "$H_FLOW/state/procevent/flow-source.source" "registration did not retain capability version"
assert_grep 'package_digest=sha256:' "$H_FLOW/state/procevent/flow-source.source" "registration did not retain package digest"

FM_HOME="$H_FLOW" "$PROCEVENT" start flow-source > "$TMP_ROOT/flow-start.out"
result=$(first_result "$H_FLOW" flow-source) || fail "external source produced no captured result"
assert_contains "$(wake_payloads "$H_FLOW")" "procevent ext-flow flow-source 1" "external source did not publish the existing bounded event"
assert_absent "${result%.result}.handled" "external evidence was silently treated as handled"
COLLISION_ROOT="$TMP_ROOT/collision-root"
mkdir -p "$COLLISION_ROOT/bin"
cat > "$COLLISION_ROOT/bin/fm-procevent-ext-flow.sh" <<'SH'
#!/usr/bin/env bash
printf 'wrong-built-in-owner\n'
exit 0
SH
chmod +x "$COLLISION_ROOT/bin/fm-procevent-ext-flow.sh"
classification=$(FM_ROOT_OVERRIDE="$COLLISION_ROOT" FM_HOME="$H_FLOW" "$PROCEVENT" classify "$result")
assert_contains "$classification" "external-ready" "captured evidence could not be classified through its immutable owner"
assert_not_contains "$classification" "wrong-built-in-owner" "a later same-name built-in reinterpreted extension evidence"
assert_absent "$H_FLOW/state/procevent/flow-source.source" "terminal external source stayed registered"
FM_HOME="$H_FLOW" "$PROCEVENT" retire flow-source --if-owner "$owner_one" >/dev/null
pass "one external adapter registers, invokes, captures unhandled evidence, classifies, and terminally retires end to end"
wrong_binding_digest="sha256:$(printf '0%.0s' {1..64})"
expect_failure "expected binding identity" env FM_HOME="$H_FLOW" "$HOST" retire-binding org.example.flow --if-binding-digest "$wrong_binding_digest"
assert_present "$H_FLOW/config/extensions.d/org.example.flow.json" "stale identity retired the local binding"
expect_failure "unhandled process-event result" env FM_HOME="$H_FLOW" "$HOST" retire-binding org.example.flow --if-binding-digest "$flow_binding_digest"
FM_HOME="$H_FLOW" "$PROCEVENT" handled flow-source 1 >/dev/null
FM_HOME="$H_FLOW" "$HOST" retire-binding org.example.flow --if-binding-digest "$flow_binding_digest" >/dev/null
assert_absent "$H_FLOW/config/extensions.d/org.example.flow.json" "exact local binding retirement left discovery enabled"
assert_present "$H_FLOW/data/extensions/retired-bindings/org.example.flow/${flow_binding_digest#sha256:}.json" "local binding retirement was not reversible"
expect_failure "no home-local extension binding" env FM_HOME="$H_FLOW" "$HOST" resolve-process-event ext-flow
pass "local binding retirement requires its exact identity and disables invocation"
fi

# --- registration and retirement serialization plus lock recovery -------------
if section_enabled lifecycle-lock; then
P_FLOW="$PACKAGES/flow"
make_package "$P_FLOW" org.example.flow ext-flow
wrong_binding_digest="sha256:$(printf '0%.0s' {1..64})"
P_RETIRE_RACE="$PACKAGES/retire-race"
race_marker="$TMP_ROOT/retire-race.marker"
race_release="$TMP_ROOT/retire-race.release"
make_package "$P_RETIRE_RACE" org.example.retire-race ext-retire-race "$(printf 'handshake-block\n%s\n%s' "$race_marker" "$race_release")"
H_RETIRE_RACE="$HOMES/retire-race"; new_home "$H_RETIRE_RACE"
touch "$race_release"
race_bind=$(bind_package "$H_RETIRE_RACE" "$P_RETIRE_RACE" ext-retire-race)
race_binding_digest=$(printf '%s\n' "$race_bind" | sed -n 's/^binding-digest: //p')
rm -f "$race_marker" "$race_release"
FM_HOME="$H_RETIRE_RACE" "$PROCEVENT" register-extension ext-retire-race race-source --config-ref good > "$TMP_ROOT/retire-race-register.out" 2>&1 &
race_register_pid=$!
wait_for_file "$race_marker" || fail "registration race fixture never entered binding resolution"
FM_HOME="$H_RETIRE_RACE" "$HOST" retire-binding org.example.retire-race --if-binding-digest "$race_binding_digest" > "$TMP_ROOT/retire-race-retire.out" 2>&1 &
race_retire_pid=$!
sleep 0.2
kill -0 "$race_retire_pid" 2>/dev/null || fail "binding retirement bypassed an in-flight registration"
touch "$race_release"
race_register_rc=0
wait "$race_register_pid" || race_register_rc=$?
race_register_pid=
[ "$race_register_rc" -eq 0 ] || fail "serialized registration did not publish its owner record"
race_retire_rc=0
wait "$race_retire_pid" || race_retire_rc=$?
race_retire_pid=
[ "$race_retire_rc" -ne 0 ] || fail "serialized retirement removed a binding with a new registration"
assert_contains "$(cat "$TMP_ROOT/retire-race-retire.out")" "still owns process-event registration" "serialized retirement did not observe the published registration"
assert_present "$H_RETIRE_RACE/config/extensions.d/org.example.retire-race.json" "registration race left a dangling owner record"
race_owner=$(sed -n 's/^owner-token: //p' "$TMP_ROOT/retire-race-register.out")
FM_HOME="$H_RETIRE_RACE" "$PROCEVENT" retire race-source --if-owner "$race_owner" >/dev/null
FM_HOME="$H_RETIRE_RACE" "$HOST" retire-binding org.example.retire-race --if-binding-digest "$race_binding_digest" >/dev/null
race_release=
pass "registration publication and binding retirement share one lifecycle boundary"

expect_failure "unknown command" env FM_HOME="$H_RETIRE_RACE" "$HOST" retire-binding-locked org.example.retire-race --if-binding-digest "$race_binding_digest"
expect_failure "unknown command" env FM_HOME="$H_RETIRE_RACE" "$HOST" retire-transfer-locked org.example.retire-race --if-transfer-digest "$wrong_binding_digest" --if-binding-digest "$race_binding_digest"
pass "public extension dispatch exposes no unlocked retirement entry"

P_LOCK_OWNER="$PACKAGES/lock-owner"
make_package "$P_LOCK_OWNER" org.example.lock-owner ext-lock-owner
H_LOCK_OWNER="$HOMES/lock-owner"; new_home "$H_LOCK_OWNER"
owner_bind=$(bind_package "$H_LOCK_OWNER" "$P_LOCK_OWNER" ext-lock-owner)
owner_binding_digest=$(printf '%s\n' "$owner_bind" | sed -n 's/^binding-digest: //p')
owner_lock="$H_LOCK_OWNER/state/procevent/.extension-binding-lifecycle.lock"
FM_HOME="$H_LOCK_OWNER" "$HOST" retire-binding org.example.lock-owner --if-binding-digest "$owner_binding_digest" > "$TMP_ROOT/lock-owner-retire.out" 2>&1 &
owner_retire_pid=$!
owner_worker_pid=
for _ in $(seq 1 400); do
  if [ -e "$owner_lock/pid" ]; then
    candidate=$(cat "$owner_lock/pid" 2>/dev/null || true)
    if [ -n "$candidate" ] && kill -STOP "$candidate" 2>/dev/null; then
      owner_worker_pid=$candidate
      break
    fi
  fi
  sleep 0.005
done
[ -n "$owner_worker_pid" ] || fail "retirement worker never acquired its lifecycle lock"
[ "$owner_worker_pid" != "$owner_retire_pid" ] || fail "retirement fixture did not cross the public wrapper boundary"
kill -TERM "$owner_retire_pid" 2>/dev/null || true
wait "$owner_retire_pid" 2>/dev/null || true
owner_retire_pid=
FM_HOME="$H_LOCK_OWNER" "$PROCEVENT" register-extension ext-lock-owner owner-source --config-ref good > "$TMP_ROOT/lock-owner-register.out" 2>&1 &
owner_register_pid=$!
sleep 0.2
kill -0 "$owner_register_pid" 2>/dev/null || fail "wrapper death released a live retirement worker's lifecycle lock"
kill -KILL "$owner_worker_pid" 2>/dev/null || true
wait "$owner_worker_pid" 2>/dev/null || true
owner_worker_pid=
owner_register_rc=0
wait "$owner_register_pid" || owner_register_rc=$?
owner_register_pid=
[ "$owner_register_rc" -eq 0 ] || fail "registration did not recover the dead retirement worker's lifecycle lock"
assert_present "$H_LOCK_OWNER/config/extensions.d/org.example.lock-owner.json" "dead retirement worker continued mutating after lock recovery"
owner_token=$(sed -n 's/^owner-token: //p' "$TMP_ROOT/lock-owner-register.out")
FM_HOME="$H_LOCK_OWNER" "$PROCEVENT" retire owner-source --if-owner "$owner_token" >/dev/null
FM_HOME="$H_LOCK_OWNER" "$HOST" retire-binding org.example.lock-owner --if-binding-digest "$owner_binding_digest" >/dev/null
pass "retirement worker ownership survives wrapper death and recovers exactly"

P_SIGNAL_LOCK="$PACKAGES/signal-lock"
make_package "$P_SIGNAL_LOCK" org.example.signal-lock ext-signal-lock
H_SIGNAL_LOCK="$HOMES/signal-lock"; new_home "$H_SIGNAL_LOCK"
signal_bind=$(bind_package "$H_SIGNAL_LOCK" "$P_SIGNAL_LOCK" ext-signal-lock)
signal_binding_digest=$(printf '%s\n' "$signal_bind" | sed -n 's/^binding-digest: //p')
signal_lock="$H_SIGNAL_LOCK/state/procevent/.extension-binding-lifecycle.lock"
FM_HOME="$H_SIGNAL_LOCK" "$HOST" retire-binding org.example.signal-lock --if-binding-digest "$signal_binding_digest" > "$TMP_ROOT/signal-lock-retire.out" 2>&1 &
signal_retire_pid=$!
signal_worker_pid=
for _ in $(seq 1 400); do
  if [ -e "$signal_lock/pid" ]; then
    candidate=$(cat "$signal_lock/pid" 2>/dev/null || true)
    if [ -n "$candidate" ] && kill -STOP "$candidate" 2>/dev/null; then
      signal_worker_pid=$candidate
      break
    fi
  fi
  sleep 0.005
done
[ -n "$signal_worker_pid" ] || fail "signal retirement worker never acquired its lifecycle lock"
kill -TERM "$signal_worker_pid" 2>/dev/null || fail "cannot signal retirement worker"
kill -CONT "$signal_worker_pid" 2>/dev/null || fail "cannot resume signalled retirement worker"
for _ in $(seq 1 400); do
  kill -0 "$signal_worker_pid" 2>/dev/null || break
  sleep 0.005
done
kill -0 "$signal_worker_pid" 2>/dev/null && fail "signalled retirement worker did not exit"
signal_worker_pid=
wait "$signal_retire_pid" 2>/dev/null || true
signal_retire_pid=
[ -L "$signal_lock" ] || fail "signalled retirement worker released its lifecycle lock before exit recovery"
signal_registration=$(FM_HOME="$H_SIGNAL_LOCK" "$PROCEVENT" register-extension ext-signal-lock signal-source --config-ref good)
signal_owner=$(printf '%s\n' "$signal_registration" | sed -n 's/^owner-token: //p')
assert_absent "$signal_lock" "registration left a recovered lifecycle lock behind"
FM_HOME="$H_SIGNAL_LOCK" "$PROCEVENT" retire signal-source --if-owner "$signal_owner" >/dev/null
FM_HOME="$H_SIGNAL_LOCK" "$HOST" retire-binding org.example.signal-lock --if-binding-digest "$signal_binding_digest" >/dev/null
pass "signal interruption leaves lifecycle lock recovery to the next owner"

H_ACTIVE_RUNNER="$HOMES/active-runner"; new_home "$H_ACTIVE_RUNNER"
bind_package "$H_ACTIVE_RUNNER" "$P_FLOW" ext-flow >/dev/null
active_runner_marker="$TMP_ROOT/active-runner.marker"
active_runner_release="$TMP_ROOT/active-runner.release"
active_config="active-block|$active_runner_marker|$active_runner_release"
FM_HOME="$H_ACTIVE_RUNNER" "$PROCEVENT" register-extension ext-flow active-source --config-ref "$active_config" >/dev/null
FM_HOME="$H_ACTIVE_RUNNER" "$PROCEVENT" start active-source > "$TMP_ROOT/active-runner.out" 2>&1 &
active_runner_pid=$!
wait_for_file "$active_runner_marker" || fail "active extension runner never entered its poll"
expect_failure "prior runner remains active" env FM_HOME="$H_ACTIVE_RUNNER" "$PROCEVENT" register-extension ext-flow active-source --config-ref replacement
expect_failure "prior runner remains active" env FM_HOME="$H_ACTIVE_RUNNER" "$PROCEVENT" register lavish active-source -- /bin/echo built-in
touch "$active_runner_release"
active_runner_release=
wait "$active_runner_pid" || fail "active extension runner did not complete"
active_runner_pid=
assert_absent "$H_ACTIVE_RUNNER/state/procevent/active-source.source" "terminal extension runner retained its registration"
FM_HOME="$H_ACTIVE_RUNNER" "$PROCEVENT" register lavish active-source -- /bin/echo built-in >/dev/null
FM_HOME="$H_ACTIVE_RUNNER" "$PROCEVENT" retire active-source --if-matches lavish -- /bin/echo built-in >/dev/null
active_replacement=$(FM_HOME="$H_ACTIVE_RUNNER" "$PROCEVENT" register-extension ext-flow active-source --config-ref replacement)
active_replacement_owner=$(printf '%s\n' "$active_replacement" | sed -n 's/^owner-token: //p')
FM_HOME="$H_ACTIVE_RUNNER" "$PROCEVENT" retire active-source --if-owner "$active_replacement_owner" >/dev/null
pass "all registration owner transitions wait for the prior extension runner"
fi

# --- owner tokens, overridden state, sweep, and legacy compatibility --------
if section_enabled lifecycle-state; then
P_FLOW="$PACKAGES/flow"
make_package "$P_FLOW" org.example.flow ext-flow
H_OWNER_SAFE="$HOMES/owner-safe"; new_home "$H_OWNER_SAFE"
bind_package "$H_OWNER_SAFE" "$P_FLOW" ext-flow >/dev/null
first=$(FM_HOME="$H_OWNER_SAFE" "$PROCEVENT" register-extension ext-flow replace-source --config-ref first)
first_token=$(printf '%s\n' "$first" | sed -n 's/^owner-token: //p')
second=$(FM_HOME="$H_OWNER_SAFE" "$PROCEVENT" register-extension ext-flow replace-source --config-ref second)
second_token=$(printf '%s\n' "$second" | sed -n 's/^owner-token: //p')
[ "$first_token" != "$second_token" ] || fail "replacement registration reused its owner generation"
expect_failure "requires its exact --if-owner token" env FM_HOME="$H_OWNER_SAFE" "$PROCEVENT" retire replace-source
expect_failure "does not match the expected owner" env FM_HOME="$H_OWNER_SAFE" "$PROCEVENT" retire replace-source --if-owner "$first_token"
assert_present "$H_OWNER_SAFE/state/procevent/replace-source.source" "stale owner retired the replacement"
FM_HOME="$H_OWNER_SAFE" "$PROCEVENT" retire replace-source --if-owner "$second_token" >/dev/null
assert_absent "$H_OWNER_SAFE/state/procevent/replace-source.source" "current owner could not retire its own registration"
pass "owner-matched retirement refuses a stale generation and accepts the current one"

H_STATE_OVERRIDE="$HOMES/state-override"; new_home "$H_STATE_OVERRIDE"
STATE_OVERRIDE="$TMP_ROOT/overridden-state"
override_bind=$(bind_package "$H_STATE_OVERRIDE" "$P_FLOW" ext-flow)
override_bind_digest=$(printf '%s\n' "$override_bind" | sed -n 's/^binding-digest: //p')
override_registration=$(FM_HOME="$H_STATE_OVERRIDE" FM_STATE_OVERRIDE="$STATE_OVERRIDE" "$PROCEVENT" register-extension ext-flow override-source --config-ref silent-result)
override_owner=$(printf '%s\n' "$override_registration" | sed -n 's/^owner-token: //p')
expect_failure "still owns process-event registration" env FM_HOME="$H_STATE_OVERRIDE" FM_STATE_OVERRIDE="$STATE_OVERRIDE" "$HOST" retire-binding org.example.flow --if-binding-digest "$override_bind_digest"
assert_present "$H_STATE_OVERRIDE/config/extensions.d/org.example.flow.json" "overridden-state dependency did not preserve its binding"
FM_HOME="$H_STATE_OVERRIDE" FM_STATE_OVERRIDE="$STATE_OVERRIDE" "$PROCEVENT" start override-source >/dev/null
override_result="$STATE_OVERRIDE/procevent-inbox/override-source.1.result"
assert_present "$override_result" "overridden-state runner did not capture its result"
assert_present "$STATE_OVERRIDE/procevent-inbox/override-source.1.handled" "overridden-state silent verdict was not recorded"
assert_absent "$STATE_OVERRIDE/procevent/override-source.source" "overridden-state terminal verdict did not retire its registration"
assert_contains "$(FM_HOME="$H_STATE_OVERRIDE" FM_STATE_OVERRIDE="$STATE_OVERRIDE" "$PROCEVENT" classify "$override_result")" "external-ready" \
  "overridden-state result could not be classified"
mkdir "$TMP_ROOT/override-outside"
cp "$override_result" "$TMP_ROOT/override-outside/override-source.1.result"
cp "$STATE_OVERRIDE/procevent-inbox/override-source.1.adapter" "$TMP_ROOT/override-outside/override-source.1.adapter"
cp "$STATE_OVERRIDE/procevent-inbox/override-source.1.extension" "$TMP_ROOT/override-outside/override-source.1.extension"
chmod 0600 "$TMP_ROOT/override-outside/override-source.1.result"
chmod 0600 "$TMP_ROOT/override-outside/override-source.1.adapter" "$TMP_ROOT/override-outside/override-source.1.extension"
expect_failure "directly inside" env FM_HOME="$H_STATE_OVERRIDE" FM_STATE_OVERRIDE="$STATE_OVERRIDE" \
  "$PROCEVENT" classify "$TMP_ROOT/override-outside/override-source.1.result"
mv "$STATE_OVERRIDE/procevent-inbox" "$TMP_ROOT/override-real-inbox"
ln -s "$TMP_ROOT/override-real-inbox" "$STATE_OVERRIDE/procevent-inbox"
expect_failure "traverses a symbolic link" env FM_HOME="$H_STATE_OVERRIDE" FM_STATE_OVERRIDE="$STATE_OVERRIDE" \
  "$PROCEVENT" classify "$STATE_OVERRIDE/procevent-inbox/override-source.1.result"
rm "$STATE_OVERRIDE/procevent-inbox"
mv "$TMP_ROOT/override-real-inbox" "$STATE_OVERRIDE/procevent-inbox"
FM_HOME="$H_STATE_OVERRIDE" FM_STATE_OVERRIDE="$STATE_OVERRIDE" "$PROCEVENT" retire override-source --if-owner "$override_owner" >/dev/null
FM_HOME="$H_STATE_OVERRIDE" FM_STATE_OVERRIDE="$STATE_OVERRIDE" "$HOST" retire-binding org.example.flow --if-binding-digest "$override_bind_digest" >/dev/null
pass "overridden state confines extension work and captured-result operations"

H_SWEEP="$HOMES/sweep"; new_home "$H_SWEEP"
bind_package "$H_SWEEP" "$P_FLOW" ext-flow >/dev/null
FM_HOME="$H_SWEEP" "$PROCEVENT" register-extension ext-flow sweep-source --config-ref good >/dev/null
assert_contains "$(FM_HOME="$H_SWEEP" "$PROCEVENT" sweep-home)" "swept: attempted=1" \
  "home sweep did not use the extension registration's owner identity"
assert_absent "$H_SWEEP/state/procevent/sweep-source.source" "home sweep retained an extension registration"
pass "bounded home sweep retires an extension source through its exact owner token"

H_LEGACY="$HOMES/legacy"; mkdir -p "$H_LEGACY/state"
FM_HOME="$H_LEGACY" "$PROCEVENT" register lavish legacy-source -- /bin/echo legacy >/dev/null
expect_failure "does not match the expected owner" env FM_HOME="$H_LEGACY" "$PROCEVENT" retire legacy-source --if-matches lavish -- /bin/echo replacement
assert_present "$H_LEGACY/state/procevent/legacy-source.source" "legacy conditional mismatch retired the registration"
FM_HOME="$H_LEGACY" "$PROCEVENT" retire legacy-source --if-matches lavish -- /bin/echo legacy >/dev/null
pass "legacy built-in registrations retain behavior and gain exact conditional retirement"
fi

# --- independent remote envelope, lifecycle, and retirement paths -----------
if section_enabled remote-envelope remote-lifecycle remote-retirement; then
wrong_binding_digest="sha256:$(printf '0%.0s' {1..64})"
P_REMOTE="$PACKAGES/remote-transport"
make_package "$P_REMOTE" org.example.remote ext-remote
mkdir "$P_REMOTE/nested"
printf 'nested transfer evidence\n' > "$P_REMOTE/nested/evidence.txt"
chmod 0755 "$P_REMOTE/nested"
chmod 0644 "$P_REMOTE/nested/evidence.txt"
H_REMOTE_CONTROL="$HOMES/remote-control"
H_REMOTE="$HOMES/remote-home"
REMOTE_ROOT="$TMP_ROOT/remote-root"
REMOTE_FAKEBIN=$(fm_fakebin "$TMP_ROOT/remote-fakebin")
REMOTE_SSH_COUNT="$TMP_ROOT/remote-ssh.count"
mkdir -p "$H_REMOTE_CONTROL/data" "$H_REMOTE" "$REMOTE_ROOT/bin"
printf 'fixture\n' > "$REMOTE_ROOT/AGENTS.md"
for remote_file in \
  fm-extension.mjs fm-extension.sh fm-procevent.sh fm-procevent-lib.sh fm-procevent-lavish.sh \
  fm-pr-lib.sh fm-wake-lib.sh fm-remote-entrypoint.sh fm-remote-job-lib.sh \
  fm-remote-job-worker.sh; do
  cp "$ROOT/bin/$remote_file" "$REMOTE_ROOT/bin/$remote_file"
done
chmod +x "$REMOTE_ROOT/bin"/fm-*.sh "$REMOTE_ROOT/bin/fm-extension.mjs"
git -C "$REMOTE_ROOT" init -q -b main
git -C "$REMOTE_ROOT" config user.email test@example.com
git -C "$REMOTE_ROOT" config user.name Test
git -C "$REMOTE_ROOT" add AGENTS.md bin
git -C "$REMOTE_ROOT" commit -qm 'remote extension fixture'
cat > "$H_REMOTE_CONTROL/data/secondmates.md" <<EOF
- ios - remote extension home (host: remote-mac; root: $REMOTE_ROOT; home: $H_REMOTE; scope: extension test; projects: none; added 2026-08-27)
EOF
cat > "$REMOTE_FAKEBIN/fake-ssh" <<'SH'
#!/usr/bin/env bash
count=$(cat "$FM_FAKE_SSH_COUNT" 2>/dev/null || echo 0)
printf '%s\n' "$((count + 1))" > "$FM_FAKE_SSH_COUNT"
while [ "$#" -gt 0 ]; do
  case "$1" in -o) shift 2 ;; --) shift; break ;; *) exit 90 ;; esac
done
host=$1
entry=$2
shift 2
[ "$host" = remote-mac ] || exit 91
[ "$entry" = fm-remote-entrypoint.sh ] || exit 92
exec "$FM_FAKE_REMOTE_ENTRYPOINT" "$@"
SH
chmod +x "$REMOTE_FAKEBIN/fake-ssh"
remote_on() {
  FM_HOME="$H_REMOTE_CONTROL" \
  FM_ROOT_OVERRIDE="$REMOTE_ROOT" \
  FM_SSH_BIN="$REMOTE_FAKEBIN/fake-ssh" \
  FM_FAKE_SSH_COUNT="$REMOTE_SSH_COUNT" \
  FM_FAKE_REMOTE_ENTRYPOINT="$REMOTE_ROOT/bin/fm-remote-entrypoint.sh" \
  FM_REMOTE_JOB_PLATFORM_OVERRIDE=Linux \
  FM_REMOTE_JOB_STATE_ROOT="$TMP_ROOT/remote-jobs" \
  "$ROOT/bin/fm-on.sh" --stdin ios "$@"
}
remote_controller() {
  FM_HOME="$H_REMOTE_CONTROL" \
  FM_ROOT_OVERRIDE="$REMOTE_ROOT" \
  FM_SSH_BIN="$REMOTE_FAKEBIN/fake-ssh" \
  FM_FAKE_SSH_COUNT="$REMOTE_SSH_COUNT" \
  FM_FAKE_REMOTE_ENTRYPOINT="$REMOTE_ROOT/bin/fm-remote-entrypoint.sh" \
  FM_REMOTE_JOB_PLATFORM_OVERRIDE=Linux \
  FM_REMOTE_JOB_STATE_ROOT="$TMP_ROOT/remote-jobs" \
  "$@"
}
remote_receive_file() {
  local file=$1 adapter=$2
  remote_on fm-extension.sh receive-transfer-bind \
    --adapter "$adapter" --trust-same-user-code < "$file"
}
remote_direct() {
  FM_HOME="$H_REMOTE" \
  FM_ROOT_OVERRIDE="$REMOTE_ROOT" \
  FM_REMOTE_JOB_PLATFORM_OVERRIDE=Linux \
  FM_REMOTE_JOB_STATE_ROOT="$TMP_ROOT/remote-jobs" \
  "$REMOTE_ROOT/bin/$@"
}
remote_receive_file_direct() {
  local file=$1 adapter=$2
  remote_direct fm-extension.sh receive-transfer-bind \
    --adapter "$adapter" --trust-same-user-code < "$file"
}

if section_enabled remote-envelope; then
REMOTE_TRANSFER="$TMP_ROOT/remote-transfer.json"
FM_HOME="$H_REMOTE_CONTROL" "$HOST" pack-transfer "$P_REMOTE" > "$REMOTE_TRANSFER"
mutate_transfer() {
  node - "$REMOTE_TRANSFER" "$1" "$2" <<'JS'
const fs = require("fs");
const crypto = require("crypto");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const scenario = process.argv[3];
if (scenario === "traversal") value.manifest.entries[0].path = "../escape";
if (scenario === "symlink") value.manifest.entries[0].type = "symlink";
if (scenario === "hash") value.payloads[value.payloads.findIndex((entry) => typeof entry === "string")] = "eA==";
if (scenario === "size") value.manifest.entries.find((entry) => entry.type === "file").size = 262145;
if (scenario === "duplicate") value.manifest.entries[1].path = value.manifest.entries[0].path;
if (scenario === "unexpected") {
  const index = value.manifest.entries.findIndex((entry) => entry.type === "directory");
  value.manifest.entries.splice(index, 1);
  value.payloads.splice(index, 1);
  value.manifest.entry_count -= 1;
}
if (scenario !== "hash") {
  const canonical = (entry) => Array.isArray(entry)
    ? `[${entry.map(canonical).join(",")}]`
    : entry && typeof entry === "object"
      ? `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${canonical(entry[key])}`).join(",")}}`
      : JSON.stringify(entry);
  value.manifest_sha256 = `sha256:${crypto.createHash("sha256").update(canonical(value.manifest)).digest("hex")}`;
}
fs.writeFileSync(process.argv[4], JSON.stringify(value));
JS
}
for transfer_case in traversal symlink hash size duplicate unexpected; do
  bad_transfer="$TMP_ROOT/remote-transfer-$transfer_case.json"
  mutate_transfer "$transfer_case" "$bad_transfer"
  case "$transfer_case" in
    traversal) transfer_error=path-unsafe ;;
    symlink) transfer_error="package-invalid" ;;
    hash) transfer_error=integrity-mismatch ;;
    size|duplicate) transfer_error=schema-invalid ;;
    unexpected) transfer_error="package-invalid" ;;
  esac
  expect_failure "$transfer_error" remote_receive_file_direct "$bad_transfer" ext-remote
done
printf '{broken' > "$TMP_ROOT/remote-transfer-malformed.json"
head -c 80 "$REMOTE_TRANSFER" > "$TMP_ROOT/remote-transfer-truncated.json"
expect_failure "package transfer has a non-string object key" remote_receive_file "$TMP_ROOT/remote-transfer-malformed.json" ext-remote
expect_failure "json-invalid" remote_receive_file_direct "$TMP_ROOT/remote-transfer-truncated.json" ext-remote
assert_absent "$H_REMOTE/config/extensions.d/org.example.remote.json" "invalid transfer published a remote binding"
if find "$H_REMOTE/data/extensions/staging" -name '.receive-*' -print 2>/dev/null | grep -q .; then
  fail "invalid transfer left a partial receive directory"
fi
pass "remote receiver rejects malformed, truncated, traversal, link, hash, size, duplicate, and incomplete envelopes"

P_REMOTE_PARTIAL="$PACKAGES/remote-partial"
make_package "$P_REMOTE_PARTIAL" org.example.remote-partial ext-remote-partial handshake-malformed
FM_HOME="$H_REMOTE_CONTROL" "$HOST" pack-transfer "$P_REMOTE_PARTIAL" > "$TMP_ROOT/remote-partial.json"
expect_failure "error[" remote_receive_file_direct "$TMP_ROOT/remote-partial.json" ext-remote-partial
assert_absent "$H_REMOTE/config/extensions.d/org.example.remote-partial.json" "failed remote activation published a binding"
if find "$H_REMOTE/data/extensions/staging/org.example.remote-partial" -mindepth 2 -maxdepth 2 -type d -print 2>/dev/null | grep -q .; then
  fail "failed remote activation left a published staging package"
fi
find "$H_REMOTE/data/extensions/retired-staging/org.example.remote-partial" -mindepth 2 -maxdepth 2 -type d -print 2>/dev/null | grep -q . \
  || fail "failed remote activation was not retained reversibly"
pass "failed activation cannot partially publish and retains exact transfer evidence"

[ "$(cat "$REMOTE_SSH_COUNT")" -eq 1 ] || fail "remote malformed-envelope transport crossing was not retained"
fi

if section_enabled remote-lifecycle; then
remote_bind=$(remote_controller "$ROOT/bin/fm-extension.sh" remote-bind ios "$P_REMOTE" --adapter ext-remote --trust-same-user-code)
assert_contains "$remote_bind" "bound: org.example.remote@1.2.3" "remote transport did not publish the binding"
remote_transfer_digest=$(printf '%s\n' "$remote_bind" | sed -n 's/^transfer-digest: //p')
case "$remote_transfer_digest" in sha256:*) ;; *) fail "remote bind returned no transfer identity" ;; esac
remote_binding_digest=$(printf '%s\n' "$remote_bind" | sed -n 's/^binding-digest: //p')
case "$remote_binding_digest" in sha256:*) ;; *) fail "remote bind returned no binding retirement identity" ;; esac
assert_contains "$(remote_direct fm-extension.sh list)" "org.example.remote" "addressed remote home did not discover the transferred binding"
remote_package_root=$(binding_value "$H_REMOTE" org.example.remote package_root)
case "$remote_package_root" in "$H_REMOTE"/data/extensions/packages/*) ;; *) fail "remote package escaped its addressed home: $remote_package_root" ;; esac
remote_source_root=$(binding_value "$H_REMOTE" org.example.remote source.path)
case "$remote_source_root" in "$H_REMOTE"/data/extensions/staging/*/package) ;; *) fail "remote binding reused a controller-local pathname: $remote_source_root" ;; esac
[ "$remote_source_root" != "$P_REMOTE" ] || fail "remote binding did not cross the serialized path boundary"
remote_active_marker="$TMP_ROOT/remote-active.marker"
remote_active_release="$TMP_ROOT/remote-active.release"
remote_active_config="active-block|$remote_active_marker|$remote_active_release"
remote_direct fm-procevent.sh register-extension ext-remote remote-active-source --config-ref "$remote_active_config" >/dev/null
remote_direct fm-procevent.sh reconcile >/dev/null
wait_for_file "$remote_active_marker" || fail "remote active runner never reached its addressed-home poll"
expect_failure "prior runner remains active" remote_direct fm-procevent.sh register-extension ext-remote remote-active-source --config-ref replacement
expect_failure "prior runner remains active" remote_direct fm-procevent.sh register lavish remote-active-source -- /bin/echo remote-built-in
touch "$remote_active_release"
remote_active_release=
for _ in $(seq 1 400); do
  [ ! -e "$H_REMOTE/state/procevent/remote-active-source.source" ] && break
  sleep 0.01
done
assert_absent "$H_REMOTE/state/procevent/remote-active-source.source" "remote terminal runner retained its registration"
remote_direct fm-procevent.sh handled remote-active-source 1 >/dev/null
remote_direct fm-procevent.sh register lavish remote-active-source -- /bin/echo remote-built-in >/dev/null
remote_direct fm-procevent.sh retire remote-active-source --if-matches lavish -- /bin/echo remote-built-in >/dev/null
remote_active_replacement=$(remote_direct fm-procevent.sh register-extension ext-remote remote-active-source --config-ref replacement)
remote_active_owner=$(printf '%s\n' "$remote_active_replacement" | sed -n 's/^owner-token: //p')
remote_direct fm-procevent.sh retire remote-active-source --if-owner "$remote_active_owner" >/dev/null
pass "remote registration owner transitions observe the active runner boundary"
remote_registration=$(remote_direct fm-procevent.sh register-extension ext-remote remote-source --config-ref remote-result)
remote_owner=$(printf '%s\n' "$remote_registration" | sed -n 's/^owner-token: //p')
expect_failure "still owns process-event registration" remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$remote_transfer_digest" --if-binding-digest "$remote_binding_digest"
remote_resolution=$(remote_direct fm-extension.sh resolve-process-event ext-remote)
IFS=$'\t' read -r _remote_schema remote_id remote_version remote_capability remote_package remote_binding remote_extra <<< "$remote_resolution"
[ -z "$remote_extra" ] || fail "remote resolution returned extra fields"
remote_result=$(remote_direct fm-extension.sh process-event ext-remote source.poll \
  --expect-extension "$remote_id" \
  --expect-version "$remote_version" \
  --expect-capability-version "$remote_capability" \
  --expect-package-digest "$remote_package" \
  --expect-binding-digest "$remote_binding" \
  --source-id remote-source \
  --config-ref remote-result \
  --request-id "sha256:$(printf '6%.0s' {1..64})")
assert_contains "$remote_result" "external evidence: remote-result" "addressed remote invocation returned no extension evidence"
remote_direct fm-procevent.sh start remote-source >/dev/null
assert_present "$H_REMOTE/state/procevent-inbox/remote-source.1.result" "remote runner did not capture its extension result"
remote_direct fm-procevent.sh retire remote-source --if-owner "$remote_owner" >/dev/null
assert_absent "$H_REMOTE/state/procevent/remote-source.source" "remote owner-matched retirement left its registration"
expect_failure "unhandled process-event result" remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$remote_transfer_digest" --if-binding-digest "$remote_binding_digest"
remote_direct fm-procevent.sh handled remote-source 1 >/dev/null
remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$remote_transfer_digest" --if-binding-digest "$remote_binding_digest" >/dev/null
assert_absent "$H_REMOTE/config/extensions.d/org.example.remote.json" "remote lifecycle retirement left its binding discoverable"
[ "$(cat "$REMOTE_SSH_COUNT")" -eq 1 ] || fail "remote lifecycle transport crossing count diverged"
pass "serialized remote binding crosses fm-on through addressed-home capture and retirement"
fi

if section_enabled remote-retirement; then
REMOTE_TRANSFER="$TMP_ROOT/remote-retirement-transfer.json"
FM_HOME="$H_REMOTE_CONTROL" "$HOST" pack-transfer "$P_REMOTE" > "$REMOTE_TRANSFER"
remote_bind=$(remote_receive_file_direct "$REMOTE_TRANSFER" ext-remote)
remote_transfer_digest=$(printf '%s\n' "$remote_bind" | sed -n 's/^transfer-digest: //p')
remote_binding_digest=$(printf '%s\n' "$remote_bind" | sed -n 's/^binding-digest: //p')
case "$remote_transfer_digest:$remote_binding_digest" in sha256:*:sha256:*) ;; *) fail "direct remote binding returned incomplete identities" ;; esac
remote_source_root=$(binding_value "$H_REMOTE" org.example.remote source.path)
remote_registration=$(remote_direct fm-procevent.sh register-extension ext-remote remote-source --config-ref remote-result)
remote_owner=$(printf '%s\n' "$remote_registration" | sed -n 's/^owner-token: //p')
remote_resolution=$(remote_direct fm-extension.sh resolve-process-event ext-remote)
IFS=$'\t' read -r _remote_schema remote_id remote_version remote_capability remote_package remote_binding remote_extra <<< "$remote_resolution"
[ -z "$remote_extra" ] || fail "remote retirement resolution returned extra fields"
remote_result=$(remote_direct fm-extension.sh process-event ext-remote source.poll \
  --expect-extension "$remote_id" --expect-version "$remote_version" \
  --expect-capability-version "$remote_capability" --expect-package-digest "$remote_package" \
  --expect-binding-digest "$remote_binding" --source-id remote-source --config-ref remote-result \
  --request-id "sha256:$(printf '6%.0s' {1..64})")
assert_contains "$remote_result" "external evidence: remote-result" "retirement fixture did not invoke its addressed extension"
remote_direct fm-procevent.sh start remote-source >/dev/null
assert_present "$H_REMOTE/state/procevent-inbox/remote-source.1.result" "retirement fixture did not capture its result"
remote_direct fm-procevent.sh retire remote-source --if-owner "$remote_owner" >/dev/null
assert_absent "$H_REMOTE/state/procevent/remote-source.source" "retirement fixture owner retirement left its registration"
remote_stage_root=${remote_source_root%/package}
remote_receipt="$remote_stage_root/receipt.json"
wrong_binding_digest="sha256:$(printf '0%.0s' {1..64})"
expect_failure "unhandled process-event result" remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$remote_transfer_digest" --if-binding-digest "$remote_binding_digest"
remote_direct fm-procevent.sh handled remote-source 1 >/dev/null
expect_failure "expected binding identity" remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$remote_transfer_digest" --if-binding-digest "$wrong_binding_digest"
assert_present "$H_REMOTE/config/extensions.d/org.example.remote.json" "stale binding identity retired the remote binding"
expect_failure "no unique staged package" remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$wrong_binding_digest" --if-binding-digest "$remote_binding_digest"
cp "$remote_receipt" "$TMP_ROOT/remote-receipt.json"
node - "$remote_receipt" <<'JS'
const fs = require("fs");
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, "utf8"));
value.package_digest = `sha256:${"f".repeat(64)}`;
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
JS
chmod 0600 "$remote_receipt"
expect_failure "staged package identity" remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$remote_transfer_digest" --if-binding-digest "$remote_binding_digest"
cp "$TMP_ROOT/remote-receipt.json" "$remote_receipt"
chmod 0600 "$remote_receipt"
cp "$remote_source_root/helper.txt" "$TMP_ROOT/remote-helper.txt"
printf 'drifted staged bytes\n' > "$remote_source_root/helper.txt"
expect_failure "staged package identity" remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$remote_transfer_digest" --if-binding-digest "$remote_binding_digest"
cp "$TMP_ROOT/remote-helper.txt" "$remote_source_root/helper.txt"
chmod 0644 "$remote_source_root/helper.txt"
remote_version_root=${remote_stage_root%/*}
remote_wrong_version="${remote_version_root%/*}/9.9.9"
mv "$remote_version_root" "$remote_wrong_version"
expect_failure "version directory" remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$remote_transfer_digest" --if-binding-digest "$remote_binding_digest"
mv "$remote_wrong_version" "$remote_version_root"
P_REMOTE_OTHER="$PACKAGES/remote-other"
make_package "$P_REMOTE_OTHER" org.example.remote-other ext-remote-other
REMOTE_OTHER_TRANSFER="$TMP_ROOT/remote-other-transfer.json"
FM_HOME="$H_REMOTE_CONTROL" "$HOST" pack-transfer "$P_REMOTE_OTHER" > "$REMOTE_OTHER_TRANSFER"
remote_other_bind=$(remote_receive_file_direct "$REMOTE_OTHER_TRANSFER" ext-remote-other)
remote_other_transfer=$(printf '%s\n' "$remote_other_bind" | sed -n 's/^transfer-digest: //p')
remote_other_binding=$(printf '%s\n' "$remote_other_bind" | sed -n 's/^binding-digest: //p')
remote_binding_path="$H_REMOTE/config/extensions.d/org.example.remote.json"
remote_partial_binding="$remote_stage_root/binding.json"
cp "$remote_binding_path" "$remote_partial_binding"
expect_failure "enabled and partial binding state" remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$remote_transfer_digest" --if-binding-digest "$remote_binding_digest"
rm -f "$remote_partial_binding"
cp "$remote_binding_path" "$TMP_ROOT/remote-binding.json"
mv "$remote_binding_path" "$remote_partial_binding"
printf ' ' >> "$remote_partial_binding"
expect_failure "partial binding does not match" remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$remote_transfer_digest" --if-binding-digest "$remote_binding_digest"
cp "$TMP_ROOT/remote-binding.json" "$remote_partial_binding"
chmod 0600 "$remote_partial_binding"
remote_direct fm-extension.sh retire-transfer org.example.remote \
  --if-transfer-digest "$remote_transfer_digest" --if-binding-digest "$remote_binding_digest" >/dev/null
assert_absent "$H_REMOTE/data/extensions/staging/org.example.remote/1.2.3/${remote_transfer_digest#sha256:}" "remote staged package was not retired"
assert_present "$H_REMOTE/data/extensions/retired-staging/org.example.remote/1.2.3/${remote_transfer_digest#sha256:}/package" "remote staged package retirement was not reversible"
assert_present "$H_REMOTE/data/extensions/retired-staging/org.example.remote/1.2.3/${remote_transfer_digest#sha256:}/binding.json" "remote enabled binding was not retained with its exact transfer"
assert_absent "$H_REMOTE/config/extensions.d/org.example.remote.json" "remote enabled binding remained discoverable after retirement"
expect_failure "no home-local extension binding" remote_direct fm-extension.sh resolve-process-event ext-remote
assert_contains "$(remote_direct fm-extension.sh list)" "org.example.remote-other" "retirement changed an unrelated remote binding"
remote_direct fm-extension.sh verify org.example.remote-other >/dev/null
pass "remote retirement refuses ambiguous drift and resumes an exact crash cut"
remote_direct fm-extension.sh retire-transfer org.example.remote-other \
  --if-transfer-digest "$remote_other_transfer" --if-binding-digest "$remote_other_binding" >/dev/null
assert_absent "$H_REMOTE_CONTROL/config/extensions.d/org.example.remote.json" "remote binding was published into the local control home"
pass "remote retirement and refusal checks run against an isolated addressed home"
fi
fi

# --- shipped runnable example ------------------------------------------------
if section_enabled example; then
P_EXAMPLE="$PACKAGES/file-signal-example"
cp -R "$ROOT/docs/examples/process-event-extension" "$P_EXAMPLE"
chmod 0755 "$P_EXAMPLE" "$P_EXAMPLE/file-signal.mjs"
chmod 0644 "$P_EXAMPLE/firstmate-extension.json"
H_EXAMPLE="$HOMES/example"; new_home "$H_EXAMPLE"
bind_package "$H_EXAMPLE" "$P_EXAMPLE" file-signal --consent artifact-references >/dev/null
SIGNAL_FILE="$TMP_ROOT/example-result.txt"
example_registration=$(FM_HOME="$H_EXAMPLE" "$PROCEVENT" register-extension file-signal example-file --config-ref "file:$SIGNAL_FILE")
example_token=$(printf '%s\n' "$example_registration" | sed -n 's/^owner-token: //p')
FM_HOME="$H_EXAMPLE" "$PROCEVENT" start example-file > "$TMP_ROOT/example-start.out" &
example_start=$!
for _ in $(seq 1 100); do
  [ -f "$FM_PROCEVENT_CLAIM_ROOT/example-file.claim" ] && break
  sleep 0.05
done
assert_present "$FM_PROCEVENT_CLAIM_ROOT/example-file.claim" "example source never started waiting"
printf 'build 42 completed successfully\n' > "$SIGNAL_FILE"
wait "$example_start" || fail "example source failed after its file appeared"
example_result=$(first_result "$H_EXAMPLE" example-file) || fail "example captured no file result"
assert_grep 'build 42 completed successfully' "$example_result" "example did not preserve external evidence"
assert_contains "$(FM_HOME="$H_EXAMPLE" "$PROCEVENT" classify "$example_result")" "file-signal" "example result did not classify through the package"
assert_absent "$H_EXAMPLE/state/procevent/example-file.source" "example terminal result did not retire its source"
FM_HOME="$H_EXAMPLE" "$PROCEVENT" retire example-file --if-owner "$example_token" >/dev/null
pass "the shipped file-signal package is a runnable end-to-end external adapter"

P_HANDSHAKE_ORPHAN="$PACKAGES/handshake-orphan"
P_HANDSHAKE_RECOVER="$PACKAGES/handshake-recover"
handshake_orphan_pid_file="$TMP_ROOT/handshake-orphan.pid"
make_package "$P_HANDSHAKE_ORPHAN" org.example.handshake-orphan ext-handshake-orphan "$(printf 'handshake-leak\n%s' "$handshake_orphan_pid_file")"
make_package "$P_HANDSHAKE_RECOVER" org.example.handshake-orphan ext-handshake-orphan
H_HANDSHAKE_ORPHAN="$HOMES/handshake-orphan"; new_home "$H_HANDSHAKE_ORPHAN"
handshake_orphan_rc=0
handshake_orphan_out=$(bind_package "$H_HANDSHAKE_ORPHAN" "$P_HANDSHAKE_ORPHAN" ext-handshake-orphan 2>&1) || handshake_orphan_rc=$?
wait_for_file "$handshake_orphan_pid_file" || fail "handshake leak fixture did not start its foreground child"
handshake_orphan_pid=$(cat "$handshake_orphan_pid_file")
[ "$handshake_orphan_rc" -ne 0 ] || fail "a handshake orphan was accepted as a successful binding"
assert_contains "$handshake_orphan_out" "process-leak" "handshake leak did not reject binding publication"
assert_absent "$H_HANDSHAKE_ORPHAN/config/extensions.d/org.example.handshake-orphan.json" "handshake orphan published an enabled binding"
kill -0 "$handshake_orphan_pid" 2>/dev/null && fail "handshake leak escaped invocation-group cleanup"
for _ in $(seq 1 50); do
  kill -0 "$handshake_orphan_pid" 2>/dev/null || break
  sleep 0.05
done
handshake_orphan_pid=
bind_package "$H_HANDSHAKE_ORPHAN" "$P_HANDSHAKE_RECOVER" ext-handshake-orphan >/dev/null
assert_contains "$(FM_HOME="$H_HANDSHAKE_ORPHAN" "$HOST" verify org.example.handshake-orphan)" "verified: org.example.handshake-orphan@1.2.3" \
  "cleaned handshake state did not permit safe binding"
pass "handshake execution rejects and reaps foreground descendants"
fi

printf '\nall extension-binding tests passed\n'
