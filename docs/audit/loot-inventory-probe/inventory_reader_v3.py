#!/usr/bin/env python3
"""Read controlled character location3 array+c8; log stable quantity deltas.

Inventory has distinct sections: +a8 is location4, NOT carried inventory.
The location3 switch and indexed getter select +c8/count+d4.
"""
import argparse
from collections import Counter
import json
import math
import os
from pathlib import Path
import time

from state_reader import EXPECTED_BINARY, Reader, Rejected, item_snapshot as original_item_snapshot, maps_for

MAX_SLOTS=640
SNAPSHOT_BYTE_BUDGET=131072
MAX_DURATION=300
DEFAULT_TOTAL_BYTE_BUDGET=400*1024*1024


def item_snapshot(reader,base,itemctx,instance_ref):
    result=original_item_snapshot(reader,base,itemctx,instance_ref)
    if not result.get('present') or result['quantity'] is not None:
        return result
    profiles={
        # primary vt: embedded offset, embedded vt, predicate slot/RVA, subtype,
        # payload condition offset/mask/value, Stackable offset.
        0x225d580:(0xa8,0x225d898,0,0x13c9d60,5,0,1,1,0x98),
        0x225dd78:(0xa8,0x225e080,0,0x13ca590,10,0,1,1,0x98),
        0x225d910:(0xe0,0x225dcb8,0x20,0x13ca130,9,0x18,0xffffffff,4,0xe8),
    }
    profile=profiles.get(int(result['vtable_rva'],16))
    if profile is None:
        return result
    embedded,embedded_vt,slot,predicate,subtype,field,mask,value,stack_offset=profile
    item=int(result['item_pointer'],16)
    primary=reader.pointer(item)
    expected_stackable=0x13c9f60 if embedded==0xe0 else 0x13c9d20
    if reader.pointer(primary+0x260)!=base+expected_stackable:
        raise Rejected('conditional_stackable_getter')
    if (reader.pointer(item+embedded)!=base+embedded_vt
            or reader.pointer(base+embedded_vt+slot)!=base+predicate):
        raise Rejected('conditional_predicate_getter')
    definition=reader.pointer(item+0x40)
    if reader.scalar(definition+0x2c,4)!=subtype:
        raise Rejected('conditional_definition_subtype')
    payload=reader.pointer(definition+0x30)
    if not payload:
        raise Rejected('conditional_null_payload')
    condition=reader.scalar(payload+field,4)
    if condition&mask==value:
        stack_vtable=reader.pointer(item+stack_offset)
        if reader.pointer(stack_vtable)!=base+0x168d10:
            raise Rejected('conditional_stack_quantity_getter')
        quantity=reader.scalar(item+stack_offset+8,4)
        if not 0<=quantity<=250:
            raise Rejected('conditional_stack_quantity_bounds')
        quantity_source='conditional_stackable_GetQuantity'
    else:
        quantity=1
        quantity_source='GetStackQuantity_verified_conditional_NULL_fallback'
    if (reader.pointer(item)!=primary or reader.pointer(item+0x40)!=definition
            or reader.pointer(definition+0x30)!=payload
            or reader.scalar(definition+0x2c,4)!=subtype
            or reader.scalar(payload+field,4)!=condition):
        raise Rejected('concurrent_conditional_definition_change')
    result['quantity']=quantity
    result['quantity_source']=quantity_source
    return result


