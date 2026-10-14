#!/usr/bin/python3
"""Kernel-enforced termination when the trusted supervisor disappears."""
import ctypes
import os
import signal
import sys

expected_parent = int(sys.argv[1])
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
    raise OSError(ctypes.get_errno(), "prctl failed")
if os.getppid() != expected_parent:
    sys.exit(1)
os.execv(sys.argv[2], sys.argv[2:])
