/* Isolated x64 read-only TEB/TLS diagnostic; never part of the shipped addon. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdint.h>
#include <inttypes.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#define BUILD_SHA "27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c"
#define TLS_INDEX_RVA UINT64_C(0x28145c0)
#define BYTE_LIMIT 4096u
#define THREAD_LIMIT 127u
#define DEFAULT_THREAD_LIMIT 100u
_Static_assert(4u + THREAD_LIMIT * 32u <= BYTE_LIMIT, "thread cap exceeds read budget");

/* ThreadBasicInformation class 0, native AMD64 ABI. Checked against our TEB. */
typedef struct {
	LONG exit_status;
	PVOID teb;
	HANDLE process_id;
	HANDLE thread_id;
	ULONG_PTR affinity;
	LONG priority;
	LONG base_priority;
} ThreadBasic;
typedef LONG (NTAPI *QueryThread)(HANDLE, ULONG, PVOID, ULONG, PULONG);
_Static_assert(sizeof(void *) == 8, "x64 required");
_Static_assert(sizeof(ThreadBasic) == 48, "unexpected native thread ABI");
_Static_assert(offsetof(ThreadBasic, teb) == 8, "unexpected TEB field");
_Static_assert(offsetof(NT_TIB, Self) == 0x30, "unexpected NT_TIB ABI");

typedef struct {
	HANDLE process;
	unsigned requested;
	unsigned successful;
	DWORD error;
	const char *reason;
	uint64_t address;
	SIZE_T size;
	SIZE_T copied;
} Reader;
typedef struct {
	uint64_t teb, tls_array, tls_block, context, loot_context;
	const char *stage;
	BOOL ok;
} Route;

static void failure(const char *stage, DWORD error) {
	printf("{\"event\":\"error\",\"stage\":\"%s\",\"win32\":%lu}\n", stage, (unsigned long)error);
}

/* Canonical lower-half user pointers only; every dereference remains an exact RPM. */
static BOOL pointer_valid(uint64_t address) {
	return address >= UINT64_C(0x10000) && address <= UINT64_C(0x00007fffffffffff)
		&& (address & 7u) == 0;
}

/* Offsets are fixed by this profile; no caller can request a scan or large read. */
static BOOL read_field(Reader *reader, uint64_t base, uint64_t offset, void *value, SIZE_T size) {
	SIZE_T copied = 0;
	reader->error = 0;
	reader->reason = "none";
	reader->address = base + offset;
	reader->size = size;
	reader->copied = 0;
	if (!pointer_valid(base) || offset > 32768u || (size != 4 && size != 8)
		|| base > UINT64_C(0x00007fffffffffff) - offset - size) {
		reader->reason = "invalid_range";
		return FALSE;
	}
	if (reader->requested > BYTE_LIMIT - size) {
		reader->reason = "byte_limit";
		return FALSE;
	}
	reader->requested += (unsigned)size;
	uint64_t scratch = 0;
	BOOL ok = ReadProcessMemory(reader->process, (LPCVOID)(uintptr_t)(base + offset), &scratch, size, &copied);
	reader->error = ok ? 0 : GetLastError();
	reader->copied = copied;
	reader->successful += (unsigned)copied;
	if (!ok || copied != size) {
		reader->reason = ok ? "short_read" : "read_failed";
		return FALSE;
	}
	memcpy(value, &scratch, size);
	return TRUE;
}

/* Resolves only this chain. NULL at any edge is a normal absent-context result. */
static Route resolve_route(Reader *reader, uint64_t teb, DWORD index) {
	Route route = { .teb = teb, .stage = "tls_array", .ok = FALSE };
	if (index > 4095u) {
		reader->reason = "tls_index_limit";
		reader->error = 0;
		return route;
	}
	if (!read_field(reader, teb, 0x58, &route.tls_array, 8)) return route;
	if (!route.tls_array) { route.ok = TRUE; return route; }
	route.stage = "tls_block";
	if (!read_field(reader, route.tls_array, (uint64_t)index * 8, &route.tls_block, 8)) return route;
	if (!route.tls_block) { route.ok = TRUE; return route; }
	route.stage = "context";
	if (!read_field(reader, route.tls_block, 0x10, &route.context, 8)) return route;
	if (!route.context) { route.ok = TRUE; return route; }
	route.stage = "loot_context";
	if (!read_field(reader, route.context, 0x198, &route.loot_context, 8)) return route;
	if (route.loot_context && !pointer_valid(route.loot_context)) {
		reader->reason = "invalid_loot_pointer";
		return route;
	}
	route.ok = TRUE;
	return route;
}

