#include "mumble_probe_core.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

typedef struct TcMumbleCandidate {
	uint32_t version;
	uint32_t tick;
	uint32_t context_length;
	uint32_t map_id;
} TcMumbleCandidate;

static uint32_t read_aligned_word(const volatile uint32_t *word, void *context)
{
	(void)context;
	/* Supported Windows targets guarantee an aligned volatile uint32_t as one word load. */
	return *word;
}

static const volatile uint32_t *word_at(const volatile uint8_t *view, size_t offset)
{
	return (const volatile uint32_t *)(const volatile void *)(view + offset);
}

static int is_little_endian(void)
{
	const uint16_t marker = 1u;
	return *(const uint8_t *)(const void *)&marker == 1u;
}

static int words_are_aligned(const volatile uint8_t *view)
{
	return ((uintptr_t)(view + TC_MUMBLE_UI_VERSION_OFFSET) % _Alignof(uint32_t)) == 0u
		&& ((uintptr_t)(view + TC_MUMBLE_UI_TICK_OFFSET) % _Alignof(uint32_t)) == 0u
		&& ((uintptr_t)(view + TC_MUMBLE_CONTEXT_LENGTH_OFFSET) % _Alignof(uint32_t)) == 0u
		&& ((uintptr_t)(view + TC_MUMBLE_CONTEXT_OFFSET + TC_MUMBLE_CONTEXT_MAP_ID_OFFSET)
			% _Alignof(uint32_t)) == 0u;
}

static TcMumbleCandidate read_candidate(
	const volatile uint8_t *view,
	TcMumbleWordReader reader,
	void *reader_context
)
{
	TcMumbleCandidate candidate;

	candidate.version = reader(word_at(view, TC_MUMBLE_UI_VERSION_OFFSET), reader_context);
	candidate.tick = reader(word_at(view, TC_MUMBLE_UI_TICK_OFFSET), reader_context);
	candidate.context_length = reader(
		word_at(view, TC_MUMBLE_CONTEXT_LENGTH_OFFSET), reader_context);
	candidate.map_id = reader(
		word_at(view, TC_MUMBLE_CONTEXT_OFFSET + TC_MUMBLE_CONTEXT_MAP_ID_OFFSET), reader_context);
	return candidate;
}

static int candidates_equal(const TcMumbleCandidate *left, const TcMumbleCandidate *right)
{
	return left->version == right->version
		&& left->tick == right->tick
		&& left->context_length == right->context_length
		&& left->map_id == right->map_id;
}

static TcMumbleProbeStatus validate_candidate(
	const TcMumbleCandidate *candidate,
	TcMumbleSample *sample
)
{
	if (candidate->version != 2u) return TC_MUMBLE_PROBE_UNSUPPORTED_VERSION;
	if (candidate->context_length < TC_MUMBLE_CONTEXT_MINIMUM_BYTES
		|| candidate->context_length > TC_MUMBLE_CONTEXT_BUFFER_BYTES) {
		return TC_MUMBLE_PROBE_INVALID_CONTEXT_LENGTH;
	}
	if (candidate->map_id == 0u) return TC_MUMBLE_PROBE_INVALID_MAP_ID;
	sample->tick = candidate->tick;
	sample->map_id = candidate->map_id;
	return TC_MUMBLE_PROBE_OK;
}

static int is_hex_nonce(const char *nonce)
{
	size_t index;

	if (nonce == NULL || strlen(nonce) != TC_MUMBLE_NONCE_HEX_BYTES) return 0;
	for (index = 0u; index < TC_MUMBLE_NONCE_HEX_BYTES; index += 1u) {
		const char value = nonce[index];
		if (!((value >= '0' && value <= '9')
			|| (value >= 'a' && value <= 'f')
			|| (value >= 'A' && value <= 'F'))) return 0;
	}
	return 1;
}

TcMumbleProbeStatus tc_mumble_decode_view(
	const volatile uint8_t *view,
	size_t view_size,
	TcMumbleSample *sample
)
{
	return tc_mumble_decode_view_with_reader(
		view,
		view_size,
		read_aligned_word,
		NULL,
		sample
	);
}

