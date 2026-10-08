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
    Only the counters differ, plus `checked` for pointers read inside a record and
    the route notes that --diagnose reports. The notes never change a verdict.
    """

    def __init__(self, ranges, pread, budget=MAX_BYTES):
        self.ranges = ranges
        self.pread = pread
        self.budget = min(budget, MAX_BYTES)
        self.requested = 0
        self.copied = 0
        self.bags = 0
        self.begin()

    def begin(self):
        """Forget the previous sample's route notes."""
        self.stage = None
        self.passed = []
        self.fault = None
        self.observed = None

    def step(self, name):
        """Name the hop about to be read; the previous one is thereby passed."""
        if self.stage and self.stage not in self.passed:
            self.passed.append(self.stage)
        self.stage = name

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

    @staticmethod
    def aligned(value, content):
        """Heap objects sit on 8 bytes; game content sits 4 past a multiple of 8.

        From the live diagnose runs of 2026-10-08 on this build: the 16 bag items passed the
        8-byte check, their 32 content pointers failed it, and all 278 content pointers the
        Magic Find probe measured ended in 4. See the README.
        """
        return value & 7 == (PROFILE['content_pointer_remainder'] if content else 0)

    def classify(self, value, content=False):
        """Why a pointer value is unusable, or None; the value itself is never reported."""
        if not value:
            return 'null'
        if not 0x10000 <= value <= MAX_ADDRESS:
            return 'out_of_user_range'
        if not self.aligned(value, content):
            return 'unaligned'
        if not any(start <= value < end for start, end in self.ranges):
            return 'unmapped'
        return None

    def content(self, value):
        """Validate a pointer into game content: an item definition or its bag payload."""
        return self.checked(value, content=True)

    def checked(self, value, content=False):
        """Validate a pointer value that was already read as part of a larger record."""
        fault = self.classify(value, content)
        if fault:
            self.fault = fault
            raise Rejected('unmapped_pointer' if fault == 'unmapped' else 'null_or_invalid_pointer')
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
    value = reader.pointer(address)
    if value != expected:
        reader.observed = value
        raise Rejected(reason)


def require_slots(reader, base):
    """Every dispatch slot the counter goes through must still select its guarded code."""
    for slot in PROFILE['slots']:
        require_pointer(reader, base + PROFILE[slot['vtable']] + slot['slot'],
                        base + slot['target_rva'], slot['target'] + '_slot')


def owner_route(reader, base, context, prefix=''):
    """Context -> controlled character -> its inventory, the route of the inventory reader."""
    mark = 'recheck_' if prefix else ''
    reader.step(mark + 'context_to_chcli')
    char_context = reader.pointer(context + 0x98)
    require_pointer(reader, char_context, base + PROFILE['char_context_vtable'], prefix + 'character_context_vtable')
    reader.step(mark + 'character')
    character = reader.pointer(char_context + 0x98)
    require_pointer(reader, character + 8, base + PROFILE['character_agent_vtable'], prefix + 'character_agent_vtable')
    reader.step(mark + 'inventory')
    inventory = reader.pointer(character + 0x3F0)
    require_pointer(reader, inventory, base + PROFILE['inventory_vtable'], prefix + 'inventory_vtable')
    return char_context, character, inventory


def bag_size(reader, base, item, index):
    """One equipped bag: item -> definition -> bag payload -> size."""
    reader.step(f'bag_pointer[{index}]')
    reader.checked(item)
    reader.step(f'bag_item_vtable[{index}]')
    require_pointer(reader, item, base + PROFILE['bag_item_vtable'], 'bag_item_vtable')
    reader.step(f'bag_definition[{index}]')
    definition = reader.content(reader.scalar(item + 0x40, 8))
    _type_id, item_type, payload = struct.unpack('<IIQ', reader.read(definition + 0x28, 16))
    if item_type != PROFILE['bag_item_type']:
        raise Rejected('bag_definition_type')
    reader.step(f'bag_size[{index}]')
    size = reader.scalar(reader.content(payload) + 0x28, 4)
    if size > PROFILE['bag_size_max']:
        raise Rejected('bag_size_bounds')
    reader.bags += 1
    return size


