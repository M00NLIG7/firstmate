#!/usr/bin/env python3
"""Drive production watcher/drain/outcome CLIs in disposable worktree-local homes.
No harness, backend, clock, command, or production function is mocked.
"""
import hashlib, json, os, pathlib, shutil, signal, subprocess, sys, tempfile, time
ROOT = pathlib.Path(os.environ['PWD'])
EVIDENCE = pathlib.Path('/Users/cmagana/.no-mistakes/evidence/01M3D88912CWXQFKHJ9ESYNF0Y')
TMP = ROOT / '.monitor-test-tmp'
TMP.mkdir(exist_ok=True)
BASE = '8d2ee291107d14f37ca7ef280199bebed22578c4'
LOG = open(EVIDENCE / 'monitoring-live.log', 'a', buffering=1)

def emit(text):
    print(text, flush=True)
    print(text, file=LOG, flush=True)

def env(home):
    e = dict(os.environ)
    for k in list(e):
        if k.startswith('FM_') or k.startswith('HERDR') or k in ('TMUX', 'TASKS_AXI_FILE', 'TASKS_AXI_BACKEND'):
            e.pop(k)
    e.update(FM_HOME=str(home), TMPDIR=str(TMP), FM_POLL='1', FM_SIGNAL_GRACE='0')
    return e

def call(args, home, code=0, root=ROOT, show=True):
    start = time.monotonic()
    proc = subprocess.Popen([str(x) for x in args], cwd=root, env=env(home), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = proc.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        stop(proc)
        raise
    p = subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)
    if show:
        emit(f'$ {" ".join(str(x) for x in args)}\nexit={p.returncode} elapsed={time.monotonic()-start:.3f}s\n{p.stdout}{p.stderr}')
    if code is not None:
        assert p.returncode == code, (args, p.returncode, p.stdout, p.stderr)
    return p

def shell(script, home, root=ROOT, show=False):
    return call(['bash', '-eu', '-c', script], home, root=root, show=show)

def lab():
    h = pathlib.Path(tempfile.mkdtemp(prefix='fm-lab.', dir=TMP))
    call([ROOT/'bin/fm-lab-home.sh', 'create', h], h)
    (h/'config/backend').write_text('tmux\n')
    return h

