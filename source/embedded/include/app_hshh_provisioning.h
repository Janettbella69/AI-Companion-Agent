#ifndef APP_HSHH_PROVISIONING_H
#define APP_HSHH_PROVISIONING_H

#include <stdbool.h>

#include "tuya_cloud_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Initialize Tuya IoT, BLE provisioning, and persisted Wi-Fi reconnect. */
OPERATE_RET app_hshh_provisioning_init(void);

/** True after the device has connected to the Tuya MQTT service. */
bool app_hshh_provisioning_is_online(void);

/** True while the unactivated device is waiting for Tuya BLE provisioning. */
bool app_hshh_provisioning_is_pairing(void);

#ifdef __cplusplus
}
#endif

#endif /* APP_HSHH_PROVISIONING_H */
