#!/usr/bin/env python3
"""Deliberately remove two real guards, one at a time; each one's fixture must go red.

1. The inventory vtable guard, at both its initial and its recheck site.
2. The content pointer alignment guard.

This only runs against owned synthetic bytes and never accesses a live process.
The expected exit code is 1: every removed guard was missed by its test. Exit 3 means
a guard was removed and its test still passed, so that guard measures nothing.
The unmodified test suite must subsequently pass.
"""
import unittest

import probe
from test_probe import BagCapacityTests

require_pointer = probe.require_pointer
aligned = probe.Reader.aligned


def without_inventory_vtable(reader, address, expected, reason):
    if reason not in ('inventory_vtable', 'concurrent_inventory_vtable'):
        require_pointer(reader, address, expected, reason)


def run(test, cases):
    """True when every case of the test failed: the removed guard was the one catching it."""
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([BagCapacityTests(test)]))
    return len(result.failures) == cases and not result.errors


probe.require_pointer = without_inventory_vtable
vtable_red = run('test_wrong_inventory_vtable_rejects_before_any_bag_read', 1)
probe.require_pointer = require_pointer

probe.Reader.aligned = staticmethod(lambda value, content: content or aligned(value, content))
alignment_red = run('test_content_pointers_off_their_observed_alignment_reject', 4)
probe.Reader.aligned = staticmethod(aligned)

print(f'removed guards missed by their tests: vtable={vtable_red} content_alignment={alignment_red}')
raise SystemExit(1 if vtable_red and alignment_red else 3)
