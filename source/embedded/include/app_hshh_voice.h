#ifndef APP_HSHH_VOICE_H
#define APP_HSHH_VOICE_H

#include <stdbool.h>
#include <stdint.h>

#include "tuya_cloud_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    APP_HSHH_VOICE_IDLE = 0,
    APP_HSHH_VOICE_CAPTURING,
    APP_HSHH_VOICE_READY,
    APP_HSHH_VOICE_UPLOADING,
    APP_HSHH_VOICE_SPEAKING,
} app_hshh_voice_state_t;

OPERATE_RET app_hshh_voice_init(void);
void app_hshh_voice_on_vad(bool started);
void app_hshh_voice_stop(void);
OPERATE_RET app_hshh_voice_start_timed_capture(uint32_t duration_ms);
bool app_hshh_voice_take_ready(const uint8_t **data, uint32_t *length, char utterance_id[33],
                               uint32_t *sample_rate);
void app_hshh_voice_release(void);
void app_hshh_voice_set_speaking(bool speaking);
app_hshh_voice_state_t app_hshh_voice_get_state(void);

#ifdef __cplusplus
}
#endif

#endif /* APP_HSHH_VOICE_H */
