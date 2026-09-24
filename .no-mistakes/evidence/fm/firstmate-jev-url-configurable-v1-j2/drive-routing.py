"""Real resolver/curl against Python's ordinary HTTP server (not a Jev implementation).
Proves routing and error handling, NOT successful Jev inference.
All operational files remain in the explicitly supplied worktree.
"""
import functools
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time

root = Path(sys.argv[1])
evidence = Path(__file__).parent
scratch = root / '.test-jev-validation/live'
home = scratch / 'home'
brief = scratch / 'brief.md'
brief.write_text('# Task\nCheck an isolated synthetic pager bug.\n')
(home / 'config/crew-dispatch.json').write_text(json.dumps({'rules': [
    {'when': 'A simple bug fix.', 'use': {'harness': 'claude'}}]}))
requests = []
class ObservedHTTPServer(http.server.SimpleHTTPRequestHandler):
    # Leave HTTP behavior untouched: standard http.server rejects POST with 501.
    def log_message(self, fmt, *args):
        pass
    def log_request(self, code='-', size='-'):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        requests.append({'method': self.command, 'path': self.path,
                         'status': code,
                         'dummy_bearer_received': self.headers.get('Authorization') == 'Bearer local-validation-only',
                         'body': json.loads(body) if body else None})

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(ObservedHTTPServer, directory=str(home)))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base = f'http://127.0.0.1:{server.server_port}'
env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'FM_HOME': str(home),
       'TMPDIR': str(scratch / 'tmp'), 'LC_ALL': 'C', 'NO_PROXY': '*', 'no_proxy': '*',
       'CURL_HOME': str(home)}
records = []
def run(name, base_url=None, dotenv=None, key=True, expected_path=None, expected_error=None, off=False):
    dotenv_path = home / '.env'
    if dotenv is None:
        dotenv_path.unlink(missing_ok=True)
    else:
        dotenv_path.write_text('TYPESAFE_BASE_URL=' + dotenv + '\n')
    process_env = dict(env)
    if key:
        process_env['TYPESAFE_API_KEY'] = 'local-validation-only'
    if base_url is not None:
        process_env['TYPESAFE_BASE_URL'] = base_url
    before = len(requests)
    start = time.monotonic()
    result = subprocess.run([str(root / 'bin/fm-dispatch-resolve.sh'), str(brief), '--project', 'synthetic-validation'],
                            env=process_env, text=True, capture_output=True, timeout=30)
    elapsed = time.monotonic() - start
    actual = requests[before:]
    record = {'scenario': name, 'base_environment': base_url, 'base_dotenv': dotenv,
              'credential': 'dummy' if key else 'absent', 'exit_code': result.returncode,
              'stdout': result.stdout, 'stderr': result.stderr, 'elapsed_seconds': round(elapsed, 3),
              'observed_http_requests': actual}
    records.append(record)
    (evidence / 'routing-transcript.json').write_text(json.dumps(records, indent=2) + '\n')
    print(json.dumps(record), flush=True)
    assert result.returncode == 0, name
    assert 'local-validation-only' not in result.stdout + result.stderr, name
    if expected_path is not None:
        assert len(actual) == 1 and actual[0]['path'] == expected_path, name
        assert actual[0]['dummy_bearer_received'] and actual[0]['body']['model'] == 'jev-latest', name
        assert 'status: error' in result.stdout and 'http 501' in result.stdout, name
        assert 'profile:' not in result.stdout, name
    if off:
        assert not actual and not result.stdout and 'dispatch-resolve: off' in result.stderr, name
    if expected_error:
        assert 'status: error' in result.stdout and expected_error in result.stdout, name
        assert 'profile:' not in result.stdout, name
    return record

try:
    run('Environment URL reaches local root endpoint', base, expected_path='/v1/systemone')
    run('Trailing slash does not double the endpoint separator', base + '/', expected_path='/v1/systemone')
    run('Base path prefix survives endpoint construction', base + '/jev/', expected_path='/jev/v1/systemone')
    run('Dotenv URL supplies endpoint when environment is absent', dotenv='"' + base + '/dotenv/"', expected_path='/dotenv/v1/systemone')
    run('Empty environment URL falls back to dotenv', '', dotenv=base + '/dotenv', expected_path='/dotenv/v1/systemone')
    run('Nonempty environment URL overrides conflicting dotenv', base + '/env', dotenv=base + '/wrong', expected_path='/env/v1/systemone')
    run('Environment URL alone cannot enable dispatch', base, key=False, off=True)
    run('Dotenv URL alone cannot enable dispatch', dotenv=base + '/dotenv', key=False, off=True)
    run('Malformed URL without a credential stays disabled', '://invalid', key=False, off=True)
    # Reserve a non-listening local port: deterministic connection refusal without another service.
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        run('Unavailable local service returns an error without a profile', f'http://127.0.0.1:{sock.getsockname()[1]}', expected_error='http 000')
    # Real hosted request uses only a synthetic brief and deliberately invalid credential.
    run('Absent URL retains the hosted default', expected_error='http 401')
    run('Empty URL settings retain the hosted default', '', dotenv='""', expected_error='http 401')
finally:
    server.shutdown()
    server.server_close()
    thread.join()
