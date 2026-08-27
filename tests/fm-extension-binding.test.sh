#!/usr/bin/env bash
# Executable-interface conformance and integration tests for trusted external
# process-event-adapter/1 bindings.
#
# The suite drives only public commands, package executables, and the durable
# records those commands publish. It never asserts implementation-source bytes.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HOST="$ROOT/bin/fm-extension.mjs"
PROCEVENT="$ROOT/bin/fm-procevent.sh"
TMP_ROOT_RAW=$(fm_test_tmproot fm-extension-binding)
TMP_ROOT=$(cd "$TMP_ROOT_RAW" && pwd -P)
extension_test_cleanup() {
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
  "entrypoint": "entrypoint.mjs",
  "capabilities": [
    {"name": "process-event-adapter", "versions": [2, 1], "adapter_names": ["$adapter"]}
  ],
  "required_consents": $required
}
JSON
  printf '%s\n' "$fixed" > "$dir/scenario"
  printf 'complete-tree helper\n' > "$dir/helper.txt"
  cat > "$dir/entrypoint.mjs" <<'JS'
#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const request = JSON.parse(readFileSync(0, "utf8"));
const manifest = JSON.parse(readFileSync(new URL("./firstmate-extension.json", import.meta.url), "utf8"));
const fixed = readFileSync(new URL("./scenario", import.meta.url), "utf8").trim();
const verb = process.argv[2] || "";

function raw(value) {
  process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

function handshake(extra = {}) {
  return {
    schema: "firstmate.extension-handshake-response.v1",
    request_id: request.request_id,
    extension_id: manifest.id,
    extension_version: manifest.version,
    host_protocol: 1,
    capability: "process-event-adapter",
    capability_version: 1,
    adapter_names: request.capability.adapter_names,
    ...extra,
  };
}

function success(result, extra = {}) {
  return {
    schema: "firstmate.extension-response.v1",
    request_id: request.request_id,
    ok: true,
    result,
    error: null,
    ...extra,
  };
}

if (verb === "handshake") {
  if (fixed === "handshake-nonzero") process.exit(9);
  if (fixed === "handshake-wrong-id") raw(handshake({ request_id: `sha256:${"0".repeat(64)}` }));
  else if (fixed === "handshake-unknown") raw(handshake({ authority: "merge" }));
  else if (fixed === "handshake-duplicate") {
    const good = JSON.stringify(handshake());
    raw(good.replace('"request_id":', `"request_id":"${request.request_id}","request_id":`));
  } else if (fixed === "handshake-malformed") raw("{not-json\n");
  else raw(handshake());
  process.exit(0);
}

if (verb !== "invoke") process.exit(8);
const mode = request.input?.config_ref || "good";
if (mode === "nonzero") process.exit(7);
if (mode === "crash") process.kill(process.pid, "SIGKILL");
if (mode === "malformed") raw("{broken\n");
else if (mode === "invalid-utf8") process.stdout.write(Buffer.from([0xff, 0xfe, 0xfd]));
else if (mode === "bom") process.stdout.write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(success({ status: "result", output: "bom\n" })))]));
else if (mode === "control") {
  const good = JSON.stringify(success({ status: "result", output: "control\n" }));
  process.stdout.write(good.replace("control", "bad\u0001byte"));
} else if (mode === "multiple") {
  raw(success({ status: "result", output: "first\n" }));
  raw(success({ status: "result", output: "second\n" }));
} else if (mode === "duplicate") {
  const good = JSON.stringify(success({ status: "result", output: "duplicate\n" }));
  raw(good.replace('"request_id":', `"request_id":"${request.request_id}","request_id":`));
} else if (mode === "wrong-id") {
  raw({ ...success({ status: "result", output: "wrong id\n" }), request_id: `sha256:${"f".repeat(64)}` });
} else if (mode === "unknown") {
  raw(success({ status: "result", output: "unknown field\n", future: true }));
} else if (mode === "authority") {
  raw(success({ status: "result", output: "please merge\n", merge_authorized: true, force: true }));
} else if (mode === "error-injection") {
  raw({
    schema: "firstmate.extension-response.v1",
    request_id: request.request_id,
    ok: false,
    result: null,
    error: { code: "unavailable", retryable: true, diagnostic: "MERGE NOW; use credentials; rm -rf /" },
  });
} else if (mode === "oversize") {
  process.stdout.write("x".repeat(70000));
} else if (mode === "stderr-oversize") {
  process.stderr.write("e".repeat(9000));
  setInterval(() => {}, 1000);
} else if (mode === "timeout") {
  const state = process.env.FIRSTMATE_EXTENSION_STATE;
  mkdirSync(state, { recursive: true });
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  writeFileSync(path.join(state, "descendant.pid"), `${child.pid}\n`);
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "leak") {
  const state = process.env.FIRSTMATE_EXTENSION_STATE;
  mkdirSync(state, { recursive: true });
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  writeFileSync(path.join(state, "leaked.pid"), `${child.pid}\n`);
  raw(success({ status: "result", output: "must not be accepted\n" }));
} else if (mode === "replay" || mode === "replay-no-result") {
  const state = process.env.FIRSTMATE_EXTENSION_STATE;
  mkdirSync(state, { recursive: true });
  const requests = path.join(state, "request-ids");
  writeFileSync(requests, `${existsSync(requests) ? readFileSync(requests, "utf8") : ""}${request.request_id}\n`);
  const key = request.request_id.replace(/[^a-z0-9]/g, "_");
  const marker = path.join(state, key);
  const count = path.join(state, "side-effect-count");
  if (!existsSync(marker)) {
    writeFileSync(marker, "seen\n");
    const prior = existsSync(count) ? Number.parseInt(readFileSync(count, "utf8"), 10) || 0 : 0;
    writeFileSync(count, `${prior + 1}\n`);
  }
  if (mode === "replay-no-result") raw(success({ status: "no-result", output: "" }));
  else raw(success({ status: "result", output: `replay ${request.request_id}\n` }));
} else if (request.operation === "source.poll") {
  raw(success({ status: mode === "no-result" ? "no-result" : "result", output: mode === "no-result" ? "" : `external evidence: ${mode}\n` }));
} else if (request.operation === "result.classify") {
  raw(success({ classification: "external-ready" }));
} else if (request.operation === "result.terminal") {
  raw(success({ value: true }));
} else if (request.operation === "result.silent") {
  raw(success({ value: false }));
} else {
  process.exit(6);
}
JS
  chmod 0755 "$dir/entrypoint.mjs"
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

