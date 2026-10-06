#!/usr/bin/env python3
"""Bounded, read-only snapshots of statically identified GW2 loot/item fields."""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import struct
import time

EXPECTED_BINARY = '27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c'
ROOT = Path(__file__).resolve().parent


class Rejected(ValueError):
    pass


class Reader:
    def __init__(self, ranges, pread, budget=131072):
        self.ranges = ranges
        self.pread = pread
        self.budget = budget
        self.bytes_read = 0

    def read(self, address, size):
        if address < 0x10000 or not 0 < size <= 4096:
            raise Rejected('address_or_size')
        if self.bytes_read + size > self.budget:
            raise Rejected('byte_budget')
        if not any(start <= address and address + size <= end for start,end in self.ranges):
            raise Rejected('mapping_range')
        data = self.pread(size, address)
        self.bytes_read += len(data)
        if len(data) != size:
            raise OSError(errno.EIO, 'short_read')
        return data

    def scalar(self, address, size):
        return int.from_bytes(self.read(address,size),'little')

    def pointer(self, address):
        pointer = self.scalar(address,8)
        if pointer and not any(start <= pointer < end for start,end in self.ranges):
            raise Rejected('unmapped_pointer')
        return pointer


def item_snapshot(reader, base, itemctx, instance_ref):
    if reader.pointer(itemctx) != base+0x225bd00:
        raise Rejected('item_context_vtable')
    if reader.pointer(base+0x225bd00+0x10) != base+0x13c6400:
        raise Rejected('item_resolver_candidate')
    length=reader.scalar(itemctx+0x3c,4)
    capacity=reader.scalar(itemctx+0x38,4)
    if not 0 < instance_ref < length <= capacity <= 1048576:
        raise Rejected('item_array_bounds')
    array=reader.pointer(itemctx+0x30)
    item=reader.pointer(array+8*instance_ref)
    if not item:
        return dict(instance_ref=instance_ref, present=False)
    vtable=reader.pointer(item)
    if not base+0x1913000 <= vtable < base+0x2552390:
        raise Rejected('item_vtable_range')
    if reader.pointer(vtable+8) != base+0x13c3e10:
        raise Rejected('item_definition_getter')
    if reader.pointer(vtable+0x68) != base+0x31b980:
        raise Rejected('item_instance_getter')
    if reader.scalar(item+0x38,4) != instance_ref:
        raise Rejected('item_instance_identity')
    definition=reader.pointer(item+0x40)
    type_id=reader.scalar(definition+0x28,4)
    if not 0 < type_id < 1000000:
        raise Rejected('item_type_id_bounds')
    if reader.pointer(vtable+0x70) != base+0x13c45d0:
        raise Rejected('location_getter')
    location=reader.scalar(item+0x48,2)&15
    getter=reader.pointer(vtable+0x260)-base
    quantity=None
    quantity_source='unsupported_conditional_stackable'
    if getter in (0x84c310,0x13c81c0):
        stack_offset=0x98 if getter==0x84c310 else 0xd0
        stack_vtable=reader.pointer(item+stack_offset)
        if reader.pointer(stack_vtable) != base+0x168d10:
            raise Rejected('stackable_quantity_getter')
        quantity=reader.scalar(item+stack_offset+8,4)
        if not 0 <= quantity <= 250:
            raise Rejected('stack_quantity_bounds')
        quantity_source='stackable_GetQuantity'
    elif getter==0x168aa0:
        if reader.read(base+getter,3) != b'\x33\xc0\xc3':
            raise Rejected('null_stackable_getter_bytes')
        quantity=1
        quantity_source='GetStackQuantity_explicit_nonstackable_fallback'
    if reader.pointer(itemctx+0x30)!=array or reader.pointer(array+8*instance_ref)!=item:
        raise Rejected('concurrent_item_change')
    return dict(instance_ref=instance_ref,present=True,item_type_id=type_id,
                quantity=quantity,quantity_source=quantity_source,location_type=location,
                vtable_rva=hex(vtable-base),item_pointer=hex(item))


