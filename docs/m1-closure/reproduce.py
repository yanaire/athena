#!/usr/bin/env python3
"""Run the frozen M1 checks; raw output stays in the private evidence archive."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root, archive = map(Path, sys.argv[1:3])
ui = root / "athena-backend-handoff/athena-codex-ui"
qa = ui / "qa"
logs = archive / "fresh-checks"
logs.mkdir(mode=0o700, exist_ok=False)
commands = [
    ("install-backend", root, ["npm", "ci"]),
    ("install-qa", qa, ["npm", "ci"]),
    ("typecheck", root, ["npm", "run", "check"]),
    ("build", ui, ["python3", "build.py"]),
    ("backend", root, ["npm", "test"]),
    ("dom", qa, ["npm", "test"]),
    ("contracts", qa, ["node", "--test", "pi-host-adapter-test.mjs",
        "runtime-integrity-test.cjs", "workspace-session-test.cjs",
        "connection-manager-test.cjs", "research-records-test.cjs",
        "workspace-views-test.cjs"]),
]
statuses = []
for name, cwd, argv in commands:
    start = time.time()
    target = logs / (name + ".log")
    with target.open("wb") as handle:
        result = subprocess.run(argv, cwd=cwd, stdout=handle,
                                stderr=subprocess.STDOUT)
    statuses.append(dict(name=name, cwd=str(cwd), argv=argv,
        exitCode=result.returncode, elapsedSeconds=round(time.time()-start, 3),
        log=str(target), sha256=hashlib.sha256(target.read_bytes()).hexdigest()))
    (logs / "statuses.json").write_text(json.dumps(statuses, indent=2) + "\n")
    print("CHECK %s EXIT %s" % (name, result.returncode), flush=True)
sys.exit(0 if all(x["exitCode"] == 0 for x in statuses) else 1)
