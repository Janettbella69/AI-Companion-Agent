/**
 * @file tuya_config.h
 * @brief IoT device credentials and product configuration
 *
 * Real UUID/AuthKey live in tuya_config_secrets.h (gitignored).
 * The Product ID mirrors the product binding in tuyaopen.project.ini.
 */

#ifndef TUYA_CONFIG_H_
#define TUYA_CONFIG_H_

#if __has_include("tuya_config_secrets.h")
#include "tuya_config_secrets.h"
#endif

#ifndef TUYA_PRODUCT_ID
#define TUYA_PRODUCT_ID      "xxhagtjheuafgkag"
#endif

#ifndef TUYA_OPENSDK_UUID
#define TUYA_OPENSDK_UUID    "your_uuid_here"
#endif

#ifndef TUYA_OPENSDK_AUTHKEY
#define TUYA_OPENSDK_AUTHKEY "your_authkey_here"
#endif

#endif /* TUYA_CONFIG_H_ */
