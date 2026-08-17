#include "app_hshh_button.h"

#include <stddef.h>

#include "tal_api.h"
#include "tdl_button_manage.h"

static TDL_BUTTON_HANDLE s_button;
static volatile uint32_t s_pending_events;
static bool s_ready;

static void app_hshh_button_callback(char *name, TDL_BUTTON_TOUCH_EVENT_E event, void *context)
{
    uint32_t mapped = APP_HSHH_BUTTON_EVENT_NONE;

    (void)name;
    (void)context;
    if (event == TDL_BUTTON_PRESS_SINGLE_CLICK) {
        mapped = APP_HSHH_BUTTON_EVENT_CONFIRM;
    } else if (event == TDL_BUTTON_PRESS_DOUBLE_CLICK) {
        mapped = APP_HSHH_BUTTON_EVENT_REJECT;
    } else if (event == TDL_BUTTON_LONG_PRESS_START) {
        mapped = APP_HSHH_BUTTON_EVENT_EMERGENCY_RELEASE;
    }
    if (mapped != APP_HSHH_BUTTON_EVENT_NONE) {
        __atomic_fetch_or(&s_pending_events, mapped, __ATOMIC_RELAXED);
    }
}

OPERATE_RET app_hshh_button_init(void)
{
    OPERATE_RET rt = OPRT_OK;
    TDL_BUTTON_CFG_T config = {
        .long_start_valid_time = 1800u,
        .long_keep_timer = 1000u,
        .button_debounce_time = 50u,
        .button_repeat_valid_count = 2u,
        .button_repeat_valid_time = 450u,
    };

    TUYA_CALL_ERR_RETURN(tdl_button_create(BUTTON_NAME, &config, &s_button));
    tdl_button_event_register(s_button, TDL_BUTTON_PRESS_SINGLE_CLICK, app_hshh_button_callback);
    tdl_button_event_register(s_button, TDL_BUTTON_PRESS_DOUBLE_CLICK, app_hshh_button_callback);
    tdl_button_event_register(s_button, TDL_BUTTON_LONG_PRESS_START, app_hshh_button_callback);
    s_ready = true;
    PR_NOTICE("[HSHH BUTTON] single=confirm double=reject long=stop+release");
    return OPRT_OK;
}

uint32_t app_hshh_button_take_events(void)
{
    return __atomic_exchange_n(&s_pending_events, 0u, __ATOMIC_ACQ_REL);
}

bool app_hshh_button_is_ready(void)
{
    return s_ready;
}
