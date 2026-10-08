#!/usr/bin/env python3
"""Controlled bag capacity fixtures; no live process, account API or game required."""
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
INVENTORY = 0x230000
HEAP = 0x240000

# The repository keeps no bytes of the game: fixtures own synthetic guard contents and
# their hashes. check_profile_offline.py is what ties the real hashes to the real file.
GUARD_BYTES = {guard['name']: hashlib.shake_256(guard['name'].encode()).digest(guard['size'])
               for guard in probe.PROFILE['guards']}
probe.PROFILE = dict(probe.PROFILE, guards=[
    dict(guard, sha256=hashlib.sha256(GUARD_BYTES[guard['name']]).hexdigest())
    for guard in probe.PROFILE['guards']])


class Fixture:
    """Owned sparse bytes with a read log and explicit race/short-read injection."""

    def __init__(self, sizes=(20, 32, 32, 28), slot_count=None):
        self.memory = {}
        self.calls = []
        self.mutate = None
        self.short = None
        self.heap = HEAP
        self.items = {}
        self.ranges = [(BASE, BASE + probe.PROFILE['image_size']), (CONTEXT, 0x300000)]
        for guard in probe.PROFILE['guards']:
            self.write(BASE + guard['rva'], GUARD_BYTES[guard['name']])
        for slot in probe.PROFILE['slots']:
            self.qword(BASE + probe.PROFILE[slot['vtable']] + slot['slot'], BASE + slot['target_rva'])
        self.qword(CONTEXT + 0x98, CHAR_CONTEXT)
        self.qword(CHAR_CONTEXT, BASE + probe.PROFILE['char_context_vtable'])
        self.qword(CHAR_CONTEXT + 0x98, CHARACTER)
        self.character(CHARACTER, INVENTORY)
        self.dword(INVENTORY + 0x440, len(sizes) if slot_count is None else slot_count)
        for index, size in enumerate(sizes):
            if size is not None:
                self.bag(index, size)

    def write(self, address, data):
        self.memory.update({address + offset: value for offset, value in enumerate(data)})

    def qword(self, address, value):
        self.write(address, struct.pack('<Q', value))

    def dword(self, address, value):
        self.write(address, struct.pack('<I', value))

    def character(self, address, inventory):
        self.qword(address + 8, BASE + probe.PROFILE['character_agent_vtable'])
        self.dword(address + 0x178, 0x10)
        self.qword(address + 0x3F0, inventory)
        self.qword(inventory, BASE + probe.PROFILE['inventory_vtable'])
        self.qword(inventory + 0x70, address)

    def alloc(self, size):
        address = self.heap
        self.heap += (size + 15) & ~15
        return address

    def bag(self, index, size, inventory=INVENTORY, vtable=None, misalign=0):
        item, definition, payload = self.alloc(0x50), self.alloc(0x48) + misalign, self.alloc(0x38) + misalign
        self.qword(item, BASE + (vtable or probe.PROFILE['bag_item_vtable']))
        self.qword(item + 0x40, definition)
        self.write(definition + 0x28, struct.pack('<IIQ', 9000 + index, probe.PROFILE['bag_item_type'], payload))
        self.dword(payload + 0x28, size)
        self.qword(inventory + 0x380 + 8 * index, item)
        self.items[index] = (item, definition, payload)
        return item

    def read(self, size, address):
        self.calls.append((address, size))
        if self.mutate:
            self.mutate(self, address, size)
        data = bytes(self.memory.get(address + offset, 0) for offset in range(size))
        return data[:-1] if self.short == address else data

    def reader(self, budget=probe.MAX_BYTES):
        return probe.Reader(self.ranges, self.read, budget)


def second_read(target, change):
    """Mutate just before the consistency reread of one address."""
    def mutate(memory, address, _size):
        if address == target and sum(at == address for at, _ in memory.calls) == 2:
            change(memory)
    return mutate


