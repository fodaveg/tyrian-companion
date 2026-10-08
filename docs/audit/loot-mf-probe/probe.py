#!/usr/bin/env python3
"""Recompose the hero panel's Magic Find candidate from stored inputs only.

Read-only diagnostic, not a production profile or proof of the displayed value.
The client keeps no total: its attribute widget sums three stored addends, and
this follows the same ones. The caller supplies a fresh context from the trusted
TEB/TLS probe.
"""
import argparse
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import time

ROOT = Path(__file__).resolve().parent
PROFILE = json.loads((ROOT / 'profile.json').read_text())
MAX_ADDRESS = 0x00007FFFFFFFFFFF
MAX_BYTES = 65536
MAX_CAPACITY = 512
MAX_MODIFIERS = 32
MAX_PUSHED = 256
MAX_LUCK_LEVEL = 1000
MAX_PLAYER_ID = 0xFFFF
MAX_ABS_PERCENT = 10000.0
BUCKET_SIZE = 24
PUSHED_SIZE = 12
MODIFIER_SIZE = 72
# type, formula, base, a, b, game mode, target, requirement, flags, requirement, condition x2
MODIFIER_FORMAT = '<II3fIQQI4xQQQ'
UNPROVEN = dict(live_value_proven=False, total_semantics_proven=False, game_cap_applied=False)


class Rejected(ValueError):
    """A closed diagnostic reason; rejected observations never mean zero."""


class Reader:
    """Exact bounded reads, injected for fixtures; no scans or writes.

    Copied from docs/audit/loot-wallet-probe/probe.py (sha256 f8f090f9...d4009b).
    Only the counters differ, plus `block` and `checked` for tables read in one go.
    """

    def __init__(self, ranges, pread, budget=MAX_BYTES):
        self.ranges = ranges
        self.pread = pread
        self.budget = min(budget, MAX_BYTES)
        self.requested = 0
        self.copied = 0
        self.buffs = 0
        self.definitions = 0

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

    def block(self, address, size):
        """A table the game owns as one array, fetched as exact bounded requests."""
        data = b''
        while len(data) < size:
            data += self.read(address + len(data), min(1008, size - len(data)))
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


def key_hash(key, table):
    """The engine's unsigned 32-bit key hash; same code as the wallet probe's currency_hash."""
    value = ((table[key & 255] ^ table[50] ^ 0xC9747A) + 0x325D1EAE) & 0xFFFFFFFF
    for shift in (8, 16, 24):
        value = ((table[value >> 24] ^ table[(key >> shift) & 255] ^ (value >> 6)) + value) & 0xFFFFFFFF
    return value or 0x3ADE68B1


def float32(value):
    """The client accumulates in single precision; keep the same rounding."""
    return struct.unpack('<f', struct.pack('<f', value))[0]


def guard_profile(reader, base):
    """Check only fixed code/table ranges; a mismatch invalidates the candidate."""
    table = None
    for guard in PROFILE['guards']:
        data = reader.block(base + guard['rva'], guard['size'])
        if hashlib.sha256(data).hexdigest() != guard['sha256']:
            raise Rejected('static_guard_' + guard['name'])
        if guard['name'] == 'hash_table':
            table = struct.unpack('<256I', data)
    if table is None:
        raise Rejected('hash_table_profile')
    return table


def require_pointer(reader, address, expected, reason):
    if reader.pointer(address) != expected:
        raise Rejected(reason)


def require_slots(reader, base):
    """Every dispatch slot the widget goes through must still select its guarded code."""
    for slot in PROFILE['slots']:
        require_pointer(reader, base + PROFILE[slot['vtable']] + slot['slot'],
                        base + slot['target_rva'], slot['target'] + '_slot')


def owner_route(reader, base, context, prefix=''):
    """Context -> controlled character, local player and the character's buff manager."""
    char_context = reader.pointer(context + 0x98)
    require_pointer(reader, char_context, base + PROFILE['char_context_vtable'], prefix + 'character_context_vtable')
    character = reader.pointer(char_context + 0x98)
    require_pointer(reader, character, base + PROFILE['character_vtable'], prefix + 'character_vtable')
    player = reader.pointer(char_context + 0xA0)
    require_pointer(reader, player, base + PROFILE['player_vtable'], prefix + 'player_vtable')
    require_pointer(reader, player + 0x9700, base + PROFILE['player_stats_vtable'], prefix + 'player_stats_vtable')
    manager = reader.pointer(character + 0xD0)
    require_pointer(reader, manager, base + PROFILE['buff_manager_vtable'], prefix + 'buff_manager_vtable')
    return char_context, character, player, manager


