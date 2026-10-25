"""Build a relocatable Ubuntu 24.04 browser bundle from the tested browser image.

Run inside local/kin-mailbox-browser-test:20261025; stdout is the tar.gz stream.
No browser profile, account, token or network request is included.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

with tempfile.TemporaryDirectory(prefix='mailbox-bundle-') as temp:
    root = Path(temp)
    source = Path('/opt/kin-mailbox')
    for name in ['venv', 'browsers']:
        shutil.copytree(source / name, root / name, symlinks=True)
    libs = root / 'lib'
    libs.mkdir()
    queue = []
    # NSS loads these via dlopen, so ldd on Chromium alone cannot discover them.
    for pattern in ['libsoftokn3.*', 'libfreebl3.*', 'libfreeblpriv3.*', 'libnssdbm3.*', 'libnssckbi.so']:
        for dep in Path('/usr/lib/x86_64-linux-gnu').glob(pattern):
            shutil.copyfile(dep.resolve(), libs / dep.name)
            if dep.suffix == '.so':
                queue.append(dep)
    shutil.copytree('/usr/share/fonts/truetype', root / 'fonts', symlinks=False)
    (root / 'fonts.conf').write_text('''<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig><dir>/home/kincli/.local/share/kin-mailbox/fonts</dir>
<cachedir>/home/kincli/.local/share/kin-mailbox/cache/fontconfig</cachedir></fontconfig>
''')
    for p in (root / 'browsers').rglob('*'):
        if p.is_file() and not p.is_symlink():
            with p.open('rb') as stream:
                if stream.read(4) == b'\x7fELF':
                    queue.append(p)
    queue.append(root / 'venv/lib/python3.12/site-packages/playwright/driver/node')
    checked = set()
    # Use the guest's libc/loader; all targets use the matching Ubuntu ABI.
    core = re.compile(r'^(?:ld-linux.*|lib(?:c|m|pthread|dl|rt|resolv|util|anl)\.so.*)$')
    while queue:
        binary = queue.pop()
        key = str(binary)
        if key in checked:
            continue
        checked.add(key)
        result = subprocess.run(['ldd', str(binary)], capture_output=True, text=True)
        for line in result.stdout.splitlines():
            match = re.search(r'=>\s+(/\S+)', line)
            if not match:
                continue
            dep = Path(match[1])
            if core.match(dep.name) or (libs / dep.name).exists():
                continue
            shutil.copyfile(dep.resolve(), libs / dep.name)
            os.chmod(libs / dep.name, 0o755)
            queue.append(dep)
    (root / 'portable.json').write_text(json.dumps({'version': '1.64.1', 'revision': 2, 'os': 'ubuntu24.04', 'arch': 'x86_64', 'python': '3.12'}))
    (root / 'ready-1.64.1').touch()
    with tarfile.open(fileobj=sys.stdout.buffer, mode='w|gz', compresslevel=1) as archive:
        for name in ['venv', 'browsers', 'lib', 'fonts', 'fonts.conf', 'portable.json', 'ready-1.64.1']:
            archive.add(root / name, arcname=name)
