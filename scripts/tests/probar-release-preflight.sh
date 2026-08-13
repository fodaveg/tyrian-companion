#!/usr/bin/env bash
set -uo pipefail

failures=0
suite_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
guardrail="${RELEASE_PREFLIGHT_UNDER_TEST:-${repo_root}/scripts/release-preflight.mjs}"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/tyrian-release-preflight.XXXXXX")" || {
	printf '%s\n' "FAIL: could not create an isolated temporary test root" >&2
	exit 1
}

cleanup() {
	case "${test_root}" in
		"${TMPDIR:-/tmp}"/tyrian-release-preflight.*) /bin/rm -rf "${test_root}" ;;
		*) printf '%s\n' "FAIL: temporary test root was not safe to remove" >&2 ;;
	esac
}
trap cleanup EXIT

fail() {
	failures=$((failures + 1))
	printf '%s\n' "FAIL: ${1}" >&2
}

assert_output() {
	local actual_file="${1}"
	local expected="${2}"
	local actual
	actual="$(<"${actual_file}")"
	if [[ "${actual}" != "${expected}" ]]; then
		fail "output did not match the category-only summary"
	fi
}

initialize_repo() {
	local target="${1}"
	mkdir -p "${target}"
	git -C "${target}" init -q -b main || return 1
	git -C "${target}" config user.name "Release Preflight Test" || return 1
	git -C "${target}" config user.email "release-preflight@example.invalid" || return 1
	printf '%s\n' "baseline" > "${target}/tracked.txt"
	git -C "${target}" add tracked.txt || return 1
	git -C "${target}" commit -q -m "baseline" || return 1
}

run_guardrail() {
	local target="${1}"
	local output_file="${2}"
	(
		cd "${target}" || exit 125
		node "${guardrail}"
	) > "${output_file}" 2>&1
}

clean_repo="${test_root}/clean"
if ! initialize_repo "${clean_repo}"; then
	fail "could not initialize the clean control repository"
elif run_guardrail "${clean_repo}" "${test_root}/clean.out"; then
	assert_output \
		"${test_root}/clean.out" \
		"release preflight: pass (untracked=0 unstaged=0 staged=0; HEAD attached)"
else
	fail "clean attached HEAD without upstream was rejected"
fi

unborn_repo="${test_root}/unborn"
if ! mkdir -p "${unborn_repo}" || ! git -C "${unborn_repo}" init -q -b main; then
	fail "could not initialize the unborn-HEAD repository"
elif run_guardrail "${unborn_repo}" "${test_root}/unborn.out"; then
	fail "a clean unborn HEAD was accepted"
else
	assert_output \
		"${test_root}/unborn.out" \
		"release preflight: fail (untracked=0 unstaged=0 staged=0; HEAD missing)"
	unborn_output="$(<"${test_root}/unborn.out")"
	printf '%s\n' "PASS: unborn repository turned red: ${unborn_output}"
fi

dirty_repo="${test_root}/dirty"
if ! initialize_repo "${dirty_repo}"; then
	fail "could not initialize the dirty control repository"
else
	printf '%s\n' "do not expose this filename or content" > "${dirty_repo}/safe-sabotage.txt"
	if run_guardrail "${dirty_repo}" "${test_root}/dirty.out"; then
		fail "an untracked file was accepted"
	else
		assert_output \
			"${test_root}/dirty.out" \
			"release preflight: fail (untracked=1 unstaged=0 staged=0; HEAD attached)"
		dirty_output="$(<"${test_root}/dirty.out")"
		if [[ "${dirty_output}" == *safe-sabotage* || "${dirty_output}" == *"do not expose"* ]]; then
			fail "dirty output exposed a path or file content"
		else
			printf '%s\n' "PASS: sabotage turned red: ${dirty_output}"
		fi
	fi
	/bin/rm -f "${dirty_repo}/safe-sabotage.txt"
	if [[ -e "${dirty_repo}/safe-sabotage.txt" ]]; then
		fail "the explicit sabotage file was not removed"
	elif run_guardrail "${dirty_repo}" "${test_root}/restored.out"; then
		assert_output \
			"${test_root}/restored.out" \
			"release preflight: pass (untracked=0 unstaged=0 staged=0; HEAD attached)"
		restored_output="$(<"${test_root}/restored.out")"
		printf '%s\n' "PASS: explicit restore turned green: ${restored_output}"
	else
		fail "the dirty repository stayed red after removing only the sabotage file"
	fi
fi

mixed_repo="${test_root}/mixed"
if ! initialize_repo "${mixed_repo}"; then
	fail "could not initialize the mixed-state repository"
else
	printf '%s\n' "staged" > "${mixed_repo}/tracked.txt"
	git -C "${mixed_repo}" add tracked.txt || fail "could not stage the mixed-state fixture"
	printf '%s\n' "unstaged after staged" > "${mixed_repo}/tracked.txt"
	printf '%s\n' "untracked" > "${mixed_repo}/safe-sabotage.txt"
	if run_guardrail "${mixed_repo}" "${test_root}/mixed.out"; then
		fail "mixed staged, unstaged and untracked changes were accepted"
	else
		assert_output \
			"${test_root}/mixed.out" \
			"release preflight: fail (untracked=1 unstaged=1 staged=1; HEAD attached)"
	fi
fi

detached_repo="${test_root}/detached"
if ! initialize_repo "${detached_repo}"; then
	fail "could not initialize the detached-HEAD repository"
elif ! git -C "${detached_repo}" checkout -q --detach; then
	fail "could not detach HEAD for the negative case"
elif run_guardrail "${detached_repo}" "${test_root}/detached.out"; then
	fail "a clean detached HEAD was accepted"
else
	assert_output \
		"${test_root}/detached.out" \
		"release preflight: fail (untracked=0 unstaged=0 staged=0; HEAD detached)"
fi

if [[ "${RELEASE_PREFLIGHT_NEGATIVE_CONTROL:-0}" != "1" ]]; then
	stub="${test_root}/always-green.mjs"
	printf '%s\n' 'process.exit(0);' > "${stub}"
	if RELEASE_PREFLIGHT_NEGATIVE_CONTROL=1 \
		RELEASE_PREFLIGHT_UNDER_TEST="${stub}" \
		bash "${suite_path}" > "${test_root}/negative-control.out" 2>&1; then
		fail "negative control stayed green after replacing the preflight with exit 0"
	else
		printf '%s\n' "PASS: negative control turned red with an always-green preflight"
	fi
fi

if (( failures > 0 )); then
	printf '%s\n' "release preflight suite: ${failures} failure(s)" >&2
	exit 1
fi

printf '%s\n' "release preflight suite: PASS"
exit 0