static QueryThread load_query(void) {
	HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
	FARPROC address = ntdll ? GetProcAddress(ntdll, "NtQueryInformationThread") : NULL;
	QueryThread query = NULL;
	_Static_assert(sizeof(query) == sizeof(address), "function pointer ABI");
	memcpy(&query, &address, sizeof(query));
	return query;
}

/* The positive ABI/RPM control and deliberately invalid RPM happen only to ourselves. */
static BOOL self_test(QueryThread query) {
	ThreadBasic basic = {0};
	ULONG returned = 0;
	LONG status = query(GetCurrentThread(), 0, &basic, sizeof(basic), &returned);
	uint64_t known = (uint64_t)(uintptr_t)NtCurrentTeb(), observed = 0;
	Reader reader = { .process = GetCurrentProcess() };
	BOOL positive = status >= 0 && returned == sizeof(basic)
		&& (uint64_t)(uintptr_t)basic.teb == known
		&& (DWORD)(uintptr_t)basic.process_id == GetCurrentProcessId()
		&& (DWORD)(uintptr_t)basic.thread_id == GetCurrentThreadId()
		&& read_field(&reader, known, offsetof(NT_TIB, Self), &observed, 8)
		&& observed == known;
	DWORD positive_error = reader.error;
	SIZE_T copied = 0;
	uint64_t invalid_value = 0;
	BOOL invalid_ok = ReadProcessMemory(GetCurrentProcess(), (LPCVOID)(uintptr_t)1, &invalid_value, 8, &copied);
	DWORD invalid_error = invalid_ok ? 0 : GetLastError();
	BOOL negative = !invalid_ok && copied == 0 && invalid_error != 0;

	/* Owned synthetic route exercises the same resolver without any game reads. */
	uint64_t fake_teb[12] = {0}, slots[4] = {0}, block[3] = {0}, context[52] = {0}, loot = 0;
	fake_teb[0x58 / 8] = (uint64_t)(uintptr_t)slots;
	slots[3] = (uint64_t)(uintptr_t)block;
	block[0x10 / 8] = (uint64_t)(uintptr_t)context;
	context[0x198 / 8] = (uint64_t)(uintptr_t)&loot;
	Reader fixture_reader = { .process = GetCurrentProcess() };
	Route route = resolve_route(&fixture_reader, (uint64_t)(uintptr_t)fake_teb, 3);
	BOOL fixture = route.ok && route.loot_context == (uint64_t)(uintptr_t)&loot
		&& fixture_reader.requested == 32 && fixture_reader.successful == 32;
	context[0x198 / 8] = 0;
	route = resolve_route(&fixture_reader, (uint64_t)(uintptr_t)fake_teb, 3);
	BOOL null_fixture = route.ok && route.loot_context == 0;
	unsigned before = fixture_reader.requested;
	BOOL range_guard = !read_field(&fixture_reader, 1, 0, &observed, 8)
		&& fixture_reader.requested == before;
	BOOL index_guard = !resolve_route(&fixture_reader, (uint64_t)(uintptr_t)fake_teb, 4096).ok
		&& fixture_reader.requested == before;
	fixture_reader.requested = BYTE_LIMIT;
	BOOL budget_guard = !read_field(&fixture_reader, known, 0x30, &observed, 8)
		&& fixture_reader.requested == BYTE_LIMIT;
	BOOL ok = positive && negative && fixture && null_fixture && range_guard && index_guard && budget_guard;
	printf("{\"event\":\"self_test\",\"ok\":%s,\"ntstatus\":\"0x%08lx\",\"returned\":%lu,"
		"\"teb_matches\":%s,\"positive_win32\":%lu,\"invalid_read_rejected\":%s,\"invalid_win32\":%lu,"
		"\"fixture\":%s,\"null_fixture\":%s,\"range_guard\":%s,\"index_guard\":%s,\"budget_guard\":%s}\n",
		ok ? "true" : "false", (unsigned long)(ULONG)status, (unsigned long)returned,
		positive ? "true" : "false", (unsigned long)positive_error, negative ? "true" : "false", (unsigned long)invalid_error,
		fixture ? "true" : "false", null_fixture ? "true" : "false", range_guard ? "true" : "false",
		index_guard ? "true" : "false", budget_guard ? "true" : "false");
	return ok;
}

