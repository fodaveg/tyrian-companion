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
    Only the counters differ, plus `block` and `checked` for tables read in one go and
    the route notes that --diagnose reports. The notes never change a normal verdict.
    """

    def __init__(self, ranges, pread, budget=MAX_BYTES):
        self.ranges = ranges
        self.pread = pread
        self.budget = min(budget, MAX_BYTES)
        self.requested = 0
        self.copied = 0
        self.buffs = 0
        self.definitions = 0
        self.diagnose = False
        self.begin()

    def begin(self):
        """Forget the previous sample's route notes."""
        self.stage = None
        self.passed = []
        self.fault = None
        self.observed = None
        self.unaligned = None
        self.partial = {}

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

    def block(self, address, size):
        """A table the game owns as one array, fetched as exact bounded requests."""
        data = b''
        while len(data) < size:
            data += self.read(address + len(data), min(1008, size - len(data)))
        return data

    def scalar(self, address, size):
        return int.from_bytes(self.read(address, size), 'little')

    @staticmethod
    def aligned(value, content):
        """Heap objects sit on 8 bytes; game content sits 4 past a multiple of 8.

        Both come from the live diagnose run of 2026-10-08 on this build: 91 of 91 table
        nodes ended in 0 and 278 of 278 content pointers ended in 4. See the README.
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
        """Validate a pointer into game content: definitions, their records and references."""
        return self.checked(value, content=True)

    def checked(self, value, content=False):
        """Validate a pointer value that was already read as part of a larger record."""
        fault = self.classify(value, content)
        if fault == 'unaligned' and self.diagnose:
            # Diagnose only: note where alignment first failed and keep walking, so one run
            # shows what a relaxed check would find. The strict verdict stays unknown.
            if self.unaligned is None:
                self.unaligned = dict(stage=self.stage, pointers=0, low_bits={})
            self.unaligned['pointers'] += 1
            bits = str(value & 7)
            self.unaligned['low_bits'][bits] = self.unaligned['low_bits'].get(bits, 0) + 1
            fault = None if any(start <= value < end for start, end in self.ranges) else 'unmapped'
        if fault:
            self.fault = fault
            raise Rejected('unmapped_pointer' if fault == 'unmapped' else 'null_or_invalid_pointer')
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
    value = reader.pointer(address)
    if value != expected:
        reader.observed = value
        raise Rejected(reason)


def require_slots(reader, base):
    """Every dispatch slot the widget goes through must still select its guarded code."""
    for slot in PROFILE['slots']:
        require_pointer(reader, base + PROFILE[slot['vtable']] + slot['slot'],
                        base + slot['target_rva'], slot['target'] + '_slot')


def owner_route(reader, base, context, prefix=''):
    """Context -> controlled character, local player and the character's buff manager."""
    mark = 'recheck_' if prefix else ''
    reader.step(mark + 'context_to_chcli')
    char_context = reader.pointer(context + 0x98)
    require_pointer(reader, char_context, base + PROFILE['char_context_vtable'], prefix + 'character_context_vtable')
    reader.step(mark + 'character')
    character = reader.pointer(char_context + 0x98)
    require_pointer(reader, character, base + PROFILE['character_vtable'], prefix + 'character_vtable')
    reader.step(mark + 'player')
    player = reader.pointer(char_context + 0xA0)
    require_pointer(reader, player, base + PROFILE['player_vtable'], prefix + 'player_vtable')
    reader.step(mark + 'player_stats')
    require_pointer(reader, player + 0x9700, base + PROFILE['player_stats_vtable'], prefix + 'player_stats_vtable')
    reader.step(mark + 'effect_manager')
    manager = reader.pointer(character + 0xD0)
    require_pointer(reader, manager, base + PROFILE['buff_manager_vtable'], prefix + 'buff_manager_vtable')
    return char_context, character, player, manager