def require_local_player(reader, base, char_context, character, player):
    """The widget resolves the player from the character's id; it must be the local one."""
    if not reader.scalar(character + 0x178, 4) & 0x10:
        raise Rejected('controlled_character_flag')
    require_pointer(reader, character + 8, base + PROFILE['character_agent_vtable'], 'character_agent_vtable')
    require_pointer(reader, character + 0x40, base + PROFILE['combatant_vtable'], 'combatant_vtable')
    agent = reader.scalar(character + 0xA0, 4)
    if agent & 0xF0000000 != 0x30000000:
        raise Rejected('character_not_player')
    player_id = reader.scalar(character + 0x220, 4) or agent - 0x30000000
    if not 0 < player_id <= MAX_PLAYER_ID or player_id >= reader.scalar(char_context + 0x8C, 4):
        raise Rejected('player_id_bounds')
    if reader.pointer(reader.pointer(char_context + 0x80) + 8 * player_id) != player:
        raise Rejected('local_player_mismatch')


def read_definition(reader, definition):
    """Flags, stacking, category and the modifier records of one buff definition."""
    head = reader.read(reader.checked(definition), 0x30)
    flags, stacking, category = (struct.unpack_from('<I', head, offset)[0] for offset in (0x4, 0xC, 0x18))
    groups, group_count = struct.unpack_from('<QI', head, 0x20)
    if not group_count:
        raise Rejected('buff_definition_bounds')
    modifiers, count = struct.unpack('<QI', reader.read(reader.checked(groups) + 0x10, 12))
    if count > MAX_MODIFIERS:
        raise Rejected('buff_modifier_bounds')
    raw = reader.block(reader.checked(modifiers), count * MODIFIER_SIZE) if count else b''
    reader.definitions += 1
    return flags, stacking, category, [struct.unpack_from(MODIFIER_FORMAT, raw, index * MODIFIER_SIZE)
                                       for index in range(count)]


def modifier_value(modifiers, wanted):
    """One definition's contribution, or a rejection when the client would need live state."""
    total = 0.0
    for kind, formula, base_value, _a, _b, mode, target, need_a, flags, need_b, when_a, when_b in modifiers:
        if kind != wanted:
            continue
        if target:
            continue  # the widget passes no target, so the client skips these too
        if mode:
            raise Rejected('modifier_game_mode_condition')
        if need_a or need_b or when_a or when_b:
            raise Rejected('modifier_requirement_condition')
        if flags & 0x1E:
            raise Rejected('modifier_state_condition')
        if formula != PROFILE['constant_formula']:
            raise Rejected('modifier_formula_unsupported')
        if not math.isfinite(base_value) or abs(base_value) > MAX_ABS_PERCENT:
            raise Rejected('modifier_value_bounds')
        total = float32(total + base_value)
        if flags & 1:
            break
    return total


def buff_total(buffs, wanted):
    """Sum over applied buffs as the client does: one per effect unless it stacks by intensity."""
    seen = set()
    total = 0.0
    for effect, (_flags, stacking, _category, modifiers) in buffs:
        if stacking != 4 and effect in seen:
            continue
        seen.add(effect)
        total = float32(total + modifier_value(modifiers, wanted))
    return total


def pushed_total(entries, wanted):
    return math.fsum(value for kind, value, _source in entries if kind == wanted)


