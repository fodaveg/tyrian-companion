#ifndef TYRIAN_MUMBLE_PROBE_WINDOWS_TEST_STUB_H
#define TYRIAN_MUMBLE_PROBE_WINDOWS_TEST_STUB_H

#include <stddef.h>
#include <stdint.h>

typedef void *HANDLE;
typedef uint32_t DWORD;
typedef int BOOL;

#define FALSE 0
#define FILE_MAP_READ 0x0004u

HANDLE OpenFileMappingW(DWORD desired_access, BOOL inherit_handle, const wchar_t *name);
void *MapViewOfFile(
	HANDLE mapping,
	DWORD desired_access,
	DWORD file_offset_high,
	DWORD file_offset_low,
	size_t bytes_to_map
);
BOOL UnmapViewOfFile(const void *base_address);
BOOL CloseHandle(HANDLE handle);
void Sleep(DWORD milliseconds);

#endif