def require_local_player(reader, base, char_context, character, player):
    """The widget resolves the player from the character's id; it must be the local one."""
    reader.step('controlled_flag')
    if not reader.scalar(character + 0x178, 4) & 0x10:
        raise Rejected('controlled_character_flag')
    reader.step('character_interfaces')
    require_pointer(reader, character + 8, base + PROFILE['character_agent_vtable'], 'character_agent_vtable')
    require_pointer(reader, character + 0x40, base + PROFILE['combatant_vtable'], 'combatant_vtable')
    reader.step('player_id')
    agent = reader.scalar(character + 0xA0, 4)
    if agent & 0xF0000000 != 0x30000000:
        raise Rejected('character_not_player')
    player_id = reader.scalar(character + 0x220, 4) or agent - 0x30000000
    if not 0 < player_id <= MAX_PLAYER_ID or player_id >= reader.scalar(char_context + 0x8C, 4):
        raise Rejected('player_id_bounds')
    reader.step('player_array')
    if reader.pointer(reader.pointer(char_context + 0x80) + 8 * player_id) != player:
        raise Rejected('local_player_mismatch')


def read_definition(reader, definition):
    """Flags, stacking, category and the modifier records of one buff definition."""
    reader.step('buff_definition')
    head = reader.read(reader.content(definition), 0x30)
    flags, stacking, category = (struct.unpack_from('<I', head, offset)[0] for offset in (0x4, 0xC, 0x18))
    groups, group_count = struct.unpack_from('<QI', head, 0x20)
    if not group_count:
        raise Rejected('buff_definition_bounds')
    reader.step('buff_modifier_group')
    modifiers, count = struct.unpack('<QI', reader.read(reader.content(groups) + 0x10, 12))
    if count > MAX_MODIFIERS:
        raise Rejected('buff_modifier_bounds')
    reader.step('buff_modifier_records')
    raw = reader.block(reader.content(modifiers), count * MODIFIER_SIZE) if count else b''
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