def capacity_snapshot(reader, base, context):
    """Add the equipped bags' sizes, then recheck the owner, the slot count and the bag list."""
    owner = owner_route(reader, base, context)
    _char_context, character, inventory = owner
    reader.step('dispatch_slots')
    require_slots(reader, base)
    reader.step('controlled_flag')
    if not reader.scalar(character + 0x178, 4) & 0x10:
        raise Rejected('controlled_character_flag')
    reader.step('inventory_owner')
    if reader.pointer(inventory + 0x70) != character:
        raise Rejected('inventory_owner_mismatch')
    reader.step('bag_slot_count')
    slot_count = reader.scalar(inventory + 0x440, 4)
    if slot_count > BAGS:
        raise Rejected('bag_slot_count_bounds')
    reader.step('bag_pointers')
    bags = reader.read(inventory + 0x380, 8 * BAGS)
    sizes = [bag_size(reader, base, item, index)
             for index, item in enumerate(struct.unpack(f'<{BAGS}Q', bags)[:slot_count]) if item]
    if (owner_route(reader, base, context, 'concurrent_') != owner
            or reader.pointer(inventory + 0x70) != character
            or reader.scalar(inventory + 0x440, 4) != slot_count
            or reader.read(inventory + 0x380, 8 * BAGS) != bags):
        raise Rejected('concurrent_bag_change')
    reader.step('done')
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


def module_rva(base, value):
    """An address inside the game image as an RVA, which names code and not player data."""
    return value - base if base <= value < base + PROFILE['image_size'] else None


def bag_survey(reader, base, context):
    """Diagnose only: class and size of every bag slot, accepting any item class whose
    definition getter dispatches to the guarded one. Never feeds the verdict."""
    survey = dict(bags=[])
    try:
        _char_context, _character, inventory = owner_route(reader, base, context)
        survey['bag_slot_count'] = slot_count = reader.scalar(inventory + 0x440, 4)
        getter = base + next(slot['target_rva'] for slot in PROFILE['slots']
                             if slot['target'] == 'item_definition_getter')
        known = {entry['vtable']: entry['name'] for entry in PROFILE['bag_item_vtable_candidates']}
        dispatch = {}
        for index, item in enumerate(struct.unpack(f'<{BAGS}Q', reader.read(inventory + 0x380, 8 * BAGS))):
            row = dict(index=index, present=bool(item))
            survey['bags'].append(row)
            if not item:
                continue
            row['pointer'] = reader.classify(item) or 'ok'
            if row['pointer'] not in ('ok', 'unaligned'):
                continue
            vtable = reader.scalar(item, 8)
            row['vtable_rva'] = rva = module_rva(base, vtable)
            row['vtable_in_module'] = rva is not None
            if rva is None:
                continue
            row['vtable_is_active'] = rva == PROFILE['bag_item_vtable']
            row['candidate_class'] = known.get(rva)
            if vtable not in dispatch:
                dispatch[vtable] = reader.scalar(vtable + 8, 8) == getter
            row['definition_getter_dispatch'] = dispatch[vtable]
            if not dispatch[vtable]:
                continue
            definition = reader.scalar(item + 0x40, 8)
            row['definition_pointer'] = reader.classify(definition, content=True) or 'ok'
            row['definition_low_bits'] = definition & 7
            if row['definition_pointer'] not in ('ok', 'unaligned'):
                continue
            _type_id, row['definition_type'], payload = struct.unpack('<IIQ', reader.read(definition + 0x28, 16))
            row['payload_pointer'] = reader.classify(payload, content=True) or 'ok'
            row['payload_low_bits'] = payload & 7
            if row['definition_type'] == PROFILE['bag_item_type'] and row['payload_pointer'] in ('ok', 'unaligned'):
                row['size'] = reader.scalar(payload + 0x28, 4)
        survey['distinct_vtables'] = len({row['vtable_rva'] for row in survey['bags'] if row.get('vtable_rva')})
        counted = [row for row in survey['bags'][:slot_count] if row['present']] if slot_count <= BAGS else None
        if counted is not None and all(row.get('size', BAGS * 99) <= PROFILE['bag_size_max'] for row in counted):
            survey['hypothetical_capacity_if_dispatch_accepted'] = sum(row['size'] for row in counted)
    except (Rejected, OSError) as error:
        survey['error'] = str(error) if isinstance(error, Rejected) else 'read_failed'
    return survey


def observe_diagnosed(reader, base, context):
    """The normal verdict plus where the route stopped and what the bag slots hold."""
    reader.begin()
    result, owner = observe(reader, base, context)
    result['diagnose'] = True
    result['passed'] = list(reader.passed)
    if result['status'] == 'unknown':
        result['stage'] = reader.stage
        if reader.fault:
            result['pointer_fault'] = reader.fault
        if reader.observed is not None:
            result['observed_rva'] = module_rva(base, reader.observed)
            result['observed_in_module'] = result['observed_rva'] is not None
    result['survey'] = bag_survey(reader, base, context)
    return result, owner


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
    parser.add_argument('--diagnose', action='store_true',
                        help='add the route stage, vtable RVAs and a per-bag survey; same reads budget')
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
                result, owner = (observe_diagnosed if args.diagnose else observe)(
                    reader, args.module_base, args.context)
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
