#ifndef APP_HSHH_AVATAR_H
#define APP_HSHH_AVATAR_H

#include <stdbool.h>
#include <stdint.h>

#include "tuya_cloud_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Load and validate any previously activated slot, then start the downloader. */
OPERATE_RET app_hshh_avatar_init(void);

/** Loads one active pet JPEG. Caller owns the returned buffer via tal_free(). */
OPERATE_RET app_hshh_avatar_load_frame(uint8_t expression, uint8_t frame,
                                      uint8_t **data, uint32_t *length);

/** Disable a corrupt runtime slot immediately; built-in assets remain available. */
void app_hshh_avatar_mark_runtime_invalid(void);
bool app_hshh_avatar_is_active(void);

#ifdef __cplusplus
}
#endif

#endif /* APP_HSHH_AVATAR_H */
