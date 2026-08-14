#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "mumble_probe_core.h"

static const wchar_t MUMBLE_MAPPING_NAME[] = L"MumbleLink";
static const DWORD ACTIVITY_WINDOW_MS = 1500u;

static int fail(TcMumbleProbeStatus status)
{
	return status == TC_MUMBLE_PROBE_OK ? 1 : (int)status;
}

int main(int argc, char **argv)
{
	HANDLE mapping;
	const volatile uint8_t *view;
	TcMumbleSample first;
	TcMumbleSample second;
	TcMumbleProbeStatus status;
	char frame[TC_MUMBLE_MAX_FRAME_BYTES + 1u];
	size_t frame_length = 0u;

	if (argc != 3 || strcmp(argv[1], "--nonce") != 0) {
		return fail(TC_MUMBLE_PROBE_INVALID_ARGUMENT);
	}

	/* Open only the named section exposed by the game in this Wine/CrossOver bottle. */
	mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, MUMBLE_MAPPING_NAME);
	if (mapping == NULL) return fail(TC_MUMBLE_PROBE_VIEW_TOO_SMALL);
	view = (const volatile uint8_t *)MapViewOfFile(
		mapping,
		FILE_MAP_READ,
		0u,
		0u,
		TC_MUMBLE_LINK_VIEW_BYTES
	);
	if (view == NULL) {
		CloseHandle(mapping);
		return fail(TC_MUMBLE_PROBE_VIEW_TOO_SMALL);
	}

	status = tc_mumble_decode_view(view, TC_MUMBLE_LINK_VIEW_BYTES, &first);
	if (status == TC_MUMBLE_PROBE_OK) {
		Sleep(ACTIVITY_WINDOW_MS);
		status = tc_mumble_decode_view(view, TC_MUMBLE_LINK_VIEW_BYTES, &second);
	}
	if (status == TC_MUMBLE_PROBE_OK) {
		status = tc_mumble_render_frame(
			argv[2],
			0u,
			&second,
			tc_mumble_activity(first.tick, second.tick),
			frame,
			sizeof(frame),
			&frame_length
		);
	}

	UnmapViewOfFile((const void *)view);
	CloseHandle(mapping);
	if (status != TC_MUMBLE_PROBE_OK) return fail(status);
	if (fwrite(frame, 1u, frame_length, stdout) != frame_length || fputc('\n', stdout) == EOF) {
		return fail(TC_MUMBLE_PROBE_INVALID_ARGUMENT);
	}
	return 0;
}
