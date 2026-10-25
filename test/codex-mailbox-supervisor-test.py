import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(os.environ['MAILBOX_SUPERVISOR_SOURCE']).read_text()


class SupervisorTests(unittest.TestCase):
    def launch(self, job):
        child = subprocess.Popen(['python3', '-u', '-c', SOURCE], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def cleanup():
            if child.poll() is None:
                child.kill();child.wait(timeout=5)
            for stream in [child.stdin, child.stdout, child.stderr]:
                if stream and not stream.closed:
                    stream.close()
        self.addCleanup(cleanup)
        child.stdin.write(json.dumps(job) + '\n')
        child.stdin.flush()
        return child

    def event(self, child):
        import select
        if not select.select([child.stdout], [], [], 5)[0]:
            self.fail('Supervisor or child did not emit an event')
        return json.loads(child.stdout.readline())

    def test_prepare_and_control_forwarding(self):
        child = self.launch({'action': 'prepare', 'bootstrap': 'true'})
        self.assertEqual(self.event(child), {'event': 'prepared', 'ok': True})
        self.assertEqual(child.wait(timeout=5), 0)
        runner = "import json,sys; p=json.loads(sys.stdin.readline()); print(json.dumps({'event':'ready','value':p['fixture']}),flush=True); c=json.loads(sys.stdin.readline());print(json.dumps({'event':'control','value':c['verification_code']}),flush=True)"
        child = self.launch({'action': 'login', 'runner': runner, 'payload': {'fixture': 'input-via-stdin'}})
        self.assertEqual(self.event(child)['value'], 'input-via-stdin')
        child.stdin.write(json.dumps({'verification_code': 'fixture123'}) + '\n');child.stdin.flush()
        self.assertEqual(self.event(child)['value'], 'fixture123')
        self.assertEqual(child.wait(timeout=5), 0)

    def process_alive(self, pid):
        try:
            # A reaped process or zombie has no running browser/network work.
            return Path(f'/proc/{pid}/stat').read_text().split()[2] != 'Z'
        except FileNotFoundError:
            return False

    def test_cancel_and_lost_control_pipe_terminate_process_group(self):
        runner = "import json,subprocess,sys,time;json.loads(sys.stdin.readline());c=subprocess.Popen(['sleep','300']);print(json.dumps({'event':'ready','pid':c.pid}),flush=True);time.sleep(300)"
        for cancel in [True, False]:
            child = self.launch({'action': 'login', 'runner': runner, 'payload': {}})
            pid = self.event(child)['pid']
            self.assertTrue(self.process_alive(pid))
            if cancel:
                child.stdin.write('{"cancel":true}\n');child.stdin.flush()
            else:
                child.stdin.close()
            self.assertEqual(child.wait(timeout=12), 130)
            for _ in range(30):
                if not self.process_alive(pid):
                    break
                time.sleep(.1)
            self.assertFalse(self.process_alive(pid))


if __name__ == '__main__':
    unittest.main(verbosity=2)
