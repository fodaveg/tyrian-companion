#!/usr/bin/env python3
"""Positive and fail-closed tests; sparse fixture, never opens a real process."""
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import inventory_reader_v3 as inv
from state_reader import Reader, Rejected
from test_state_reader import BASE, ITEM, ITEMCTX, REF, fixture as item_fixture

CONTEXT=0x100000
CHARCTX=0x109000
CHARACTER=0x10a000
INVENTORY=0x10b000
SLOTS=0x10c000
ITEMVT=BASE+0x225c148


def fixture(count=570):
    reader,put,calls=item_fixture()
    reader.ranges[0]=(0x100000,0x140000)
    put(CONTEXT+0x98,CHARCTX)
    put(CONTEXT+0x178,ITEMCTX)
    put(CHARCTX,BASE+0x215cf48)
    put(BASE+0x215cf48+0x68,BASE+0x11b4480)
    put(CHARCTX+0x98,CHARACTER)
    put(CHARACTER+0x178,0x18,4)
    put(CHARACTER+8,BASE+0x21601d0)
    put(BASE+0x21601d0+0xc8,BASE+0x11d74d0)
    put(CHARACTER+0x3f0,INVENTORY)
    put(INVENTORY,BASE+0x21621a8)
    put(BASE+0x21621a8+0x220,BASE+0x45dd90)
    put(BASE+0x21621a8+0x190,BASE+0x11ee3d0)
    put(INVENTORY+0x70,CHARACTER)
    put(INVENTORY+0xc8,SLOTS)
    put(INVENTORY+0xd0,count,4)
    put(INVENTORY+0xd4,count,4)
    put(SLOTS,ITEM)
    put(ITEM+0x48,3,2)
    put(ITEM+0x58,INVENTORY)
    put(ITEMVT+0xa0,BASE+0x13c46d0)
    return reader,put,calls


def snapshot(reader):
    reader.bytes_read=0
    return inv.owned_inventory_snapshot(reader,BASE,CONTEXT)


