#!/usr/bin/env python3
import os
import subprocess
import sys

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPTS_DIR)

def out(cmd):
    print(f"+ {cmd}")
    return subprocess.check_output(cmd, shell=True, cwd=PROJECT_DIR, text=True).strip()

def run(cmd):
    print(f"+ {cmd}")
    subprocess.check_call(cmd, shell=True, cwd=PROJECT_DIR)

head_before = out("git rev-parse HEAD")
run("git pull --recurse-submodules")
head_after = out("git rev-parse HEAD")

if head_before != head_after:
    run("make install")

run_py = os.path.join(SCRIPTS_DIR, "run.py")
os.execvp("trace-python", ["trace-python", run_py, *sys.argv[1:]])
