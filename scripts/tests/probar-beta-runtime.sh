#!/usr/bin/env bash
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
failures=0

if ! node "${repo_root}/scripts/tests/probar-beta-runtime.mjs"; then
	printf '%s\n' 'FAIL: beta runtime cases failed'
	failures=$((failures + 1))
fi

negative_root="$(mktemp -d)"
trap 'rm -rf "${negative_root}"' EXIT
printf '%s\n' 'export function verifyBetaRuntime() { return { diskVersion: "0.1.4", registeredVersion: "0.1.4", runtimeVersion: "0.1.4" }; }' > "${negative_root}/always-green.mjs"
if TYRIAN_RUNTIME_VERIFIER="${negative_root}/always-green.mjs" node "${repo_root}/scripts/tests/probar-beta-runtime.mjs" >/dev/null 2>&1; then
	printf '%s\n' 'FAIL: negative control stayed green with the verifier replaced by exit 0'
	failures=$((failures + 1))
else
	printf '%s\n' 'beta runtime negative control: RED as expected'
fi

if (( failures > 0 )); then
	exit 1
fi
printf '%s\n' 'beta runtime suite: PASS'
