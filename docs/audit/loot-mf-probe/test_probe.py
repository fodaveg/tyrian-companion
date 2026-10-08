#!/usr/bin/env python3
"""Controlled Magic Find fixtures; no live process, account API or game required."""
import contextlib
import errno
import hashlib
import io
import json
import struct
import unittest
from unittest import mock

import probe

BASE = 0x140000000
CONTEXT = 0x200000
CHAR_CONTEXT = 0x210000
CHARACTER = 0x220000
PLAYERS = 0x230000
MANAGER = 0x240000
BUCKETS = 0x250000
PUSHED = 0x260000
HEAP = 0x270000
PLAYER = 0x300000
STATS = PLAYER + 0x9700
PLAYER_ID = 7
MF = probe.PROFILE['magic_find_modifier']
BOON = probe.PROFILE['magic_find_boon_modifier']

# The repository keeps no bytes of the game: fixtures own synthetic guard contents and
# their hashes. check_profile_offline.py is what ties the real hashes to the real file.
GUARD_BYTES = {guard['name']: hashlib.shake_256(guard['name'].encode()).digest(guard['size'])
               for guard in probe.PROFILE['guards']}
probe.PROFILE = dict(probe.PROFILE, guards=[
    dict(guard, sha256=hashlib.sha256(GUARD_BYTES[guard['name']]).hexdigest())
    for guard in probe.PROFILE['guards']])
TABLE = struct.unpack('<256I', GUARD_BYTES['hash_table'])


def modifier(kind=MF, value=30.0, formula=6, mode=0, target=0, need=0, flags=0):
    return kind, formula, value, 0.0, 0.0, mode, target, need, flags, 0, 0, 0


