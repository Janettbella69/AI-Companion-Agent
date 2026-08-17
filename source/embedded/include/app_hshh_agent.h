#ifndef APP_HSHH_AGENT_H
#define APP_HSHH_AGENT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tuya_cloud_types.h"

#ifdef __cplusplus
extern "C" {
#endif

OPERATE_RET app_hshh_agent_init(void);
void app_hshh_agent_notify_speech(bool started);
void app_hshh_agent_notify_confirmation(bool hug_scope);
void app_hshh_agent_notify_reject(void);
void app_hshh_agent_notify_stop(void);
void app_hshh_agent_request_capture(void);
bool app_hshh_agent_is_ready(void);
void app_hshh_agent_format_status(char *line, size_t size);
uint32_t app_hshh_agent_take_local_events(void);

#define APP_HSHH_AGENT_LOCAL_CONTEXT_READY (1u << 0)

#ifdef __cplusplus
}
#endif

#endif /* APP_HSHH_AGENT_H */