class InventoryTests(unittest.TestCase):
    def conditional_fixture(self,primary):
        reader,put,calls=fixture()
        profile={
            0x225d580:(0xa8,0x225d898,0,0x13c9d60,5,0,1,0x98,0x13c9d20),
            0x225dd78:(0xa8,0x225e080,0,0x13ca590,10,0,1,0x98,0x13c9d20),
            0x225d910:(0xe0,0x225dcb8,0x20,0x13ca130,9,0x18,4,0xe8,0x13c9f60),
        }[primary]
        embedded,embedded_vt,slot,predicate,subtype,field,value,stack_offset,stack_getter=profile
        for offset,getter in ((8,0x13c3e10),(0x68,0x31b980),(0x70,0x13c45d0),
                (0xa0,0x13c46d0),(0x260,stack_getter)):
            put(BASE+primary+offset,BASE+getter)
        put(ITEM,BASE+primary)
        put(ITEM+embedded,BASE+embedded_vt)
        put(BASE+embedded_vt+slot,BASE+predicate)
        definition=0x108000;payload=0x120000
        put(definition+0x2c,subtype,4);put(definition+0x30,payload)
        put(payload+field,value,4)
        put(ITEM+stack_offset,BASE+0x225c460)
        put(ITEM+stack_offset+8,7,4)
        return reader,put,calls,profile,payload

    def test_three_conditional_profiles_true_and_false(self):
        for primary in (0x225d580,0x225dd78,0x225d910):
            reader,put,calls,profile,payload=self.conditional_fixture(primary)
            value=snapshot(reader)
            self.assertEqual(value['quantities'],{'19701':7})
            self.assertEqual(value['items'][0]['quantity_source'],'conditional_stackable_GetQuantity')
            put(payload+profile[5],0,4)
            value=snapshot(reader)
            self.assertEqual(value['quantities'],{'19701':1})
            self.assertEqual(value['items'][0]['quantity_source'],
                'GetStackQuantity_verified_conditional_NULL_fallback')

    def test_conditional_wrong_getter_payload_subtype_or_quantity_rejected(self):
        for failure in ('getter','payload','subtype','quantity'):
            reader,put,calls,profile,payload=self.conditional_fixture(0x225d580)
            if failure=='getter':put(BASE+0x225d898,BASE+0x13c9d68)
            if failure=='payload':put(0x108000+0x30,0xdeadbeef)
            if failure=='subtype':put(0x108000+0x2c,9,4)
            if failure=='quantity':put(ITEM+0xa0,251,4)
            with self.assertRaises(Rejected):snapshot(reader)
            if failure=='payload':self.assertFalse(any(a==0xdeadbeef for _,a in calls))

    def test_conditional_predicate_race_rejected(self):
        reader,put,calls,profile,payload=self.conditional_fixture(0x225d580)
        original=reader.pread;seen=0
        def pread(size,address):
            nonlocal seen
            if address==payload:
                seen+=1
                if seen==2:put(payload,0,4)
            return original(size,address)
        reader.pread=pread
        with self.assertRaisesRegex(Rejected,'concurrent_conditional_definition_change'):
            snapshot(reader)

    def test_location4_array_is_never_read(self):
        reader,put,calls=fixture()
        # Old candidate followed this different section; even unmapped here is harmless.
        put(INVENTORY+0xa8,0xdeadbeef)
        put(INVENTORY+0xb0,570,4)
        put(INVENTORY+0xb4,570,4)
        value=snapshot(reader)
        self.assertEqual(value['quantities'],{'19701':3})
        forbidden={INVENTORY+0xa8,INVENTORY+0xb0,INVENTORY+0xb4,0xdeadbeef}
        self.assertFalse(any(address in forbidden for _,address in calls))

    def test_positive_570_id_quantity_location_and_owner(self):
        reader,put,calls=fixture()
        value=snapshot(reader)
        self.assertEqual(value['slot_structure_length'],570)
        self.assertEqual(value['quantities'],{'19701':3})
        self.assertEqual([(x['instance_ref'],x['location_type']) for x in value['items']],[(17,3)])
        self.assertLess(reader.bytes_read,inv.SNAPSHOT_BYTE_BUDGET)

    def test_640_accepts_641_rejects_before_array(self):
        reader,put,calls=fixture(640)
        self.assertEqual(snapshot(reader)['slot_structure_length'],640)
        calls.clear()
        put(INVENTORY+0xd0,641,4)
        put(INVENTORY+0xd4,641,4)
        with self.assertRaisesRegex(Rejected,'inventory_slot_bounds'):snapshot(reader)
        self.assertFalse(any(SLOTS<=a<SLOTS+641*8 for _,a in calls))

    def test_wrong_owner_rejects_before_array(self):
        reader,put,calls=fixture()
        put(INVENTORY+0x70,CHARACTER+0x1000)
        with self.assertRaisesRegex(Rejected,'inventory_owner_mismatch'):snapshot(reader)
        self.assertFalse(any(SLOTS<=a<SLOTS+570*8 for _,a in calls))

    def test_invalid_pointer_rejects_before_dereference(self):
        reader,put,calls=fixture()
        put(INVENTORY+0xc8,0xdeadbeef)
        with self.assertRaisesRegex(Rejected,'unmapped_pointer'):snapshot(reader)
        self.assertFalse(any(a==0xdeadbeef for _,a in calls))

    def test_final_quantity_getter_verified(self):
        reader,put,calls=fixture()
        put(ITEMVT+0xa0,BASE+0x13c46d8)
        with self.assertRaisesRegex(Rejected,'final_GetStackQuantity_getter'):snapshot(reader)
        self.assertFalse(any(a==ITEM+0xa0 for _,a in calls))

    def test_location_filter_precedes_definition_and_quantity(self):
        for location in (0,1,2,4,6,7,10):
            reader,put,calls=fixture()
            put(ITEM+0x48,location,2)
            value=snapshot(reader)
            self.assertEqual(value['items'],[])
            self.assertFalse(any(a in (ITEM+0x40,ITEM+0xa0) for _,a in calls))

    def test_item_owner_mismatch(self):
        reader,put,calls=fixture()
        put(ITEM+0x58,INVENTORY+0x1000)
        with self.assertRaisesRegex(Rejected,'item_inventory_owner_mismatch'):snapshot(reader)

    def test_root_counter_array_or_slot_change_rejected(self):
        for address,changed,size,reason in (
                (INVENTORY+0xd4,569,4,'concurrent_inventory_root_change'),
                (INVENTORY+0xc8,SLOTS+8,8,'concurrent_inventory_root_change'),
                (SLOTS,0,8,'concurrent_inventory_slot_change')):
            reader,put,calls=fixture()
            original=reader.pread
            reads=0
            def pread(length,where):
                nonlocal reads
                if where==address:
                    reads+=1
                    if reads==2:put(address,changed,size)
                return original(length,where)
            reader.pread=pread
            with self.assertRaisesRegex(Rejected,reason):snapshot(reader)

    def test_unsupported_quantity_not_guessed(self):
        reader,put,calls=fixture()
        put(ITEMVT+0x260,BASE+0x13c1230)
        value=snapshot(reader)
        self.assertEqual(value['items'][0]['quantity'],None)
        self.assertEqual(value['quantities'],{})
        self.assertEqual(value['unsupported_quantity_type_ids'],[19701])

    def test_baseline_then_confirmed_stack_merge_delta(self):
        reader,put,calls=fixture()
        before=snapshot(reader)
        tracker=inv.StableDeltas()
        self.assertIsNone(tracker.push(before))
        event=tracker.push(before)
        self.assertEqual(event['kind'],'baseline')
        self.assertFalse(event['acquisition'])
        put(ITEM+0xa0,5,4)
        after=snapshot(reader)
        self.assertIsNone(tracker.push(after))
        delta=tracker.push(after)
        self.assertEqual(delta['changes'],[dict(item_type_id=19701,before=3,after=5,
            quantity_delta=2,instance_refs_before=[REF],instance_refs_after=[REF],location_type=3)])

    def test_slot_movement_same_total_has_no_delta(self):
        reader,put,calls=fixture()
        before=snapshot(reader)
        tracker=inv.StableDeltas()
        tracker.push(before);tracker.push(before)
        put(SLOTS,0);put(SLOTS+8,ITEM)
        moved=snapshot(reader)
        self.assertEqual(moved['items'][0]['slot'],1)
        self.assertIsNone(tracker.push(moved))
        self.assertIsNone(tracker.push(moved))

    def test_unknown_quantity_change_never_becomes_delta(self):
        reader,put,calls=fixture()
        before=snapshot(reader)
        tracker=inv.StableDeltas()
        tracker.push(before);tracker.push(before)
        put(ITEMVT+0x260,BASE+0x13c1230)
        unknown=snapshot(reader)
        self.assertIsNone(tracker.push(unknown));self.assertIsNone(tracker.push(unknown))

    def test_character_inventory_change_requires_new_baseline(self):
        reader,put,calls=fixture()
        before=snapshot(reader)
        tracker=inv.StableDeltas()
        tracker.push(before);tracker.push(before)
        other=copy.deepcopy(before)
        other['inventory_pointer']='0x120000';other['quantities']['19701']=5
        self.assertIsNone(tracker.push(other))
        self.assertEqual(tracker.push(other)['kind'],'baseline')

    def test_duration_interval_and_total_budget_bounds(self):
        self.assertEqual(inv.observation_limits(300,.1,inv.DEFAULT_TOTAL_BYTE_BUDGET),3001)
        for duration,interval,budget in ((301,.1,inv.DEFAULT_TOTAL_BYTE_BUDGET),
                (300,.099,inv.DEFAULT_TOTAL_BYTE_BUDGET),(-1,.1,inv.DEFAULT_TOTAL_BYTE_BUDGET),
                (300,.1,131071),(300,.1,inv.DEFAULT_TOTAL_BYTE_BUDGET+1)):
            with self.assertRaises(Rejected):inv.observation_limits(duration,interval,budget)

    def test_failure_logged_before_first_normal_event(self):
        for failure,klass,code in ((Rejected('fixture_controlled_failure'),'Rejected',None),
                (OSError(5,'fixture_short_read'),'OSError',5)):
            with tempfile.TemporaryDirectory(prefix='inventory-fixture-') as folder:
                destination=Path(folder)/'output.jsonl'
                argv=['inventory_reader.py','--pid','123','--context',hex(CONTEXT),
                      '--seconds','0','--output',str(destination)]
                with patch('sys.argv',argv), patch.object(inv,'maps_for',return_value=([],BASE)), \
                        patch.object(inv.os,'open',return_value=99),patch.object(inv.os,'close'), \
                        patch.object(inv,'owned_inventory_snapshot',side_effect=failure), \
                        patch('sys.stdout',new=io.StringIO()):
                    inv.main()
                records=[json.loads(line) for line in destination.read_text().splitlines()]
                self.assertEqual([r['kind'] for r in records],
                    ['observation_started','snapshot_rejected','observation_finished'])
                self.assertEqual(records[1]['error_class'],klass)
                self.assertEqual(records[1]['errno'],code)
                self.assertEqual(records[-1]['valid_snapshots'],0)


if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(InventoryTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    report=dict(fixture='sparse synthetic memory; no process accessed',tests=result.testsRun,
                failures=len(result.failures),errors=len(result.errors),ok=result.wasSuccessful())
    (Path(__file__).resolve().parent/'inventory-reader-v3-tests.json').write_text(json.dumps(report,indent=2)+'\n')
    raise SystemExit(0 if result.wasSuccessful() else 1)
