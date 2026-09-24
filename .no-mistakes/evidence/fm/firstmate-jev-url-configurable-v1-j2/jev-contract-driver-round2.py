"""Bounded resolver contract evidence; synthetic Jev/quota, never inference."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

root = Path.cwd()
evidence = Path(__file__).parent
transcript = []
requests = []
response = {"model": "jev-fixture", "answers": {"rule": {"type": "choice", "choice": "rule_1", "confidence": 0.95, "probabilities": {"rule_1": 0.95, "default": 0.05}}}, "usage": {"input_tokens": 20, "output_tokens": 5}}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        record = {"path": self.path, "request": body, "dummy_bearer_received": self.headers.get('Authorization') == 'Bearer local-dummy'}
        requests.append(record)
        assert record['dummy_bearer_received']
        payload = json.dumps(response).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(payload)

with tempfile.TemporaryDirectory(prefix='manual-', dir=root / '.jev-validation-tmp') as temp:
    home = Path(temp)
    (home / 'config').mkdir()
    (home / 'tools').mkdir()
    (home / 'brief.md').write_text('Fix a pager off-by-one error.\n')
    (home / 'config/crew-dispatch.json').write_text(json.dumps({'rules': [{'when': 'A small bug fix.', 'use': {'harness': 'claude', 'model': 'sonnet', 'effort': 'high'}}]}))
    quota = {'schemaVersion': 5, 'generatedAt': '2030-01-01T00:00:00Z', 'providers': [{'provider': 'claude', 'quotaSemantics': {'status': 'known', 'effectiveAvailability': [{'scope': 'all_models', 'status': 'known', 'effectivePercentRemaining': 80, 'runway': {'status': 'through_reset'}, 'selection': {'spendPriority': 0.5}}]}}]}
    (home / 'tools/quota-axi').write_text('#!/bin/sh\nprintf "%s\\n" '+"'"+json.dumps(quota)+"'\n")
    (home / 'tools/quota-axi').chmod(0o700)
    env = {'PATH': str(home / 'tools') + ':' + os.environ['PATH'], 'HOME': str(home), 'FM_HOME': str(home), 'TMPDIR': str(home), 'NO_PROXY': '*', 'no_proxy': '*', 'LC_ALL': 'C'}
    server = HTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}'

    def run(label, overrides, dotenv=None, expected='clear', path=None):
        dot = home / '.env'
        if dotenv is None:
            dot.unlink(missing_ok=True)
        else:
            dot.write_text(dotenv)
        before = len(requests)
        result = subprocess.run(['bin/fm-dispatch-resolve.sh', str(home / 'brief.md'), '--project', 'pager'], env=env | overrides, text=True, capture_output=True, timeout=15)
        assert result.returncode == 0, result.stderr
        if expected == 'off':
            assert not result.stdout and 'dispatch-resolve: off' in result.stderr
            assert len(requests) == before
        else:
            assert f'  status: {expected}' in result.stdout, result.stdout
        if expected == 'clear':
            assert "profile: --harness 'claude' --model 'sonnet' --effort 'high'" in result.stdout
        if path is not None:
            assert len(requests) == before + 1
            assert requests[-1]['path'] == path
            assert requests[-1]['request']['model'] == 'jev-latest'
            assert requests[-1]['request']['state']['task']['project'] == 'pager'
        assert 'local-dummy' not in result.stdout + result.stderr
        clean = (result.stdout + result.stderr).replace(str(home), '<isolated-home>')
        transcript.append({'scenario': label, 'exit': result.returncode, 'http_requests': len(requests)-before, 'received_path': path, 'output': clean})
        return result

    try:
        for suffix in ['', '/', '/jev/']:
            run('environment base ' + (suffix or '(no suffix)'), {'TYPESAFE_API_KEY': 'local-dummy', 'TYPESAFE_BASE_URL': base+suffix}, path=suffix.rstrip('/')+'/v1/systemone')
        dotenv = f'TYPESAFE_API_KEY=local-dummy\nTYPESAFE_BASE_URL={base}/dotenv/\n'
        run('dotenv base and key', {}, dotenv, path='/dotenv/v1/systemone')
        run('empty environment falls back to dotenv', {'TYPESAFE_BASE_URL': ''}, dotenv, path='/dotenv/v1/systemone')
        run('nonempty environment overrides dotenv', {'TYPESAFE_BASE_URL': base+'/environment'}, dotenv, path='/environment/v1/systemone')
        for override in [base, 'not a URL']:
            run('disabled with base '+('loopback' if override == base else 'malformed'), {'TYPESAFE_BASE_URL': override}, expected='off')
        run('disabled with dotenv base only', {}, f'TYPESAFE_BASE_URL={base}\n', expected='off')
        # Reserve but do not listen: real connection refusal, no fixture response.
        with socket.socket() as refusal:
            refusal.bind(('127.0.0.1', 0))
            failed = run('unreachable override does not fall back', {'TYPESAFE_API_KEY': 'local-dummy', 'TYPESAFE_BASE_URL': f'http://127.0.0.1:{refusal.getsockname()[1]}'}, expected='error')
            assert 'http 000' in failed.stdout and 'profile:' not in failed.stdout
        # Hosted default captured at executable boundary; no external network.
        curl = home / 'tools/curl'
        curl.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/destination-argv"\nexit 7\n')
        curl.chmod(0o700)
        for settings in [{}, {'TYPESAFE_BASE_URL': ''}]:
            run('hosted default destination captured (transport stub)', settings | {'TYPESAFE_API_KEY': 'local-dummy'}, 'TYPESAFE_BASE_URL=\n', expected='error')
            argv = (home / 'destination-argv').read_text().splitlines()
            assert 'https://api.typesafe.ai/v1/systemone' in argv
            assert 'local-dummy' not in '\n'.join(argv)
            transcript[-1]['captured_destination'] = 'https://api.typesafe.ai/v1/systemone'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

(evidence / 'jev-contract-observations-round2.json').write_text(json.dumps({'scope': 'Real resolver and real curl with synthetic local Jev and quota responses; no inference, production credentials, hosted requests or fleet actions.', 'observations': transcript, 'local_requests': requests}, indent=2)+'\n')
for item in transcript:
    print(item['scenario']+': '+item['output'].splitlines()[1 if 'status:' in item['output'] else 0].strip())
print('Local HTTP requests:', len(requests))
