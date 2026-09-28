import os
import pathlib
import shlex
import signal
import subprocess
import tempfile
import time

ROOT = pathlib.Path.cwd()
LIB = ROOT / 'bin/fm-timeout-lib.sh'
ENV = os.environ.copy()
ENV.pop('FM_EXEC_TIMED_OWNER_PID', None)
ENV.pop('FM_TIMEOUT_MECHANISM_OVERRIDE', None)
ENV['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin'
tracked = set()

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False

def gone(pid):
    end = time.monotonic() + 5
    while alive(pid) and time.monotonic() < end:
        time.sleep(.02)
    print(f'process {pid}: alive={alive(pid)}', flush=True)
    assert not alive(pid)
    tracked.discard(pid)

def readpid(path):
    end = time.monotonic() + 5
    while time.monotonic() < end:
        if path.exists() and path.read_text().strip():
            pid = int(path.read_text().strip())
            tracked.add(pid)
            return pid
        time.sleep(.01)
    raise AssertionError(f'no PID published: {path}')

def run(label, script, args=(), expected=0, env=None):
    argv = ['/bin/bash', '-c', script, '_', str(LIB), *map(str, args)]
    print(f'\n{label}\n$ {shlex.join(argv)}', flush=True)
    start = time.monotonic()
    p = subprocess.run(argv, env=env or ENV, text=True, capture_output=True, timeout=12)
    elapsed = time.monotonic() - start
    print(f'exit={p.returncode}; elapsed={elapsed:.3f}s; stdout={p.stdout!r}; stderr={p.stderr!r}', flush=True)
    assert p.returncode in (expected if isinstance(expected, tuple) else (expected,))
    return p, elapsed

print(subprocess.check_output(['/bin/bash', '--version'], text=True), flush=True)
print(subprocess.check_output(['uname', '-sm'], text=True), flush=True)
print('All product calls use real Bash, Perl, and child processes; no runner stubs.', flush=True)
try:
    with tempfile.TemporaryDirectory(prefix='.timeout-live-', dir=ROOT) as temp:
        d = pathlib.Path(temp)
        base = d / 'base-lib.sh'
        base.write_bytes(subprocess.check_output(['git', 'show', '29213a09322a35d87b2f8acc29c415f3f860cb64:bin/fm-timeout-lib.sh']))
        script = '. "$1"; fm_exec_timed 5 1 /bin/bash -c "echo command-ran"'
        original = subprocess.run(['/bin/bash', '-c', script, '_', str(base)], env=ENV, capture_output=True, text=True)
        print(f'BASE REPRODUCTION: exit={original.returncode}; stdout={original.stdout!r}; stderr={original.stderr!r}', flush=True)
        assert original.returncode != 0 and 'BASHPID: unbound variable' in original.stderr and not original.stdout
        for mode in ['top-level', 'subshell']:
            for code, cmd in [(0, 'echo command-ran; echo command-stderr >&2'), (7, 'echo command-ran; echo command-stderr >&2; exit 7'), (137, 'echo command-ran; echo command-stderr >&2; kill -KILL $$'), (143, 'echo command-ran; echo command-stderr >&2; kill -TERM $$')]:
                call = 'fm_exec_timed 5 1 /bin/bash -c "$2"'
                if mode == 'subshell':
                    call = '( ' + call + ' ); rc=$?; exit "$rc"'
                p, _ = run(f'BASH32 STATUS {mode} {code}', '. "$1"; ' + call, [cmd], code)
                assert p.stdout == 'command-ran\n' and p.stderr == 'command-stderr\n'

        for mode in ['top-level', 'subshell']:
            call = 'echo $$ > "$2"; fm_exec_timed 5 1 /bin/bash -c \'echo parent=$PPID\'' if mode == 'top-level' else '( /usr/bin/perl -e \'print getppid(), "\\n"\' > "$2"; fm_exec_timed 5 1 /bin/bash -c \'echo parent=$PPID\' ); rc=$?; exit "$rc"'
            pidfile = d / ('replace-' + mode)
            p, _ = run(f'EXEC REPLACEMENT {mode}', '. "$1"; ' + call, [pidfile])
            assert p.stdout == f'parent={pidfile.read_text().strip()}\n'
            print('pre-exec shell PID equals bounded command parent PID', flush=True)

        for label, child, grace, minimum in [
            ('cooperative child', 'echo $$ > "$1"; exec /bin/sleep 20', 5, 1),
            ('TERM-ignoring child', 'trap "" TERM; echo $$ > "$1"; exec /bin/sleep 20', 1, 2),
            ('output-holding descendant', '( trap "" TERM; exec /bin/sleep 20 ) & echo $! > "$1"; wait', 5, 1),
        ]:
            pidfile = d / label.replace(' ', '-')
            p, elapsed = run('DEADLINE ' + label, '. "$1"; fm_exec_timed 1 "$2" /bin/bash -c "$3" _ "$4"', [grace, child, pidfile], 124)
            assert minimum <= elapsed < 4
            gone(readpid(pidfile))

        for sig in ['TERM', 'INT', 'HUP']:
            pidfile = d / ('signal-' + sig)
            child = f'trap "echo forwarded-{sig}; exit 3" {sig}; echo $$ > "$1"; while :; do /bin/sleep .1; done'
            argv = ['/bin/bash', '-c', '. "$1"; fm_exec_timed 20 1 /bin/bash -c "$2" _ "$3"', '_', str(LIB), child, str(pidfile)]
            print(f'\nFORWARD {sig}\n$ {shlex.join(argv)}', flush=True)
            watchdog = subprocess.Popen(argv, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            tracked.add(watchdog.pid)
            childpid = readpid(pidfile)
            os.kill(watchdog.pid, getattr(signal, 'SIG' + sig))
            out, err = watchdog.communicate(timeout=5)
            tracked.discard(watchdog.pid)
            print(f'signalled watchdog={watchdog.pid}; child={childpid}; exit={watchdog.returncode}; stdout={out!r}; stderr={err!r}', flush=True)
            assert watchdog.returncode == 3 and out == f'forwarded-{sig}\n'
            gone(childpid)

        # An unrelated process must not be swept up by any ownership escalation.
        sentinel = subprocess.Popen(['/bin/sleep', '30'], env=ENV)
        tracked.add(sentinel.pid)
        for mode in ['top-level', 'subshell']:
            for timing in ['startup', 'running']:
                wdfile = d / (mode + timing + '-watchdog')
                childfile = d / (mode + timing + '-child')
                child = 'echo $$ > "$1"; exec /bin/sleep 20'
                if mode == 'top-level':
                    inner = '. "$1"; echo $$ > "$2"; '
                    if timing == 'startup':
                        inner += 'while kill -0 "$PPID" 2>/dev/null; do /bin/sleep .02; done; '
                    inner += 'fm_exec_timed 20 1 /bin/bash -c "$4" _ "$3"'
                    launcher = '/bin/bash -c "$5" _ "$1" "$2" "$3" "$4" & '
                else:
                    inner = ''
                    launcher = '. "$1"; ( /usr/bin/perl -e \'print getppid(), "\\n"\' > "$2"; '
                    if timing == 'startup':
                        launcher += 'while kill -0 "$$" 2>/dev/null; do /bin/sleep .02; done; '
                    launcher += 'fm_exec_timed 20 1 /bin/bash -c "$4" _ "$3" ) & '
                launcher += 'while :; do /bin/sleep .02; done'
                argv = ['/bin/bash', '-c', launcher, '_', str(LIB), str(wdfile), str(childfile), child, inner]
                print(f'\nOWNER DEATH {mode} {timing}\n$ {shlex.join(argv)}', flush=True)
                parent = subprocess.Popen(argv, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                tracked.add(parent.pid)
                wdpid = readpid(wdfile)
                childpid = readpid(childfile) if timing == 'running' else None
                start = time.monotonic()
                parent.kill()
                # Reap the killed owner before draining descendants' pipes: a zombie
                # still answers kill(0) and would hold our startup barrier open.
                parent.wait(timeout=5)
                tracked.discard(parent.pid)
                out, err = parent.communicate(timeout=5)
                elapsed = time.monotonic() - start
                print(f'killed owner={parent.pid}; watchdog={wdpid}; child={childpid}; drain={elapsed:.3f}s; stdout={out!r}; stderr={err!r}', flush=True)
                gone(wdpid)
                if childfile.exists() and childfile.read_text().strip():
                    gone(readpid(childfile))
                assert sentinel.poll() is None
                print(f'unrelated sentinel={sentinel.pid} remains alive', flush=True)

        dead = subprocess.Popen(['/bin/sleep', '0'])
        dead.wait()
        env = ENV.copy()
        env['FM_EXEC_TIMED_OWNER_PID'] = str(dead.pid)
        p, elapsed = run('EXPLICIT DEAD OWNER', '. "$1"; fm_exec_timed 20 1 /bin/sleep 20', expected=(143, 137), env=env)
        assert elapsed < 3 and sentinel.poll() is None
        sentinel.terminate()
        sentinel.wait()
        tracked.discard(sentinel.pid)

        # Guard failures must never execute the requested command.
        marker = d / 'must-not-run'
        for seconds, grace in [('0', '1'), ('1', '0'), ('01', '1'), ('1', 'x')]:
            p, _ = run('INVALID BOUND', '. "$1"; fm_exec_timed "$2" "$3" /bin/bash -c \'echo ran > "$1"\' _ "$4"', [seconds, grace, marker], 125)
            assert not marker.exists()
        emptybin = d / 'emptybin'
        emptybin.mkdir()
        env = ENV.copy()
        env['PATH'] = str(emptybin)
        p, _ = run('NO BOUNDING BACKEND', '. "$1"; fm_exec_timed 1 1 /bin/bash -c \'echo ran > "$1"\' _ "$2"', [marker], 127, env)
        assert not marker.exists() and 'none of perl, timeout, or gtimeout' in p.stderr
        print('Requested command never executed on refused calls.', flush=True)

        # Existing upstream run_timed signal semantics, without the test suite's timeout stub.
        for status, child in [(0, 'echo completed'), (7, 'exit 7'), (137, 'kill -KILL $$'), (143, 'kill -TERM $$'), (124, 'exec /bin/sleep 20')]:
            run('RUN_TIMED REAL PERL ' + str(status), '. "$1"; fm_run_timed 1 /bin/bash -c "$2"', [child], status)
        print('\nAll manual product scenarios passed; transient inputs cleaned.', flush=True)
finally:
    for pid in tracked:
        if alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
