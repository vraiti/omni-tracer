#!/usr/bin/env python3
import os
import subprocess
import sys

DIR = os.path.dirname(os.path.abspath(__file__))

def run(cmd, **kw):
    print(f"+ {cmd}")
    subprocess.check_call(cmd, shell=True, cwd=DIR, **kw)

run("git pull --recurse-submodules")
run("make install")
import shutil
shutil.copy2(os.path.join(DIR, "run.py"), "/tmp/run.py")
os.chdir("/tmp")
os.execvp("trace-python", ["trace-python", "/tmp/run.py", *sys.argv[1:]])
