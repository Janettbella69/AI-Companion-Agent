#include "tal_api.h"
#include "tkl_output.h"
#include "cJSON.h"
#include "board_com_api.h"
#include "app_hshh_agent.h"
#include "app_hshh_avatar.h"
#include "app_hshh_display.h"
#include "app_hshh_effects.h"
#include "app_hshh_lan.h"
#include "app_hshh_provisioning.h"
#include "app_hshh_state.h"
#include "app_hshh_voice.h"

static void user_main(void)
{
    OPERATE_RET rt;

#if defined(ENABLE_EXT_RAM) && (ENABLE_EXT_RAM == 1)
    cJSON_InitHooks(&(cJSON_Hooks){.malloc_fn = tal_psram_malloc, .free_fn = tal_psram_free});
#else
    cJSON_InitHooks(&(cJSON_Hooks){.malloc_fn = tal_malloc, .free_fn = tal_free});
#endif

    tal_log_init(TAL_LOG_LEVEL_DEBUG, 4096, (TAL_LOG_OUTPUT_CB)tkl_log_output);

    /* Light the ST7789 before BLE/Wi-Fi. Timers must exist before tdl_*_open(). */
    rt = tal_sw_timer_init();
    if (rt != OPRT_OK) {
        PR_ERR("[HSHH] timer init failed, rt=%d", rt);
    }
    rt = tal_workq_init();
    if (rt != OPRT_OK) {
        PR_ERR("[HSHH] workqueue init failed, rt=%d", rt);
    }
    rt = board_register_hardware();
    if (rt != OPRT_OK) {
        PR_ERR("[HSHH] board registration degraded, rt=%d", rt);
    }
    rt = app_hshh_display_init();
    if (rt != OPRT_OK) {
        PR_ERR("[HSHH] display failed to light, rt=%d", rt);
    }

    /* The provisioner owns the single station connection shared by cloud, Agent,
     * and LAN workers. */
    rt = app_hshh_provisioning_init();
    if (rt != OPRT_OK) {
        PR_ERR("[HSHH PROVISION] initialization failed safely, rt=%d", rt);
    }
    (void)app_hshh_display_force_lit();

    rt = app_hshh_lan_init();
    if (rt != OPRT_OK) {
        PR_ERR("[HSHH LAN] initialization failed safely, rt=%d", rt);
    }

    rt = app_hshh_effects_init();
    if (rt != OPRT_OK) {
        PR_WARN("[HSHH] one or more local effects are degraded, rt=%d", rt);
    }
    (void)app_hshh_display_force_lit();

    rt = app_hshh_voice_init();
    if (rt != OPRT_OK) {
        PR_WARN("[HSHH VOICE] utterance buffer degraded, rt=%d", rt);
    }

    rt = app_hshh_avatar_init();
    if (rt != OPRT_OK) {
        PR_WARN("[HSHH AVATAR] initialization degraded to built-in basic, rt=%d", rt);
    }

    rt = app_hshh_agent_init();
    if (rt != OPRT_OK) {
        PR_WARN("[HSHH AGENT] initialization degraded safely, rt=%d", rt);
    }
    (void)app_hshh_display_force_lit();
    app_hshh_state_run();
}

/**
 * @brief main
 *
 * @param argc
 * @param argv
 * @return void
 */
#if OPERATING_SYSTEM == SYSTEM_LINUX
void main(int argc, char *argv[])
{
    user_main();
}
#else

/* Tuya thread handle */
static THREAD_HANDLE ty_app_thread = NULL;

/**
 * @brief  task thread
 *
 * @param[in] arg:Parameters when creating a task
 * @return none
 */
static void tuya_app_thread(void *arg)
{
    user_main();

    tal_thread_delete(ty_app_thread);
    ty_app_thread = NULL;
}

void tuya_app_main(void)
{
    THREAD_CFG_T thrd_param = {0};
    thrd_param.stackDepth = 1024 * 16;
    thrd_param.priority = THREAD_PRIO_1;
    thrd_param.thrdname = "tuya_app_main";

    tal_thread_create_and_start(&ty_app_thread, NULL, NULL, tuya_app_thread, NULL, &thrd_param);
}
#endif
