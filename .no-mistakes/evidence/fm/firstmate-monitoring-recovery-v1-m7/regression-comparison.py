import json, os, pathlib, shutil, signal, subprocess, tempfile, time
ROOT = pathlib.Path.cwd()
BASE = 'ef595d8d4536a44377d537d5e1954a1f61c466c2'
EVIDENCE = pathlib.Path('/Users/cmagana/.no-mistakes/evidence/01M3DK7TM1KSHFF8N8SW9KCZMY')
env = {k:v for k,v in os.environ.items() if not k.startswith('FM_') and k not in ('TMUX', 'TMUX_PANE')}
env['TMPDIR'] = str(ROOT / '.live-test-tmp')
work = pathlib.Path(tempfile.mkdtemp(prefix='regression-', dir=env['TMPDIR']))
log = (EVIDENCE / 'regression-comparison.log').open('w')
holder = None

def emit(s):
    print(s, flush=True); log.write(s + '\n'); log.flush()

try:
    # Only the changed production files differ; dependencies remain at target.
    old = work / 'baseline-bin'
    shutil.copytree(ROOT / 'bin', old)
    for name in ['fm-pending-reply-lib.sh', 'fm-branch-outcome.sh', 'fm-classify-lib.sh']:
        (old / name).write_bytes(subprocess.check_output(['git', 'show', f'{BASE}:bin/{name}'], cwd=ROOT))
    h = work / 'home'
    subprocess.run(['bin/fm-lab-home.sh', 'create', str(h)], cwd=ROOT, env=env, check=True, capture_output=True)
    e = dict(env, FM_HOME=str(h))
    records = h / 'state/pending-replies'; records.mkdir()
    for i in (1,2):
        (records / f'{i:016x}').write_text(f'corr_id={i:016x}\ntask_id=mate\nphase=resolved\n' + ('escalated_epoch=1\nescalation_closed_epoch=2\n' if i == 2 else ''))
    holder = subprocess.Popen(['bash', '-c', '. bin/fm-wake-lib.sh; fm_lock_acquire_wait "$FM_HOME/state/.pending-reply-0000000000000001.lock"; fm_lock_acquire_wait "$FM_HOME/state/.pending-reply-0000000000000002.lock"; echo held; read -r release; fm_lock_release "$FM_HOME/state/.pending-reply-0000000000000001.lock"; fm_lock_release "$FM_HOME/state/.pending-reply-0000000000000002.lock"'], cwd=ROOT, env=e, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    assert holder.stdout.readline().strip() == 'held'
    emit('Comparison: identical settled records, two real held locks, executable pending-reply tick; unchanged dependencies at target.')
    for label, library in [('base', old / 'fm-pending-reply-lib.sh'), ('target', ROOT / 'bin/fm-pending-reply-lib.sh')]:
        start = time.monotonic()
        p = subprocess.Popen(['bash', '-c', '. "$1"; fm_pending_reply_tick "$FM_HOME/state"; echo tick-returned', '_', str(library)], cwd=ROOT, env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            stdout, stderr = p.communicate(timeout=5)
            emit(f'{label}: exit={p.returncode}, elapsed={time.monotonic()-start:.3f}s, stdout={stdout!r}, stderr={stderr!r}')
            assert label == 'target' and p.returncode == 0 and 'tick-returned' in stdout
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGTERM); p.communicate(timeout=5)
            emit(f'{label}: tick remained blocked at 5s while settled-record locks were held; stopped only the test-owned process group.')
            assert label == 'base'
        assert holder.poll() is None
    holder.communicate('release\n', timeout=5)
    store = h / 'state/branch-outcomes.jsonl'
    store.write_text(json.dumps(dict(seq=1, epoch=1, task='old task label', wake='', verdict='captain', summary='retain decision', silent=False)) + '\n')
    (h / 'state/.branch-outcomes-cursor').write_text('1\n')
    (h / 'state/.branch-outcomes-processed').write_text('0\n')
    original = store.read_bytes()
    for label, program in [('base', old / 'fm-branch-outcome.sh'), ('target', ROOT / 'bin/fm-branch-outcome.sh')]:
        p = subprocess.run([str(program), 'processed-init'], cwd=ROOT, env=e, text=True, capture_output=True, timeout=15)
        emit(f'{label} processed-init: exit={p.returncode}, stdout={p.stdout!r}, stderr={p.stderr!r}')
        assert (p.returncode != 0) if label == 'base' else (p.returncode == 0)
        assert store.read_bytes() == original
    emit('PASS: both reported regression mechanisms reproduced before the fix and passed after it; source history bytes remained unchanged.')
finally:
    if holder and holder.poll() is None: holder.communicate('release\n', timeout=5)
    shutil.rmtree(work)
    log.close()