/* Names are compared, never logged. Ambiguous discovery needs an explicit Windows PID. */
static DWORD find_process(DWORD requested_pid, BOOL enumerate) {
	HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
	if (snapshot == INVALID_HANDLE_VALUE) { failure("process_snapshot", GetLastError()); return 0; }
	PROCESSENTRY32W entry = { .dwSize = sizeof(entry) };
	DWORD selected = 0, matches = 0;
	BOOL more = Process32FirstW(snapshot, &entry);
	while (more) {
		if (_wcsicmp(entry.szExeFile, L"Gw2-64.exe") == 0 && (!requested_pid || requested_pid == entry.th32ProcessID)) {
			matches++;
			selected = entry.th32ProcessID;
			if (enumerate) printf("{\"event\":\"gw2_process\",\"windows_pid\":%lu}\n", (unsigned long)selected);
		}
		more = Process32NextW(snapshot, &entry);
	}
	DWORD error = GetLastError();
	CloseHandle(snapshot);
	if (error != ERROR_NO_MORE_FILES) { failure("process_enumeration", error); return 0; }
	if (matches != 1 && !enumerate) { failure("process_absent_or_ambiguous", matches); return 0; }
	return matches == 1 ? selected : 0;
}

static BOOL find_module(DWORD pid, uint64_t *base, DWORD *size) {
	HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid);
	if (snapshot == INVALID_HANDLE_VALUE) { failure("module_snapshot", GetLastError()); return FALSE; }
	MODULEENTRY32W entry = { .dwSize = sizeof(entry) };
	BOOL found = FALSE, more = Module32FirstW(snapshot, &entry);
	while (more) {
		if (_wcsicmp(entry.szModule, L"Gw2-64.exe") == 0) {
			*base = (uint64_t)(uintptr_t)entry.modBaseAddr;
			*size = entry.modBaseSize;
			found = TRUE;
			break;
		}
		more = Module32NextW(snapshot, &entry);
	}
	DWORD error = found ? 0 : GetLastError();
	CloseHandle(snapshot);
	if (!found) failure("module_absent", error);
	return found;
}

static BOOL architecture_valid(HANDLE process) {
	BOOL wow64 = TRUE;
	SYSTEM_INFO system;
	GetNativeSystemInfo(&system);
	if (!IsWow64Process(process, &wow64)) { failure("architecture_query", GetLastError()); return FALSE; }
	if (wow64 || system.wProcessorArchitecture != PROCESSOR_ARCHITECTURE_AMD64) {
		failure("architecture_not_native_amd64", 0);
		return FALSE;
	}
	return TRUE;
}

/* Threads can exit between snapshot/query/read; each failure is retained and marks incomplete. */
static int probe_threads(QueryThread query, DWORD pid, Reader *reader, DWORD index, unsigned limit) {
	HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
	if (snapshot == INVALID_HANDLE_VALUE) { failure("thread_snapshot", GetLastError()); return 1; }
	THREADENTRY32 entry = { .dwSize = sizeof(entry) };
	unsigned total = 0, examined = 0, failures = 0, loot_roots = 0;
	BOOL more = Thread32First(snapshot, &entry);
	while (more) {
		if (entry.th32OwnerProcessID == pid) {
			total++;
			if (examined < limit) {
				examined++;
				HANDLE thread = OpenThread(THREAD_QUERY_INFORMATION, FALSE, entry.th32ThreadID);
				if (!thread) {
					printf("{\"event\":\"thread_error\",\"tid\":%lu,\"stage\":\"open_thread\",\"win32\":%lu}\n",
						(unsigned long)entry.th32ThreadID, (unsigned long)GetLastError());
					failures++;
				} else {
					ThreadBasic basic = {0};
					ULONG returned = 0;
					LONG status = query(thread, 0, &basic, sizeof(basic), &returned);
					CloseHandle(thread);
					BOOL valid = status >= 0 && returned == sizeof(basic)
						&& (DWORD)(uintptr_t)basic.process_id == pid
						&& (DWORD)(uintptr_t)basic.thread_id == entry.th32ThreadID;
					if (!valid) {
						printf("{\"event\":\"thread_error\",\"tid\":%lu,\"stage\":\"query_thread\",\"ntstatus\":\"0x%08lx\",\"returned\":%lu}\n",
							(unsigned long)entry.th32ThreadID, (unsigned long)(ULONG)status, (unsigned long)returned);
						failures++;
					} else {
						Route route = resolve_route(reader, (uint64_t)(uintptr_t)basic.teb, index);
						if (!route.ok) failures++;
						if (route.ok && route.loot_context) loot_roots++;
						printf("{\"event\":\"thread_route\",\"tid\":%lu,\"ok\":%s,\"stage\":\"%s\",\"reason\":\"%s\",\"win32\":%lu,"
							"\"read_address\":\"0x%016" PRIx64 "\",\"requested_size\":%llu,\"copied_size\":%llu,"
							"\"teb\":\"0x%016" PRIx64 "\",\"tls_array\":\"0x%016" PRIx64 "\",\"tls_block\":\"0x%016" PRIx64 "\","
							"\"context\":\"0x%016" PRIx64 "\",\"loot_context\":\"0x%016" PRIx64 "\"}\n",
							(unsigned long)entry.th32ThreadID, route.ok ? "true" : "false", route.stage, reader->reason,
							(unsigned long)reader->error, reader->address, (unsigned long long)reader->size,
							(unsigned long long)reader->copied, route.teb, route.tls_array, route.tls_block, route.context, route.loot_context);
					}
				}
			}
		}
		more = Thread32Next(snapshot, &entry);
	}
	DWORD error = GetLastError();
	CloseHandle(snapshot);
	BOOL complete = error == ERROR_NO_MORE_FILES && total > 0 && total == examined && failures == 0;
	if (error != ERROR_NO_MORE_FILES) failure("thread_enumeration", error);
	printf("{\"event\":\"summary\",\"complete\":%s,\"threads_total\":%u,\"threads_examined\":%u,\"thread_limit\":%u,"
		"\"failures\":%u,\"nonzero_loot_roots\":%u,\"bytes_requested\":%u,\"bytes_read\":%u,\"byte_limit\":%u,\"loot_capture_proven\":false}\n",
		complete ? "true" : "false", total, examined, limit, failures, loot_roots, reader->requested, reader->successful, BYTE_LIMIT);
	return complete ? 0 : 2;
}

