#!/usr/bin/env python3
"""Check PE identity/import scope without executing the Windows diagnostic."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    args = parser.parse_args()
    result = subprocess.run(
        ["x86_64-w64-mingw32-objdump", "-p", str(args.executable)],
        check=True, capture_output=True, text=True,
    )
    text = result.stdout
    import_table = text.split("The Import Tables", 1)[-1].split("The Function Table", 1)[0]
    imports = set(re.findall(
        r"^\s+[0-9a-f]+\s+(?:<none>\s+)?[0-9a-f]+\s+(\w+)\s*$",
        import_table, re.MULTILINE,
    ))
    required = {
        "ReadProcessMemory", "OpenProcess", "OpenThread", "CloseHandle",
        "CreateToolhelp32Snapshot", "GetProcAddress", "IsWow64Process",
    }
    forbidden = {
        "WriteProcessMemory", "VirtualAllocEx", "VirtualProtectEx", "CreateRemoteThread",
        "SuspendThread", "ResumeThread", "SetThreadContext", "DebugActiveProcess",
        "AdjustTokenPrivileges", "LoadLibraryA", "LoadLibraryW",
    }
    source = Path(__file__).with_name("probe.c")
    checks = {
        "amd64_pe": "file format pei-x86-64" in text,
        "required_imports": required <= imports,
        "forbidden_imports_absent": not (forbidden & imports),
        "size_limit": args.executable.stat().st_size < 20 * 1024 * 1024,
    }
    print(json.dumps({
        "checks": checks,
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "executable_sha256": hashlib.sha256(args.executable.read_bytes()).hexdigest(),
        "executable_bytes": args.executable.stat().st_size,
        "missing_imports": sorted(required - imports),
        "forbidden_imports": sorted(forbidden & imports),
        "runtime_verified": False,
    }))
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
