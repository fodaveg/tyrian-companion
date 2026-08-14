#ifndef TYRIAN_MUMBLE_PROBE_CORE_H
#define TYRIAN_MUMBLE_PROBE_CORE_H

#include <stddef.h>
#include <stdint.h>

/* Pinned Mumble Link v2 / ArenaNet context layout from the H8.1 sources. */
#define TC_MUMBLE_LINK_VIEW_BYTES 5460u
#define TC_MUMBLE_UI_VERSION_OFFSET 0u
#define TC_MUMBLE_UI_TICK_OFFSET 4u
#define TC_MUMBLE_CONTEXT_LENGTH_OFFSET 1104u
#define TC_MUMBLE_CONTEXT_OFFSET 1108u
#define TC_MUMBLE_CONTEXT_MAP_ID_OFFSET 28u
#define TC_MUMBLE_CONTEXT_MINIMUM_BYTES 32u
#define TC_MUMBLE_CONTEXT_BUFFER_BYTES 256u
#define TC_MUMBLE_SAMPLE_PAIR_ATTEMPTS 8u
#define TC_MUMBLE_NONCE_HEX_BYTES 32u
#define TC_MUMBLE_MAX_FRAME_BYTES 512u
#define TC_MUMBLE_MAX_SEQUENCE 9007199254740991ULL

typedef enum TcMumbleProbeStatus {
	TC_MUMBLE_PROBE_OK = 0,
	TC_MUMBLE_PROBE_INVALID_ARGUMENT,
	TC_MUMBLE_PROBE_VIEW_TOO_SMALL,
	TC_MUMBLE_PROBE_UNALIGNED_VIEW,
	TC_MUMBLE_PROBE_UNSUPPORTED_VERSION,
	TC_MUMBLE_PROBE_INVALID_CONTEXT_LENGTH,
	TC_MUMBLE_PROBE_UNSTABLE_SAMPLE,
	TC_MUMBLE_PROBE_INVALID_MAP_ID,
	TC_MUMBLE_PROBE_INVALID_NONCE,
	TC_MUMBLE_PROBE_INVALID_SEQUENCE,
	TC_MUMBLE_PROBE_FRAME_TOO_LARGE
} TcMumbleProbeStatus;

typedef struct TcMumbleSample {
	uint32_t tick;
	uint32_t map_id;
} TcMumbleSample;

typedef uint32_t (*TcMumbleWordReader)(const volatile uint32_t *word, void *context);

/*
 * Best-effort shared-memory read: accepts only two complete, identical samples.
 * This is deliberately not described as a seqlock or a coherent writer snapshot.
 */
TcMumbleProbeStatus tc_mumble_decode_view(
	const volatile uint8_t *view,
	size_t view_size,
	TcMumbleSample *sample
);

/* Injectable aligned-word reader used by adversarial interleaving tests. */
TcMumbleProbeStatus tc_mumble_decode_view_with_reader(
	const volatile uint8_t *view,
	size_t view_size,
	TcMumbleWordReader reader,
	void *reader_context,
	TcMumbleSample *sample
);

const char *tc_mumble_activity(uint32_t previous_tick, uint32_t current_tick);

TcMumbleProbeStatus tc_mumble_render_frame(
	const char *nonce,
	uint64_t sequence,
	const TcMumbleSample *sample,
	const char *activity,
	char *output,
	size_t output_capacity,
	size_t *output_length
);

const char *tc_mumble_status_name(TcMumbleProbeStatus status);

#endif
