#!/usr/bin/env python3
"""Probe only currency 45 in the statically identified wallet candidate.

Read-only diagnostic, not a production profile or proof of currency identity.
The caller supplies a fresh context from the trusted TEB/TLS probe.
"""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import struct
import time

ROOT = Path(__file__).resolve().parent
PROFILE = json.loads((ROOT / 'profile.json').read_text())
MAX_ADDRESS = 0x00007FFFFFFFFFFF
MAX_BYTES = 4096
MAX_CAPACITY = 4096
MAX_BUCKETS = 16


class Rejected(ValueError):
    """A closed diagnostic reason; rejected observations never mean zero."""


class Reader:
    """Exact bounded reads, injected for fixtures; no scans or writes."""

    def __init__(self, ranges, pread, budget=MAX_BYTES):
        self.ranges = ranges
        self.pread = pread
        self.budget = min(budget, MAX_BYTES)
        self.requested = 0
        self.copied = 0
        self.buckets = 0

    def read(self, address, size):
        if not 0x10000 <= address <= MAX_ADDRESS or not 0 < size <= 1024:
            raise Rejected('address_or_size')
        if address + size > MAX_ADDRESS + 1:
            raise Rejected('address_overflow')
        if self.requested + size > self.budget:
            raise Rejected('byte_budget')
        if not any(start <= address and address + size <= end for start, end in self.ranges):
            raise Rejected('mapping_range')
        self.requested += size
        data = self.pread(size, address)
        self.copied += len(data)
        if len(data) != size:
            raise OSError(errno.EIO, 'short_read')
        return data

    def scalar(self, address, size):
        return int.from_bytes(self.read(address, size), 'little')

    def pointer(self, address):
        value = self.scalar(address, 8)
        if not value or value & 7 or not 0x10000 <= value <= MAX_ADDRESS:
            raise Rejected('null_or_invalid_pointer')
        if not any(start <= value < end for start, end in self.ranges):
            raise Rejected('unmapped_pointer')
        return value


def currency_hash(key, table):
    """Reproduce the byte-verified map lookup's unsigned 32-bit key hash."""
    value = ((table[key & 255] ^ table[50] ^ 0xC9747A) + 0x325D1EAE) & 0xFFFFFFFF
    for shift in (8, 16, 24):
        value = ((table[value >> 24] ^ table[(key >> shift) & 255] ^ (value >> 6)) + value) & 0xFFFFFFFF
    return value or 0x3ADE68B1


def guard_profile(reader, base):
    """Check only fixed code/table ranges; a mismatch invalidates the candidate."""
    table = None
    for guard in PROFILE['guards']:
        data = reader.read(base + guard['rva'], guard['size'])
        if hashlib.sha256(data).hexdigest() != guard['sha256']:
            raise Rejected('static_guard_' + guard['name'])
        if guard['name'] == 'hash_table':
            table = struct.unpack('<256I', data)
    if table is None or currency_hash(PROFILE['currency_id'], table) != PROFILE['currency_hash']:
        raise Rejected('currency_hash_profile')


def require_pointer(reader, address, expected, reason):
    if reader.pointer(address) != expected:
        raise Rejected(reason)


def wallet_snapshot(reader, base, context):
    """Read a sparse keyed candidate, then recheck its owner, header and value."""
    char_context = reader.pointer(context + 0x98)
    require_pointer(reader, char_context, base + PROFILE['char_context_vtable'], 'character_context_vtable')
    require_pointer(reader, base + PROFILE['char_context_vtable'] + 0x70,
                    base + PROFILE['char_context_getter'], 'local_character_getter')
    # Wallet UI uses +A0. The controlled-inventory wrapper at +98 is different.
    character = reader.pointer(char_context + 0xA0)
    require_pointer(reader, character, base + PROFILE['character_vtable'], 'wallet_character_vtable')
    require_pointer(reader, base + PROFILE['character_vtable'] + 0x250,
                    base + PROFILE['character_wallet_getter'], 'wallet_manager_getter')
    manager = character + 0x1878
    require_pointer(reader, manager, base + PROFILE['currency_manager_vtable'], 'currency_manager_vtable')
    require_pointer(reader, base + PROFILE['currency_manager_vtable'],
                    base + PROFILE['balance_getter'], 'balance_getter')
    header = reader.read(manager + 8, 16)
    capacity, count, entries = struct.unpack('<IIQ', header)
    if not 0 < capacity <= MAX_CAPACITY or capacity & (capacity - 1) or count > capacity:
        raise Rejected('currency_map_bounds')
    if not entries or entries & 7 or not 0x10000 <= entries <= MAX_ADDRESS:
        raise Rejected('currency_map_pointer')
    if not count:
        raise Rejected('currency_key_unobserved')
    target_hash = PROFILE['currency_hash']
    selected = None
    observed = None
    # Reserve one 12-byte read for the selected bucket's consistency check.
    for step in range(min(capacity, MAX_BUCKETS - 1)):
        bucket = (target_hash + step) & (capacity - 1)
        address = entries + 12 * bucket
        data = reader.read(address, 12)
        reader.buckets += 1
        key, value, occupied_hash = struct.unpack('<III', data)
        if not occupied_hash:
            raise Rejected('currency_key_unobserved')
        if key == PROFILE['currency_id'] and occupied_hash != target_hash:
            raise Rejected('currency_key_hash_mismatch')
        if key == PROFILE['currency_id'] and occupied_hash == target_hash:
            selected, observed = address, data
            break
    if selected is None:
        raise Rejected('currency_bucket_limit')
    if (reader.pointer(context + 0x98) != char_context
            or reader.pointer(char_context + 0xA0) != character
            or reader.read(manager + 8, 16) != header):
        raise Rejected('concurrent_wallet_change')
    reader.buckets += 1
    if reader.read(selected, 12) != observed:
        raise Rejected('concurrent_wallet_change')
    # Recheck type identities as well as pointer values, not merely the header.
    require_pointer(reader, char_context, base + PROFILE['char_context_vtable'], 'concurrent_context_vtable')
    require_pointer(reader, character, base + PROFILE['character_vtable'], 'concurrent_character_vtable')
    require_pointer(reader, manager, base + PROFILE['currency_manager_vtable'], 'concurrent_manager_vtable')
    return struct.unpack('<III', observed)[1], (char_context, character, manager)