def stop(p):
    if p is None: return
    try: os.killpg(p.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: p.wait(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()

def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()

def values(p):
    return dict(line.split('=',1) for line in p.read_text().splitlines() if '=' in line)

def wait_for(pred, seconds=15):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if pred(): return True
        time.sleep(.1)
    return False

def watcher_lock_case(root, label, expected_block=False):
    h = lab(); state=h/'state'; holder=None; watch=None
    try:
        setup = shell('''
. bin/fm-pending-reply-lib.sh
for i in $(seq 1 32); do
  c=$(fm_pending_reply_create "$FM_HOME" "$FM_HOME/state" archive 'settled request = \\literal')
  fm_pending_reply_set "$FM_HOME/state/pending-replies/$c" phase resolved
  if [ "$i" -eq 2 ]; then
    fm_pending_reply_set "$FM_HOME/state/pending-replies/$c" escalated_epoch 1
    fm_pending_reply_set "$FM_HOME/state/pending-replies/$c" escalation_closed_epoch 2
  fi
  [ "$i" -gt 2 ] || printf '%s\n' "$c" >> "$FM_HOME/locked-corrs"
done
c=$(fm_pending_reply_create "$FM_HOME" "$FM_HOME/state" mate 'new reply = \\literal')
fm_pending_reply_mark_delivered "$FM_HOME/state" "$c"
printf '%s\n' "$c"
''', h, root=root)
        corr=setup.stdout.strip(); records=state/'pending-replies'
        old={p.name:digest(p) for p in records.iterdir() if p.name!=corr}
        with open(EVIDENCE/f'{label}-locks.log','w') as lf:
            holder=subprocess.Popen(['bash','-eu','-c','''
. bin/fm-wake-lib.sh
while IFS= read -r c; do fm_lock_acquire_wait "$STATE/.pending-reply-$c.lock"; done < "$FM_HOME/locked-corrs"
printf ready > "$FM_HOME/locks-ready"
while :; do sleep 1; done
'''],cwd=root,env=env(h),stdout=lf,stderr=lf,start_new_session=True)
            assert wait_for(lambda:(h/'locks-ready').exists())
            with open(EVIDENCE/f'{label}-watcher.log','w') as wf:
                watch=subprocess.Popen([str(root/'bin/fm-watch.sh')],cwd=root,env=env(h),stdout=wf,stderr=wf,start_new_session=True)
                beat=state/'.last-watcher-beat'
                assert wait_for(beat.exists), 'watcher never published a beacon'
                first=beat.stat().st_mtime_ns
                refreshed=wait_for(lambda:beat.stat().st_mtime_ns>first, seconds=4 if expected_block else 40)
                emit(f'{label}: real watcher PID={watch.pid}; 32 settled records; two live correlation locks held; beacon_refreshed={refreshed}')
                # A plain append with corr is a documented worker report interface.
                start=time.monotonic()
                with open(state/'mate.status','a') as out:
                    out.write(f'done [corr={corr}]: monitoring live reply = \\literal\n')
                delivered=wait_for(lambda:watch.poll() is not None, seconds=12 if expected_block else 40)
                emit(f'{label}: new report appended; watcher_returned={delivered}; latency={time.monotonic()-start:.3f}s; phase={values(records/corr)["phase"]}')
                emit((EVIDENCE/f'{label}-watcher.log').read_text())
                if expected_block:
                    assert not refreshed and not delivered
                    assert values(records/corr)['phase']=='awaiting_report'
                    emit('BASELINE REPRODUCED: settled lock prevents later report processing and beacon refresh.')
                else:
                    assert refreshed and delivered and watch.returncode==0
                    # A report arriving after this cycle's pending scan may be
                    # delivered first, then reconciled on the next normal arm.
                    if values(records/corr)['phase']!='resolved':
                        emit('Report arrived after reconciliation; rearming production watcher for next cycle.')
                        stop(watch)
                        watch=subprocess.Popen([str(root/'bin/fm-watch.sh')],cwd=root,env=env(h),stdout=wf,stderr=wf,start_new_session=True)
                        assert wait_for(lambda:values(records/corr)['phase']=='resolved', seconds=40)
                    assert values(records/corr)['phase']=='resolved'
                    assert (state/'.wake-queue').is_file()
                    emit('Durable wake queue:\n'+(state/'.wake-queue').read_text())
                    d=call([ROOT/'bin/fm-wake-drain.sh'],h)
                    assert 'monitoring live reply = \\literal' in d.stdout
                    (EVIDENCE/'notification-drain.txt').write_text(d.stdout+d.stderr)
                    assert old=={p.name:digest(p) for p in records.iterdir() if p.name!=corr}
                    assert holder.poll() is None
                    emit('Settled history hashes unchanged; new correlation resolved and delivered while old locks remain held.')
    finally:
        stop(watch); stop(holder); shutil.rmtree(h)
        emit(f'{label}: lab and owned processes removed')

def closure_retry():
    h=lab(); state=h/'state'; watch=None
    try:
        p=shell('''
. bin/fm-pending-reply-lib.sh
c=$(fm_pending_reply_create "$FM_HOME" "$FM_HOME/state" mate 'retry close safely')
fm_pending_reply_mark_delivered "$FM_HOME/state" "$c"
r="$FM_HOME/state/pending-replies/$c"
fm_pending_reply_set "$r" phase recovery_failed
fm_pending_reply_set "$r" recovery_delivery_outcome failed
fm_pending_reply_maybe_escalate "$FM_HOME/state" "$c"
printf 'blocked [key=unrelated]: still needs human approval\n' >> "$FM_HOME/state/mate.status"
printf 'done [corr=%s]: late answer\n' "$c" >> "$FM_HOME/state/mate.status"
chmod 400 "$FM_HOME/state/mate.status"
fm_pending_reply_try_resolve "$FM_HOME/state" "$c"
printf '%s\n' "$c"
''',h)
        corr=p.stdout.strip(); rec=state/'pending-replies'/corr; status=state/'mate.status'
        assert values(rec)['phase']=='resolved' and not values(rec).get('escalation_closed_epoch')
        emit('Resolved record survived an actual mode-400 status-write failure, with no close receipt yet:\n'+status.read_text())
        before=status.read_bytes(); status.chmod(0o600)
        with open(EVIDENCE/'closure-retry-watcher.log','w') as wf:
            watch=subprocess.Popen([str(ROOT/'bin/fm-watch.sh')],cwd=ROOT,env=env(h),stdout=wf,stderr=wf,start_new_session=True)
            assert wait_for(lambda:bool(values(rec).get('escalation_closed_epoch')))
            assert wait_for(lambda:watch.poll() is not None)
        assert status.read_bytes().startswith(before)
        assert status.read_text().count('pending-reply-resolved:')==1
        emit('Watcher retried close without losing history:\n'+status.read_text())
        d=call([ROOT/'bin/fm-wake-drain.sh'],h)
        assert 'still needs human approval' in d.stdout
        fold=shell('. bin/fm-classify-lib.sh; status_open_decisions "$FM_HOME/state/mate.status"',h).stdout
        assert 'unrelated' in fold and 'pending-reply-' not in fold
        emit('Current open decisions (production fold):\n'+fold)
    finally:
        stop(watch); shutil.rmtree(h)

def cursor_case():
    h=lab(); state=h/'state'
    try:
        for i in range(24): (state/f'task-{i:02d}.status').write_text('note: initial line\n')
        start=time.monotonic()
        call([ROOT/'bin/fm-wake-drain.sh'],h,show=False)
        emit(f'24-task initial drain elapsed={time.monotonic()-start:.3f}s')
        (state/'task-00.status').write_text('note: initial line\nnote: answer = \\literal\nnote: routine follow-up\n')
        (state/'task-23.status').write_text('note: initial line\ndone: ready-for-review-23\n')
        a=call([ROOT/'bin/fm-wake-drain.sh'],h)
        assert 'answer = \\literal' in a.stdout and 'routine follow-up' in a.stdout and 'ready-for-review-23' in a.stdout
        assert 'initial line' not in a.stdout
        b=call([ROOT/'bin/fm-wake-drain.sh'],h)
        assert not b.stdout.strip(), 'already-presented notifications replayed'
        with open(state/'task-00.status','a') as f:f.write('note: genuinely-new-answer\n')
        c=call([ROOT/'bin/fm-wake-drain.sh'],h)
        assert 'genuinely-new-answer' in c.stdout and 'routine follow-up' not in c.stdout
        emit('Persisted presentation cursor (24 tasks):\n'+(state/'.status-presentation-cursor').read_text())
    finally: shutil.rmtree(h)

def migration_case(root, label, expected_fail=False):
    h=lab(); state=h/'state'
    try:
        labels=['task-1','old task label','../escape','task-2','trailing-newline\n','\tbad','/absolute','fleet']
        rows=[dict(seq=i+1,epoch=i+1,task=t,wake='',verdict='captain' if i==1 else 'routine',summary='retain decision' if i==1 else f'history-{i}',silent=False) for i,t in enumerate(labels)]
        store=state/'branch-outcomes.jsonl'
        store.write_text(''.join(json.dumps(row)+'\n' for row in rows))
        (state/'.branch-outcomes-cursor').write_text('2\n'); (state/'.branch-outcomes-processed').write_text('1\n')
        snapshot=store.read_bytes()
        p=call([root/'bin/fm-branch-outcome.sh','processed-init'],h,code=None,root=root)
        if expected_fail:
            assert p.returncode!=0
            emit('BASELINE REPRODUCED: legacy label prevents derived index rebuild.')
            return
        assert p.returncode==0 and store.read_bytes()==snapshot
        assert (state/'.branch-outcomes-cursor').read_text()=='2\n'
        assert (state/'.branch-outcomes-processed').read_text()=='1\n'
        assert (state/'.branch-outcome-index-ready').read_text()=='8\n'
        indexes=sorted(p.name for p in state.glob('.*.branch-outcome-index'))
        assert indexes==['.task-1.branch-outcome-index','.task-2.branch-outcome-index'], indexes
        p=call([ROOT/'bin/fm-branch-outcome.sh','unprocessed'],h)
        assert [json.loads(x)['summary'] for x in p.stdout.splitlines()]==['retain decision']
        p=call([ROOT/'bin/fm-branch-outcome.sh','append','--task','../escape','--verdict','routine','--summary','must refuse'],h,code=None)
        assert p.returncode!=0 and store.read_bytes()==snapshot
        # Recovery through the end-user drain, not only explicit migration.
        (state/'.branch-outcome-index-ready').unlink()
        (state/'task-2.status').write_text('done: new completion after legacy history\n')
        d=call([ROOT/'bin/fm-wake-drain.sh'],h)
        assert 'new completion after legacy history' in d.stdout and 'skipped' not in d.stderr
        assert store.read_bytes()==snapshot
        emit(f'{label}: history SHA256={digest(store)}; cursor=2 processed=1 unchanged; indexes={indexes}; drain self-healed ready=8')
        emit('Original history retained:\n'+store.read_text())
    finally: shutil.rmtree(h)

baseline=TMP/'baseline'
try:
    baseline.mkdir(); shutil.copytree(ROOT/'bin',baseline/'bin')
    for f in ('fm-pending-reply-lib.sh','fm-classify-lib.sh','fm-branch-outcome.sh'):
        (baseline/'bin'/f).write_bytes(subprocess.check_output(['git','show',f'{BASE}:bin/{f}'],cwd=ROOT))
    if '--remaining' not in sys.argv:
        watcher_lock_case(baseline,'baseline',True)
        watcher_lock_case(ROOT,'target')
        closure_retry()
    cursor_case()
    migration_case(baseline,'baseline',True)
    migration_case(ROOT,'target')
    emit('ALL SELECTED LIVE CLI SCENARIOS PASSED.')
finally:
    shutil.rmtree(baseline,ignore_errors=True)
    try: TMP.rmdir()
    except OSError: pass
    LOG.close()
