#include "app_hshh_audio.h"

#include <stddef.h>

#include "tal_api.h"
#include "tdl_audio_manage.h"

#define APP_HSHH_AUDIO_VOLUME       92u
#define APP_HSHH_AUDIO_MAX_SAMPLES  10400u

static TDL_AUDIO_HANDLE_T s_audio;
static TDL_AUDIO_INFO_T s_info;
static int16_t s_cue_buffer[APP_HSHH_AUDIO_MAX_SAMPLES];
static volatile uint32_t s_pending_events;
static app_hshh_audio_frame_handler_t s_frame_handler;
static void *s_frame_context;
static bool s_ready;
static uint8_t s_volume;
static volatile uint32_t s_play_generation;
static volatile uint32_t s_pcm_frames;
static volatile uint32_t s_pcm_bytes;
static volatile uint32_t s_vad_starts;
static volatile uint32_t s_vad_ends;

static void app_hshh_audio_frame_callback(TDL_AUDIO_FRAME_FORMAT_E type, TDL_AUDIO_STATUS_E status,
                                          uint8_t *data, uint32_t length)
{
    if (status == TDL_AUDIO_STATUS_VAD_START) {
        __atomic_fetch_or(&s_pending_events, APP_HSHH_AUDIO_EVENT_VAD_START, __ATOMIC_RELAXED);
        __atomic_fetch_add(&s_vad_starts, 1u, __ATOMIC_RELAXED);
    } else if (status == TDL_AUDIO_STATUS_VAD_END) {
        __atomic_fetch_or(&s_pending_events, APP_HSHH_AUDIO_EVENT_VAD_END, __ATOMIC_RELAXED);
        __atomic_fetch_add(&s_vad_ends, 1u, __ATOMIC_RELAXED);
    }

    if (type == TDL_AUDIO_FRAME_FORMAT_PCM && data != NULL && length > 0u) {
        __atomic_fetch_add(&s_pcm_frames, 1u, __ATOMIC_RELAXED);
        __atomic_fetch_add(&s_pcm_bytes, length, __ATOMIC_RELAXED);
        if (s_frame_handler != NULL) {
            s_frame_handler(data, length, s_frame_context);
        }
    }
}

static uint32_t app_hshh_fill_tone(uint32_t sample_rate, uint32_t frequency, uint32_t duration_ms,
                                   int16_t amplitude)
{
    uint32_t sample_count = sample_rate * duration_ms / 1000u;
    uint32_t fade_samples = sample_rate / 100u;
    uint32_t period;
    uint32_t index;

    if (sample_count > APP_HSHH_AUDIO_MAX_SAMPLES) {
        sample_count = APP_HSHH_AUDIO_MAX_SAMPLES;
    }
    period = sample_rate / frequency;
    if (period < 4u) {
        period = 4u;
    }
    if (fade_samples == 0u) {
        fade_samples = 1u;
    }
    for (index = 0; index < sample_count; index++) {
        const uint32_t phase = index % period;
        const int32_t rising = phase < period / 2u
                                   ? (int32_t)(phase * 4u * (uint32_t)amplitude / period) - amplitude
                                   : (int32_t)((period - phase) * 4u * (uint32_t)amplitude / period) - amplitude;
        uint32_t fade = index < fade_samples ? index : fade_samples;
        const uint32_t remaining = sample_count - index;

        if (remaining < fade) {
            fade = remaining;
        }
        s_cue_buffer[index] = (int16_t)(rising * (int32_t)fade / (int32_t)fade_samples);
    }
    return sample_count;
}

OPERATE_RET app_hshh_audio_init(void)
{
    OPERATE_RET rt;

    rt = tdl_audio_find(AUDIO_CODEC_NAME, &s_audio);
    if (rt != OPRT_OK) {
        PR_ERR("[HSHH AUDIO] '%s' was not registered, rt=%d", AUDIO_CODEC_NAME, rt);
        return rt;
    }
    TUYA_CALL_ERR_RETURN(tdl_audio_open(s_audio, app_hshh_audio_frame_callback));
    memset(&s_info, 0, sizeof(s_info));
    TUYA_CALL_ERR_RETURN(tdl_audio_get_info(s_audio, &s_info));
    rt = tdl_audio_volume_set(s_audio, APP_HSHH_AUDIO_VOLUME);
    if (rt == OPRT_OK) {
        s_volume = APP_HSHH_AUDIO_VOLUME;
    } else {
        PR_WARN("[HSHH AUDIO] volume setup failed, rt=%d", rt);
    }
    s_ready = true;
    PR_NOTICE("[HSHH AUDIO] ready rate=%u channels=%u bits=%u frame=%u volume=%u", s_info.sample_rate,
              s_info.sample_ch_num, s_info.sample_bits, s_info.frame_size, s_volume);
    return OPRT_OK;
}

uint32_t app_hshh_audio_take_events(void)
{
    return __atomic_exchange_n(&s_pending_events, 0u, __ATOMIC_ACQ_REL);
}

