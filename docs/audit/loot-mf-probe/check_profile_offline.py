#!/usr/bin/env python3
"""Check profile.json against the installed Gw2-64.exe file; never touches the process.

profile.json keeps hashes only, no bytes of the game. This is what ties those hashes and
the dispatch slots to the file on disk before anyone reads a live process with them.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parent
DEFAULT_BINARY = Path.home() / '.local/share/Steam/steamapps/common/Guild Wars 2/Gw2-64.exe'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, default=DEFAULT_BINARY)
    args = parser.parse_args()
    profile = json.loads((ROOT / 'profile.json').read_text())
    data = args.binary.read_bytes()
    failures = []
    if hashlib.sha256(data).hexdigest() != profile['binary_sha256']:
        failures.append('binary_sha256')
    pe_offset = struct.unpack_from('<I', data, 0x3C)[0]
    if data[pe_offset:pe_offset + 6] != b'PE\0\0\x64\x86':
        failures.append('binary_architecture')
    section_count = struct.unpack_from('<H', data, pe_offset + 6)[0]
    optional_size = struct.unpack_from('<H', data, pe_offset + 20)[0]
    image_base = struct.unpack_from('<Q', data, pe_offset + 24 + 24)[0]
    if image_base != profile['image_base'] or struct.unpack_from('<I', data, pe_offset + 24 + 56)[0] != profile['image_size']:
        failures.append('image_layout')
    sections = [struct.unpack_from('<8xIIII', data, pe_offset + 24 + optional_size + 40 * index)
                for index in range(section_count)]

    def file_bytes(rva, size):
        for virtual_size, virtual_address, raw_size, raw_offset in sections:
            if virtual_address <= rva and rva + size <= virtual_address + min(virtual_size, raw_size):
                return data[raw_offset + rva - virtual_address:raw_offset + rva - virtual_address + size]
        return b''

    for guard in profile['guards']:
        if hashlib.sha256(file_bytes(guard['rva'], guard['size'])).hexdigest() != guard['sha256']:
            failures.append('guard_' + guard['name'])
    guarded = {guard['rva'] for guard in profile['guards']}
    for slot in profile['slots']:
        stored = file_bytes(profile[slot['vtable']] + slot['slot'], 8)
        if stored != struct.pack('<Q', image_base + slot['target_rva']) or slot['target_rva'] not in guarded:
            failures.append('slot_' + slot['target'])
    # Static-only evidence for identities that --diagnose reports but no guard enforces yet.
    for link in profile.get('offline_links', []):
        raw = file_bytes(link['at_rva'], 4)
        value = struct.unpack('<I' if link['kind'] == 'u32' else '<i', raw)[0] if len(raw) == 4 else None
        reached = value if link['kind'] == 'u32' else None if value is None else link['at_rva'] + 4 + value
        if reached != link['target_rva']:
            failures.append('offline_link_' + link['name'])
    print(json.dumps(dict(event='offline_profile_check', guards=len(profile['guards']),
                          slots=len(profile['slots']),
                          offline_links=len(profile.get('offline_links', [])),
                          guard_bytes=sum(guard['size'] for guard in profile['guards']),
                          failures=failures, process_access=False)))
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
