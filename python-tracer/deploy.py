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
python = os.path.join(DIR, "cpython", "python")
os.execvp(python, [python, os.path.join(DIR, "run.py"), *sys.argv[1:]])
