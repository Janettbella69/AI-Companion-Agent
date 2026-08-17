#ifndef APP_HSHH_AUDIO_H
#define APP_HSHH_AUDIO_H

#include <stdbool.h>
#include <stdint.h>

#include "tuya_cloud_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    APP_HSHH_AUDIO_EVENT_NONE = 0,
    APP_HSHH_AUDIO_EVENT_VAD_START = 1u << 0,
    APP_HSHH_AUDIO_EVENT_VAD_END = 1u << 1,
} app_hshh_audio_event_t;

typedef enum {
    APP_HSHH_AUDIO_CUE_NOTICED = 0,
    APP_HSHH_AUDIO_CUE_CONFIRM,
    APP_HSHH_AUDIO_CUE_HAPPY,
    APP_HSHH_AUDIO_CUE_CONFUSED,
    APP_HSHH_AUDIO_CUE_STOP,
} app_hshh_audio_cue_t;

typedef void (*app_hshh_audio_frame_handler_t)(const uint8_t *data, uint32_t length, void *context);

typedef struct {
    bool ready;
    uint8_t volume;
    uint32_t pcm_frames;
    uint32_t pcm_bytes;
    uint32_t vad_starts;
    uint32_t vad_ends;
} app_hshh_audio_diagnostics_t;

OPERATE_RET app_hshh_audio_init(void);
uint32_t app_hshh_audio_take_events(void);
void app_hshh_audio_set_frame_handler(app_hshh_audio_frame_handler_t handler, void *context);
OPERATE_RET app_hshh_audio_play_cue(app_hshh_audio_cue_t cue);
OPERATE_RET app_hshh_audio_play_pcm(const uint8_t *data, uint32_t length);
uint32_t app_hshh_audio_get_sample_rate(void);
uint32_t app_hshh_audio_get_frame_size(void);
void app_hshh_audio_stop(void);
bool app_hshh_audio_is_ready(void);
OPERATE_RET app_hshh_audio_set_volume(uint8_t volume);
uint8_t app_hshh_audio_get_volume(void);
void app_hshh_audio_get_diagnostics(app_hshh_audio_diagnostics_t *diagnostics);
void app_hshh_audio_reset_diagnostics(void);

#ifdef __cplusplus
}
#endif

#endif /* APP_HSHH_AUDIO_H */
