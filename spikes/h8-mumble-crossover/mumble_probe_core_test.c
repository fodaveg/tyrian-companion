#include "mumble_probe_core.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int failures = 0;

typedef struct AlignedView {
	uint32_t words[TC_MUMBLE_LINK_VIEW_BYTES / sizeof(uint32_t)];
} AlignedView;

_Static_assert(TC_MUMBLE_LINK_VIEW_BYTES % sizeof(uint32_t) == 0u,
	"fixture view must contain complete aligned words");

static void expect(int condition, const char *message)
{
	if (!condition) {
		fprintf(stderr, "FAIL: %s\n", message);
		failures += 1;
	}
}

static void write_u32(uint8_t *bytes, size_t offset, uint32_t value)
{
	uint32_t *word = (uint32_t *)(void *)(bytes + offset);
	*word = value;
}

static uint8_t *view_bytes(AlignedView *view)
{
	return (uint8_t *)(void *)view->words;
}

static void valid_fixture(uint8_t *view)
{
	memset(view, 0xa5, TC_MUMBLE_LINK_VIEW_BYTES);
	/* Independent literals make layout drift turn the focal test red. */
	write_u32(view, 0u, 2u);
	write_u32(view, 4u, 42u);
	write_u32(view, 1104u, 48u);
	write_u32(view, 1108u + 28u, 866u);
}

typedef struct ScriptedReader {
	const volatile uint8_t *base;
	const uint32_t *values;
	size_t value_count;
	size_t index;
} ScriptedReader;

static uint32_t scripted_read(const volatile uint32_t *word, void *context)
{
	static const size_t expected_offsets[] = { 0u, 4u, 1104u, 1136u };
	ScriptedReader *script = (ScriptedReader *)context;
	const size_t offset = (size_t)((const volatile uint8_t *)word - script->base);

	expect(script->index < script->value_count, "scripted reader stays in bounds");
	expect(offset == expected_offsets[script->index % 4u], "reader uses only four pinned words");
	if (script->index >= script->value_count) return 0u;
	return script->values[script->index++];
}

static void test_layout_and_decode(void)
{
	AlignedView storage;
	uint8_t *view = view_bytes(&storage);
	TcMumbleSample sample = { 0u, 0u };
	TcMumbleProbeStatus status;

	expect(TC_MUMBLE_LINK_VIEW_BYTES == 5460u, "Mumble Link view size is pinned");
	expect(TC_MUMBLE_CONTEXT_LENGTH_OFFSET == 1104u, "context length offset is pinned");
	expect(TC_MUMBLE_CONTEXT_OFFSET == 1108u, "context offset is pinned");
	expect(TC_MUMBLE_CONTEXT_MAP_ID_OFFSET == 28u, "map id offset is pinned");
	expect(TC_MUMBLE_SAMPLE_PAIR_ATTEMPTS == 8u, "sample pair attempts are pinned");
	expect(TC_MUMBLE_MAX_FRAME_BYTES == 512u, "maximum frame bytes are pinned");
	expect(TC_MUMBLE_MAX_SEQUENCE == 9007199254740991ULL, "maximum sequence is pinned");
	valid_fixture(view);
	status = tc_mumble_decode_view(view, TC_MUMBLE_LINK_VIEW_BYTES, &sample);
	expect(status == TC_MUMBLE_PROBE_OK, "valid official-layout fixture decodes");
	expect(sample.tick == 42u, "only the tick is projected");
	expect(sample.map_id == 866u, "the Labyrinth map id is projected");
	expect(tc_mumble_decode_view(view, 1139u, &sample) == TC_MUMBLE_PROBE_VIEW_TOO_SMALL,
		"truncated view fails closed");
	expect(tc_mumble_decode_view(view + 1u, TC_MUMBLE_LINK_VIEW_BYTES - 1u, &sample)
		== TC_MUMBLE_PROBE_UNALIGNED_VIEW, "unaligned word view fails closed");
}

static void test_malformed_fields(void)
{
	AlignedView storage;
	uint8_t *view = view_bytes(&storage);
	TcMumbleSample sample = { 0u, 0u };

	valid_fixture(view);
	write_u32(view, 0u, 1u);
	expect(tc_mumble_decode_view(view, TC_MUMBLE_LINK_VIEW_BYTES, &sample)
		== TC_MUMBLE_PROBE_UNSUPPORTED_VERSION, "unknown layout fails closed");
	valid_fixture(view);
	write_u32(view, 1104u, 31u);
	expect(tc_mumble_decode_view(view, TC_MUMBLE_LINK_VIEW_BYTES, &sample)
		== TC_MUMBLE_PROBE_INVALID_CONTEXT_LENGTH, "short context fails closed");
	write_u32(view, 1104u, 257u);
	expect(tc_mumble_decode_view(view, TC_MUMBLE_LINK_VIEW_BYTES, &sample)
		== TC_MUMBLE_PROBE_INVALID_CONTEXT_LENGTH, "oversized context fails closed");
	valid_fixture(view);
	write_u32(view, 1136u, 0u);
	expect(tc_mumble_decode_view(view, TC_MUMBLE_LINK_VIEW_BYTES, &sample)
		== TC_MUMBLE_PROBE_INVALID_MAP_ID, "zero map id fails closed");
}