class Fixture:
    """Owned sparse bytes with a read log and explicit race/short-read injection."""

    def __init__(self, luck=300, capacity=64):
        self.memory = {}
        self.calls = []
        self.mutate = None
        self.short = None
        self.capacity = capacity
        self.count = 0
        self.used = set()
        self.pushed = []
        self.heap = HEAP
        self.ranges = [(BASE, BASE + probe.PROFILE['image_size']), (CONTEXT, 0x400000)]
        for guard in probe.PROFILE['guards']:
            self.write(BASE + guard['rva'], GUARD_BYTES[guard['name']])
        for slot in probe.PROFILE['slots']:
            self.qword(BASE + probe.PROFILE[slot['vtable']] + slot['slot'], BASE + slot['target_rva'])
        self.qword(CONTEXT + 0x98, CHAR_CONTEXT)
        self.qword(CHAR_CONTEXT, BASE + probe.PROFILE['char_context_vtable'])
        self.qword(CHAR_CONTEXT + 0x98, CHARACTER)
        self.qword(CHAR_CONTEXT + 0xA0, PLAYER)
        self.qword(CHAR_CONTEXT + 0x80, PLAYERS)
        self.dword(CHAR_CONTEXT + 0x8C, 16)
        self.qword(PLAYERS + 8 * PLAYER_ID, PLAYER)
        self.character(CHARACTER)
        self.qword(PLAYER, BASE + probe.PROFILE['player_vtable'])
        self.qword(STATS, BASE + probe.PROFILE['player_stats_vtable'])
        self.luck(luck)
        self.qword(MANAGER, BASE + probe.PROFILE['buff_manager_vtable'])
        self.dword(MANAGER + 0xF0, 4)
        self.headers()

    def write(self, address, data):
        self.memory.update({address + offset: value for offset, value in enumerate(data)})

    def qword(self, address, value):
        self.write(address, struct.pack('<Q', value))

    def dword(self, address, value):
        self.write(address, struct.pack('<I', value))

    def character(self, address):
        self.qword(address, BASE + probe.PROFILE['character_vtable'])
        self.qword(address + 8, BASE + probe.PROFILE['character_agent_vtable'])
        self.qword(address + 0x40, BASE + probe.PROFILE['combatant_vtable'])
        self.dword(address + 0x178, 0x10)
        self.dword(address + 0xA0, 0x30000000 + PLAYER_ID)
        self.dword(address + 0x220, 0)
        self.qword(address + 0xD0, MANAGER)

    def luck(self, level):
        self.write(STATS + 0x18, struct.pack('<4I', 123456, 10, 100, level))

    def headers(self):
        self.write(MANAGER + 0x20, struct.pack('<IIQ', self.capacity, self.count, BUCKETS))
        self.write(MANAGER + 0xD8, struct.pack('<QII', PUSHED, 64, len(self.pushed)))

    def alloc(self, size):
        address = self.heap
        self.heap += (size + 15) & ~15
        return address

    def definition(self, modifiers, stacking=0, category=1, flags=0):
        records = self.alloc(len(modifiers) * probe.MODIFIER_SIZE or 16)
        for index, record in enumerate(modifiers):
            self.write(records + index * probe.MODIFIER_SIZE, struct.pack(probe.MODIFIER_FORMAT, *record))
        groups = self.alloc(0x20)
        self.write(groups + 0x10, struct.pack('<QI', records if modifiers else 0, len(modifiers)))
        definition = self.alloc(0x30)
        self.dword(definition + 0x4, flags)
        self.dword(definition + 0xC, stacking)
        self.dword(definition + 0x18, category)
        self.qword(definition + 0x20, groups)
        self.dword(definition + 0x28, 1)
        return definition

    def buff(self, key, effect, definition):
        node = self.alloc(0x20)
        instance = self.alloc(0x70)
        self.qword(node + 0x10, instance)
        self.dword(node + 0x18, key)
        self.dword(instance + 0x28, effect)
        self.dword(instance + 0x58, 1)
        self.qword(instance + 0x60, definition)
        occupied = probe.key_hash(key, TABLE)
        index = occupied & (self.capacity - 1)
        while index in self.used:
            index = (index + 1) & (self.capacity - 1)
        self.used.add(index)
        self.count += 1
        bucket = BUCKETS + probe.BUCKET_SIZE * index
        self.write(bucket, struct.pack('<I4xQI4x', key, node, occupied))
        self.headers()
        return bucket, node, instance

    def push(self, kind, value, source=1):
        self.pushed = sorted(self.pushed + [(kind, value, source)])
        for index, entry in enumerate(self.pushed):
            self.write(PUSHED + index * probe.PUSHED_SIZE, struct.pack('<IfI', *entry))
        self.headers()

    def read(self, size, address):
        self.calls.append((address, size))
        if self.mutate:
            self.mutate(self, address, size)
        data = bytes(self.memory.get(address + offset, 0) for offset in range(size))
        return data[:-1] if self.short == address else data

    def reader(self, budget=probe.MAX_BYTES):
        return probe.Reader(self.ranges, self.read, budget)


def standard():
    """300 from luck, 7 pushed by the server and one 30 food buff: 337 in the hero panel."""
    fixture = Fixture()
    fixture.push(MF, 7.0)
    fixture.food = fixture.buff(1001, 501, fixture.definition([modifier(MF, 30.0)]))
    return fixture


def second_read(target, change):
    """Mutate just before the consistency reread of one address."""
    def mutate(memory, address, _size):
        if address == target and sum(at == address for at, _ in memory.calls) == 2:
            change(memory)
    return mutate


