#!/bin/sh
set -eu

spike_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compiler=${CC:-cc}

if ! command -v "$compiler" >/dev/null 2>&1; then
	printf '%s\n' "h8 crossover spike core: FAIL (no C compiler: $compiler)" >&2
	exit 1
fi

test_dir=$(mktemp -d "${TMPDIR:-/tmp}/tyrian-h8-crossover.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM

compile_test() {
	"$compiler" -std=c11 -Wall -Wextra -Werror -pedantic \
		-I"$1" "$1/mumble_probe_core.c" "$1/mumble_probe_core_test.c" \
		-o "$2"
}

compile_test "$spike_dir" "$test_dir/core-test"
"$test_dir/core-test"

"$compiler" -std=c11 -Wall -Wextra -Werror -pedantic \
	-fsanitize=address,undefined -fno-omit-frame-pointer \
	-I"$spike_dir" "$spike_dir/mumble_probe_core.c" "$spike_dir/mumble_probe_core_test.c" \
	-o "$test_dir/core-sanitized"
ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=halt_on_error=1 "$test_dir/core-sanitized"
printf '%s\n' 'h8 crossover spike ASan/UBSan: PASS'

"$compiler" -std=c11 -Wall -Wextra -Werror -pedantic -fsyntax-only \
	-I"$spike_dir/test-support" -I"$spike_dir" "$spike_dir/mumble_probe_windows.c"
printf '%s\n' 'h8 crossover spike Windows wrapper syntax: PASS'

"$compiler" -E -P -I"$spike_dir/test-support" -I"$spike_dir" \
	"$spike_dir/mumble_probe_windows.c" > "$test_dir/mumble_probe_windows.i"
node "$spike_dir/validate-preprocessed.mjs" "$test_dir/mumble_probe_windows.i"

run_sabotage() {
	name=$1
	from=$2
	to=$3
	expected=$4
	directory="$test_dir/sabotage-$name"
	mkdir "$directory"
	cp "$spike_dir/mumble_probe_core.c" "$directory/"
	cp "$spike_dir/mumble_probe_core_test.c" "$directory/"
	sed "s/$from/$to/" "$spike_dir/mumble_probe_core.h" > "$directory/mumble_probe_core.h"
	compile_test "$directory" "$directory/core-test"
	if "$directory/core-test" >"$directory/stdout" 2>"$directory/stderr"; then
		printf '%s\n' "h8 crossover spike sabotage: FAIL ($name stayed green)" >&2
		exit 1
	fi
	if ! grep -F "FAIL: $expected" "$directory/stderr" >/dev/null; then
		printf '%s\n' "h8 crossover spike sabotage: FAIL ($name lacked causal assertion)" >&2
		exit 1
	fi
	printf '%s\n' "h8 crossover spike sabotage $name: PASS"
}

run_sabotage map-offset \
	'TC_MUMBLE_CONTEXT_MAP_ID_OFFSET 28u' 'TC_MUMBLE_CONTEXT_MAP_ID_OFFSET 24u' \
	'map id offset is pinned'
run_sabotage view-bytes \
	'TC_MUMBLE_LINK_VIEW_BYTES 5460u' 'TC_MUMBLE_LINK_VIEW_BYTES 5456u' \
	'Mumble Link view size is pinned'
run_sabotage frame-bytes \
	'TC_MUMBLE_MAX_FRAME_BYTES 512u' 'TC_MUMBLE_MAX_FRAME_BYTES 511u' \
	'maximum frame bytes are pinned'
run_sabotage pair-attempts \
	'TC_MUMBLE_SAMPLE_PAIR_ATTEMPTS 8u' 'TC_MUMBLE_SAMPLE_PAIR_ATTEMPTS 7u' \
	'sample pair attempts are pinned'
run_sabotage sequence-maximum \
	'TC_MUMBLE_MAX_SEQUENCE 9007199254740991ULL' \
	'TC_MUMBLE_MAX_SEQUENCE 9007199254740990ULL' \
	'maximum sequence is pinned'