void app_hshh_audio_set_frame_handler(app_hshh_audio_frame_handler_t handler, void *context)
{
    s_frame_context = context;
    s_frame_handler = handler;
}

OPERATE_RET app_hshh_audio_play_cue(app_hshh_audio_cue_t cue)
{
    uint32_t frequency = 320u;
    uint32_t duration_ms = 85u;
    int16_t amplitude = 4200;
    uint32_t samples;
    uint32_t bytes;

    if (!s_ready) {
        return OPRT_RESOURCE_NOT_READY;
    }
    switch (cue) {
    case APP_HSHH_AUDIO_CUE_NOTICED:
        frequency = 620u;
        break;
    case APP_HSHH_AUDIO_CUE_CONFIRM:
        frequency = 880u;
        duration_ms = 650u;
        amplitude = 15000;
        break;
    case APP_HSHH_AUDIO_CUE_HAPPY:
        frequency = 110u;
        duration_ms = 120u;
        amplitude = 3000;
        break;
    case APP_HSHH_AUDIO_CUE_CONFUSED:
        frequency = 260u;
        break;
    case APP_HSHH_AUDIO_CUE_STOP:
        frequency = 180u;
        duration_ms = 65u;
        amplitude = 3500;
        break;
    default:
        return OPRT_INVALID_PARM;
    }
    samples = app_hshh_fill_tone(s_info.sample_rate == 0u ? 16000u : s_info.sample_rate,
                                  frequency, duration_ms, amplitude);
    bytes = samples * sizeof(s_cue_buffer[0]);
    return app_hshh_audio_play_pcm((const uint8_t *)s_cue_buffer, bytes);
}

OPERATE_RET app_hshh_audio_play_pcm(const uint8_t *data, uint32_t length)
{
    uint32_t offset = 0u;
    uint32_t chunk_size;
    uint32_t generation;
    OPERATE_RET rt;

    if (!s_ready) {
        return OPRT_RESOURCE_NOT_READY;
    }
    if (data == NULL || length == 0u) {
        return OPRT_INVALID_PARM;
    }
    generation = __atomic_load_n(&s_play_generation, __ATOMIC_ACQUIRE);
    chunk_size = s_info.frame_size == 0u ? 640u : s_info.frame_size;
    while (offset < length) {
        uint32_t remaining = length - offset;
        uint32_t chunk = remaining < chunk_size ? remaining : chunk_size;

        if (__atomic_load_n(&s_play_generation, __ATOMIC_ACQUIRE) != generation) {
            return OPRT_OK;
        }
        rt = tdl_audio_play(s_audio, (uint8_t *)(data + offset), chunk);
        if (rt != OPRT_OK) {
            return rt;
        }
        offset += chunk;
    }
    return OPRT_OK;
}

uint32_t app_hshh_audio_get_sample_rate(void)
{
    return s_info.sample_rate == 0u ? 16000u : s_info.sample_rate;
}

uint32_t app_hshh_audio_get_frame_size(void)
{
    return s_info.frame_size == 0u ? 640u : s_info.frame_size;
}

void app_hshh_audio_stop(void)
{
    __atomic_fetch_add(&s_play_generation, 1u, __ATOMIC_RELEASE);
    if (s_ready) {
        (void)tdl_audio_play_stop(s_audio);
    }
}

bool app_hshh_audio_is_ready(void)
{
    return s_ready;
}

OPERATE_RET app_hshh_audio_set_volume(uint8_t volume)
{
    OPERATE_RET rt;

    if (!s_ready) {
        return OPRT_RESOURCE_NOT_READY;
    }
    if (volume > 100u) {
        return OPRT_INVALID_PARM;
    }
    rt = tdl_audio_volume_set(s_audio, volume);
    if (rt == OPRT_OK) {
        s_volume = volume;
    }
    return rt;
}

uint8_t app_hshh_audio_get_volume(void)
{
    return s_volume;
}

void app_hshh_audio_get_diagnostics(app_hshh_audio_diagnostics_t *diagnostics)
{
    if (diagnostics == NULL) {
        return;
    }
    diagnostics->ready = s_ready;
    diagnostics->volume = s_volume;
    diagnostics->pcm_frames = __atomic_load_n(&s_pcm_frames, __ATOMIC_ACQUIRE);
    diagnostics->pcm_bytes = __atomic_load_n(&s_pcm_bytes, __ATOMIC_ACQUIRE);
    diagnostics->vad_starts = __atomic_load_n(&s_vad_starts, __ATOMIC_ACQUIRE);
    diagnostics->vad_ends = __atomic_load_n(&s_vad_ends, __ATOMIC_ACQUIRE);
}

void app_hshh_audio_reset_diagnostics(void)
{
    __atomic_store_n(&s_pcm_frames, 0u, __ATOMIC_RELEASE);
    __atomic_store_n(&s_pcm_bytes, 0u, __ATOMIC_RELEASE);
    __atomic_store_n(&s_vad_starts, 0u, __ATOMIC_RELEASE);
    __atomic_store_n(&s_vad_ends, 0u, __ATOMIC_RELEASE);
}