def bucket_survey(reader, buckets, table):
    """Diagnose only: shape of the buff table already read, with no pointer values."""
    survey = dict(occupied=0, hash_mismatch=0, padding_nonzero=0, node_pointers={}, node_low_bits={})
    for index in range(len(buckets) // BUCKET_SIZE):
        key, key_pad, node, bucket_hash, hash_pad = struct.unpack_from('<IIQII', buckets, index * BUCKET_SIZE)
        if not bucket_hash:
            continue
        survey['occupied'] += 1
        survey['padding_nonzero'] += bool(key_pad or hash_pad)
        survey['hash_mismatch'] += bucket_hash != key_hash(key, table)
        kind = reader.classify(node) or 'ok'
        survey['node_pointers'][kind] = survey['node_pointers'].get(kind, 0) + 1
        bits = str(node & 7)
        survey['node_low_bits'][bits] = survey['node_low_bits'].get(bits, 0) + 1
    return survey


def node_class(reader, base, node):
    """Diagnose only: is this table node of the class its constructor installs? 8 bytes each."""
    tally = reader.partial.setdefault('node_vtables', dict(expected=0, other=0, other_rvas=[]))
    rva = module_rva(base, reader.scalar(node, 8))
    if rva == PROFILE['buff_node_vtable']:
        tally['expected'] += 1
    else:
        tally['other'] += 1
        if rva not in tally['other_rvas'] and len(tally['other_rvas']) < 8:
            tally['other_rvas'].append(rva)


def magic_find_records(buffs, limit=64):
    """Diagnose only: every Magic Find record of the applied buffs, as content shape."""
    records = []
    wanted = (PROFILE['magic_find_modifier'], PROFILE['magic_find_boon_modifier'])
    for _effect, (_flags, stacking, category, modifiers) in buffs:
        for kind, formula, value, _a, _b, mode, target, need_a, flags, need_b, when_a, when_b in modifiers:
            if kind in wanted and len(records) < limit:
                records.append(dict(type=kind, formula=formula, game_mode=mode, has_target=bool(target),
                                    has_requirement=bool(need_a or need_b or when_a or when_b),
                                    state_flags=flags & 0x1E, stops=bool(flags & 1),
                                    value=round(value, 3) if math.isfinite(value) else None,
                                    stacking=stacking, category=category))
    return records


def module_rva(base, value):
    """An address inside the game image as an RVA, which names code and not player data."""
    return value - base if base <= value < base + PROFILE['image_size'] else None


def observe_diagnosed(reader, base, context, table):
    """The normal verdict plus where the route stopped and what was read before that.

    Alignment is the one check relaxed while walking: an unaligned pointer is noted and
    followed, so a single run shows how far a relaxed route gets. The verdict reported
    is still the strict one; whatever the relaxed walk finds is labelled diagnostic.
    """
    reader.begin()
    reader.diagnose = True
    try:
        walked, owner = observe(reader, base, context, table)
    finally:
        reader.diagnose = False
    notes = dict(diagnose=True, passed=list(reader.passed), partial=dict(reader.partial))
    failure = {}
    if walked['status'] == 'unknown':
        failure['stage'] = reader.stage
        if reader.fault:
            failure['pointer_fault'] = reader.fault
        if reader.observed is not None:
            failure['observed_rva'] = module_rva(base, reader.observed)
            failure['observed_in_module'] = failure['observed_rva'] is not None
    if reader.unaligned is None:
        return dict(walked, **failure, **notes), owner
    relaxed = dict(walked, **failure, diagnostic_only=True, unaligned_pointers=reader.unaligned['pointers'],
                   unaligned_low_bits=reader.unaligned['low_bits'])
    for flag in UNPROVEN:
        relaxed.pop(flag)
    strict = dict(status='unknown', candidate_total_percent=None, reason='null_or_invalid_pointer', errno=None,
                  **UNPROVEN, stage=reader.unaligned['stage'], pointer_fault='unaligned',
                  relaxed_alignment=relaxed, **notes)
    return strict, None


def magic_find_snapshot(reader, base, context, table):
    """Read the three stored addends, then recheck every owner, header and table."""
    owner = owner_route(reader, base, context)
    char_context, character, player, manager = owner
    reader.step('dispatch_slots')
    require_slots(reader, base)
    require_local_player(reader, base, char_context, character, player)
    reader.step('account_luck')
    luck = reader.read(player + 0x9700 + 0x18, 16)
    level = struct.unpack('<4I', luck)[3]
    if level > MAX_LUCK_LEVEL:
        raise Rejected('account_luck_bounds')
    reader.partial['account_luck_percent'] = level
    reader.step('manager_headers')
    table_header = reader.read(manager + 0x20, 16)
    pushed_header = reader.read(manager + 0xD8, 16)
    hidden_mode = reader.scalar(manager + 0xF0, 4)

    reader.step('pushed_table')
    pushed_at, _pushed_capacity, pushed_count = struct.unpack('<QII', pushed_header)
    if pushed_count > MAX_PUSHED:
        raise Rejected('pushed_table_bounds')
    pushed_raw = reader.block(reader.checked(pushed_at), pushed_count * PUSHED_SIZE) if pushed_count else b''
    pushed = [struct.unpack_from('<IfI', pushed_raw, index * PUSHED_SIZE) for index in range(pushed_count)]
    if any(later[0] < earlier[0] for earlier, later in zip(pushed, pushed[1:])):
        raise Rejected('pushed_table_unsorted')
    if any(not math.isfinite(value) or abs(value) > MAX_ABS_PERCENT for _kind, value, _source in pushed):
        raise Rejected('pushed_value_bounds')
    reader.partial.update(pushed_records=pushed_count, pushed_magic_find_percent=round(
        pushed_total(pushed, PROFILE['magic_find_modifier']), 3))

    reader.step('buff_table')
    capacity, count, entries = struct.unpack('<IIQ', table_header)
    reader.partial.update(buff_table_capacity=capacity, buff_table_count=count)
    buckets = b''
    buffs = []
    if count:
        if not 0 < capacity <= MAX_CAPACITY or capacity & (capacity - 1) or count > capacity:
            raise Rejected('buff_table_bounds')
        buckets = reader.block(reader.checked(entries), capacity * BUCKET_SIZE)
    if reader.diagnose:
        reader.partial['bucket_survey'] = bucket_survey(reader, buckets, table)
    definitions = {}
    occupied = 0
    for index in range(len(buckets) // BUCKET_SIZE):
        key, node, bucket_hash = struct.unpack_from('<I4xQI', buckets, index * BUCKET_SIZE)
        if not bucket_hash:
            continue
        reader.step('buff_bucket')
        if bucket_hash != key_hash(key, table):
            raise Rejected('buff_bucket_hash')
        occupied += 1
        reader.step('buff_node')
        node = reader.checked(node)
        if reader.diagnose:
            node_class(reader, base, node)
        instance, instance_key = struct.unpack('<QI', reader.read(node + 0x10, 12))
        if instance_key != key:
            raise Rejected('buff_instance_key')
        reader.step('buff_instance')
        effect = reader.scalar(reader.content(instance) + 0x28, 4)
        state, definition = struct.unpack('<I4xQ', reader.read(instance + 0x58, 16))
        if state != 1:
            raise Rejected('buff_definition_unresolved')
        if definition not in definitions:
            definitions[definition] = read_definition(reader, definition)
        reader.buffs += 1
        reader.partial['buffs_walked'] = reader.partial.get('buffs_walked', 0) + 1
        # buff_filter: in this manager mode the client hides definitions flagged 0x40.
        if hidden_mode == 1 and definitions[definition][0] & 0x40:
            continue
        buffs.append((effect, definitions[definition]))
    reader.step('buff_count')
    if occupied != count:
        raise Rejected('buff_count_mismatch')
    if reader.diagnose:
        reader.partial['magic_find_records'] = magic_find_records(buffs)

    reader.step('sum')
    kind = PROFILE['magic_find_modifier']
    from_pushed = pushed_total(pushed, kind)
    from_buffs = buff_total(buffs, kind)
    # RewardCreatureAllBoon only counts while some applied buff has category 0.
    with_boon = any(category == 0 for _effect, (_flags, _stacking, category, _modifiers) in buffs)
    if with_boon:
        boon = PROFILE['magic_find_boon_modifier']
        from_pushed += pushed_total(pushed, boon)
        from_buffs = float32(from_buffs + buff_total(buffs, boon))

    reader.partial.update(buff_magic_find_percent=round(from_buffs, 3), boon_modifier_included=with_boon)
    if (owner_route(reader, base, context, 'concurrent_') != owner
            or reader.read(player + 0x9700 + 0x18, 16) != luck
            or reader.read(manager + 0x20, 16) != table_header
            or reader.read(manager + 0xD8, 16) != pushed_header
            or reader.scalar(manager + 0xF0, 4) != hidden_mode
            or (pushed_raw and reader.block(pushed_at, len(pushed_raw)) != pushed_raw)
            or (buckets and reader.block(entries, len(buckets)) != buckets)):
        raise Rejected('concurrent_magic_find_change')
    reader.step('done')
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
    parser.add_argument('--diagnose', action='store_true',
                        help='add the route stage, vtable RVAs and partial addends; same reads budget')
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
            sample_bytes = 0
            for index in range(args.samples):
                before = reader.requested
                if reader.requested + sample_bytes > reader.budget:
                    # A further full pass would not fit: say so before reading anything.
                    result, owner = dict(status='unknown', candidate_total_percent=None, reason='byte_budget',
                                         errno=None, **UNPROVEN), None
                else:
                    result, owner = (observe_diagnosed if args.diagnose else observe)(
                        reader, args.module_base, args.context, table)
                sample_bytes = max(sample_bytes, reader.requested - before)
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
