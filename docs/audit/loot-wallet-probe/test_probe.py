#!/usr/bin/env python3
"""Controlled wallet fixtures; no live process, account API or game required."""
import errno
import contextlib
import io
import json
from pathlib import Path
import struct
import unittest
from unittest import mock

import probe

BASE = 0x140000000
CONTEXT = 0x200000
CHAR_CONTEXT = 0x210000
CHARACTER = 0x220000
MANAGER = CHARACTER + 0x1878
ENTRIES = 0x240000


class Fixture:
    """Owned sparse bytes with a read log and explicit race/short-read injection."""

    def __init__(self, value=100, capacity=64):
        self.memory = {}
        self.calls = []
        self.mutate = None
        self.short = None
        self.ranges = [(BASE, BASE + probe.PROFILE['image_size']), (CONTEXT, 0x260000)]
        for guard in probe.PROFILE['guards']:
            self.write(BASE + guard['rva'], bytes.fromhex(guard['hex']))
        self.qword(CONTEXT + 0x98, CHAR_CONTEXT)
        self.qword(CHAR_CONTEXT, BASE + probe.PROFILE['char_context_vtable'])
        self.qword(BASE + probe.PROFILE['char_context_vtable'] + 0x70, BASE + probe.PROFILE['char_context_getter'])
        self.qword(CHAR_CONTEXT + 0xA0, CHARACTER)
        self.qword(CHARACTER, BASE + probe.PROFILE['character_vtable'])
        self.qword(BASE + probe.PROFILE['character_vtable'] + 0x250, BASE + probe.PROFILE['character_wallet_getter'])
        self.qword(MANAGER, BASE + probe.PROFILE['currency_manager_vtable'])
        self.qword(BASE + probe.PROFILE['currency_manager_vtable'], BASE + probe.PROFILE['balance_getter'])
        self.write(MANAGER + 8, struct.pack('<IIQ', capacity, 1, ENTRIES))
        self.target = ENTRIES + 12 * (probe.PROFILE['currency_hash'] & (capacity - 1))
        self.entry(self.target, 45, value, probe.PROFILE['currency_hash'])

    def write(self, address, data):
        self.memory.update({address + offset: value for offset, value in enumerate(data)})

    def qword(self, address, value):
        self.write(address, struct.pack('<Q', value))

    def entry(self, address, key, value, occupied):
        self.write(address, struct.pack('<III', key, value, occupied))

    def read(self, size, address):
        self.calls.append((address, size))
        if self.mutate:
            self.mutate(self, address, size)
        data = bytes(self.memory.get(address + offset, 0) for offset in range(size))
        return data[:-1] if self.short == address else data

    def reader(self, budget=probe.MAX_BYTES):
        return probe.Reader(self.ranges, self.read, budget)