class MagicFindTests(unittest.TestCase):
    def observe(self, fixture, reader=None):
        result, _owner = probe.observe(reader or fixture.reader(), BASE, CONTEXT, TABLE)
        return result

    def total(self, fixture):
        result = self.observe(fixture)
        self.assertEqual(result['status'], 'candidate_magic_find', result)
        return result['candidate_total_percent']

    def assert_unknown(self, fixture, reason, reader=None):
        result = self.observe(fixture, reader)
        self.assertEqual(result['status'], 'unknown')
        self.assertIsNone(result['candidate_total_percent'])
        for field in ('account_luck_percent', 'pushed_modifier_percent', 'buff_modifier_percent'):
            self.assertNotIn(field, result)
        self.assertEqual(result['reason'], reason)

    def test_total_is_account_plus_pushed_plus_buffs_with_full_static_guard(self):
        fixture = standard()
        reader = fixture.reader()
        table = probe.guard_profile(reader, BASE)
        result, _owner = probe.observe(reader, BASE, CONTEXT, table)
        self.assertEqual(result['status'], 'candidate_magic_find')
        self.assertEqual(result['candidate_total_percent'], 337.0)
        self.assertEqual((result['account_luck_percent'], result['pushed_modifier_percent'],
                          result['buff_modifier_percent']), (300, 7.0, 30.0))
        self.assertFalse(result['boon_modifier_included'])
        self.assertFalse(result['live_value_proven'])
        self.assertFalse(result['total_semantics_proven'])
        self.assertFalse(result['game_cap_applied'])
        self.assertEqual((reader.buffs, reader.definitions), (1, 1))
        self.assertLessEqual(reader.requested, probe.MAX_BYTES)

    def test_supported_zero_is_distinct_from_unknown(self):
        result = self.observe(Fixture(luck=0))
        self.assertEqual((result['status'], result['candidate_total_percent']), ('candidate_magic_find', 0.0))

    def test_wrong_buff_manager_vtable_rejects_before_any_bucket_read(self):
        fixture = standard()
        fixture.qword(MANAGER, BASE + 0x123400)
        reader = fixture.reader()
        self.assert_unknown(fixture, 'buff_manager_vtable', reader)
        self.assertEqual(reader.buffs, 0)
        self.assertFalse(any(BUCKETS <= address < PUSHED for address, _size in fixture.calls))

    def test_wrong_dispatch_slot_rejects(self):
        fixture = standard()
        fixture.qword(BASE + probe.PROFILE['buff_manager_vtable'] + 0x28, BASE + 0x123400)
        self.assert_unknown(fixture, 'buff_iterator_slot')

    def test_wrong_owner_vtables_reject(self):
        for address, reason in ((CHAR_CONTEXT, 'character_context_vtable'), (CHARACTER, 'character_vtable'),
                                (PLAYER, 'player_vtable'), (STATS, 'player_stats_vtable'),
                                (CHARACTER + 8, 'character_agent_vtable'), (CHARACTER + 0x40, 'combatant_vtable')):
            with self.subTest(reason=reason):
                fixture = standard()
                fixture.qword(address, BASE + 0x123400)
                self.assert_unknown(fixture, reason)

    def test_character_must_be_the_controlled_local_player(self):
        cases = (('controlled_character_flag', lambda f: f.dword(CHARACTER + 0x178, 0)),
                 ('character_not_player', lambda f: f.dword(CHARACTER + 0xA0, 0x20000000 + PLAYER_ID)),
                 ('player_id_bounds', lambda f: f.dword(CHARACTER + 0xA0, 0x30000000)),
                 ('player_id_bounds', lambda f: f.dword(CHAR_CONTEXT + 0x8C, PLAYER_ID)),
                 ('local_player_mismatch', lambda f: f.qword(PLAYERS + 8 * PLAYER_ID, PLAYER + 0x10000)))
        for reason, change in cases:
            with self.subTest(reason=reason):
                fixture = standard()
                change(fixture)
                self.assert_unknown(fixture, reason)

    def test_cached_player_id_takes_precedence(self):
        fixture = standard()
        fixture.dword(CHARACTER + 0x220, 9)
        fixture.qword(PLAYERS + 8 * 9, PLAYER + 0x10000)
        self.assert_unknown(fixture, 'local_player_mismatch')
        fixture.qword(PLAYERS + 8 * 9, PLAYER)
        self.assertEqual(self.total(fixture), 337.0)

    def test_null_pointer_rejects(self):
        fixture = standard()
        fixture.qword(CHARACTER + 0xD0, 0)
        self.assert_unknown(fixture, 'null_or_invalid_pointer')

    def test_unmapped_pointer_rejects(self):
        fixture = standard()
        fixture.qword(CHARACTER + 0xD0, 0x500000)
        self.assert_unknown(fixture, 'unmapped_pointer')

    def test_null_buff_instance_rejects(self):
        fixture = standard()
        fixture.qword(fixture.food[1] + 0x10, 0)
        self.assert_unknown(fixture, 'null_or_invalid_pointer')

    def test_account_luck_bounds_reject(self):
        fixture = standard()
        fixture.luck(probe.MAX_LUCK_LEVEL + 1)
        self.assert_unknown(fixture, 'account_luck_bounds')

    def test_invalid_buff_table_rejects(self):
        for capacity, count in [(0, 1), (3, 1), (1024, 1), (64, 65)]:
            with self.subTest(capacity=capacity, count=count):
                fixture = standard()
                fixture.write(MANAGER + 0x20, struct.pack('<IIQ', capacity, count, BUCKETS))
                self.assert_unknown(fixture, 'buff_table_bounds')

    def test_bucket_integrity_rejects(self):
        bucket, node, instance = standard().food
        cases = (('buff_bucket_hash', lambda f: f.dword(bucket + 0x10, probe.key_hash(1001, TABLE) ^ 1)),
                 ('buff_instance_key', lambda f: f.dword(node + 0x18, 1002)),
                 ('buff_definition_unresolved', lambda f: f.dword(instance + 0x58, 0)),
                 ('buff_count_mismatch', lambda f: f.write(MANAGER + 0x20, struct.pack('<IIQ', 64, 2, BUCKETS))))
        for reason, change in cases:
            with self.subTest(reason=reason):
                fixture = standard()
                change(fixture)
                self.assert_unknown(fixture, reason)

    def test_definition_bounds_reject(self):
        fixture = Fixture()
        definition = fixture.definition([modifier()])
        fixture.buff(1, 1, definition)
        fixture.dword(definition + 0x28, 0)
        self.assert_unknown(fixture, 'buff_definition_bounds')
        fixture = Fixture()
        fixture.buff(1, 1, fixture.definition([modifier(5)] * (probe.MAX_MODIFIERS + 1)))
        self.assert_unknown(fixture, 'buff_modifier_bounds')

    def test_empty_buff_table_still_counts_account_and_pushed(self):
        fixture = Fixture()
        fixture.push(MF, 7.0)
        self.assertEqual(self.total(fixture), 307.0)

    def test_pushed_table_sums_every_entry_of_the_type_only(self):
        fixture = Fixture()
        for kind, value in ((14, 1000.0), (MF, 7.0), (MF, 3.0), (BOON, 40.0), (126, 5.0)):
            fixture.push(kind, value)
        self.assertEqual(self.total(fixture), 310.0)

    def test_pushed_table_integrity_rejects(self):
        fixture = Fixture()
        fixture.push(MF, 7.0)
        fixture.push(126, 5.0)
        fixture.write(PUSHED, struct.pack('<IfI', 127, 7.0, 1))
        self.assert_unknown(fixture, 'pushed_table_unsorted')
        fixture = Fixture()
        fixture.push(MF, float('nan'))
        self.assert_unknown(fixture, 'pushed_value_bounds')
        fixture = Fixture()
        fixture.write(MANAGER + 0xD8, struct.pack('<QII', PUSHED, 512, probe.MAX_PUSHED + 1))
        self.assert_unknown(fixture, 'pushed_table_bounds')

    def test_unsupported_magic_find_modifier_is_unknown_never_a_partial_total(self):
        cases = (('modifier_formula_unsupported', modifier(formula=0)),
                 ('modifier_game_mode_condition', modifier(mode=1)),
                 ('modifier_requirement_condition', modifier(need=0x280000)),
                 ('modifier_state_condition', modifier(flags=0x8)),
                 ('modifier_value_bounds', modifier(value=float('inf'))))
        for reason, record in cases:
            with self.subTest(reason=reason):
                fixture = standard()
                fixture.buff(1002, 502, fixture.definition([record]))
                self.assert_unknown(fixture, reason)

    def test_other_modifier_types_are_ignored_even_when_unsupported(self):
        fixture = standard()
        fixture.buff(1002, 502, fixture.definition([modifier(14, 100.0, formula=0, mode=2, need=0x280000, flags=0x1E)]))
        self.assertEqual(self.total(fixture), 337.0)

    def test_target_conditioned_modifier_is_skipped_like_the_client(self):
        fixture = standard()
        fixture.buff(1002, 502, fixture.definition([modifier(MF, 99.0, formula=0, target=0x280000)]))
        self.assertEqual(self.total(fixture), 337.0)

    def test_stop_flag_ends_a_definition_after_its_first_match(self):
        fixture = Fixture()
        fixture.buff(1, 1, fixture.definition([modifier(MF, 10.0, flags=1), modifier(MF, 20.0)]))
        self.assertEqual(self.total(fixture), 310.0)

    def test_stacking_counts_once_per_effect_unless_by_intensity(self):
        fixture = Fixture()
        duration = fixture.definition([modifier(MF, 10.0)], stacking=1)
        intensity = fixture.definition([modifier(MF, 1.0)], stacking=4)
        for key in (1, 2, 3):
            fixture.buff(key, 700, duration)
        for key in (11, 12, 13, 14):
            fixture.buff(key, 800, intensity)
        self.assertEqual(self.total(fixture), 314.0)

    def test_boon_modifier_needs_an_applied_category_zero_buff(self):
        fixture = standard()
        fixture.buff(1002, 502, fixture.definition([modifier(BOON, 40.0)]))
        fixture.push(BOON, 2.0)
        self.assertEqual(self.total(fixture), 337.0)
        fixture.buff(1003, 503, fixture.definition([modifier(14, 5.0)], category=0))
        result = self.observe(fixture)
        self.assertEqual((result['candidate_total_percent'], result['boon_modifier_included']), (379.0, True))

    def test_unsupported_boon_modifier_only_matters_when_it_counts(self):
        fixture = standard()
        fixture.buff(1002, 502, fixture.definition([modifier(BOON, 40.0, mode=1)]))
        self.assertEqual(self.total(fixture), 337.0)
        fixture.buff(1003, 503, fixture.definition([], category=0))
        self.assert_unknown(fixture, 'modifier_game_mode_condition')

    def test_manager_mode_hides_flagged_definitions(self):
        fixture = standard()
        fixture.buff(1002, 502, fixture.definition([modifier(MF, 50.0)], flags=0x40))
        self.assertEqual(self.total(fixture), 387.0)
        fixture.dword(MANAGER + 0xF0, 1)
        self.assertEqual(self.total(fixture), 337.0)

    def test_changes_between_rereads_reject(self):
        def other_character(memory):
            memory.character(CHARACTER + 0x1000)
            memory.qword(CHAR_CONTEXT + 0x98, CHARACTER + 0x1000)
        cases = ((STATS + 0x18, lambda memory: memory.luck(301)),
                 (MANAGER + 0x20, lambda memory: memory.buff(1002, 502, memory.definition([modifier()]))),
                 (MANAGER + 0xD8, lambda memory: memory.push(MF, 1.0)),
                 (MANAGER + 0xF0, lambda memory: memory.dword(MANAGER + 0xF0, 1)),
                 (PUSHED, lambda memory: memory.write(PUSHED, struct.pack('<IfI', MF, 8.0, 1))),
                 (BUCKETS, lambda memory: memory.dword(BUCKETS + 4, 1)),
                 (CHAR_CONTEXT + 0x98, other_character))
        for target, change in cases:
            with self.subTest(target=hex(target)):
                fixture = standard()
                fixture.mutate = second_read(target, change)
                self.assert_unknown(fixture, 'concurrent_magic_find_change')

    def test_vtable_changed_at_recheck_rejects(self):
        fixture = standard()
        fixture.mutate = second_read(MANAGER, lambda memory: memory.qword(MANAGER, BASE + 0x123400))
        self.assert_unknown(fixture, 'concurrent_buff_manager_vtable')

    def test_short_read_rejects_without_partial_value(self):
        fixture = standard()
        fixture.short = fixture.food[1] + 0x10
        result = self.observe(fixture)
        self.assertEqual((result['status'], result['reason'], result['errno']), ('unknown', 'read_failed', errno.EIO))
        self.assertIsNone(result['candidate_total_percent'])

    def test_byte_budget_rejects_before_more_reads(self):
        fixture = standard()
        reader = fixture.reader(budget=8)
        self.assert_unknown(fixture, 'byte_budget', reader)
        self.assertEqual(reader.requested, 8)

    def test_budget_cannot_be_raised_above_the_declared_limit(self):
        self.assertEqual(standard().reader(budget=1 << 30).budget, probe.MAX_BYTES)

    def test_out_of_mapping_rejects_before_read(self):
        fixture = standard()
        reader = fixture.reader()
        with self.assertRaisesRegex(probe.Rejected, 'mapping_range'):
            reader.read(0x500000, 12)
        self.assertEqual(fixture.calls, [])

    def test_static_guard_mutation_fails_then_restoration_passes(self):
        fixture = standard()
        guard = next(guard for guard in probe.PROFILE['guards'] if guard['name'] == 'modifier_sum')
        address = BASE + guard['rva'] + guard['size'] - 1
        fixture.write(address, bytes([GUARD_BYTES['modifier_sum'][-1] ^ 1]))
        with self.assertRaisesRegex(probe.Rejected, 'static_guard_modifier_sum'):
            probe.guard_profile(fixture.reader(), BASE)
        fixture.write(address, GUARD_BYTES['modifier_sum'][-1:])
        self.assertEqual(probe.guard_profile(fixture.reader(), BASE), TABLE)

    def run_main(self, fixture, between_samples):
        output = io.StringIO()
        arguments = ['probe.py', '--pid', '1', '--module-base', hex(BASE), '--context', hex(CONTEXT), '--samples', '2']
        with (mock.patch('sys.argv', arguments),
              mock.patch.object(probe, 'prepare_process', return_value=fixture.ranges),
              mock.patch.object(probe.os, 'open', return_value=123),
              mock.patch.object(probe.os, 'close'),
              mock.patch.object(probe.os, 'pread', side_effect=lambda fd, size, address: fixture.read(size, address)),
              mock.patch.object(probe.time, 'sleep', side_effect=between_samples),
              contextlib.redirect_stdout(output)):
            exit_code = probe.main()
        return exit_code, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_main_new_buff_moves_the_total_and_not_the_account_base(self):
        fixture = standard()
        exit_code, rows = self.run_main(
            fixture, lambda _delay: fixture.buff(1002, 502, fixture.definition([modifier(MF, 50.0)])))
        self.assertEqual(exit_code, 0)
        self.assertEqual([row['candidate_total_percent'] for row in rows[:2]], [337.0, 387.0])
        self.assertEqual(rows[1]['candidate_net_change'], 50.0)
        self.assertEqual([row['account_luck_percent'] for row in rows[:2]], [300, 300])
        self.assertEqual(rows[2]['event'], 'summary')
        self.assertLessEqual(rows[2]['bytes_requested'], probe.MAX_BYTES)
        self.assertEqual(rows[2]['game_writes'], 0)
        for row in rows:
            self.assertFalse(any(isinstance(value, str) and value.startswith('0x') for value in row.values()))

    def test_main_owner_change_between_samples_does_not_project_delta(self):
        fixture = standard()
        def change_owner(_delay):
            fixture.character(CHARACTER + 0x3000)
            fixture.qword(CHAR_CONTEXT + 0x98, CHARACTER + 0x3000)
        exit_code, rows = self.run_main(fixture, change_owner)
        self.assertEqual(exit_code, 0)
        self.assertEqual(rows[1]['status'], 'candidate_magic_find')
        self.assertEqual(rows[1]['continuity'], 'owner_changed')
        self.assertNotIn('candidate_net_change', rows[1])

    def test_main_unknown_sample_exits_two_without_a_value(self):
        fixture = standard()
        exit_code, rows = self.run_main(fixture, lambda _delay: fixture.qword(MANAGER, BASE + 0x123400))
        self.assertEqual(exit_code, 2)
        self.assertEqual((rows[1]['status'], rows[1]['candidate_total_percent']), ('unknown', None))


if __name__ == '__main__':
    unittest.main()