class BagCapacityTests(unittest.TestCase):
    def observe(self, fixture, reader=None):
        result, _owner = probe.observe(reader or fixture.reader(), BASE, CONTEXT)
        return result

    def capacity(self, fixture):
        result = self.observe(fixture)
        self.assertEqual(result['status'], 'candidate_bag_capacity', result)
        return result['candidate_capacity_slots']

    def assert_unknown(self, fixture, reason, reader=None):
        result = self.observe(fixture, reader)
        self.assertEqual(result['status'], 'unknown')
        self.assertIsNone(result['candidate_capacity_slots'])
        self.assertNotIn('bags_equipped', result)
        self.assertEqual(result['reason'], reason)

    def test_capacity_is_the_sum_of_equipped_bag_sizes_with_full_static_guard(self):
        fixture = Fixture()
        reader = fixture.reader()
        probe.guard_profile(reader, BASE)
        result, _owner = probe.observe(reader, BASE, CONTEXT)
        self.assertEqual((result['status'], result['candidate_capacity_slots']), ('candidate_bag_capacity', 112))
        self.assertEqual((result['bag_slot_count'], result['bags_equipped']), (4, 4))
        self.assertFalse(result['live_value_proven'])
        self.assertFalse(result['capacity_semantics_proven'])
        self.assertEqual(reader.bags, 4)

    def test_sixteen_full_bags_and_two_samples_fit_the_declared_budget(self):
        fixture = Fixture(sizes=(32,) * 16)
        reader = fixture.reader()
        probe.guard_profile(reader, BASE)
        for _sample in range(2):
            result, _owner = probe.observe(reader, BASE, CONTEXT)
            self.assertEqual(result['candidate_capacity_slots'], 512)
        self.assertLessEqual(reader.requested, probe.MAX_BYTES)

    def test_empty_bag_slots_add_nothing(self):
        fixture = Fixture(sizes=(20, None, 32, None, None))
        result = self.observe(fixture)
        self.assertEqual((result['candidate_capacity_slots'], result['bag_slot_count'], result['bags_equipped']),
                         (52, 5, 2))

    def test_bags_beyond_the_unlocked_slot_count_are_not_counted(self):
        self.assertEqual(self.capacity(Fixture(sizes=(20, 32, 32, 28), slot_count=2)), 52)

    def test_supported_zero_is_distinct_from_unknown(self):
        result = self.observe(Fixture(sizes=(None, None), slot_count=2))
        self.assertEqual((result['status'], result['candidate_capacity_slots']), ('candidate_bag_capacity', 0))

    def test_wrong_inventory_vtable_rejects_before_any_bag_read(self):
        fixture = Fixture()
        fixture.qword(INVENTORY, BASE + 0x123400)
        reader = fixture.reader()
        self.assert_unknown(fixture, 'inventory_vtable', reader)
        self.assertEqual(reader.bags, 0)
        self.assertFalse(any(INVENTORY + 0x380 <= address < INVENTORY + 0x444 for address, _size in fixture.calls))

    def test_wrong_dispatch_slot_rejects(self):
        fixture = Fixture()
        fixture.qword(BASE + probe.PROFILE['inventory_vtable'] + 0x1F0, BASE + 0x123400)
        self.assert_unknown(fixture, 'capacity_getter_slot')

    def test_wrong_owner_identities_reject(self):
        cases = (('character_context_vtable', lambda f: f.qword(CHAR_CONTEXT, BASE + 0x123400)),
                 ('character_agent_vtable', lambda f: f.qword(CHARACTER + 8, BASE + 0x123400)),
                 ('controlled_character_flag', lambda f: f.dword(CHARACTER + 0x178, 0)),
                 ('inventory_owner_mismatch', lambda f: f.qword(INVENTORY + 0x70, CHARACTER + 0x1000)))
        for reason, change in cases:
            with self.subTest(reason=reason):
                fixture = Fixture()
                change(fixture)
                self.assert_unknown(fixture, reason)

    def test_bag_identity_and_bounds_reject(self):
        cases = (('bag_item_vtable', lambda f, bag: f.qword(bag[0], BASE + 0x123400)),
                 ('bag_definition_type', lambda f, bag: f.dword(bag[1] + 0x2C, 5)),
                 ('bag_size_bounds', lambda f, bag: f.dword(bag[2] + 0x28, 33)),
                 ('null_or_invalid_pointer', lambda f, bag: f.qword(bag[0] + 0x40, 0)),
                 ('null_or_invalid_pointer', lambda f, bag: f.qword(bag[1] + 0x30, 0)),
                 ('null_or_invalid_pointer', lambda f, bag: f.qword(INVENTORY + 0x388, bag[0] + 1)),
                 ('unmapped_pointer', lambda f, bag: f.qword(INVENTORY + 0x388, 0x500000)))
        for reason, change in cases:
            with self.subTest(reason=reason):
                fixture = Fixture()
                change(fixture, fixture.items[1])
                self.assert_unknown(fixture, reason)

    def test_bag_slot_count_bounds_reject(self):
        fixture = Fixture()
        fixture.dword(INVENTORY + 0x440, 17)
        self.assert_unknown(fixture, 'bag_slot_count_bounds')

    def test_null_and_unmapped_owner_pointers_reject(self):
        fixture = Fixture()
        fixture.qword(CHARACTER + 0x3F0, 0)
        self.assert_unknown(fixture, 'null_or_invalid_pointer')
        fixture = Fixture()
        fixture.qword(CHARACTER + 0x3F0, 0x500000)
        self.assert_unknown(fixture, 'unmapped_pointer')

    def test_changes_between_rereads_reject(self):
        def other_character(memory):
            memory.character(CHARACTER + 0x1000, INVENTORY + 0x1000)
            memory.qword(CHAR_CONTEXT + 0x98, CHARACTER + 0x1000)
        cases = ((INVENTORY + 0x440, lambda memory: memory.dword(INVENTORY + 0x440, 3)),
                 (INVENTORY + 0x380, lambda memory: memory.bag(2, 20)),
                 (INVENTORY + 0x70, lambda memory: memory.qword(INVENTORY + 0x70, CHARACTER + 0x1000)),
                 (CHAR_CONTEXT + 0x98, other_character))
        for target, change in cases:
            with self.subTest(target=hex(target)):
                fixture = Fixture()
                fixture.mutate = second_read(target, change)
                self.assert_unknown(fixture, 'concurrent_bag_change')

    def test_vtable_changed_at_recheck_rejects(self):
        fixture = Fixture()
        fixture.mutate = second_read(INVENTORY, lambda memory: memory.qword(INVENTORY, BASE + 0x123400))
        self.assert_unknown(fixture, 'concurrent_inventory_vtable')

    def test_short_read_rejects_without_partial_value(self):
        fixture = Fixture()
        fixture.short = fixture.items[2][2] + 0x28
        result = self.observe(fixture)
        self.assertEqual((result['status'], result['reason'], result['errno']), ('unknown', 'read_failed', errno.EIO))
        self.assertIsNone(result['candidate_capacity_slots'])

    def test_byte_budget_rejects_before_more_reads(self):
        fixture = Fixture()
        reader = fixture.reader(budget=8)
        self.assert_unknown(fixture, 'byte_budget', reader)
        self.assertEqual(reader.requested, 8)

    def test_budget_cannot_be_raised_above_the_declared_limit(self):
        self.assertEqual(Fixture().reader(budget=1 << 30).budget, probe.MAX_BYTES)

    def test_out_of_mapping_rejects_before_read(self):
        fixture = Fixture()
        reader = fixture.reader()
        with self.assertRaisesRegex(probe.Rejected, 'mapping_range'):
            reader.read(0x500000, 12)
        self.assertEqual(fixture.calls, [])

    def test_static_guard_mutation_fails_then_restoration_passes(self):
        fixture = Fixture()
        guard = next(guard for guard in probe.PROFILE['guards'] if guard['name'] == 'capacity_getter')
        address = BASE + guard['rva']
        fixture.write(address, bytes([GUARD_BYTES['capacity_getter'][0] ^ 1]))
        with self.assertRaisesRegex(probe.Rejected, 'static_guard_capacity_getter'):
            probe.guard_profile(fixture.reader(), BASE)
        fixture.write(address, GUARD_BYTES['capacity_getter'][:1])
        probe.guard_profile(fixture.reader(), BASE)

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

    def test_main_swapping_a_bag_moves_the_capacity(self):
        fixture = Fixture()
        exit_code, rows = self.run_main(fixture, lambda _delay: fixture.bag(0, 32))
        self.assertEqual(exit_code, 0)
        self.assertEqual([row['candidate_capacity_slots'] for row in rows[:2]], [112, 124])
        self.assertEqual(rows[1]['candidate_net_change'], 12)
        self.assertEqual(rows[2]['event'], 'summary')
        self.assertLessEqual(rows[2]['bytes_requested'], probe.MAX_BYTES)
        self.assertEqual(rows[2]['game_writes'], 0)

    def test_main_other_character_reports_its_own_bags_without_a_delta(self):
        fixture = Fixture()
        def change_character(_delay):
            fixture.character(CHARACTER + 0x3000, INVENTORY + 0x3000)
            fixture.dword(INVENTORY + 0x3000 + 0x440, 2)
            fixture.bag(0, 18, INVENTORY + 0x3000)
            fixture.bag(1, 20, INVENTORY + 0x3000)
            fixture.qword(CHAR_CONTEXT + 0x98, CHARACTER + 0x3000)
        exit_code, rows = self.run_main(fixture, change_character)
        self.assertEqual(exit_code, 0)
        self.assertEqual([row['candidate_capacity_slots'] for row in rows[:2]], [112, 38])
        self.assertEqual(rows[1]['continuity'], 'owner_changed')
        self.assertNotIn('candidate_net_change', rows[1])

    def test_main_unknown_sample_exits_two_without_a_value(self):
        fixture = Fixture()
        exit_code, rows = self.run_main(fixture, lambda _delay: fixture.qword(INVENTORY, BASE + 0x123400))
        self.assertEqual(exit_code, 2)
        self.assertEqual((rows[1]['status'], rows[1]['candidate_capacity_slots']), ('unknown', None))


