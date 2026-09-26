import hashlib, json, os, pathlib, re, shutil, subprocess, tempfile, time

ROOT = pathlib.Path.cwd()
EVIDENCE = pathlib.Path('/Users/cmagana/.no-mistakes/evidence/01M3DK7TM1KSHFF8N8SW9KCZMY')
log = (EVIDENCE / 'live-monitoring.log').open('w')
env = os.environ.copy()
for key in list(env):
    if key.startswith('FM_') or key in ('TMUX', 'TMUX_PANE', 'TASKS_AXI_FILE', 'TASKS_AXI_BACKEND'):
        env.pop(key)
env['TMPDIR'] = str(ROOT / '.live-test-tmp')
homes = []
children = []

def emit(text):
    print(text, flush=True)
    log.write(text + '\n'); log.flush()

def run(args, home, timeout=30, ok=True):
    e = dict(env, FM_HOME=str(home), TMUX_TMPDIR=str(home / 'tmux'))
    start = time.monotonic()
    try:
        p = subprocess.run(args, cwd=ROOT, env=e, text=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        emit(f'TIMEOUT after {timeout}s: {args}; stdout={exc.stdout!r}; stderr={exc.stderr!r}')
        for item in (home / 'state').rglob('*'):
            if item.is_file() and item.stat().st_size < 10000:
                emit(f'Diagnostic {item.relative_to(home)}: {item.read_text(errors="replace")}')
        raise
    emit('$ ' + ' '.join(map(str, args)))
    emit(f'exit={p.returncode} elapsed={time.monotonic()-start:.3f}s\n{p.stdout}{p.stderr}')
    if ok:
        assert p.returncode == 0, p.stderr
    return p

def home(name):
    h = pathlib.Path(tempfile.mkdtemp(prefix='fm-lab-' + name + '-', dir=env['TMPDIR']))
    homes.append(h)
    run(['bin/fm-lab-home.sh', 'create', str(h)], h)
    (h / 'tmux').mkdir()
    return h

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def watch(h, timeout=60):
    return run(['env', 'FM_POLL=1', 'FM_SIGNAL_GRACE=0', 'bin/fm-watch.sh'], h, timeout)

try:
    emit('LIVE SCENARIO: settled correlation locks cannot starve a fresh status notification')
    h = home('locks'); state = h / 'state'; records = state / 'pending-replies'; records.mkdir()
    for i in range(1, 101):
        corr = f'{i:016x}'
        extra = 'escalated_epoch=1\nescalation_closed_epoch=2\n' if i % 2 == 0 else ''
        (records / corr).write_text(f'corr_id={corr}\ntask_id=mate\nphase=resolved\n' + extra)
    before = {p.name: digest(p) for p in records.iterdir()}
    holder_code = '''. bin/fm-wake-lib.sh
fm_lock_acquire_wait "$FM_HOME/state/.pending-reply-0000000000000001.lock"
fm_lock_acquire_wait "$FM_HOME/state/.pending-reply-0000000000000002.lock"
printf 'locks-held\\n'
read -r release
fm_lock_release "$FM_HOME/state/.pending-reply-0000000000000001.lock"
fm_lock_release "$FM_HOME/state/.pending-reply-0000000000000002.lock"
'''
    holder = subprocess.Popen(['bash', '-c', holder_code], cwd=ROOT, env=dict(env, FM_HOME=str(h)), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    children.append(holder)
    assert holder.stdout.readline().strip() == 'locks-held'
    emit(f'Live holder pid={holder.pid}; 100 settled records retained; locks held for never-escalated and already-closed records.')
    status = state / 'worker.status'
    status.write_text('done: monitoring proof one\nnote: answer = REST \\literal\nnote: routine acknowledgement\n')
    start = time.monotonic(); out = watch(h); elapsed = time.monotonic() - start
    assert 'signal:' in out.stdout and 'worker.status' in out.stdout
    assert holder.poll() is None
    emit(f'Fresh notification surfaced in {elapsed:.3f}s while both correlation locks remained held.')
    queue_before = (state / '.wake-queue').read_bytes()
    d1 = run(['bin/fm-wake-drain.sh'], h)
    assert 'monitoring proof one' in d1.stdout and 'answer = REST \\literal' in d1.stdout and 'routine acknowledgement' in d1.stdout
    assert (state / '.wake-queue').read_bytes() == queue_before
    ack = re.search(r'--ack-through (\d+) --recovery-generation ([A-Za-z0-9._-]+)', d1.stdout + d1.stderr)
    assert ack
    run(['bin/fm-wake-drain.sh', '--ack-through', ack[1], '--recovery-generation', ack[2]], h)
    assert not (state / '.wake-queue').read_text().strip()
    d2 = run(['bin/fm-wake-drain.sh'], h)
    assert 'answer = REST' not in d2.stdout and 'monitoring proof one' not in d2.stdout
    with status.open('a') as f:
        f.write('done: monitoring proof two\nnote: follow-up after acknowledgement\n')
    watch(h)
    d3 = run(['bin/fm-wake-drain.sh'], h)
    assert 'monitoring proof two' in d3.stdout and 'follow-up after acknowledgement' in d3.stdout
    assert 'answer = REST' not in d3.stdout
    assert before == {p.name: digest(p) for p in records.iterdir()}
    assert holder.poll() is None
    holder.communicate('release\n', timeout=10)
    assert holder.returncode == 0
    emit('PASS: two real watcher arms delivered new signals; drain/ack preserved raw rows until acknowledgement, advanced presentation cursors without replay, and retained all 100 records byte-for-byte.')

    emit('LIVE SCENARIO: a resolved escalation missing its closing receipt converges once')
    h = home('close'); state = h / 'state'; (state / 'pending-replies').mkdir()
    corr = 'abcdef0123456789'; rec = state / 'pending-replies' / corr
    rec.write_text(f'corr_id={corr}\ntask_id=mate\nphase=resolved\nescalated_epoch=1\nrequest_summary=proof\nparent_status={state}/mate.status\nresolved_via=status\n')
    status = state / 'mate.status'
    status.write_text(f'blocked [key=pending-reply-{corr}]: pending-reply-missed: task=mate pending-reply-id={corr} request=proof\n')
    (state / 'trigger.status').write_text('done: unrelated new notification\n')
    watch(h)
    assert 'escalation_closed_epoch=' in rec.read_text()
    assert status.read_text().count('pending-reply-resolved:') == 1
    emit('Persisted record:\n' + rec.read_text() + 'Persisted status:\n' + status.read_text())
    snapshot = (rec.read_bytes(), status.read_bytes())
    d = run(['bin/fm-wake-drain.sh'], h)
    assert 'pending-reply-resolved:' in d.stdout and 'OPEN DECISIONS' not in d.stdout
    with (state / 'trigger.status').open('a') as f: f.write('done: another unrelated notification\n')
    watch(h)
    assert snapshot == (rec.read_bytes(), status.read_bytes())
    emit('PASS: real watcher retried the missing close, persisted one receipt, presented the resolution, and did not duplicate or rewrite it on the next arm.')

    emit('LIVE SCENARIO: recover legacy labels without rewriting history or losing captain decisions')
    h = home('history'); state = h / 'state'
    rows = [dict(seq=i, epoch=i, task=task, wake='', verdict=verdict, summary=summary, silent=False) for i, task, verdict, summary in [
        (1, 'task-1', 'routine', 'first'), (2, 'old task label', 'captain', 'retain this decision'),
        (3, '../escape', 'routine', 'path-like historical label'), (4, 'task-2', 'routine', 'last task'),
        (5, 'trailing-newline\n', 'routine', 'newline historical label')]]
    store = state / 'branch-outcomes.jsonl'
    store.write_text(''.join(json.dumps(r) + '\n' for r in rows))
    (state / '.branch-outcomes-cursor').write_text('2\n')
    (state / '.branch-outcomes-processed').write_text('1\n')
    original = digest(store)
    run(['bin/fm-branch-outcome.sh', 'processed-init'], h)
    assert digest(store) == original
    assert (state / '.branch-outcomes-cursor').read_text() == '2\n'
    assert (state / '.branch-outcomes-processed').read_text() == '1\n'
    indexes = sorted(p.name for p in state.glob('.*.branch-outcome-index'))
    assert indexes == ['.task-1.branch-outcome-index', '.task-2.branch-outcome-index'], indexes
    assert (state / '.branch-outcome-index-ready').read_text().strip() == '5'
    emit(f'History SHA256 preserved: {original}; read cursor=2; processed=1; generation=5; derived indexes={indexes}')
    u = run(['bin/fm-branch-outcome.sh', 'unprocessed'], h)
    assert json.loads(u.stdout)['summary'] == 'retain this decision'
    for label in ['new invalid label', '../escape', 'trailing-newline\n']:
        p = run(['bin/fm-branch-outcome.sh', 'append', '--task', label, '--verdict', 'routine', '--summary', 'must refuse'], h, ok=False)
        assert p.returncode != 0 and digest(store) == original
    (state / '.branch-outcome-index-ready').unlink()
    (state / 'fresh.status').write_text('done: new result survives legacy migration\n')
    d = run(['bin/fm-wake-drain.sh'], h)
    assert 'new result survives legacy migration' in d.stdout
    assert (state / '.branch-outcome-index-ready').read_text().strip() == '5'
    assert digest(store) == original
    u = run(['bin/fm-branch-outcome.sh', 'unprocessed'], h)
    assert json.loads(u.stdout)['summary'] == 'retain this decision'
    emit('PASS: both explicit recovery and automatic drain recovery handled legacy labels, preserved history/acknowledgements, exposed the outstanding captain decision, and refused unsafe new labels.')
    emit('ALL LIVE SCENARIOS PASSED; no harness CLI, fake backend, production home, or default session used.')
finally:
    for child in children:
        if child.poll() is None:
            child.communicate('release\n', timeout=10)
    for h in homes:
        shutil.rmtree(h)
    emit('Cleanup: disposable lab homes removed.')
    log.close()
