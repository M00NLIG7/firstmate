#!/usr/bin/env python3
"""Bounded, isolated product-CLI validation. No substituted tools or product functions."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

ROOT = Path('/Users/cmagana/.no-mistakes/worktrees/48ce38e9c45c/01M3MREKC49SGBXWF3FAQYRBSP')
EVIDENCE = Path('/Users/cmagana/.no-mistakes/evidence/01M3MREKC49SGBXWF3FAQYRBSP')
LABROOT = ROOT / '.test-monitoring/live'
LABROOT.mkdir(parents=True, exist_ok=True)
(ROOT / '.test-monitoring/tmp').mkdir(parents=True, exist_ok=True)
BASE = 'd5c2507ab4cac59b1103134140af4fe0934bd0da'
log = (EVIDENCE / 'monitoring-product-transcript.log').open('w')
results = []

def record(message):
    print(message, flush=True)
    print(message, file=log, flush=True)

def env_for(home):
    env = os.environ.copy()
    for key in list(env):
        if key.startswith('FM_') or key in ('PI_CODING_AGENT', 'TMUX', 'HERDR_ENV', 'HERDR_SESSION', 'TASKS_AXI_FILE', 'TASKS_AXI_BACKEND'):
            env.pop(key, None)
    env.update(FM_HOME=str(home), TMPDIR=str(ROOT / '.test-monitoring/tmp'), FM_POLL='1', FM_SIGNAL_GRACE='0', FM_BACKEND='tmux')
    return env

def command(args, home, timeout=40, expected=0):
    start = time.monotonic()
    proc = subprocess.Popen([str(a) for a in args], cwd=ROOT, env=env_for(home), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        stop(proc)
        stdout, stderr = proc.communicate(timeout=5)
        record(f'TIMEOUT {args}: {stdout}{stderr}')
        raise
    p = subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)
    record('$ ' + ' '.join(str(a) for a in args))
    record(f'exit={p.returncode} elapsed={time.monotonic()-start:.3f}s\n{p.stdout}{p.stderr}')
    if expected is not None:
        assert p.returncode == expected, (args, p.returncode)
    return p

def home(name):
    h = LABROOT / name
    command([ROOT/'bin/fm-lab-home.sh', 'create', h], h)
    return h

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def stop(p):
    # Only this driver's independently created process group, never a shared server.
    try:
        os.killpg(p.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        p.wait(timeout=5)

def ack(h, output):
    import re
    match = re.search(r'bin/fm-wake-drain.sh --ack-through (\d+) --recovery-generation (\S+)', output)
    if match:
        command([ROOT/'bin/fm-wake-drain.sh', '--ack-through', match[1], '--recovery-generation', match[2]], h)


def settled_history(code, name, should_deliver):
    h = home(name)
    state = h/'state'
    pending = state/'pending-replies'
    pending.mkdir()
    # These are intentional persisted-record contracts, not mocked readers.
    for i in range(1, 129):
        corr = f'{i:016x}'
        fields = f'corr_id={corr}\ntask_id=historical\nphase=awaiting_report\nrequest_summary=literal = \\payload\nphase=resolved'
        if i % 2 == 0:
            fields += '\nescalated_epoch=1\nescalation_closed_epoch=2'
        (pending/corr).write_text(fields)  # Deliberately no terminal newline.
    before = {p.name: digest(p) for p in pending.iterdir()}
    unlanded = h/'projects/unlanded.txt'
    unlanded.write_text('preserve local work exactly\n')
    ready = h/'locks-ready'
    script = '''set -eu
. "$1/bin/fm-wake-lib.sh"
a="$FM_HOME/state/.pending-reply-0000000000000001.lock"
b="$FM_HOME/state/.pending-reply-0000000000000002.lock"
fm_lock_acquire_wait "$a"
fm_lock_acquire_wait "$b"
trap 'fm_lock_release "$a"; fm_lock_release "$b"' EXIT
trap 'exit 143' TERM
printf ready > "$2"
read -r release || true
'''
    holder = subprocess.Popen(['bash', '-c', script, '_', str(ROOT), str(ready)], cwd=ROOT, env=env_for(h), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    watcher = None
    try:
        deadline = time.monotonic()+10
        while not ready.exists() and time.monotonic()<deadline:
            assert holder.poll() is None, 'lock holder exited'
            time.sleep(.05)
        assert ready.exists(), 'lock acquisition timed out'
        record(f'\nSCENARIO {name}: 128 settled records, two genuinely held correlation locks, literal duplicate fields and unterminated final values')
        start = time.monotonic()
        watcher = subprocess.Popen([str(code/'bin/fm-watch.sh')], cwd=ROOT, env=env_for(h), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        beat = state/'.last-watcher-beat'
        deadline = time.monotonic()+10
        while not beat.exists() and time.monotonic()<deadline:
            assert watcher.poll() is None, 'watcher exited before beacon'
            time.sleep(.05)
        assert beat.exists(), 'no real watcher beacon'
        initial = beat.stat().st_mtime_ns
        (state/'fresh.status').write_text('done: fresh completion while historical locks remain held\n')
        try:
            out, err = watcher.communicate(timeout=20)
            elapsed = time.monotonic()-start
            record(f'$ {code}/bin/fm-watch.sh\nexit={watcher.returncode} elapsed={elapsed:.3f}s\n{out}{err}')
            assert should_deliver, 'unchanged base unexpectedly delivered'
            assert watcher.returncode == 0 and 'signal:' in out and 'fresh.status' in out
            assert holder.poll() is None, 'contention disappeared before delivery'
            queue = state/'wake.queue'
            # Queue filename is read via production state inventory below.
            record('Watcher state files: ' + ', '.join(sorted(p.name for p in state.iterdir())))
            drained = command([ROOT/'bin/fm-wake-drain.sh'], h)
            assert 'fresh completion while historical locks remain held' in drained.stdout
            ack(h, drained.stdout+drained.stderr)
            record(f'Fresh notification presented while both locks stayed owned; delivery latency {elapsed:.3f}s.')
        except subprocess.TimeoutExpired:
            assert not should_deliver, 'candidate watcher blocked behind settled history'
            unchanged = beat.stat().st_mtime_ns == initial
            assert unchanged and holder.poll() is None
            record('UNCHANGED BASE REPRODUCTION: no notification within 20 seconds; beacon stopped advancing while the settled-record lock holder remained alive.')
        assert before == {p.name:digest(p) for p in pending.iterdir()}, 'settled history mutated'
        assert unlanded.read_text() == 'preserve local work exactly\n'
        record('All 128 original record SHA-256 hashes and the local-work sentinel remained unchanged.')
    finally:
        if watcher is not None:
            stop(watcher)
        holder.stdin.write('release\n')
        holder.stdin.flush()
        holder.wait(timeout=5)
        record('Owned watcher process group stopped; both correlation locks released.')


def closure_retry():
    h = home('closure-retry')
    state = h/'state'
    record('\nSCENARIO closure retry: a resolved reply whose previous escalation still lacks its closing receipt')
    created = command(['bash', '-c', '. "$1/bin/fm-pending-reply-lib.sh"; fm_pending_reply_create "$FM_HOME" "$FM_HOME/state" mate "retain = \\literal request"', '_', ROOT], h)
    corr = created.stdout.strip()
    rec = state/'pending-replies'/corr
    # Model the durable crash boundary after resolution, before close publication.
    with rec.open('a') as f:
        f.write('\nphase=resolved\nescalated_epoch=1\nresolved_via=status\n')
    status = state/'mate.status'
    payload = command(['bash','-c','. "$1/bin/fm-pending-reply-lib.sh"; fm_pending_reply_escalation_payload "$2" missed','_', ROOT, rec], h).stdout
    status.write_text(f'blocked [key=pending-reply-{corr}]: {payload}\n')
    (state/'fresh.status').write_text('done: new event after an interrupted escalation close\n')
    command([ROOT/'bin/fm-watch.sh'], h, timeout=40)
    text = status.read_text()
    record('Persisted parent status after actual watcher tick:\n'+text)
    assert text.count(f'resolved [key=pending-reply-{corr}]') == 1
    assert any(x.startswith('escalation_closed_epoch=') and x.split('=',1)[1] for x in rec.read_text().splitlines())
    drained = command([ROOT/'bin/fm-wake-drain.sh'], h)
    assert 'pending-reply-resolved:' in drained.stdout
    assert 'OPEN DECISIONS' not in drained.stdout
    ack(h, drained.stdout+drained.stderr)
    command(['bash','-c','. "$1/bin/fm-pending-reply-lib.sh"; fm_pending_reply_tick "$FM_HOME/state"','_', ROOT],h)
    assert status.read_text() == text
    record('The real watcher closed the open escalation; subsequent reconciliation did not duplicate the receipt.')


def unread():
    h = home('unread-status')
    state = h/'state'
    record('\nSCENARIO unread presentation: multiple tasks, successive notes, and independent notification cursors')
    for task in ['alpha','beta','gamma']:
        (state/f'{task}.status').write_text(f'note: {task} initial message\n')
    first=command([ROOT/'bin/fm-wake-drain.sh'],h)
    for task in ['alpha','beta','gamma']:
        assert f'{task} initial message' in first.stdout
        with (state/f'{task}.status').open('a') as f:
            f.write(f'note: {task} answer = literal \\path\nnote: {task} trailing acknowledgement\n')
    second=command([ROOT/'bin/fm-wake-drain.sh'],h)
    for task in ['alpha','beta','gamma']:
        assert f'{task} answer = literal \\path' in second.stdout
        assert f'{task} trailing acknowledgement' in second.stdout
        assert f'{task} initial message' not in second.stdout
    third=command([ROOT/'bin/fm-wake-drain.sh'],h)
    assert 'UNREAD STATUS' not in third.stdout
    with (state/'beta.status').open('a') as f:
        f.write('note: beta follow-up after presentation\n')
    fourth=command([ROOT/'bin/fm-wake-drain.sh'],h)
    assert 'beta follow-up after presentation' in fourth.stdout
    assert 'answer = literal' not in fourth.stdout
    record('Each unread line was displayed once; a later beta append surfaced without replaying the other tasks.')


def migration(code, name, expect_success):
    h=home(name)
    state=h/'state'
    record(f'\nSCENARIO {name}: rebuild derived indexes from historical labels without consuming decisions or rewriting history')
    labels=['task-1','old task label','../escape','task-2','trailing-newline\n','absolute / label','tab\tlabel']
    rows=[dict(seq=i, epoch=i, task=t, wake='',verdict='captain' if i==2 else 'routine',summary='retain this decision' if i==2 else 'historical completion',silent=False) for i,t in enumerate(labels,1)]
    store=state/'branch-outcomes.jsonl'
    store.write_text(''.join(json.dumps(r)+'\n' for r in rows))
    (state/'.branch-outcomes-cursor').write_text('2\n')
    (state/'.branch-outcomes-processed').write_text('1\n')
    snapshot=digest(store)
    result=command([code/'bin/fm-branch-outcome.sh','processed-init'],h,expected=None)
    assert (result.returncode==0)==expect_success
    assert digest(store)==snapshot
    assert (state/'.branch-outcomes-cursor').read_text()=='2\n'
    assert (state/'.branch-outcomes-processed').read_text()=='1\n'
    if not expect_success:
        record('UNCHANGED BASE REPRODUCTION: valid legacy labels prevent processed-init; history and cursors remain preserved.')
        return
    assert (state/'.branch-outcome-index-ready').read_text().strip()=='7'
    indexes=sorted(p.name for p in state.glob('.*.branch-outcome-index'))
    assert indexes==['.task-1.branch-outcome-index','.task-2.branch-outcome-index'], indexes
    record('Generated index paths: '+json.dumps(indexes))
    unprocessed=command([ROOT/'bin/fm-branch-outcome.sh','unprocessed'],h)
    assert 'retain this decision' in unprocessed.stdout
    for label in ['new invalid label','../escape','new\n','new\tlabel']:
        rejected=command([ROOT/'bin/fm-branch-outcome.sh','append','--task',label,'--verdict','routine','--summary','must be refused'],h,expected=None)
        assert rejected.returncode!=0
    assert digest(store)==snapshot
    record(f'Authoritative history SHA-256 remains {snapshot}; cursor=2; processed=1; legacy captain decision is still deliverable.')
    command([ROOT/'bin/fm-branch-outcome.sh','append','--task','valid-task','--verdict','routine','--summary','valid new notification'],h)
    assert store.read_text().splitlines()[:7]==[json.dumps(r) for r in rows]
    # A separate corrupt history must still fail closed, not be silently filtered.
    bad=home(name+'-corrupt')
    badstore=bad/'state/branch-outcomes.jsonl'
    badstore.write_text(json.dumps(rows[0])+'\n'+json.dumps(rows[0])+'\n')
    badhash=digest(badstore)
    refused=command([ROOT/'bin/fm-branch-outcome.sh','processed-init'],bad,expected=None)
    assert refused.returncode!=0 and digest(badstore)==badhash
    assert not (bad/'state/.branch-outcome-index-ready').exists()
    record('Duplicate sequence corruption remains refused without publishing a ready index or changing the store.')


def run(name,fn):
    try:
        fn()
        results.append(dict(name=name,result='pass'))
    except Exception as e:
        results.append(dict(name=name,result='fail',reason=str(e)))
        record(f'FAILED {name}: {e!r}')
    finally:
        (EVIDENCE/'monitoring-driver-results.json').write_text(json.dumps(results,indent=2)+'\n')

try:
    baseline=LABROOT/'unchanged-base'
    (baseline/'bin').mkdir(parents=True)
    shutil.copytree(ROOT/'bin',baseline/'bin',dirs_exist_ok=True)
    for file in ['fm-pending-reply-lib.sh','fm-classify-lib.sh','fm-branch-outcome.sh']:
        original=subprocess.check_output(['git','show',f'{BASE}:bin/{file}'],cwd=ROOT)
        (baseline/'bin'/file).write_bytes(original)
    record('Setup correction from initial run: the escalation status must use the record-owned request_summary; the initial manual seed used a different request and correctly did not qualify for closure. This run obtains the payload from the production owner. The initial combined regression-test invocation also exhausted its tool deadline; the backstop suite subsequently completed with a sufficient bound.')
    record('Candidate '+subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip())
    record('Baseline uses the same executable script graph with the three changed production files restored byte-for-byte from '+BASE)
    run('unchanged-base settled-lock reproduction',lambda:settled_history(baseline,'base-settled',False))
    run('candidate notification delivery past settled locks',lambda:settled_history(ROOT,'candidate-settled',True))
    run('interrupted escalation close converges exactly once',closure_retry)
    run('unread status cursors preserve literal notifications',unread)
    run('unchanged-base historical-label reproduction',lambda:migration(baseline,'base-history',False))
    run('legacy history migration and unsafe-write guards',lambda:migration(ROOT,'candidate-history',True))
finally:
    # The driver owns this lab subtree only; evidence stays published separately.
    shutil.rmtree(LABROOT)
    record('Removed all disposable lab homes and the baseline code copy.')
    log.close()

raise SystemExit(1 if any(r['result']=='fail' for r in results) else 0)