static void test_same_tick_hybrid_map_retries_to_a_complete_pair(void)
{
	AlignedView storage;
	uint8_t *view = view_bytes(&storage);
	const uint32_t reads[] = {
		2u, 42u, 48u, 866u,
		2u, 42u, 48u, 999u,
		2u, 42u, 48u, 866u,
		2u, 42u, 48u, 866u,
	};
	ScriptedReader script = { view, reads, sizeof(reads) / sizeof(reads[0]), 0u };
	TcMumbleSample sample = { 0u, 0u };

	valid_fixture(view);
	expect(tc_mumble_decode_view_with_reader(
		view, TC_MUMBLE_LINK_VIEW_BYTES, scripted_read, &script, &sample)
		== TC_MUMBLE_PROBE_OK, "same tick with a hybrid map retries before acceptance");
	expect(script.index == 16u, "retry consumes a new complete pair");
	expect(sample.tick == 42u && sample.map_id == 866u,
		"only the later identical complete pair is projected");
}

static void test_repeated_tearing_exhausts_best_effort_retries(void)
{
	AlignedView storage;
	uint8_t *view = view_bytes(&storage);
	uint32_t reads[TC_MUMBLE_SAMPLE_PAIR_ATTEMPTS * 8u];
	ScriptedReader script;
	TcMumbleSample sample = { 0u, 0u };
	size_t attempt;

	for (attempt = 0u; attempt < TC_MUMBLE_SAMPLE_PAIR_ATTEMPTS; attempt += 1u) {
		const size_t offset = attempt * 8u;
		reads[offset] = 2u;
		reads[offset + 1u] = 42u;
		reads[offset + 2u] = 48u;
		reads[offset + 3u] = 866u;
		reads[offset + 4u] = 2u;
		reads[offset + 5u] = 42u;
		reads[offset + 6u] = 48u;
		reads[offset + 7u] = 0x00ff0362u;
	}
	script.base = view;
	script.values = reads;
	script.value_count = sizeof(reads) / sizeof(reads[0]);
	script.index = 0u;
	valid_fixture(view);
	expect(tc_mumble_decode_view_with_reader(
		view, TC_MUMBLE_LINK_VIEW_BYTES, scripted_read, &script, &sample)
		== TC_MUMBLE_PROBE_UNSTABLE_SAMPLE, "repeated same-tick word tearing fails closed");
	expect(script.index == sizeof(reads) / sizeof(reads[0]),
		"tearing exhausts every bounded complete-pair attempt");
}

static void test_minimal_frame(void)
{
	const char nonce[] = "00112233445566778899aabbccddeeff";
	const char expected[] = "{\"version\":1,\"nonce\":\"00112233445566778899aabbccddeeff\","
		"\"sequence\":0,\"tick\":42,\"mapId\":866,\"activity\":\"link_advancing\"}";
	TcMumbleSample sample = { 42u, 866u };
	char frame[TC_MUMBLE_MAX_FRAME_BYTES + 1u];
	size_t length = 0u;

	expect(strcmp(tc_mumble_activity(41u, 42u), "link_advancing") == 0,
		"an advancing tick derives activity only");
	expect(strcmp(tc_mumble_activity(42u, 42u), "link_stalled") == 0,
		"an unchanged tick derives a stall only");
	expect(tc_mumble_render_frame(nonce, 0u, &sample, "link_advancing",
		frame, sizeof(frame), &length) == TC_MUMBLE_PROBE_OK, "minimal frame renders");
	expect(length == strlen(expected) && strcmp(frame, expected) == 0,
		"frame keys and values are exact");
	expect(length <= TC_MUMBLE_MAX_FRAME_BYTES, "frame stays within H8.1 bound");
	expect(tc_mumble_render_frame("too-short", 0u, &sample, "link_advancing",
		frame, sizeof(frame), &length) == TC_MUMBLE_PROBE_INVALID_NONCE,
		"weak nonce fails closed");
	expect(tc_mumble_render_frame(nonce, TC_MUMBLE_MAX_SEQUENCE + 1u, &sample, "link_advancing",
		frame, sizeof(frame), &length) == TC_MUMBLE_PROBE_INVALID_SEQUENCE,
		"unsafe sequence fails closed");
	expect(tc_mumble_render_frame(nonce, 0u, &sample, "movement",
		frame, sizeof(frame), &length) == TC_MUMBLE_PROBE_INVALID_ARGUMENT,
		"unsupported activity fails closed");
	expect(tc_mumble_render_frame(nonce, 0u, &sample, "link_advancing",
		frame, 16u, &length) == TC_MUMBLE_PROBE_FRAME_TOO_LARGE,
		"truncated output buffer fails closed");
}

int main(void)
{
	test_layout_and_decode();
	test_malformed_fields();
	test_same_tick_hybrid_map_retries_to_a_complete_pair();
	test_repeated_tearing_exhausts_best_effort_retries();
	test_minimal_frame();
	if (failures != 0) return 1;
	puts("h8 crossover spike core: PASS");
	return 0;
}
