#!/usr/bin/env python3
"""Read-only diagnostic: whole wallet map of the guarded route versus the account API wallet.

Reuses the repo probe's Reader, guards and hash; only the byte budget is raised so the
wallet's own table (capacity x 12 bytes) can be read once. No heap scan, no writes.
"""
import argparse
import json
import os
import struct
import sys
import time

BUDGET = 64 * 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe-dir', required=True)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--module-base', type=lambda s: int(s, 0), required=True)
    parser.add_argument('--context', type=lambda s: int(s, 0), required=True)
    parser.add_argument('--api-wallet', required=True)
    args = parser.parse_args()
    sys.path.insert(0, args.probe_dir)
    import probe
    probe.MAX_BYTES = BUDGET
    profile = probe.PROFILE
    base = args.module_base
    api = {row['id']: row['value'] for row in json.load(open(args.api_wallet))}

    ranges = probe.prepare_process(args.pid, base)
    fd = os.open(f'/proc/{args.pid}/mem', os.O_RDONLY)
    try:
        reader = probe.Reader(ranges, lambda size, address: os.pread(fd, size, address), budget=BUDGET)
        probe.guard_profile(reader, base)
        guard = next(g for g in profile['guards'] if g['name'] == 'hash_table')
        table = struct.unpack('<256I', reader.read(base + guard['rva'], guard['size']))

        def route():
            char_context = reader.pointer(args.context + 0x98)
            probe.require_pointer(reader, char_context, base + profile['char_context_vtable'], 'character_context_vtable')
            character = reader.pointer(char_context + 0xA0)
            probe.require_pointer(reader, character, base + profile['character_vtable'], 'wallet_character_vtable')
            manager = character + 0x1878
            probe.require_pointer(reader, manager, base + profile['currency_manager_vtable'], 'currency_manager_vtable')
            return char_context, character, manager, reader.read(manager + 8, 16)

        owner_before = route()
        capacity, count, entries = struct.unpack('<IIQ', owner_before[3])
        if not 0 < capacity <= probe.MAX_CAPACITY or capacity & (capacity - 1) or count > capacity:
            raise probe.Rejected('currency_map_bounds')
        raw = b''
        total = capacity * 12
        while len(raw) < total:
            raw += reader.read(entries + len(raw), min(1020, total - len(raw)))
        if route() != owner_before:
            raise probe.Rejected('concurrent_wallet_change')
    finally:
        os.close(fd)

    native = {}
    bad_hash = []
    misplaced = []
    for bucket in range(capacity):
        key, value, occupied = struct.unpack_from('<III', raw, bucket * 12)
        if not occupied:
            continue
        if probe.currency_hash(key, table) != occupied:
            bad_hash.append(key)
            continue
        # Linear probing: every bucket from the home slot up to this one must be occupied.
        home = occupied & (capacity - 1)
        step = home
        reachable = True
        while step != bucket:
            if not struct.unpack_from('<I', raw, step * 12 + 8)[0]:
                reachable = False
                break
            step = (step + 1) & (capacity - 1)
        if not reachable:
            misplaced.append(key)
        native[key] = value

    equal = sorted(k for k in api if native.get(k) == api[k])
    differ = sorted((k, native[k], api[k]) for k in api if k in native and native[k] != api[k])
    api_only = sorted(k for k in api if k not in native)
    native_only = sorted((k, native[k]) for k in native if k not in api)
    print(json.dumps(dict(
        time_ns=time.time_ns(), capacity=capacity, count=count, occupied=len(native) + len(bad_hash),
        bytes_requested=reader.requested, bytes_read=reader.copied, game_writes=0,
        hash_mismatch_keys=bad_hash, unreachable_keys=misplaced,
        api_currencies=len(api), equal=len(equal), equal_ids=equal,
        differ=differ, api_only=api_only, native_only=native_only), indent=1))


if __name__ == '__main__':
    main()
