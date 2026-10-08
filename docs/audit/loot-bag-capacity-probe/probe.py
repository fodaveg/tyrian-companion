#!/usr/bin/env python3
"""Sum the sizes of the controlled character's equipped bags, as the inventory window does.

Read-only diagnostic, not a production profile or proof of the displayed total.
The client keeps no capacity field: its counter adds each equipped bag's size, and
this follows the same bags. The caller supplies a fresh context from the trusted
TEB/TLS probe.
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
BAGS = PROFILE['bags_max']
UNPROVEN = dict(live_value_proven=False, capacity_semantics_proven=False)


class Rejected(ValueError):
    """A closed diagnostic reason; rejected observations never mean zero."""


class Reader:
    """Exact bounded reads, injected for fixtures; no scans or writes.

    Copied from docs/audit/loot-wallet-probe/probe.py (sha256 f8f090f9...d4009b).
    Only the counters differ, plus `checked` for pointers read inside a record.
    """

    def __init__(self, ranges, pread, budget=MAX_BYTES):
        self.ranges = ranges
        self.pread = pread
        self.budget = min(budget, MAX_BYTES)
        self.requested = 0
        self.copied = 0
        self.bags = 0

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

    def checked(self, value):
        """Validate a pointer value that was already read as part of a larger record."""
        if not value or value & 7 or not 0x10000 <= value <= MAX_ADDRESS:
            raise Rejected('null_or_invalid_pointer')
        if not any(start <= value < end for start, end in self.ranges):
            raise Rejected('unmapped_pointer')
        return value

    def pointer(self, address):
        return self.checked(self.scalar(address, 8))


def guard_profile(reader, base):
    """Check only fixed code ranges; a mismatch invalidates the candidate."""
    for guard in PROFILE['guards']:
        data = reader.read(base + guard['rva'], guard['size'])
        if hashlib.sha256(data).hexdigest() != guard['sha256']:
            raise Rejected('static_guard_' + guard['name'])


def require_pointer(reader, address, expected, reason):
    if reader.pointer(address) != expected:
        raise Rejected(reason)


def require_slots(reader, base):
    """Every dispatch slot the counter goes through must still select its guarded code."""
    for slot in PROFILE['slots']:
        require_pointer(reader, base + PROFILE[slot['vtable']] + slot['slot'],
                        base + slot['target_rva'], slot['target'] + '_slot')


def owner_route(reader, base, context, prefix=''):
    """Context -> controlled character -> its inventory, the route of the inventory reader."""
    char_context = reader.pointer(context + 0x98)
    require_pointer(reader, char_context, base + PROFILE['char_context_vtable'], prefix + 'character_context_vtable')
    character = reader.pointer(char_context + 0x98)
    require_pointer(reader, character + 8, base + PROFILE['character_agent_vtable'], prefix + 'character_agent_vtable')
    inventory = reader.pointer(character + 0x3F0)
    require_pointer(reader, inventory, base + PROFILE['inventory_vtable'], prefix + 'inventory_vtable')
    return char_context, character, inventory


def bag_size(reader, base, item):
    """One equipped bag: item -> definition -> bag payload -> size."""
    require_pointer(reader, reader.checked(item), base + PROFILE['bag_item_vtable'], 'bag_item_vtable')
    definition = reader.pointer(item + 0x40)
    _type_id, item_type, payload = struct.unpack('<IIQ', reader.read(definition + 0x28, 16))
    if item_type != PROFILE['bag_item_type']:
        raise Rejected('bag_definition_type')
    size = reader.scalar(reader.checked(payload) + 0x28, 4)
    if size > PROFILE['bag_size_max']:
        raise Rejected('bag_size_bounds')
    reader.bags += 1
    return size


def capacity_snapshot(reader, base, context):
    """Add the equipped bags' sizes, then recheck the owner, the slot count and the bag list."""
    owner = owner_route(reader, base, context)
    _char_context, character, inventory = owner
    require_slots(reader, base)
    if not reader.scalar(character + 0x178, 4) & 0x10:
        raise Rejected('controlled_character_flag')
    if reader.pointer(inventory + 0x70) != character:
        raise Rejected('inventory_owner_mismatch')
    slot_count = reader.scalar(inventory + 0x440, 4)
    if slot_count > BAGS:
        raise Rejected('bag_slot_count_bounds')
    bags = reader.read(inventory + 0x380, 8 * BAGS)
    sizes = [bag_size(reader, base, item) for item in struct.unpack(f'<{BAGS}Q', bags)[:slot_count] if item]
    if (owner_route(reader, base, context, 'concurrent_') != owner
            or reader.pointer(inventory + 0x70) != character
            or reader.scalar(inventory + 0x440, 4) != slot_count
            or reader.read(inventory + 0x380, 8 * BAGS) != bags):
        raise Rejected('concurrent_bag_change')
    return dict(candidate_capacity_slots=sum(sizes), bag_slot_count=slot_count, bags_equipped=len(sizes)), owner


def observe(reader, base, context):
    """Project only the summed candidate or a closed unknown reason."""
    try:
        values, owner = capacity_snapshot(reader, base, context)
        return dict(status='candidate_bag_capacity', **values, **UNPROVEN), owner
    except (Rejected, OSError) as error:
        return (dict(status='unknown', candidate_capacity_slots=None,
                     reason=str(error) if isinstance(error, Rejected) else 'read_failed',
                     errno=getattr(error, 'errno', None), **UNPROVEN), None)


def prepare_process(pid, supplied_base):
    """Validate the mapped file and supplied base before opening any process memory.

    Copied from docs/audit/loot-wallet-probe/probe.py; validated live there on 2026-10-07.
    """
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
                    value = result['candidate_capacity_slots']
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
        print(json.dumps(dict(status='unknown', candidate_capacity_slots=None,
                              reason=str(error) if isinstance(error, Rejected) else 'prepare_or_read_failed',
                              errno=getattr(error, 'errno', None), **UNPROVEN)), flush=True)
        exit_code = 2
    print(json.dumps(dict(event='summary', bytes_requested=reader.requested if reader else 0,
                          bytes_read=reader.copied if reader else 0,
                          bags_read=reader.bags if reader else 0, byte_limit=MAX_BYTES,
                          game_writes=0, live_value_proven=False)), flush=True)
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
