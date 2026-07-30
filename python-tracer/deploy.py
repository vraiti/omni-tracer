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
run_py = os.path.join(DIR, "run.py")
os.chdir("/tmp")
os.execvp("trace-python", ["trace-python", run_py, *sys.argv[1:]])
