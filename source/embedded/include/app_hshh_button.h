#ifndef APP_HSHH_BUTTON_H
#define APP_HSHH_BUTTON_H

#include <stdbool.h>
#include <stdint.h>

#include "tuya_cloud_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    APP_HSHH_BUTTON_EVENT_NONE = 0,
    APP_HSHH_BUTTON_EVENT_CONFIRM = 1u << 0,
    APP_HSHH_BUTTON_EVENT_REJECT = 1u << 1,
    APP_HSHH_BUTTON_EVENT_EMERGENCY_RELEASE = 1u << 2,
} app_hshh_button_event_t;

OPERATE_RET app_hshh_button_init(void);
uint32_t app_hshh_button_take_events(void);
bool app_hshh_button_is_ready(void);

#ifdef __cplusplus
}
#endif

#endif /* APP_HSHH_BUTTON_H */
