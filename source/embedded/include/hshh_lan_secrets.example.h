/**
 * Copy this file to hshh_lan_secrets.h and fill in local values.
 * hshh_lan_secrets.h is intentionally ignored by git.
 */

#ifndef HSHH_LAN_SECRETS_H
#define HSHH_LAN_SECRETS_H

/* Used by the independent ESP32-CAM build. T5 Wi-Fi is provisioned by BLE. */
#define HSHH_LAN_WIFI_SSID            "your-2.4-ghz-ssid"
#define HSHH_LAN_WIFI_PASSWORD        "your-wifi-password"
#define HSHH_LAN_MOTION_HOST          "192.168.1.50"
#define HSHH_LAN_MOTION_PORT          80
#define HSHH_LAN_MOTION_SHARED_SECRET "replace-with-at-least-32-random-characters"
#define HSHH_LAN_CAMERA_HOST          "192.168.1.51"
#define HSHH_LAN_CAMERA_PORT          80
/* Must be a different random value from HSHH_LAN_MOTION_SHARED_SECRET. */
#define HSHH_LAN_CAMERA_SHARED_SECRET "replace-with-a-different-32-char-secret"
#define HSHH_LAN_ROBOT_ID             "robot-1"

/* Agent service on the same controlled LAN; token must match HSHH_DEVICE_TOKEN. */
#define HSHH_AGENT_HOST                "192.168.1.20"
#define HSHH_AGENT_PORT                8787
#define HSHH_AGENT_DEVICE_TOKEN        "replace-with-device-bearer-token"
#define HSHH_AGENT_USER_ID             "user-1"

#endif /* HSHH_LAN_SECRETS_H */
