# H8.2 CrossOver read-only spike

This directory is a non-production engineering spike. Nothing under `spikes/` is imported by the
Obsidian plugin or included in its release package. The probe opens the existing `MumbleLink` named
mapping with `FILE_MAP_READ`, reads only `uiVersion`, `uiTick`, `context_len` and `context.mapId`,
waits 1.5 seconds and writes one bounded H8.1 JSON frame to standard output. It does not enumerate a
process, inject code, read process memory, send input, open a socket or persist data.

## Automated evidence available now

Run the portable decoder, malformed-layout fixtures and causal wrong-offset sabotage with:

```sh
spikes/h8-mumble-crossover/test-host.sh
```

The host gate compiles the core normally and under ASan/UBSan, syntax-checks the Windows wrapper,
preprocesses that wrapper with the same compiler/stub and validates the expanded access/name/view,
injects same-tick/hybrid-map and repeated word-tearing reads, and sabotages the pinned map offset,
5,460-byte view, 512-byte frame, eight sample pairs and `9007199254740991` sequence maximum. The
architecture test also censuses the exact spike, core/wrapper calls and sinks, Windows stub and host
script. It requires exactly one read-only mapping open and view and rejects numeric `0x0002`, write
mapping permissions, Toolhelp/process/private-memory APIs, alternate sinks, personal/spatial fields,
network, persistence, logs, Wine/CrossOver execution and copies outside the owned temporary directory
without changing the production scanner. C calls and arguments are extracted lexically, so good
forms hidden in comments or string literals cannot excuse real decimal `2u` write access or a
redirected output sink. The whole host script is held to a byte-for-byte positive contract with exact
temporary write destinations; adding any command, including alternate `cp` forms, turns the gate red.
The wrapper preprocessor is also positive-only: one harmless lean-Windows define and the five exact
includes. Undefining or redefining mapping access, the mapping name, the view size, or adding a
contractual alias fails even when the write bit is spelled `(1u << 1)`.
Exact hashes pin the wrapper, runtime header, Windows stub and preprocessed validator. Causal tests
redefine values from each header and through `%:` digraphs and line-splicing; the compiler accepts
the constructs, then the validator rejects their effective expansion.

The reader uses naturally aligned `uint32_t` word loads and accepts only two identical complete
`version/tick/context_len/mapId` candidates, retrying at most eight pairs. This is a best-effort race
filter, **not a seqlock or a coherent snapshot guarantee**: an uncooperative writer could expose the
same hybrid candidate twice. H8 remains shadow and API-authoritative. These tests do **not** prove
that CrossOver exposes the mapping during a real Guild Wars 2 session and do not open or modify a
bottle.

## Build prerequisite still missing on the inspected Mac

The inspected host has Apple Clang, but no existing MinGW/LLVM Windows cross-compiler. CrossOver
26.3.0 and the existing 64-bit `Guild Wars 2` bottle were detected read-only. Do not install a
toolchain or copy a binary into that bottle as part of this spike.

Once an approved x86-64 MinGW compiler is available, build outside the bottle:

```sh
mkdir -p /tmp/tyrian-h8-probe
x86_64-w64-mingw32-gcc -std=c11 -Os -Wall -Wextra -Werror \
  spikes/h8-mumble-crossover/mumble_probe_core.c \
  spikes/h8-mumble-crossover/mumble_probe_windows.c \
  -o /tmp/tyrian-h8-probe/tyrian-mumble-probe.exe
```

## Human QA command for a later real session

Only after David has started Guild Wars 2 in the existing bottle and approved the probe, generate a
fresh 128-bit nonce without saving it and execute the binary in the **same** bottle:

```sh
probe_nonce=$(openssl rand -hex 16)
'/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine' \
  --bottle 'Guild Wars 2' --no-update --no-gui --wait \
  --cx-app /tmp/tyrian-h8-probe/tyrian-mumble-probe.exe \
  --nonce "$probe_nonce"
unset probe_nonce
```

The expected success is exactly one JSON line with keys `version`, `nonce`, `sequence`, `tick`,
`mapId` and `activity`; `sequence` is `0`, and `activity` is only `link_advancing` or
`link_stalled`. For the Labyrinth, `mapId` must be `866`. No output containing identity, character,
coordinates, process identifiers or raw context is acceptable. A generic error or no mapping is a
failed/inconclusive QA result, never permission to switch to process inspection.

## Linux with Steam/Proton — executed 2026-08-19

This is the primary platform and the spike has been run there. Build the PE on the host with
`mingw64-gcc` and launch it from outside the prefix; nothing is installed into or copied inside the
prefix:

```sh
mkdir -p /tmp/tyrian-h8-probe
x86_64-w64-mingw32-gcc -std=c11 -Os -Wall -Wextra -Werror \
  spikes/h8-mumble-crossover/mumble_probe_core.c \
  spikes/h8-mumble-crossover/mumble_probe_windows.c \
  -o /tmp/tyrian-h8-probe/tyrian-mumble-probe.exe

probe_nonce=$(openssl rand -hex 16)
STEAM_COMPAT_DATA_PATH="$HOME/.steam/steam/steamapps/compatdata/1284210" \
  protontricks-launch --appid 1284210 \
  /tmp/tyrian-h8-probe/tyrian-mumble-probe.exe --nonce "$probe_nonce"
unset probe_nonce
```

Recorded result on Fedora Linux 44 with GE-Proton11-5: twenty samples across two runs, each with a
distinct nonce echoed intact, `sequence` `0`, `activity` `link_advancing` and a strictly increasing
`uiTick` with no repeated pair; `mapId` followed a zone change (`1442`→`1595`) and `uiTick` reset from
16,962 to 572 across a game restart, which ties the signal to the live process. No frame carried
identity, character, coordinates, process identifiers or raw context.

The negative control passed. With the game closed, ten runs emitted no frame; this wrapper prints
nothing on failure and reports only through its exit code, so one further run without a pipe and
without suppressed stderr recorded that code: `exit=2`, `TC_MUMBLE_PROBE_VIEW_TOO_SMALL`, what the
wrapper returns when `OpenFileMappingW` yields `NULL`. That run's stderr shows the wine loader
starting, so the empty output is not a failed launch. Running the same PE with no arguments returned
`exit=1` (`TC_MUMBLE_PROBE_INVALID_ARGUMENT`), which proves `protontricks-launch` propagates the PE's
own exit code rather than substituting one of its own.

Twenty clean samples do not refute the residual risk of two identical hybrid reads: it was not
observed, which is not the same as being impossible.

macOS/CrossOver, native Windows and stock Valve Proton remain unexecuted. This spike must not be
wired to `src/`, the plugin scanner allowlist or release packaging.
