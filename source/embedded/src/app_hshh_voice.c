#include "app_hshh_voice.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "app_hshh_audio.h"
#include "tal_api.h"

#define APP_HSHH_VOICE_BUFFER_BYTES   (512u * 1024u)
#define APP_HSHH_VOICE_MIN_MS         300u
#define APP_HSHH_VOICE_MAX_MS         8000u

static uint8_t *s_buffer;
static uint32_t s_capacity;
static volatile uint32_t s_length;
static volatile app_hshh_voice_state_t s_state;
static uint32_t s_deadline_ms;
static char s_utterance_id[33];

static void *app_hshh_voice_alloc(size_t bytes)
{
#if defined(ENABLE_EXT_RAM) && (ENABLE_EXT_RAM == 1)
    return tal_psram_malloc(bytes);
#else
    return tal_malloc(bytes);
#endif
}

static uint32_t app_hshh_voice_duration_ms(uint32_t bytes)
{
    uint32_t sample_rate = app_hshh_audio_get_sample_rate();

    if (sample_rate == 0u) {
        sample_rate = 16000u;
    }
    return (uint32_t)((uint64_t)bytes * 1000u / 2u / sample_rate);
}

static void app_hshh_voice_begin_capture(uint32_t duration_ms)
{
    uint32_t now_ms = tal_system_get_millisecond();

    s_length = 0u;
    s_deadline_ms = now_ms + duration_ms;
    (void)snprintf(s_utterance_id, sizeof(s_utterance_id), "utt%08lx",
                   (unsigned long)(now_ms & 0xfffffffful));
    s_state = APP_HSHH_VOICE_CAPTURING;
}

static void app_hshh_voice_finish_capture(void)
{
    uint32_t bytes;
    uint32_t duration_ms;

    if (s_state != APP_HSHH_VOICE_CAPTURING) {
        return;
    }
    bytes = s_length;
    duration_ms = app_hshh_voice_duration_ms(bytes);
    if (duration_ms < APP_HSHH_VOICE_MIN_MS) {
        s_length = 0u;
        s_deadline_ms = 0u;
        s_state = APP_HSHH_VOICE_IDLE;
        PR_DEBUG("[HSHH VOICE] dropped short utterance ms=%lu bytes=%lu",
                 (unsigned long)duration_ms, (unsigned long)bytes);
        return;
    }
    s_deadline_ms = 0u;
    s_state = APP_HSHH_VOICE_READY;
    PR_NOTICE("[HSHH VOICE] ready bytes=%lu ms=%lu", (unsigned long)bytes,
              (unsigned long)duration_ms);
}

static void app_hshh_voice_finalize_if_due(void)
{
    uint32_t now_ms;

    if (s_state != APP_HSHH_VOICE_CAPTURING || s_deadline_ms == 0u) {
        return;
    }
    now_ms = tal_system_get_millisecond();
    if ((int32_t)(now_ms - s_deadline_ms) >= 0) {
        app_hshh_voice_finish_capture();
    }
}

static void app_hshh_voice_on_pcm(const uint8_t *data, uint32_t length, void *context)
{
    uint32_t room;
    uint32_t copy;
    uint32_t offset;

    (void)context;
    if (s_state != APP_HSHH_VOICE_CAPTURING || s_buffer == NULL || data == NULL || length == 0u) {
        return;
    }
    offset = s_length;
    if (offset >= s_capacity) {
        app_hshh_voice_finish_capture();
        return;
    }
    room = s_capacity - offset;
    copy = length < room ? length : room;
    memcpy(s_buffer + offset, data, copy);
    s_length = offset + copy;
    if (copy < length || s_length >= s_capacity) {
        app_hshh_voice_finish_capture();
        return;
    }
    app_hshh_voice_finalize_if_due();
}

OPERATE_RET app_hshh_voice_init(void)
{
    if (s_buffer != NULL) {
        return OPRT_OK;
    }
    s_buffer = app_hshh_voice_alloc(APP_HSHH_VOICE_BUFFER_BYTES);
    if (s_buffer == NULL) {
        PR_ERR("[HSHH VOICE] utterance buffer unavailable");
        return OPRT_MALLOC_FAILED;
    }
    s_capacity = APP_HSHH_VOICE_BUFFER_BYTES;
    s_length = 0u;
    s_deadline_ms = 0u;
    s_state = APP_HSHH_VOICE_IDLE;
    memset(s_utterance_id, 0, sizeof(s_utterance_id));
    app_hshh_audio_set_frame_handler(app_hshh_voice_on_pcm, NULL);
    PR_NOTICE("[HSHH VOICE] buffer_bytes=%lu sample_rate=%lu", (unsigned long)s_capacity,
              (unsigned long)app_hshh_audio_get_sample_rate());
    return OPRT_OK;
}

void app_hshh_voice_on_vad(bool started)
{
    if (started) {
        if (s_state != APP_HSHH_VOICE_IDLE && s_state != APP_HSHH_VOICE_CAPTURING) {
            return;
        }
        app_hshh_voice_begin_capture(APP_HSHH_VOICE_MAX_MS);
        return;
    }
    app_hshh_voice_finish_capture();
}

void app_hshh_voice_stop(void)
{
    app_hshh_audio_stop();
    s_length = 0u;
    s_deadline_ms = 0u;
    s_state = APP_HSHH_VOICE_IDLE;
}

OPERATE_RET app_hshh_voice_start_timed_capture(uint32_t duration_ms)
{
    if (s_buffer == NULL) {
        return OPRT_RESOURCE_NOT_READY;
    }
    if (duration_ms < APP_HSHH_VOICE_MIN_MS) {
        duration_ms = APP_HSHH_VOICE_MIN_MS;
    }
    if (duration_ms > APP_HSHH_VOICE_MAX_MS) {
        duration_ms = APP_HSHH_VOICE_MAX_MS;
    }
    app_hshh_audio_stop();
    app_hshh_voice_begin_capture(duration_ms);
    return OPRT_OK;
}

bool app_hshh_voice_take_ready(const uint8_t **data, uint32_t *length, char utterance_id[33],
                               uint32_t *sample_rate)
{
    app_hshh_voice_finalize_if_due();
    if (s_state != APP_HSHH_VOICE_READY || s_buffer == NULL || data == NULL || length == NULL ||
        utterance_id == NULL || sample_rate == NULL) {
        return false;
    }
    *data = s_buffer;
    *length = s_length;
    memcpy(utterance_id, s_utterance_id, sizeof(s_utterance_id));
    *sample_rate = app_hshh_audio_get_sample_rate();
    s_state = APP_HSHH_VOICE_UPLOADING;
    return true;
}

void app_hshh_voice_release(void)
{
    s_length = 0u;
    s_deadline_ms = 0u;
    if (s_state == APP_HSHH_VOICE_UPLOADING || s_state == APP_HSHH_VOICE_READY) {
        s_state = APP_HSHH_VOICE_IDLE;
    }
}

void app_hshh_voice_set_speaking(bool speaking)
{
    if (speaking) {
        s_state = APP_HSHH_VOICE_SPEAKING;
        return;
    }
    if (s_state == APP_HSHH_VOICE_SPEAKING) {
        s_state = APP_HSHH_VOICE_IDLE;
    }
}

app_hshh_voice_state_t app_hshh_voice_get_state(void)
{
    app_hshh_voice_finalize_if_due();
    return s_state;
}