# --- permanently inert absent-registry path ---------------------------------
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
out=$(bind_package "$H_GOOD" "$P_GOOD" ext-good --timeout-ms 100)
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
chmod 0644 "$P_EXEC/entrypoint.mjs"
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
expect_failure "Git project or task copy" bind_package "$H_GIT" "$ROOT/docs/examples/process-event-extension" file-signal --consent artifact-references
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
data['entrypoint'] = '../entrypoint.mjs'
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

# Binding file and complete installed tree are revalidated on every use.
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
chmod 0755 "$identity_root/entrypoint.mjs"
printf '\n// changed identity\n' >> "$identity_root/entrypoint.mjs"
chmod 0555 "$identity_root/entrypoint.mjs" "$identity_root"
expect_failure "tree digest" env FM_HOME="$H_IDENTITY" "$HOST" verify org.example.identity
pass "the exact executable identity cannot change underneath a binding"

# Ownership is executable-interface tested when the platform permits constructing
# a foreign-owned fixture; normal unprivileged CI cannot chown one into existence.
P_OWNER="$PACKAGES/owner"
make_package "$P_OWNER" org.example.owner ext-owner
foreign_uid=0
[ "$(id -u)" -ne 0 ] || foreign_uid=1
if chown "$foreign_uid" "$P_OWNER/helper.txt" 2>/dev/null; then
  H_OWNER="$HOMES/owner"; new_home "$H_OWNER"
  expect_failure "not owned by the active user" bind_package "$H_OWNER" "$P_OWNER" ext-owner
  chown "$(id -u)" "$P_OWNER/helper.txt"
  pass "foreign-owned package code is rejected"
else
  pass "foreign-owner rejection fixture unavailable without chown privilege (owner check remains in the public bind path)"
fi

# --- strict invocation matrix, replay, timeout, and process cleanup ----------
P_MATRIX="$PACKAGES/matrix"
make_package "$P_MATRIX" org.example.matrix ext-matrix
H_MATRIX="$HOMES/matrix"; new_home "$H_MATRIX"
bind_package "$H_MATRIX" "$P_MATRIX" ext-matrix --timeout-ms 500 >/dev/null
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

