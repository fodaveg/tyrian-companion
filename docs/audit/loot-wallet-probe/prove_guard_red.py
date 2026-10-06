#!/usr/bin/env python3
"""Deliberately remove the real vtable guard; its targeted fixture must go red.

This only runs against owned synthetic bytes and never accesses a live process.
The expected exit code is 1. The unmodified test suite must subsequently pass.
"""
import unittest

import probe
from test_probe import WalletTests

original = probe.require_pointer


def missing_guard(reader, address, expected, reason):
    if reason not in ('currency_manager_vtable', 'concurrent_manager_vtable'):
        original(reader, address, expected, reason)


probe.require_pointer = missing_guard
suite = unittest.TestSuite([WalletTests('test_wrong_vtable_rejects_before_any_bucket_read')])
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
