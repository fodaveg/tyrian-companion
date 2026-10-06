#!/usr/bin/env python3
"""Exercise the exact state reader against a sparse synthetic memory fixture."""
import json
from pathlib import Path
import struct
import unittest

from state_reader import Reader, Rejected, item_snapshot, loot_references

BASE=0x140000000
ITEMCTX=0x101000
LOOTCTX=0x102000
REF=17
ITEM=0x107000


def fixture():
    memory={}
    def put(address,value,size=8):
        for i,b in enumerate(value.to_bytes(size,'little')):
            memory[address+i]=b
    put(ITEMCTX,BASE+0x225bd00)
    put(BASE+0x225bd10,BASE+0x13c6400)
    put(ITEMCTX+0x30,0x106000)
    put(ITEMCTX+0x38,64,4)
    put(ITEMCTX+0x3c,32,4)
    put(0x106000+8*REF,ITEM)
    vtable=BASE+0x225c148
    put(ITEM,vtable)
    put(vtable+8,BASE+0x13c3e10)
    put(vtable+0x68,BASE+0x31b980)
    put(vtable+0x70,BASE+0x13c45d0)
    put(vtable+0x260,BASE+0x84c310)
    put(ITEM+0x38,REF,4)
    put(ITEM+0x40,0x108000)
    put(0x108000+0x28,19701,4)
    put(ITEM+0x48,7,2)
    put(ITEM+0x98,BASE+0x225c460)
    put(BASE+0x225c460,BASE+0x168d10)
    put(ITEM+0xa0,3,4)
    put(LOOTCTX+0x54,1,4)
    put(LOOTCTX+0x58,0x103000)
    put(0x103008,0x104000)
    put(0x104000,BASE+0x22d8230)
    put(0x104010,0x105000)
    put(0x104018,8,4)
    put(0x10401c,1,4)
    put(0x104054,444,4)
    put(0x105000,REF,4)
    put(0x105004,999,4)
    calls=[]
    def pread(size,address):
        calls.append((size,address))
        return bytes(memory.get(address+i,0) for i in range(size))
    ranges=[(0x100000,0x110000),(BASE,BASE+0x2c48000)]
    return Reader(ranges,pread),put,calls


class StateReaderTests(unittest.TestCase):
    def test_positive_exact_id_quantity_and_player_separation(self):
        reader,put,calls=fixture()
        refs=loot_references(reader,BASE,LOOTCTX)
        self.assertEqual(refs,[dict(instance_ref=17,player_id=999,lootable_id=444)])
        item=item_snapshot(reader,BASE,ITEMCTX,17)
        self.assertEqual((item['item_type_id'],item['quantity'],item['location_type']),
                         (19701,3,7))
        put(ITEM+0xa0,5,4)
        put(ITEM+0x48,3,2)
        after=item_snapshot(reader,BASE,ITEMCTX,17)
        self.assertEqual((after['quantity'],after['location_type']),(5,3))

    def test_invalid_range_never_calls_pread(self):
        reader,put,calls=fixture()
        for address,size in ((0,8),(0x10ffff,2),(0x200000,8),(0x100000,4097)):
            with self.assertRaises(Rejected):reader.read(address,size)
        self.assertEqual(calls,[])

    def test_invalid_pointer(self):
        reader,put,calls=fixture()
        put(ITEMCTX+0x30,0xdeadbeef)
        with self.assertRaisesRegex(Rejected,'unmapped_pointer'):
            item_snapshot(reader,BASE,ITEMCTX,17)

    def test_wrong_vtable(self):
        reader,put,calls=fixture()
        put(ITEMCTX,BASE+0x225bd08)
        with self.assertRaisesRegex(Rejected,'item_context_vtable'):
            item_snapshot(reader,BASE,ITEMCTX,17)

    def test_bad_counter(self):
        reader,put,calls=fixture()
        put(ITEMCTX+0x3c,65,4)
        with self.assertRaisesRegex(Rejected,'item_array_bounds'):
            item_snapshot(reader,BASE,ITEMCTX,17)

    def test_excess_quantity(self):
        reader,put,calls=fixture()
        put(ITEM+0xa0,251,4)
        with self.assertRaisesRegex(Rejected,'stack_quantity_bounds'):
            item_snapshot(reader,BASE,ITEMCTX,17)

    def test_read_budget_and_short_read(self):
        reader,put,calls=fixture()
        reader.budget=4
        with self.assertRaisesRegex(Rejected,'byte_budget'):reader.read(ITEMCTX,8)
        self.assertEqual(calls,[])
        reader.budget=100
        reader.pread=lambda size,address:bytes(size-1)
        with self.assertRaises(OSError) as failure:reader.read(ITEMCTX,8)
        self.assertEqual(failure.exception.errno,5)


if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(StateReaderTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    report=dict(fixture='sparse synthetic memory; no process accessed',
                tests=result.testsRun,failures=len(result.failures),errors=len(result.errors),
                ok=result.wasSuccessful())
    (Path(__file__).resolve().parent/'state-reader-tests.json').write_text(json.dumps(report,indent=2)+'\n')
    raise SystemExit(0 if result.wasSuccessful() else 1)