def owned_inventory_snapshot(reader,base,context):
    charctx=reader.pointer(context+0x98)
    if reader.pointer(charctx)!=base+0x215cf48:
        raise Rejected('character_context_vtable')
    if reader.pointer(base+0x215cf48+0x68)!=base+0x11b4480:
        raise Rejected('controlled_character_getter')
    character=reader.pointer(charctx+0x98)
    if not character or not reader.scalar(character+0x178,4)&0x10:
        raise Rejected('controlled_character_flag')
    char_secondary=reader.pointer(character+8)
    if char_secondary!=base+0x21601d0 or reader.pointer(char_secondary+0xc8)!=base+0x11d74d0:
        raise Rejected('controlled_inventory_getter')
    inventory=reader.pointer(character+0x3f0)
    if not inventory or reader.pointer(inventory)!=base+0x21621a8:
        raise Rejected('owned_inventory_vtable')
    if reader.pointer(base+0x21621a8+0x220)!=base+0x45dd90:
        raise Rejected('inventory_owner_getter')
    if reader.pointer(inventory+0x70)!=character:
        raise Rejected('inventory_owner_mismatch')
    if reader.pointer(base+0x21621a8+0x190)!=base+0x11ee3d0:
        raise Rejected('inventory_location3_index_getter')
    count=reader.scalar(inventory+0xd4,4)
    capacity=reader.scalar(inventory+0xd0,4)
    if not 0<=count<=capacity<=MAX_SLOTS:
        raise Rejected('inventory_slot_bounds')
    array=reader.pointer(inventory+0xc8)
    if count and not array:
        raise Rejected('inventory_null_array')
    itemctx=reader.pointer(context+0x178)
    items=[]
    seen=set()
    slots=[]
    for slot in range(count):
        item=reader.pointer(array+slot*8)
        slots.append(item)
        if not item:
            continue
        vtable=reader.pointer(item)
        if not base+0x1913000<=vtable<base+0x2552390:
            raise Rejected('item_vtable_range')
        if reader.pointer(vtable+0x70)!=base+0x13c45d0:
            raise Rejected('item_location_getter')
        # Exclude equipment, bank/account, shared storage and lootable objects.
        if reader.scalar(item+0x48,2)&15!=3:
            continue
        if reader.pointer(item+0x58)!=inventory:
            raise Rejected('item_inventory_owner_mismatch')
        if reader.pointer(vtable+0xa0)!=base+0x13c46d0:
            raise Rejected('final_GetStackQuantity_getter')
        ref=reader.scalar(item+0x38,4)
        if ref in seen:
            raise Rejected('duplicate_inventory_instance')
        seen.add(ref)
        snapshot=item_snapshot(reader,base,itemctx,ref)
        if not snapshot.get('present') or snapshot['item_pointer']!=hex(item):
            raise Rejected('concurrent_inventory_item_change')
        if snapshot['location_type']!=3 or reader.pointer(item+0x58)!=inventory:
            raise Rejected('concurrent_inventory_location_change')
        snapshot['slot']=slot
        items.append(snapshot)
    if any(reader.pointer(array+slot*8)!=item for slot,item in enumerate(slots)):
        raise Rejected('concurrent_inventory_slot_change')
    if (reader.pointer(context+0x98)!=charctx or reader.pointer(charctx+0x98)!=character
            or reader.pointer(character+0x3f0)!=inventory
            or reader.scalar(inventory+0xd4,4)!=count
            or reader.pointer(inventory+0xc8)!=array):
        raise Rejected('concurrent_inventory_root_change')
    totals=Counter()
    unsupported=set()
    for item in items:
        if item['quantity'] is None:
            unsupported.add(item['item_type_id'])
        else:
            totals[item['item_type_id']]+=item['quantity']
    for type_id in unsupported:
        totals.pop(type_id,None)
    return dict(origin='controlled_character_inventory',inventory_pointer=hex(inventory),
                slot_structure_length=count,items=items,
                quantities={str(k):v for k,v in sorted(totals.items())},
                unsupported_quantity_type_ids=sorted(unsupported))


class StableDeltas:
    def __init__(self,confirmations=2):
        self.confirmations=confirmations
        self.pending=None
        self.streak=0
        self.previous=None
        self.previous_snapshot=None

    def push(self,snapshot):
        key=(tuple(sorted(snapshot['quantities'].items())),
             tuple(snapshot['unsupported_quantity_type_ids']),snapshot['inventory_pointer'])
        if key!=self.pending:
            self.pending=key
            self.streak=1
        else:
            self.streak+=1
        if self.streak<self.confirmations:
            return None
        if key==self.previous:
            self.previous_snapshot=snapshot
            return None
        if self.previous is None or self.previous[2]!=key[2]:
            self.previous=key
            self.previous_snapshot=snapshot
            return dict(kind='baseline',snapshot=snapshot,acquisition=False)
        before=dict(self.previous[0])
        after=dict(key[0])
        unknown=set(self.previous[1])|set(key[1])
        changes=[]
        for type_id in sorted(set(before)|set(after),key=int):
            if int(type_id) in unknown:
                continue
            delta=after.get(type_id,0)-before.get(type_id,0)
            if delta:
                prior_refs=[item['instance_ref'] for item in self.previous_snapshot['items']
                            if item['item_type_id']==int(type_id)]
                current_refs=[item['instance_ref'] for item in snapshot['items']
                              if item['item_type_id']==int(type_id)]
                changes.append(dict(item_type_id=int(type_id),before=before.get(type_id,0),
                                    after=after.get(type_id,0),quantity_delta=delta,
                                    instance_refs_before=sorted(prior_refs),
                                    instance_refs_after=sorted(current_refs),location_type=3))
        self.previous=key
        self.previous_snapshot=snapshot
        return dict(kind='inventory_quantity_delta',changes=changes,
                    confirmation_samples=self.confirmations,
                    origin='controlled_character_inventory') if changes else None