def observe(reader, base, context):
    """Project only the targeted candidate balance or a closed unknown reason."""
    try:
        value, owner = wallet_snapshot(reader, base, context)
        return (dict(status='candidate_balance', currency_id=45, candidate_value=value,
                     native_key_mapping_proven=False, acquisition_proven=False), owner)
    except (Rejected, OSError) as error:
        return (dict(status='unknown', currency_id=45, candidate_value=None,
                     reason=str(error) if isinstance(error, Rejected) else 'read_failed',
                     errno=getattr(error, 'errno', None),
                     native_key_mapping_proven=False, acquisition_proven=False), None)


def prepare_process(pid, supplied_base):
    """Validate the mapped file and supplied base before opening any process memory."""
    records = [line.split(maxsplit=5) for line in Path(f'/proc/{pid}/maps').read_text().splitlines()]
    ranges = [tuple(int(value, 16) for value in row[0].split('-')) for row in records if 'r' in row[1]]
    modules = [row for row in records if len(row) == 6
               and row[5].endswith('/Guild Wars 2/Gw2-64.exe') and int(row[2], 16) == 0]
    if len(modules) != 1:
        raise Rejected('module_mapping')
    module = modules[0]
    actual_base = int(module[0].split('-')[0], 16)
    if actual_base != supplied_base:
        raise Rejected('module_base_mismatch')
    with open(module[5], 'rb') as binary:
        if hashlib.file_digest(binary, 'sha256').hexdigest() != PROFILE['binary_sha256']:
            raise Rejected('binary_candidate')
        binary.seek(0x3C)
        pe_offset = int.from_bytes(binary.read(4), 'little')
        binary.seek(pe_offset)
        if binary.read(6) != b'PE\0\0\x64\x86':
            raise Rejected('binary_architecture')
    return ranges


def parse_pointer(text):
    value = int(text, 0)
    if not 0x10000 <= value <= MAX_ADDRESS or value & 7:
        raise argparse.ArgumentTypeError('expected aligned x64 user pointer')
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', type=int, required=True, help='Linux PID, not Windows PID')
    parser.add_argument('--module-base', type=parse_pointer, required=True)
    parser.add_argument('--context', type=parse_pointer, required=True)
    parser.add_argument('--samples', type=int, default=1, choices=(1, 2))
    parser.add_argument('--interval', type=float, default=1)
    args = parser.parse_args()
    if not 0 < args.pid <= 0x7FFFFFFF or not 0.1 <= args.interval <= 30:
        parser.error('PID or interval outside limits')
    reader = None
    exit_code = 0
    try:
        ranges = prepare_process(args.pid, args.module_base)
        fd = os.open(f'/proc/{args.pid}/mem', os.O_RDONLY)
        try:
            reader = Reader(ranges, lambda size, address: os.pread(fd, size, address))
            guard_profile(reader, args.module_base)
            previous = None
            previous_owner = None
            for index in range(args.samples):
                result, owner = observe(reader, args.module_base, args.context)
                result['sample'] = index
                result['time_ns'] = time.time_ns()
                if result['status'] == 'unknown':
                    previous = None
                    previous_owner = None
                    exit_code = 2
                else:
                    value = result['candidate_value']
                    if previous is not None and previous_owner == owner:
                        result['candidate_net_change'] = value - previous
                    elif previous_owner is not None:
                        result['continuity'] = 'owner_changed'
                    previous = value
                    previous_owner = owner
                print(json.dumps(result), flush=True)
                if index + 1 < args.samples:
                    time.sleep(args.interval)
        finally:
            os.close(fd)
    except (Rejected, OSError) as error:
        print(json.dumps(dict(status='unknown', currency_id=45, candidate_value=None,
                              reason=str(error) if isinstance(error, Rejected) else 'prepare_or_read_failed',
                              errno=getattr(error, 'errno', None), acquisition_proven=False)), flush=True)
        exit_code = 2
    print(json.dumps(dict(event='summary', bytes_requested=reader.requested if reader else 0,
                          bytes_read=reader.copied if reader else 0,
                          buckets_read=reader.buckets if reader else 0, byte_limit=MAX_BYTES,
                          game_writes=0, acquisition_proven=False)), flush=True)
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
