#ifndef APP_HSHH_DISPLAY_H
#define APP_HSHH_DISPLAY_H

#include <stdbool.h>
#include <stdint.h>

#include "tuya_cloud_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    APP_HSHH_EXPRESSION_IDLE = 0,
    APP_HSHH_EXPRESSION_NOTICED,
    APP_HSHH_EXPRESSION_LISTENING,
    APP_HSHH_EXPRESSION_THINKING,
    APP_HSHH_EXPRESSION_HAPPY,
    APP_HSHH_EXPRESSION_CONFUSED,
    APP_HSHH_EXPRESSION_SAD,
    APP_HSHH_EXPRESSION_SLEEPING,
    APP_HSHH_EXPRESSION_ANGRY,
} app_hshh_expression_t;

OPERATE_RET app_hshh_display_init(void);
OPERATE_RET app_hshh_display_force_lit(void);
OPERATE_RET app_hshh_display_drive_pin(uint32_t pin, uint8_t level);
void app_hshh_display_set_expression(app_hshh_expression_t expression);
void app_hshh_display_tick(uint32_t now_ms);
app_hshh_expression_t app_hshh_display_current_expression(void);
bool app_hshh_display_is_ready(void);
OPERATE_RET app_hshh_display_last_init_rt(void);

#ifdef __cplusplus
}
#endif

#endif /* APP_HSHH_DISPLAY_H */