static BOOL parse_uint(const char *text, unsigned long maximum, DWORD *value) {
	if (!text[0] || text[0] < '0' || text[0] > '9') return FALSE;
	char *end = NULL;
	errno = 0;
	unsigned long result = strtoul(text, &end, 10);
	if (errno || *end || !result || result > maximum) return FALSE;
	*value = (DWORD)result;
	return TRUE;
}

int main(int argc, char **argv) {
	DWORD pid = 0, limit = DEFAULT_THREAD_LIMIT;
	BOOL self = FALSE, enumerate = FALSE, profile = FALSE;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--self-test")) self = TRUE;
		else if (!strcmp(argv[i], "--enumerate")) enumerate = TRUE;
		else if (!strcmp(argv[i], "--pid") && i + 1 < argc && parse_uint(argv[i + 1], UINT32_MAX, &pid)) i++;
		else if (!strcmp(argv[i], "--max-threads") && i + 1 < argc && parse_uint(argv[i + 1], THREAD_LIMIT, &limit)) i++;
		else if (!strcmp(argv[i], "--confirmed-build-sha256") && i + 1 < argc && !strcmp(argv[i + 1], BUILD_SHA)) { profile = TRUE; i++; }
		else { failure("invalid_argument", 0); return 64; }
	}
	if ((self && (enumerate || profile || pid)) || (enumerate && profile) || (!self && !enumerate && !profile)) {
		failure("mode_required_or_conflicting", 0); return 64;
	}
	QueryThread query = load_query();
	if (!query) { failure("load_query_thread", GetLastError()); return 1; }
	if (!self_test(query)) return 1;
	if (self) return 0;
	DWORD selected = find_process(pid, enumerate);
	if (enumerate) return selected ? 0 : 2;
	if (!selected) return 1;
	HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, selected);
	if (!process) { failure("open_process", GetLastError()); return 1; }
	uint64_t base = 0;
	DWORD size = 0;
	if (!architecture_valid(process) || !find_module(selected, &base, &size)
		|| !pointer_valid(base) || size < TLS_INDEX_RVA + 4) {
		failure("invalid_module_or_architecture", 0);
		CloseHandle(process);
		return 1;
	}
	Reader reader = { .process = process };
	DWORD index = 0;
	/* Large RVA is permitted only inside the independently discovered module. */
	if (!read_field(&reader, base + TLS_INDEX_RVA, 0, &index, 4) || index > 4095u) {
		failure("tls_index", reader.error);
		CloseHandle(process);
		return 1;
	}
	printf("{\"event\":\"profile\",\"windows_pid\":%lu,\"confirmed_build_sha256\":\"%s\","
		"\"module_base\":\"0x%016" PRIx64 "\",\"module_size\":%lu,\"tls_index\":%lu}\n",
		(unsigned long)selected, BUILD_SHA, base, (unsigned long)size, (unsigned long)index);
	int result = probe_threads(query, selected, &reader, index, limit);
	CloseHandle(process);
	return result;
}