def magic_find_snapshot(reader, base, context, table):
    """Read the three stored addends, then recheck every owner, header and table."""
    owner = owner_route(reader, base, context)
    char_context, character, player, manager = owner
    require_slots(reader, base)
    require_local_player(reader, base, char_context, character, player)
    luck = reader.read(player + 0x9700 + 0x18, 16)
    level = struct.unpack('<4I', luck)[3]
    if level > MAX_LUCK_LEVEL:
        raise Rejected('account_luck_bounds')
    table_header = reader.read(manager + 0x20, 16)
    pushed_header = reader.read(manager + 0xD8, 16)
    hidden_mode = reader.scalar(manager + 0xF0, 4)

    pushed_at, _pushed_capacity, pushed_count = struct.unpack('<QII', pushed_header)
    if pushed_count > MAX_PUSHED:
        raise Rejected('pushed_table_bounds')
    pushed_raw = reader.block(reader.checked(pushed_at), pushed_count * PUSHED_SIZE) if pushed_count else b''
    pushed = [struct.unpack_from('<IfI', pushed_raw, index * PUSHED_SIZE) for index in range(pushed_count)]
    if any(later[0] < earlier[0] for earlier, later in zip(pushed, pushed[1:])):
        raise Rejected('pushed_table_unsorted')
    if any(not math.isfinite(value) or abs(value) > MAX_ABS_PERCENT for _kind, value, _source in pushed):
        raise Rejected('pushed_value_bounds')

    capacity, count, entries = struct.unpack('<IIQ', table_header)
    buckets = b''
    buffs = []
    if count:
        if not 0 < capacity <= MAX_CAPACITY or capacity & (capacity - 1) or count > capacity:
            raise Rejected('buff_table_bounds')
        buckets = reader.block(reader.checked(entries), capacity * BUCKET_SIZE)
    definitions = {}
    occupied = 0
    for index in range(len(buckets) // BUCKET_SIZE):
        key, node, bucket_hash = struct.unpack_from('<I4xQI', buckets, index * BUCKET_SIZE)
        if not bucket_hash:
            continue
        if bucket_hash != key_hash(key, table):
            raise Rejected('buff_bucket_hash')
        occupied += 1
        instance, instance_key = struct.unpack('<QI', reader.read(reader.checked(node) + 0x10, 12))
        if instance_key != key:
            raise Rejected('buff_instance_key')
        effect = reader.scalar(reader.checked(instance) + 0x28, 4)
        state, definition = struct.unpack('<I4xQ', reader.read(instance + 0x58, 16))
        if state != 1:
            raise Rejected('buff_definition_unresolved')
        if definition not in definitions:
            definitions[definition] = read_definition(reader, definition)
        reader.buffs += 1
        # buff_filter: in this manager mode the client hides definitions flagged 0x40.
        if hidden_mode == 1 and definitions[definition][0] & 0x40:
            continue
        buffs.append((effect, definitions[definition]))
    if occupied != count:
        raise Rejected('buff_count_mismatch')

    kind = PROFILE['magic_find_modifier']
    from_pushed = pushed_total(pushed, kind)
    from_buffs = buff_total(buffs, kind)
    # RewardCreatureAllBoon only counts while some applied buff has category 0.
    with_boon = any(category == 0 for _effect, (_flags, _stacking, category, _modifiers) in buffs)
    if with_boon:
        boon = PROFILE['magic_find_boon_modifier']
        from_pushed += pushed_total(pushed, boon)
        from_buffs = float32(from_buffs + buff_total(buffs, boon))

    if (owner_route(reader, base, context, 'concurrent_') != owner
            or reader.read(player + 0x9700 + 0x18, 16) != luck
            or reader.read(manager + 0x20, 16) != table_header
            or reader.read(manager + 0xD8, 16) != pushed_header
            or reader.scalar(manager + 0xF0, 4) != hidden_mode
            or (pushed_raw and reader.block(pushed_at, len(pushed_raw)) != pushed_raw)
            or (buckets and reader.block(entries, len(buckets)) != buckets)):
        raise Rejected('concurrent_magic_find_change')
    total = float32(float32(from_pushed + from_buffs) + level)
    return dict(candidate_total_percent=round(total, 3), account_luck_percent=level,
                pushed_modifier_percent=round(from_pushed, 3), buff_modifier_percent=round(from_buffs, 3),
                boon_modifier_included=with_boon), owner


def observe(reader, base, context, table):
    """Project only the recomposed candidate or a closed unknown reason."""
    try:
        values, owner = magic_find_snapshot(reader, base, context, table)
        return dict(status='candidate_magic_find', **values, **UNPROVEN), owner
    except (Rejected, OSError) as error:
        return (dict(status='unknown', candidate_total_percent=None,
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
            table = guard_profile(reader, args.module_base)
            previous = None
            previous_owner = None
            for index in range(args.samples):
                result, owner = observe(reader, args.module_base, args.context, table)
                result['sample'] = index
                result['time_ns'] = time.time_ns()
                if result['status'] == 'unknown':
                    previous = None
                    previous_owner = None
                    exit_code = 2
                else:
                    value = result['candidate_total_percent']
                    if previous is not None and previous_owner == owner:
                        result['candidate_net_change'] = round(value - previous, 3)
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
        print(json.dumps(dict(status='unknown', candidate_total_percent=None,
                              reason=str(error) if isinstance(error, Rejected) else 'prepare_or_read_failed',
                              errno=getattr(error, 'errno', None), **UNPROVEN)), flush=True)
        exit_code = 2
    print(json.dumps(dict(event='summary', bytes_requested=reader.requested if reader else 0,
                          bytes_read=reader.copied if reader else 0,
                          buffs_read=reader.buffs if reader else 0,
                          definitions_read=reader.definitions if reader else 0, byte_limit=MAX_BYTES,
                          game_writes=0, live_value_proven=False)), flush=True)
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