def loot_references(reader,base,lootctx):
    count=reader.scalar(lootctx+0x54,4)
    if count>128:
        raise Rejected('loot_map_count')
    entries=reader.pointer(lootctx+0x58)
    references=[]
    for i in range(count):
        entry=entries+24*i
        lootable=reader.pointer(entry+8)
        if not lootable:
            continue
        if reader.pointer(lootable)!=base+0x22d8230:
            raise Rejected('lootable_vtable')
        n=reader.scalar(lootable+0x1c,4)
        capacity=reader.scalar(lootable+0x18,4)
        if not 0<=n<=capacity<=128:
            raise Rejected('loot_item_count')
        array=reader.pointer(lootable+0x10)
        for j in range(n):
            ref,player=struct.unpack('<II',reader.read(array+8*j,8))
            if ref:
                references.append(dict(instance_ref=ref,player_id=player,
                                       lootable_id=reader.scalar(lootable+0x54,4)))
        if reader.scalar(lootable+0x1c,4)!=n or reader.pointer(lootable+0x10)!=array:
            raise Rejected('concurrent_loot_change')
    if reader.scalar(lootctx+0x54,4)!=count or reader.pointer(lootctx+0x58)!=entries:
        raise Rejected('concurrent_loot_map_change')
    return references


def maps_for(pid):
    lines=[line.split(maxsplit=5) for line in Path(f'/proc/{pid}/maps').read_text().splitlines()]
    ranges=[tuple(int(x,16) for x in line[0].split('-')) for line in lines if 'r' in line[1]]
    modules=[line for line in lines if len(line)==6 and line[5].endswith('/Guild Wars 2/Gw2-64.exe') and int(line[2],16)==0]
    if len(modules)!=1:
        raise Rejected('module_mapping')
    module=modules[0]
    with open(module[5],'rb') as source:
        digest=hashlib.file_digest(source,'sha256').hexdigest()
    if digest!=EXPECTED_BINARY:
        raise Rejected('binary_candidate')
    return ranges,int(module[0].split('-')[0],16)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--pid',type=int,required=True)
    parser.add_argument('--context',type=lambda x:int(x,0),required=True)
    parser.add_argument('--refs',nargs='*',type=int,default=[])
    parser.add_argument('--seconds',type=float,default=0)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not 0<=args.seconds<=60 or len(args.refs)>128:
        parser.error('duration/ref bounds')
    ranges,base=maps_for(args.pid)
    fd=os.open(f'/proc/{args.pid}/mem',os.O_RDONLY)
    deadline=time.monotonic()+args.seconds
    tracked=set(args.refs)
    if any(x<=0 for x in tracked):
        parser.error('instance refs must be positive')
    try:
        with args.output.open('w') as output:
            while True:
                reader=Reader(ranges,lambda size,address:os.pread(fd,size,address))
                record=dict(time_ns=time.time_ns(),pid=args.pid,binary_sha256=EXPECTED_BINARY,
                            module_base=hex(base),context=hex(args.context),items=[])
                try:
                    itemctx=reader.pointer(args.context+0x178)
                    lootctx=reader.pointer(args.context+0x198)
                    if not itemctx or not lootctx:
                        raise Rejected('null_context_component')
                    refs=loot_references(reader,base,lootctx)
                    record['loot_references']=refs
                    tracked.update(ref['instance_ref'] for ref in refs)
                    if len(tracked)>128:
                        raise Rejected('tracked_item_bounds')
                    for ref in sorted(tracked):
                        try:
                            record['items'].append(item_snapshot(reader,base,itemctx,ref))
                        except (OSError,Rejected) as error:
                            record['items'].append(dict(instance_ref=ref,error_class=type(error).__name__,
                                                        reason=str(error) if isinstance(error,Rejected) else None,
                                                        errno=getattr(error,'errno',None)))
                except (OSError,Rejected) as error:
                    record['error_class']=type(error).__name__
                    record['reason']=str(error) if isinstance(error,Rejected) else None
                    record['errno']=getattr(error,'errno',None)
                record['bytes_read']=reader.bytes_read
                output.write(json.dumps(record)+'\n')
                output.flush()
                if time.monotonic()>=deadline:
                    break
                time.sleep(.05)
    finally:
        os.close(fd)
    print(json.dumps(dict(output=str(args.output),tracked_refs=len(tracked))))


if __name__=='__main__':
    main()
