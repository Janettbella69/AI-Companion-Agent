/**
 * @file app_hshh_lan.h
 * @brief Signed, high-level LAN control client for the ESP32-S3 motion node.
 */

#ifndef APP_HSHH_LAN_H
#define APP_HSHH_LAN_H

#include <stdbool.h>

#include "tuya_cloud_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    APP_HSHH_LAN_SKILL_STOP = 0,
    APP_HSHH_LAN_SKILL_APPROACH_SHORT,
    APP_HSHH_LAN_SKILL_TURN_TO_USER,
    APP_HSHH_LAN_SKILL_INVITE_HUG,
    APP_HSHH_LAN_SKILL_RELEASE_HUG,
} app_hshh_lan_skill_t;

/** Start the signed LAN worker on provisioned Wi-Fi and issue a fail-safe stop. */
OPERATE_RET app_hshh_lan_init(void);

/**
 * Queue one high-level SafeSkill. Non-escape skills fail closed while the
 * authenticated motion node is unavailable. No raw actuator values cross this
 * boundary.
 */
OPERATE_RET app_hshh_lan_request_skill(app_hshh_lan_skill_t skill);

/** True only after an authenticated status read and a confirmed boot stop. */
bool app_hshh_lan_is_ready(void);
bool app_hshh_lan_clock_is_trusted(void);
bool app_hshh_lan_link_is_up(void);

const char *app_hshh_lan_skill_name(app_hshh_lan_skill_t skill);

#ifdef __cplusplus
}
#endif

#endif /* APP_HSHH_LAN_H */
