/**
 * @file app_hshh_lan_config.h
 * @brief Non-secret defaults for the signed HSHH LAN client.
 */

#ifndef APP_HSHH_LAN_CONFIG_H
#define APP_HSHH_LAN_CONFIG_H

#if __has_include("hshh_lan_secrets.h")
#include "hshh_lan_secrets.h"
#endif

#ifndef HSHH_LAN_MOTION_HOST
#define HSHH_LAN_MOTION_HOST ""
#endif

#ifndef HSHH_LAN_MOTION_PORT
#define HSHH_LAN_MOTION_PORT 80
#endif

#ifndef HSHH_LAN_MOTION_SHARED_SECRET
#define HSHH_LAN_MOTION_SHARED_SECRET ""
#endif

#ifndef HSHH_LAN_ROBOT_ID
#define HSHH_LAN_ROBOT_ID ""
#endif

#ifndef HSHH_AGENT_HOST
#define HSHH_AGENT_HOST ""
#endif

#ifndef HSHH_AGENT_PORT
#define HSHH_AGENT_PORT 8787
#endif

#ifndef HSHH_AGENT_DEVICE_TOKEN
#define HSHH_AGENT_DEVICE_TOKEN ""
#endif

#ifndef HSHH_AGENT_USER_ID
#define HSHH_AGENT_USER_ID ""
#endif

#define HSHH_LAN_HTTP_TIMEOUT_MS       3500u
#define HSHH_LAN_COMMAND_TTL_MS        1500u
#define HSHH_LAN_PENDING_TTL_MS        1000u
#define HSHH_LAN_STATUS_INTERVAL_MS    5000u
#define HSHH_LAN_RETRY_INTERVAL_MS     1500u
#define HSHH_LAN_MAX_RESPONSE_BYTES    2048u
#define HSHH_AGENT_HTTP_TIMEOUT_MS      3500u
#define HSHH_AGENT_EFFECT_INTERVAL_MS  600u
#define HSHH_AGENT_MAX_RESPONSE_BYTES  12288u
#define HSHH_AGENT_SPEECH_TIMEOUT_MS   8000u
#define HSHH_AGENT_SPEECH_MAX_BYTES    (512u * 1024u)
#define HSHH_AGENT_UTTERANCES_PATH     "/v1/device/utterances"

#endif /* APP_HSHH_LAN_CONFIG_H */