class WalletTests(unittest.TestCase):
    def observe(self, fixture, reader=None):
        result, _owner = probe.observe(reader or fixture.reader(), BASE, CONTEXT)
        return result

    def assert_unknown(self, fixture, reason, reader=None):
        result = self.observe(fixture, reader)
        self.assertEqual(result['status'], 'unknown')
        self.assertIsNone(result['candidate_value'])
        self.assertEqual(result['reason'], reason)

    def test_positive_six_delta_with_full_static_guard(self):
        fixture = Fixture(100)
        reader = fixture.reader()
        probe.guard_profile(reader, BASE)
        first, owner = probe.observe(reader, BASE, CONTEXT)
        fixture.entry(fixture.target, 45, 106, probe.PROFILE['currency_hash'])
        second, next_owner = probe.observe(reader, BASE, CONTEXT)
        self.assertEqual(first['status'], 'candidate_balance')
        self.assertEqual(second['candidate_value'] - first['candidate_value'], 6)
        self.assertEqual(owner, next_owner)
        self.assertFalse(second['native_key_mapping_proven'])
        self.assertFalse(second['acquisition_proven'])
        self.assertEqual(reader.buckets, 4)
        self.assertLessEqual(reader.requested, 4096)

    def test_supported_zero_is_distinct_from_unknown(self):
        result = self.observe(Fixture(0))
        self.assertEqual((result['status'], result['candidate_value']), ('candidate_balance', 0))

    def test_wrong_vtable_rejects_before_any_bucket_read(self):
        fixture = Fixture()
        fixture.qword(MANAGER, BASE + 0x123400)
        reader = fixture.reader()
        self.assert_unknown(fixture, 'currency_manager_vtable', reader)
        self.assertEqual(reader.buckets, 0)

    def test_wrong_getter_rejects(self):
        fixture = Fixture()
        fixture.qword(BASE + probe.PROFILE['character_vtable'] + 0x250, BASE + 0x123400)
        self.assert_unknown(fixture, 'wallet_manager_getter')

    def test_wrong_character_context_rejects(self):
        fixture = Fixture()
        fixture.qword(CHAR_CONTEXT, BASE + 0x123400)
        self.assert_unknown(fixture, 'character_context_vtable')

    def test_invalid_capacity_rejects(self):
        for capacity, count in [(0, 0), (3, 1), (8192, 1), (64, 65)]:
            with self.subTest(capacity=capacity, count=count):
                fixture = Fixture()
                fixture.write(MANAGER + 8, struct.pack('<IIQ', capacity, count, ENTRIES))
                self.assert_unknown(fixture, 'currency_map_bounds')

    def test_null_pointer_rejects(self):
        fixture = Fixture()
        fixture.qword(CHAR_CONTEXT + 0xA0, 0)
        self.assert_unknown(fixture, 'null_or_invalid_pointer')

    def test_unmapped_pointer_rejects(self):
        fixture = Fixture()
        fixture.qword(CHAR_CONTEXT + 0xA0, 0x300000)
        self.assert_unknown(fixture, 'unmapped_pointer')

    def test_invalid_map_pointer_rejects(self):
        fixture = Fixture()
        fixture.qword(MANAGER + 0x10, ENTRIES + 1)
        self.assert_unknown(fixture, 'currency_map_pointer')

    def test_wrong_key_is_unknown_not_zero(self):
        fixture = Fixture()
        fixture.entry(fixture.target, 44, 106, probe.PROFILE['currency_hash'])
        self.assert_unknown(fixture, 'currency_key_unobserved')

    def test_wrong_hash_is_unknown_not_zero(self):
        fixture = Fixture()
        fixture.entry(fixture.target, 45, 106, probe.PROFILE['currency_hash'] ^ 1)
        self.assert_unknown(fixture, 'currency_key_hash_mismatch')

    def test_empty_map_is_unknown_not_zero(self):
        fixture = Fixture()
        fixture.write(MANAGER + 8, struct.pack('<IIQ', 64, 0, ENTRIES))
        self.assert_unknown(fixture, 'currency_key_unobserved')

    def test_collision_lookup_and_wrap(self):
        fixture = Fixture(capacity=8)
        first = probe.PROFILE['currency_hash'] & 7
        for step in range(3):
            fixture.entry(ENTRIES + 12 * ((first + step) & 7), 100 + step, 999, 123)
        fixture.entry(ENTRIES + 12 * ((first + 3) & 7), 45, 106, probe.PROFILE['currency_hash'])
        fixture.write(MANAGER + 8, struct.pack('<IIQ', 8, 4, ENTRIES))
        self.assertEqual(self.observe(fixture)['candidate_value'], 106)

    def test_collision_cap_has_at_most_sixteen_bucket_reads(self):
        fixture = Fixture()
        first = probe.PROFILE['currency_hash'] & 63
        for step in range(17):
            fixture.entry(ENTRIES + 12 * ((first + step) & 63), 100 + step, 999, 123)
        fixture.write(MANAGER + 8, struct.pack('<IIQ', 64, 17, ENTRIES))
        reader = fixture.reader()
        self.assert_unknown(fixture, 'currency_bucket_limit', reader)
        self.assertEqual(reader.buckets, 15)

    def test_changed_header_rejects(self):
        fixture = Fixture()
        def mutate(memory, address, size):
            if address == MANAGER + 8 and sum(at == address for at, _ in memory.calls) == 2:
                memory.write(address, struct.pack('<IIQ', 128, 1, ENTRIES))
        fixture.mutate = mutate
        self.assert_unknown(fixture, 'concurrent_wallet_change')

    def test_changed_owner_rejects(self):
        fixture = Fixture()
        def mutate(memory, address, size):
            if address == CHAR_CONTEXT + 0xA0 and sum(at == address for at, _ in memory.calls) == 2:
                memory.qword(address, CHARACTER + 0x1000)
        fixture.mutate = mutate
        self.assert_unknown(fixture, 'concurrent_wallet_change')

    def test_changed_balance_rejects(self):
        fixture = Fixture()
        def mutate(memory, address, size):
            if address == memory.target and sum(at == address for at, _ in memory.calls) == 2:
                memory.entry(address, 45, 106, probe.PROFILE['currency_hash'])
        fixture.mutate = mutate
        self.assert_unknown(fixture, 'concurrent_wallet_change')

    def test_short_read_rejects_without_partial_value(self):
        fixture = Fixture()
        fixture.short = fixture.target
        result = self.observe(fixture)
        self.assertEqual((result['status'], result['reason'], result['errno']), ('unknown', 'read_failed', errno.EIO))
        self.assertIsNone(result['candidate_value'])

    def test_byte_budget_rejects_before_more_reads(self):
        fixture = Fixture()
        reader = fixture.reader(budget=8)
        self.assert_unknown(fixture, 'byte_budget', reader)
        self.assertEqual(reader.requested, 8)

    def test_out_of_mapping_rejects_before_read(self):
        fixture = Fixture()
        reader = fixture.reader()
        with self.assertRaisesRegex(probe.Rejected, 'mapping_range'):
            reader.read(0x300000, 12)
        self.assertEqual(fixture.calls, [])

    def test_static_guard_mutation_fails_then_restoration_passes(self):
        fixture = Fixture()
        guard = probe.PROFILE['guards'][0]
        address = BASE + guard['rva']
        fixture.write(address, b'\x00')
        with self.assertRaisesRegex(probe.Rejected, 'static_guard_local_character'):
            probe.guard_profile(fixture.reader(), BASE)
        fixture.write(address, bytes.fromhex(guard['hex']))
        probe.guard_profile(fixture.reader(), BASE)

    def test_main_owner_change_between_samples_does_not_project_delta(self):
        fixture = Fixture()
        output = io.StringIO()
        def change_owner(_delay):
            next_character = CHARACTER + 0x3000
            fixture.qword(CHAR_CONTEXT + 0xA0, next_character)
            fixture.qword(next_character, BASE + probe.PROFILE['character_vtable'])
            fixture.qword(next_character + 0x1878, BASE + probe.PROFILE['currency_manager_vtable'])
            fixture.write(next_character + 0x1880, struct.pack('<IIQ', 64, 1, ENTRIES))
            fixture.entry(fixture.target, 45, 106, probe.PROFILE['currency_hash'])
        arguments = ['probe.py', '--pid', '1', '--module-base', hex(BASE), '--context', hex(CONTEXT), '--samples', '2']
        with (mock.patch('sys.argv', arguments),
              mock.patch.object(probe, 'prepare_process', return_value=fixture.ranges),
              mock.patch.object(probe.os, 'open', return_value=123),
              mock.patch.object(probe.os, 'close'),
              mock.patch.object(probe.os, 'pread', side_effect=lambda fd, size, address: fixture.read(size, address)),
              mock.patch.object(probe.time, 'sleep', side_effect=change_owner),
              contextlib.redirect_stdout(output)):
            self.assertEqual(probe.main(), 0)
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(rows[1]['status'], 'candidate_balance')
        self.assertEqual(rows[1]['continuity'], 'owner_changed')
        self.assertNotIn('candidate_net_change', rows[1])


if __name__ == '__main__':
    unittest.main()