def observation_limits(seconds,interval,total_budget):
    if not 0<=seconds<=MAX_DURATION or not .1<=interval<=1:
        raise Rejected('observation_duration_or_interval')
    if not SNAPSHOT_BYTE_BUDGET<=total_budget<=DEFAULT_TOTAL_BYTE_BUDGET:
        raise Rejected('observation_total_budget')
    return math.ceil(seconds/interval)+1


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--pid',type=int,required=True)
    parser.add_argument('--context',type=lambda s:int(s,0),required=True)
    parser.add_argument('--seconds',type=float,default=300)
    parser.add_argument('--interval',type=float,default=.1)
    parser.add_argument('--total-byte-budget',type=int,default=DEFAULT_TOTAL_BYTE_BUDGET)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    max_samples=observation_limits(args.seconds,args.interval,args.total_byte_budget)
    ranges,base=maps_for(args.pid)
    fd=os.open(f'/proc/{args.pid}/mem',os.O_RDONLY)
    deadline=time.monotonic()+args.seconds
    tracker=StableDeltas(2)
    samples=valid=total_bytes=events=0
    errors=Counter()
    last_error=None
    stop='deadline'
    try:
        with args.output.open('w') as output:
            def emit(record):
                nonlocal events
                record['time_ns']=time.time_ns()
                output.write(json.dumps(record)+'\n')
                output.flush()
                events+=1
            emit(dict(kind='observation_started',pid=args.pid,context=hex(args.context),
                      binary_sha256=EXPECTED_BINARY,module_base=hex(base),duration_seconds=args.seconds,
                      interval_seconds=args.interval,max_samples=max_samples,
                      per_snapshot_byte_budget=SNAPSHOT_BYTE_BUDGET,
                      total_byte_budget=args.total_byte_budget,max_inventory_slots=MAX_SLOTS,
                      quantity_profile='verified unconditional/conditional Stackable quantity <=250 or explicit game NULL fallback1',
                      logging='baseline, stable deltas, distinct errors and terminal summary only'))
            while samples<max_samples:
                if total_bytes+SNAPSHOT_BYTE_BUDGET>args.total_byte_budget:
                    stop='total_byte_budget'
                    break
                reader=Reader(ranges,lambda size,address:os.pread(fd,size,address),SNAPSHOT_BYTE_BUDGET)
                start=time.monotonic()
                samples+=1
                try:
                    snapshot=owned_inventory_snapshot(reader,base,args.context)
                    valid+=1
                    event=tracker.push(snapshot)
                    if event:
                        emit(event)
                    last_error=None
                except (OSError,Rejected) as error:
                    reason=str(error) if isinstance(error,Rejected) else None
                    key=(type(error).__name__,reason,getattr(error,'errno',None))
                    errors[str(key)]+=1
                    tracker.pending=None
                    tracker.streak=0
                    if key!=last_error:
                        emit(dict(kind='snapshot_rejected',error_class=key[0],reason=key[1],errno=key[2]))
                    last_error=key
                total_bytes+=reader.bytes_read
                if time.monotonic()>=deadline:
                    break
                time.sleep(max(0,args.interval-(time.monotonic()-start)))
            emit(dict(kind='observation_finished',stop_reason=stop,samples=samples,
                      valid_snapshots=valid,bytes_read=total_bytes,error_counts=dict(errors),
                      prior_records_written=events))
    finally:
        os.close(fd)
    print(json.dumps(dict(output=str(args.output),samples=samples,valid_snapshots=valid,
                          bytes_read=total_bytes,stop_reason=stop)))


if __name__=='__main__':
    main()
