#ifndef APP_HSHH_EFFECTS_H
#define APP_HSHH_EFFECTS_H

#include <stdbool.h>
#include <stdint.h>

#include "tuya_cloud_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    APP_HSHH_CONSENT_NONE = 0,
    APP_HSHH_CONSENT_APPROACH,
    APP_HSHH_CONSENT_HUG,
} app_hshh_consent_scope_t;

OPERATE_RET app_hshh_effects_init(void);
void app_hshh_effects_tick(uint32_t now_ms);
void app_hshh_effects_offer_consent(app_hshh_consent_scope_t scope, uint32_t expires_at_ms);
bool app_hshh_effects_take_confirmation(app_hshh_consent_scope_t *scope);
void app_hshh_effects_local_stop(uint32_t now_ms);
OPERATE_RET app_hshh_effects_queue_expression(uint8_t expression, uint32_t duration_ms);
OPERATE_RET app_hshh_effects_queue_sound(uint8_t sound);

#ifdef __cplusplus
}
#endif

#endif /* APP_HSHH_EFFECTS_H */