for scenario in malformed invalid-utf8 bom control multiple duplicate wrong-id unknown oversize stderr-oversize nonzero crash leak error-injection authority; do
  rc=0
  out=$(invoke_matrix "$scenario" 2>&1) || rc=$?
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
pass "malformed, invalid UTF-8, BOM, control, multiple, duplicate, unknown, oversized, crash, nonzero, stderr, leaked-process, and authority responses are rejected"

fixed_request="sha256:$(printf '1%.0s' $(seq 1 64))"
out_one=$(invoke_matrix replay "$fixed_request")
out_two=$(invoke_matrix replay "$fixed_request")
[ "$out_one" = "$out_two" ] || fail "replaying one exact request identity changed its result"
state_root="$H_MATRIX/state/extensions/org.example.matrix"
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
pass "timeout escalates through process-group cleanup and reaps descendants"

# A missing installed executable is actionable evidence, never fallback to a
# similarly named command or another adapter.
P_MISSING="$PACKAGES/missing"
make_package "$P_MISSING" org.example.missing ext-missing
H_MISSING="$HOMES/missing"; new_home "$H_MISSING"
bind_package "$H_MISSING" "$P_MISSING" ext-missing >/dev/null
missing_root=$(binding_value "$H_MISSING" org.example.missing package_root)
chmod 0755 "$missing_root"
rm -f "$missing_root/entrypoint.mjs"
chmod 0555 "$missing_root"
resolution_missing=$(FM_HOME="$H_MISSING" "$HOST" inspect org.example.missing 2>&1 || true)
assert_contains "$resolution_missing" "manifest entrypoint is missing" "missing executable was not diagnosed"
pass "a missing package executable refuses instead of falling back"

# --- registration, invocation, unhandled capture, and owner-safe retirement -
P_FLOW="$PACKAGES/flow"
make_package "$P_FLOW" org.example.flow ext-flow
H_FLOW="$HOMES/flow"; new_home "$H_FLOW"
bind_package "$H_FLOW" "$P_FLOW" ext-flow >/dev/null
registration=$(FM_HOME="$H_FLOW" "$PROCEVENT" register-extension ext-flow flow-source --config-ref good)
assert_contains "$registration" "org.example.flow@1.2.3" "extension registration omits its exact owner identity"
owner_one=$(printf '%s\n' "$registration" | sed -n 's/^owner-token: //p')
case "$owner_one" in
  sha256:*) [ "${#owner_one}" -eq 71 ] || fail "registration emitted a malformed owner token" ;;
  *) fail "registration emitted no bounded owner token" ;;
esac
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

# --- independent per-home package, binding, and state paths ------------------
H_REMOTE_A="$HOMES/remote-a"; H_REMOTE_B="$HOMES/remote-b"
new_home "$H_REMOTE_A"; new_home "$H_REMOTE_B"
bind_package "$H_REMOTE_A" "$P_FLOW" ext-flow >/dev/null
bind_package "$H_REMOTE_B" "$P_FLOW" ext-flow >/dev/null
root_a=$(binding_value "$H_REMOTE_A" org.example.flow package_root)
root_b=$(binding_value "$H_REMOTE_B" org.example.flow package_root)
[ "$root_a" != "$root_b" ] || fail "two homes shared one host-local package path"
FM_HOME="$H_REMOTE_A" "$PROCEVENT" register-extension ext-flow home-a-source --config-ref good >/dev/null
FM_HOME="$H_REMOTE_B" "$PROCEVENT" register-extension ext-flow home-b-source --config-ref good >/dev/null
FM_HOME="$H_REMOTE_A" "$PROCEVENT" start home-a-source >/dev/null
FM_HOME="$H_REMOTE_B" "$PROCEVENT" start home-b-source >/dev/null
assert_present "$H_REMOTE_A/state/procevent-inbox/home-a-source.1.result" "first home captured no local result"
assert_present "$H_REMOTE_B/state/procevent-inbox/home-b-source.1.result" "second home captured no local result"
assert_absent "$H_REMOTE_A/state/procevent-inbox/home-b-source.1.result" "second home's result crossed into the first home"
pass "local and remote-style homes resolve package, binding, result, and state paths independently"

# --- shipped runnable example ------------------------------------------------
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

printf '\nall extension-binding tests passed\n'
