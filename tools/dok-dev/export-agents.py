#!/usr/bin/env python3
"""Export committed, reviewed portable agent knowledge as a tar stream.

No credentials, untracked files, pending/rejected proposals or symlinks are read.
The export is a release snapshot; edits belong in the owning ~/.agents Git repo.
"""
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tarfile

root = pathlib.Path(sys.argv[1]).expanduser()
revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
entries = subprocess.check_output(['git', '-C', str(root), 'ls-tree', '-r', revision], text=True).splitlines()
allowed = ('agents/helper.md', 'agents/workflow.md', 'agents/vm.md', 'agents/tikkytracker.md', 'agent-skills/workflow-context/',
           'evals/helper/', 'evals/workflow/', 'memory/shared/', 'memory/projects/dev-workflow/', 'memory/agents/workflow/',
           'memory/projects/vm/', 'memory/projects/tikkytracker/', 'memory/agents/vm/', 'memory/agents/tikkytracker/')
files = {}
for entry in entries:
    metadata, name = entry.split('\t', 1)
    if metadata.split()[0] != '100644' or not any(name == p or p.endswith('/') and name.startswith(p) for p in allowed):
        continue
    if '__pycache__' in name or not name.endswith(('.md', '.py', '.json')):
        continue
    files[name] = subprocess.check_output(['git', '-C', str(root), 'show', f'{revision}:{name}'])
manifest = {'source_revision': revision, 'agents': ['helper', 'workflow', 'vm', 'tikkytracker'],
            'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
files['RELEASE.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as archive:
    for name, data in files.items():
        info = tarfile.TarInfo(name)
        info.size, info.mode = len(data), 0o600
        archive.addfile(info, io.BytesIO(data))