CANDIDATE = probe.PROFILE['bag_item_vtable_candidates'][0]
GETTER = next(slot['target_rva'] for slot in probe.PROFILE['slots'] if slot['target'] == 'item_definition_getter')
NORMAL_KEYS = {'status', 'candidate_capacity_slots', 'bag_slot_count', 'bags_equipped',
               'live_value_proven', 'capacity_semantics_proven'}
UNKNOWN_KEYS = {'status', 'candidate_capacity_slots', 'reason', 'errno',
                'live_value_proven', 'capacity_semantics_proven'}


def candidate_class_fixture(sizes=(20, 32, 32, 28)):
    """Every bag is of the prepared, not yet accepted, class: what the live run of 8 Oct met."""
    fixture = Fixture(sizes=(None,) * len(sizes))
    fixture.qword(BASE + CANDIDATE['vtable'] + 8, BASE + GETTER)
    for index, size in enumerate(sizes):
        fixture.bag(index, size, vtable=CANDIDATE['vtable'])
    return fixture


class DiagnoseTests(unittest.TestCase):
    def diagnose(self, fixture):
        result, _owner = probe.observe_diagnosed(fixture.reader(), BASE, CONTEXT)
        return result

    def test_normal_mode_output_is_unchanged(self):
        result, _owner = probe.observe(Fixture().reader(), BASE, CONTEXT)
        self.assertEqual(set(result), NORMAL_KEYS)
        result, _owner = probe.observe(candidate_class_fixture().reader(), BASE, CONTEXT)
        self.assertEqual(set(result), UNKNOWN_KEYS)
        self.assertEqual(result['reason'], 'bag_item_vtable')
        exit_code, rows = BagCapacityTests.run_main(self, Fixture(), lambda _delay: None)
        self.assertEqual(exit_code, 0)
        self.assertEqual(set(rows[0]), NORMAL_KEYS | {'sample', 'time_ns'})
        self.assertEqual(set(rows[2]), {'event', 'bytes_requested', 'bytes_read', 'bags_read', 'byte_limit',
                                        'game_writes', 'live_value_proven'})

    def test_rejected_bag_class_reports_stage_rva_and_survey(self):
        fixture = candidate_class_fixture()
        result = self.diagnose(fixture)
        self.assertEqual((result['status'], result['reason'], result['candidate_capacity_slots']),
                         ('unknown', 'bag_item_vtable', None))
        self.assertEqual(result['stage'], 'bag_item_vtable[0]')
        self.assertEqual((result['observed_rva'], result['observed_in_module']), (CANDIDATE['vtable'], True))
        for passed in ('context_to_chcli', 'character', 'inventory', 'dispatch_slots', 'bag_slot_count',
                       'bag_pointers', 'bag_pointer[0]'):
            self.assertIn(passed, result['passed'])
        survey = result['survey']
        self.assertEqual((survey['bag_slot_count'], len(survey['bags']), survey['distinct_vtables']), (4, 16, 1))
        self.assertEqual(survey['bags'][0], dict(
            index=0, present=True, pointer='ok', vtable_rva=CANDIDATE['vtable'], vtable_in_module=True,
            vtable_is_active=False, candidate_class='ItCliBag', definition_getter_dispatch=True,
            definition_pointer='ok', definition_type=3, payload_pointer='ok', size=20))
        self.assertEqual(survey['bags'][4], dict(index=4, present=False))
        self.assertEqual(survey['hypothetical_capacity_if_dispatch_accepted'], 112)
        text = json.dumps(result)
        for item, definition, payload in fixture.items.values():
            for address in (item, definition, payload):
                self.assertNotIn(str(address), text)
                self.assertNotIn(hex(address), text)

    def test_accepted_class_keeps_the_normal_verdict(self):
        result = self.diagnose(Fixture())
        self.assertEqual((result['status'], result['candidate_capacity_slots']), ('candidate_bag_capacity', 112))
        self.assertNotIn('stage', result)
        self.assertIn('bag_size[3]', result['passed'])
        self.assertTrue(all(row['vtable_is_active'] for row in result['survey']['bags'][:4]))
        self.assertEqual(result['survey']['hypothetical_capacity_if_dispatch_accepted'], 112)

    def test_pointer_faults_are_named_without_their_value(self):
        cases = (('null', 'inventory', lambda f: f.qword(CHARACTER + 0x3F0, 0)),
                 ('unmapped', 'inventory', lambda f: f.qword(CHARACTER + 0x3F0, 0x500000)),
                 ('unaligned', 'bag_pointer[1]', lambda f: f.qword(INVENTORY + 0x388, f.items[1][0] + 4)),
                 ('out_of_user_range', 'bag_pointer[1]', lambda f: f.qword(INVENTORY + 0x388, 1 << 60)))
        for fault, stage, change in cases:
            with self.subTest(fault=fault):
                fixture = Fixture()
                change(fixture)
                result = self.diagnose(fixture)
                self.assertEqual((result['status'], result['pointer_fault'], result['stage']),
                                 ('unknown', fault, stage))
                self.assertNotIn('observed_rva', result)

    def test_unaligned_definition_stays_unknown_and_is_visible_in_the_survey(self):
        fixture = Fixture(sizes=(20, None))
        fixture.bag(1, 32, misalign=4)
        result = self.diagnose(fixture)
        self.assertEqual((result['status'], result['reason'], result['stage'], result['pointer_fault']),
                         ('unknown', 'null_or_invalid_pointer', 'bag_definition[1]', 'unaligned'))
        row = result['survey']['bags'][1]
        self.assertEqual((row['definition_pointer'], row['payload_pointer'], row['size']),
                         ('unaligned', 'unaligned', 32))
        self.assertEqual(result['survey']['hypothetical_capacity_if_dispatch_accepted'], 52)

    def test_vtable_outside_the_module_is_reported_as_such(self):
        fixture = Fixture()
        fixture.qword(fixture.items[0][0], HEAP + 0x8000)
        result = self.diagnose(fixture)
        self.assertEqual((result['reason'], result['observed_rva'], result['observed_in_module']),
                         ('bag_item_vtable', None, False))
        self.assertEqual(result['survey']['bags'][0]['vtable_in_module'], False)
        self.assertNotIn('hypothetical_capacity_if_dispatch_accepted', result['survey'])

    def test_class_without_the_guarded_getter_gets_no_size_and_no_hypothetical(self):
        fixture = Fixture()
        fixture.qword(fixture.items[2][0], BASE + 0x123400)
        row = self.diagnose(fixture)['survey']['bags'][2]
        self.assertEqual((row['vtable_rva'], row['definition_getter_dispatch'], row['candidate_class']),
                         (0x123400, False, None))
        self.assertNotIn('size', row)
        self.assertNotIn('hypothetical_capacity_if_dispatch_accepted', self.diagnose(fixture)['survey'])

    def test_survey_failure_is_reported_and_never_becomes_a_value(self):
        fixture = Fixture()
        fixture.qword(INVENTORY, BASE + 0x123400)
        result = self.diagnose(fixture)
        self.assertEqual((result['status'], result['stage'], result['observed_rva']), ('unknown', 'inventory', 0x123400))
        self.assertEqual(result['survey'], dict(bags=[], error='inventory_vtable'))

    def test_main_diagnose_with_sixteen_rejected_bags_fits_the_budget(self):
        fixture = candidate_class_fixture(sizes=(32,) * 16)
        output = io.StringIO()
        arguments = ['probe.py', '--pid', '1', '--module-base', hex(BASE), '--context', hex(CONTEXT), '--diagnose']
        with (mock.patch('sys.argv', arguments),
              mock.patch.object(probe, 'prepare_process', return_value=fixture.ranges),
              mock.patch.object(probe.os, 'open', return_value=123),
              mock.patch.object(probe.os, 'close'),
              mock.patch.object(probe.os, 'pread', side_effect=lambda fd, size, address: fixture.read(size, address)),
              contextlib.redirect_stdout(output)):
            exit_code = probe.main()
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(exit_code, 2)
        self.assertEqual(rows[0]['survey']['hypothetical_capacity_if_dispatch_accepted'], 512)
        self.assertLessEqual(rows[1]['bytes_requested'], probe.MAX_BYTES)
        self.assertEqual(rows[1]['game_writes'], 0)


if __name__ == '__main__':
    unittest.main()
