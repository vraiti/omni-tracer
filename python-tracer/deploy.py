#!/usr/bin/env python3
import os
import shutil
import subprocess
import sys

DIR = os.path.dirname(os.path.abspath(__file__))

def out(cmd):
    print(f"+ {cmd}")
    return subprocess.check_output(cmd, shell=True, cwd=DIR, text=True).strip()

def run(cmd):
    print(f"+ {cmd}")
    subprocess.check_call(cmd, shell=True, cwd=DIR)

head_before = out("git rev-parse HEAD")
run("git pull --recurse-submodules")
head_after = out("git rev-parse HEAD")

if head_before != head_after:
    run("make install")

shutil.copy2(os.path.join(DIR, "run.py"), "/tmp/run.py")
os.chdir("/tmp")
os.execvp("trace-python", ["trace-python", "/tmp/run.py", *sys.argv[1:]])