TcMumbleProbeStatus tc_mumble_decode_view_with_reader(
	const volatile uint8_t *view,
	size_t view_size,
	TcMumbleWordReader reader,
	void *reader_context,
	TcMumbleSample *sample
)
{
	size_t attempt;
	const size_t required = TC_MUMBLE_CONTEXT_OFFSET
		+ TC_MUMBLE_CONTEXT_MAP_ID_OFFSET + sizeof(uint32_t);

	if (view == NULL || reader == NULL || sample == NULL || !is_little_endian()) {
		return TC_MUMBLE_PROBE_INVALID_ARGUMENT;
	}
	if (view_size < required) return TC_MUMBLE_PROBE_VIEW_TOO_SMALL;
	if (!words_are_aligned(view)) return TC_MUMBLE_PROBE_UNALIGNED_VIEW;

	for (attempt = 0u; attempt < TC_MUMBLE_SAMPLE_PAIR_ATTEMPTS; attempt += 1u) {
		const TcMumbleCandidate first = read_candidate(view, reader, reader_context);
		const TcMumbleCandidate second = read_candidate(view, reader, reader_context);
		if (candidates_equal(&first, &second)) return validate_candidate(&second, sample);
	}
	return TC_MUMBLE_PROBE_UNSTABLE_SAMPLE;
}

const char *tc_mumble_activity(uint32_t previous_tick, uint32_t current_tick)
{
	return previous_tick == current_tick ? "link_stalled" : "link_advancing";
}

TcMumbleProbeStatus tc_mumble_render_frame(
	const char *nonce,
	uint64_t sequence,
	const TcMumbleSample *sample,
	const char *activity,
	char *output,
	size_t output_capacity,
	size_t *output_length
)
{
	int written;

	if (sample == NULL || activity == NULL || output == NULL || output_length == NULL) {
		return TC_MUMBLE_PROBE_INVALID_ARGUMENT;
	}
	if (!is_hex_nonce(nonce)) return TC_MUMBLE_PROBE_INVALID_NONCE;
	if (sequence > TC_MUMBLE_MAX_SEQUENCE) return TC_MUMBLE_PROBE_INVALID_SEQUENCE;
	if (strcmp(activity, "link_advancing") != 0 && strcmp(activity, "link_stalled") != 0) {
		return TC_MUMBLE_PROBE_INVALID_ARGUMENT;
	}

	written = snprintf(
		output,
		output_capacity,
		"{\"version\":1,\"nonce\":\"%s\",\"sequence\":%" PRIu64
		",\"tick\":%" PRIu32 ",\"mapId\":%" PRIu32 ",\"activity\":\"%s\"}",
		nonce,
		sequence,
		sample->tick,
		sample->map_id,
		activity
	);
	if (written < 0 || (size_t)written >= output_capacity
		|| (size_t)written > TC_MUMBLE_MAX_FRAME_BYTES) {
		return TC_MUMBLE_PROBE_FRAME_TOO_LARGE;
	}
	*output_length = (size_t)written;
	return TC_MUMBLE_PROBE_OK;
}

const char *tc_mumble_status_name(TcMumbleProbeStatus status)
{
	switch (status) {
	case TC_MUMBLE_PROBE_OK: return "ok";
	case TC_MUMBLE_PROBE_INVALID_ARGUMENT: return "invalid_argument";
	case TC_MUMBLE_PROBE_VIEW_TOO_SMALL: return "view_too_small";
	case TC_MUMBLE_PROBE_UNALIGNED_VIEW: return "unaligned_view";
	case TC_MUMBLE_PROBE_UNSUPPORTED_VERSION: return "unsupported_version";
	case TC_MUMBLE_PROBE_INVALID_CONTEXT_LENGTH: return "invalid_context_length";
	case TC_MUMBLE_PROBE_UNSTABLE_SAMPLE: return "unstable_sample";
	case TC_MUMBLE_PROBE_INVALID_MAP_ID: return "invalid_map_id";
	case TC_MUMBLE_PROBE_INVALID_NONCE: return "invalid_nonce";
	case TC_MUMBLE_PROBE_INVALID_SEQUENCE: return "invalid_sequence";
	case TC_MUMBLE_PROBE_FRAME_TOO_LARGE: return "frame_too_large";
	default: return "unknown";
	}
}
