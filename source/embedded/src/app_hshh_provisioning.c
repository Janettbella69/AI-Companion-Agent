/**
 * @file app_hshh_provisioning.c
 * @brief Tuya BLE provisioning and persisted Wi-Fi/cloud lifecycle.
 */

#include "app_hshh_provisioning.h"

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "app_hshh_audio.h"
#include "app_hshh_agent.h"
#include "app_hshh_display.h"
#include "app_hshh_effects.h"
#include "app_hshh_expression_assets.h"
#include "app_hshh_voice.h"
#include "netconn_wifi.h"
#include "netmgr.h"
#include "tal_api.h"
#include "tal_cli.h"
#include "tal_event_info.h"
#include "tal_time_service.h"
#include "tuya_authorize.h"
#include "tuya_config.h"
#include "tuya_iot.h"

#if defined(ENABLE_LIBLWIP) && (ENABLE_LIBLWIP == 1)
#include "lwip/lwip_init.h"
#endif

#ifndef PROJECT_VERSION
#define PROJECT_VERSION "1.0.0"
#endif

#define HSHH_UUID_LENGTH_SHORT       16u
#define HSHH_UUID_LENGTH             20u
#define HSHH_AUTHKEY_LENGTH          32u
#define HSHH_RESET_COUNT_KEY         "hshh_rst_cnt"
#define HSHH_RESET_COUNT_MAX         3u
#define HSHH_RESET_COUNT_WINDOW_MS   5000u

static tuya_iot_client_t s_iot_client;
static tuya_iot_license_t s_license;
static THREAD_HANDLE s_iot_thread;
static TIMER_ID s_reset_count_timer;
static volatile bool s_started;
static volatile bool s_online;
static volatile bool s_pairing;
static volatile bool s_bind_seen;
static volatile bool s_token_seen;
static volatile bool s_wifi_seen;
static volatile bool s_activation_seen;
static volatile int s_last_iot_error;

static const char *client_status_name(uint8_t status)
{
    switch (status) {
    case TUYA_STATUS_UNACTIVE:
        return "unactivated";
    case TUYA_STATUS_NETCFG_IDLE:
        return "netcfg_idle";
    case TUYA_STATUS_UNCONNECT_ROUTER:
        return "router_down";
    case TUYA_STATUS_WIFI_CONNECTED:
        return "wifi_connected";
    case TUYA_STATUS_MQTT_CONNECTED:
        return "mqtt_connected";
    default:
        return "unknown";
    }
}

static const char *provisioning_stage_name(void)
{
    if (__atomic_load_n(&s_online, __ATOMIC_ACQUIRE)) {
        return "cloud_online";
    }
    if (__atomic_load_n(&s_activation_seen, __ATOMIC_ACQUIRE) || tuya_iot_activated(&s_iot_client)) {
        return "activated";
    }
    if (__atomic_load_n(&s_wifi_seen, __ATOMIC_ACQUIRE)) {
        return "wifi_seen";
    }
    if (__atomic_load_n(&s_token_seen, __ATOMIC_ACQUIRE)) {
        return "credentials_received";
    }
    if (__atomic_load_n(&s_bind_seen, __ATOMIC_ACQUIRE)) {
        return "waiting_for_credentials";
    }
    return s_started ? "started" : "initializing";
}

static void provisioning_status_command(int argc, char *argv[])
{
    char line[256];
    char *reset_description = NULL;
    netmgr_status_e network_status = NETMGR_LINK_DOWN;
    TUYA_RESET_REASON_E reset_reason;
    OPERATE_RET network_rt;

    (void)argc;
    (void)argv;

    network_rt = netmgr_conn_get(NETCONN_AUTO, NETCONN_CMD_STATUS, &network_status);
    reset_reason = tal_system_get_reset_reason(&reset_description);
    snprintf(line, sizeof(line),
             "HSHH_STATUS stage=%s bind=%u token=%u wifi=%s wifi_seen=%u activated=%u mqtt=%u "
             "client=%s(%u) state=%u last_iot_error=%d uptime_ms=%llu reset=%u",
             provisioning_stage_name(),
             __atomic_load_n(&s_bind_seen, __ATOMIC_ACQUIRE) ? 1u : 0u,
             __atomic_load_n(&s_token_seen, __ATOMIC_ACQUIRE) ? 1u : 0u,
             network_rt == OPRT_OK ? NETMGR_STATUS_TO_STR(network_status) : "unavailable",
             __atomic_load_n(&s_wifi_seen, __ATOMIC_ACQUIRE) ? 1u : 0u,
             tuya_iot_activated(&s_iot_client) ? 1u : 0u,
             __atomic_load_n(&s_online, __ATOMIC_ACQUIRE) ? 1u : 0u,
             client_status_name(s_iot_client.status), (unsigned int)s_iot_client.status,
             (unsigned int)s_iot_client.state,
             __atomic_load_n(&s_last_iot_error, __ATOMIC_ACQUIRE),
             (unsigned long long)tal_system_get_millisecond(), (unsigned int)reset_reason);
    tal_cli_echo(line);
}

static void audio_diagnostics_command(int argc, char *argv[])
{
    app_hshh_audio_diagnostics_t diagnostics = {0};
    char line[192];
    OPERATE_RET rt;

    if (argc >= 2 && strcmp(argv[1], "reset") == 0) {
        app_hshh_audio_reset_diagnostics();
        tal_cli_echo("HSHH_AUDIO reset=ok");
        return;
    }
    if (argc >= 2 && strcmp(argv[1], "tone") == 0) {
        rt = app_hshh_audio_play_cue(APP_HSHH_AUDIO_CUE_CONFIRM);
        snprintf(line, sizeof(line), "HSHH_AUDIO tone=%s rt=%d",
                 rt == OPRT_OK ? "started" : "failed", rt);
        tal_cli_echo(line);
        return;
    }
    if (argc >= 2 && strcmp(argv[1], "volume") == 0) {
        char *end = NULL;
        unsigned long volume;

        if (argc != 3) {
            tal_cli_echo("usage: hshh_audio volume <0-100>");
            return;
        }
        volume = strtoul(argv[2], &end, 10);
        if (end == argv[2] || *end != '\0' || volume > 100u) {
            tal_cli_echo("HSHH_AUDIO volume=invalid");
            return;
        }
        rt = app_hshh_audio_set_volume((uint8_t)volume);
        snprintf(line, sizeof(line), "HSHH_AUDIO volume=%lu result=%s rt=%d", volume,
                 rt == OPRT_OK ? "ok" : "failed", rt);
        tal_cli_echo(line);
        return;
    }
    if (argc >= 2 && strcmp(argv[1], "utterance") == 0) {
        char *end = NULL;
        unsigned long duration_ms = 3000u;

        if (argc >= 3) {
            duration_ms = strtoul(argv[2], &end, 10);
            if (end == argv[2] || *end != '\0' || duration_ms < 300u || duration_ms > 8000u) {
                tal_cli_echo("HSHH_AUDIO utterance=invalid");
                return;
            }
        }
        rt = app_hshh_voice_start_timed_capture((uint32_t)duration_ms);
        snprintf(line, sizeof(line), "HSHH_AUDIO utterance=%s duration_ms=%lu rt=%d",
                 rt == OPRT_OK ? "started" : "failed", duration_ms, rt);
        tal_cli_echo(line);
        return;
    }
    if (argc >= 2 && strcmp(argv[1], "status") != 0) {
        tal_cli_echo("usage: hshh_audio status|reset|tone|volume <0-100>|utterance [ms]");
        return;
    }

    app_hshh_audio_get_diagnostics(&diagnostics);
    snprintf(line, sizeof(line),
             "HSHH_AUDIO ready=%u volume=%u pcm_frames=%lu pcm_bytes=%lu vad_starts=%lu vad_ends=%lu",
             diagnostics.ready ? 1u : 0u,
             diagnostics.volume,
             (unsigned long)diagnostics.pcm_frames,
             (unsigned long)diagnostics.pcm_bytes,
             (unsigned long)diagnostics.vad_starts,
             (unsigned long)diagnostics.vad_ends);
    tal_cli_echo(line);
}

static void agent_status_command(int argc, char *argv[])
{
    char line[256];

    (void)argc;
    (void)argv;
    app_hshh_agent_format_status(line, sizeof(line));
    tal_cli_echo(line);
}

static void display_command(int argc, char *argv[])
{
    char line[160];
    OPERATE_RET rt;

    if (argc >= 2 && strcmp(argv[1], "on") == 0) {
        rt = app_hshh_display_force_lit();
        snprintf(line, sizeof(line), "HSHH_DISPLAY on=%s rt=%d",
                 rt == OPRT_OK ? "red" : "failed", rt);
        tal_cli_echo(line);
        return;
    }
    if (argc >= 2 && strcmp(argv[1], "pin") == 0) {
        char *end_pin = NULL;
        char *end_level = NULL;
        unsigned long pin;
        unsigned long level;

        if (argc != 4) {
            tal_cli_echo("usage: hshh_display pin <gpio> <0|1>");
            return;
        }
        pin = strtoul(argv[2], &end_pin, 10);
        level = strtoul(argv[3], &end_level, 10);
        if (end_pin == argv[2] || *end_pin != '\0' || end_level == argv[3] ||
            *end_level != '\0' || level > 1u) {
            tal_cli_echo("HSHH_DISPLAY pin=invalid");
            return;
        }
        rt = app_hshh_display_drive_pin((uint32_t)pin, (uint8_t)level);
        snprintf(line, sizeof(line), "HSHH_DISPLAY pin=%lu level=%lu rt=%d", pin, level, rt);
        tal_cli_echo(line);
        return;
    }
    if (argc >= 2 && strcmp(argv[1], "hunt") == 0) {
        static const uint8_t pins[] = {9u, 19u, 5u};
        unsigned int index;

        rt = app_hshh_display_force_lit();
        snprintf(line, sizeof(line), "HSHH_DISPLAY hunt=start rt=%d", rt);
        tal_cli_echo(line);
        for (index = 0u; index < (unsigned int)(sizeof(pins) / sizeof(pins[0])); index++) {
            rt = app_hshh_display_drive_pin(pins[index], 1u);
            snprintf(line, sizeof(line), "HSHH_DISPLAY hunt=bl%u=1 rt=%d", pins[index], rt);
            tal_cli_echo(line);
            tal_system_sleep(4000);
            rt = app_hshh_display_drive_pin(pins[index], 0u);
            snprintf(line, sizeof(line), "HSHH_DISPLAY hunt=bl%u=0 rt=%d", pins[index], rt);
            tal_cli_echo(line);
            tal_system_sleep(4000);
        }
        (void)app_hshh_display_drive_pin(9u, 1u);
        tal_cli_echo("HSHH_DISPLAY hunt=done bl9=1");
        return;
    }
    if (argc >= 2 && strcmp(argv[1], "status") != 0) {
        tal_cli_echo("usage: hshh_display status|on|pin <gpio> <0|1>|hunt");
        return;
    }
    snprintf(line, sizeof(line), "HSHH_DISPLAY ready=%u last_init_rt=%d expression=%s",
             app_hshh_display_is_ready() ? 1u : 0u, app_hshh_display_last_init_rt(),
             app_hshh_expression_asset_name((uint8_t)app_hshh_display_current_expression()));
    tal_cli_echo(line);
}

static const cli_cmd_t s_provisioning_cli_commands[] = {
    {
        .name = "hshh_status",
        .help = "Show safe provisioning stage (no credentials)",
        .func = provisioning_status_command,
    },
    {
        .name = "hshh_audio",
        .help = "Audio diagnostics: status|reset|tone|volume|utterance (no raw audio)",
        .func = audio_diagnostics_command,
    },
    {
        .name = "hshh_display",
        .help = "Display diagnostics: status|on|pin|hunt",
        .func = display_command,
    },
    {
        .name = "hshh_agent",
        .help = "Show Agent Wi-Fi client status (no credentials)",
        .func = agent_status_command,
    },
};

static bool init_result_ok(OPERATE_RET rt)
{
    return rt == OPRT_OK || rt == OPRT_INIT_MORE_THAN_ONCE;
}

static bool text_is_placeholder(const char *text)
{
    return text == NULL || text[0] == '\0' || strstr(text, "your_") != NULL ||
           strstr(text, "replace-") != NULL;
}

static bool product_id_valid(void)
{
    size_t length;

    if (text_is_placeholder(TUYA_PRODUCT_ID)) {
        return false;
    }
    length = strlen(TUYA_PRODUCT_ID);
    return length >= 1u && length <= MAX_LENGTH_PRODUCT_ID;
}

static bool license_valid(const tuya_iot_license_t *license)
{
    size_t uuid_length;

    if (license == NULL || text_is_placeholder(license->uuid) || text_is_placeholder(license->authkey)) {
        return false;
    }
    uuid_length = strlen(license->uuid);
    return (uuid_length == HSHH_UUID_LENGTH_SHORT || uuid_length == HSHH_UUID_LENGTH) &&
           strlen(license->authkey) == HSHH_AUTHKEY_LENGTH;
}

static bool network_is_ready(void)
{
    netmgr_status_e status = NETMGR_LINK_DOWN;

    if (netmgr_conn_get(NETCONN_AUTO, NETCONN_CMD_STATUS, &status) != OPRT_OK) {
        return false;
    }
    return status == NETMGR_LINK_UP || status == NETMGR_LINK_UP_SWITH;
}

static OPERATE_RET provisioning_link_status_handler(void *data)
{
    netmgr_status_e status;

    if (data == NULL) {
        return OPRT_INVALID_PARM;
    }
    status = *(netmgr_status_e *)data;
    if (status == NETMGR_LINK_UP || status == NETMGR_LINK_UP_SWITH) {
        __atomic_store_n(&s_wifi_seen, true, __ATOMIC_RELEASE);
        (void)app_hshh_effects_queue_expression(APP_HSHH_EXPRESSION_NOTICED, 30000u);
        PR_NOTICE("[HSHH PROVISION] Wi-Fi link established; cloud activation pending");
    }
    return OPRT_OK;
}

static void provisioning_event_handler(tuya_iot_client_t *client, tuya_event_msg_t *event)
{
    (void)client;

    if (event == NULL) {
        return;
    }
    PR_DEBUG("[HSHH PROVISION] event=%s", EVENT_ID2STR(event->id));

    switch (event->id) {
    case TUYA_EVENT_BIND_START:
        __atomic_store_n(&s_bind_seen, true, __ATOMIC_RELEASE);
        __atomic_store_n(&s_pairing, true, __ATOMIC_RELEASE);
        __atomic_store_n(&s_online, false, __ATOMIC_RELEASE);
        (void)app_hshh_effects_queue_expression(APP_HSHH_EXPRESSION_LISTENING, 30000u);
        PR_NOTICE("[HSHH PROVISION] BLE pairing is ready");
        break;
    case TUYA_EVENT_BIND_TOKEN_ON:
        __atomic_store_n(&s_token_seen, true, __ATOMIC_RELEASE);
        (void)app_hshh_effects_queue_expression(APP_HSHH_EXPRESSION_THINKING, 30000u);
        PR_NOTICE("[HSHH PROVISION] BLE provisioning data received; joining Wi-Fi");
        break;
    case TUYA_EVENT_ACTIVATE_SUCCESSED:
        __atomic_store_n(&s_activation_seen, true, __ATOMIC_RELEASE);
        __atomic_store_n(&s_pairing, false, __ATOMIC_RELEASE);
        (void)app_hshh_effects_queue_expression(APP_HSHH_EXPRESSION_HAPPY, 5000u);
        PR_NOTICE("[HSHH PROVISION] device activation succeeded");
        break;
    case TUYA_EVENT_MQTT_CONNECTED:
        __atomic_store_n(&s_pairing, false, __ATOMIC_RELEASE);
        __atomic_store_n(&s_online, true, __ATOMIC_RELEASE);
        (void)app_hshh_effects_queue_expression(APP_HSHH_EXPRESSION_HAPPY, 5000u);
        PR_NOTICE("[HSHH PROVISION] Tuya cloud connected");
        break;
    case TUYA_EVENT_MQTT_DISCONNECT:
        __atomic_store_n(&s_online, false, __ATOMIC_RELEASE);
        PR_NOTICE("[HSHH PROVISION] Tuya cloud disconnected");
        break;
    case TUYA_EVENT_RESET_COMPLETE:
        PR_NOTICE("[HSHH PROVISION] pairing data cleared; restarting");
        tal_system_reset();
        break;
    default:
        break;
    }
}

static void reset_count_write(uint8_t count)
{
    OPERATE_RET rt = tal_kv_set(HSHH_RESET_COUNT_KEY, &count, sizeof(count));

    if (rt != OPRT_OK) {
        PR_WARN("[HSHH PROVISION] reset counter write failed, rt=%d", rt);
    }
}

static void reset_count_clear_timer(TIMER_ID timer_id, void *arg)
{
    (void)timer_id;
    (void)arg;
    reset_count_write(0u);
}

static uint8_t reset_count_start(void)
{
    uint8_t count = 0u;
    uint8_t *stored = NULL;
    size_t stored_length = 0u;
    OPERATE_RET rt;

    rt = tal_kv_get(HSHH_RESET_COUNT_KEY, &stored, &stored_length);
    if (rt == OPRT_OK && stored != NULL && stored_length == sizeof(count)) {
        count = stored[0];
    }
    if (stored != NULL) {
        tal_kv_free(stored);
    }
    if (count < UINT8_MAX) {
        count++;
    }
    reset_count_write(count);

    rt = tal_sw_timer_create(reset_count_clear_timer, NULL, &s_reset_count_timer);
    if (rt == OPRT_OK) {
        rt = tal_sw_timer_start(s_reset_count_timer, HSHH_RESET_COUNT_WINDOW_MS, TAL_TIMER_ONCE);
    }
    if (rt != OPRT_OK) {
        PR_WARN("[HSHH PROVISION] reset window timer unavailable, rt=%d", rt);
        reset_count_write(0u);
        return 0u;
    }
    return count;
}

static void iot_worker(void *arg)
{
    (void)arg;

    while (true) {
        OPERATE_RET rt = tuya_iot_yield(&s_iot_client);

        if (rt != OPRT_OK) {
            __atomic_store_n(&s_last_iot_error, rt, __ATOMIC_RELEASE);
            PR_WARN("[HSHH PROVISION] Tuya IoT yield failed, rt=%d", rt);
            tal_system_sleep(500u);
        } else {
            tal_system_sleep(10u);
        }
    }
}

OPERATE_RET app_hshh_provisioning_init(void)
{
    static tal_kv_cfg_t kv_config = {
        .seed = "vmlkasdh93dlvlcy",
        .key = "dflfuap134ddlduq",
    };
    THREAD_CFG_T thread_config = {0};
    tuya_iot_license_t configured_license = {
        .uuid = TUYA_OPENSDK_UUID,
        .authkey = TUYA_OPENSDK_AUTHKEY,
    };
    uint8_t boot_count;
    OPERATE_RET rt;

    if (s_started) {
        return OPRT_OK;
    }
    if (!product_id_valid()) {
        PR_ERR("[HSHH PROVISION] Tuya Product ID is missing or invalid");
        return OPRT_INVALID_PARM;
    }

    rt = tal_kv_init(&kv_config);
    if (!init_result_ok(rt)) {
        return rt;
    }
    rt = tal_sw_timer_init();
    if (!init_result_ok(rt)) {
        return rt;
    }
    rt = tal_workq_init();
    if (!init_result_ok(rt)) {
        return rt;
    }
    rt = tal_time_service_init();
    if (!init_result_ok(rt)) {
        return rt;
    }
    rt = tal_cli_init();
    if (!init_result_ok(rt)) {
        return rt;
    }
    rt = tuya_authorize_init();
    if (!init_result_ok(rt)) {
        return rt;
    }

    boot_count = reset_count_start();
    rt = tuya_authorize_read(&s_license);
    if (rt != OPRT_OK || !license_valid(&s_license)) {
        if (!license_valid(&configured_license)) {
            PR_ERR("[HSHH PROVISION] UUID/AuthKey are missing or invalid");
            return OPRT_INVALID_PARM;
        }
        s_license = configured_license;
        PR_NOTICE("[HSHH PROVISION] using local device license");
    } else {
        PR_NOTICE("[HSHH PROVISION] using device-stored license");
    }

    rt = tuya_iot_init(&s_iot_client, &(const tuya_iot_config_t){
                                            .software_ver = PROJECT_VERSION,
                                            .productkey = TUYA_PRODUCT_ID,
                                            .uuid = s_license.uuid,
                                            .authkey = s_license.authkey,
                                            .event_handler = provisioning_event_handler,
                                            .network_check = network_is_ready,
                                        });
    if (rt != OPRT_OK) {
        return rt;
    }

#if defined(ENABLE_LIBLWIP) && (ENABLE_LIBLWIP == 1)
    TUYA_LwIP_Init();
#endif

    rt = netmgr_init(NETCONN_WIFI);
    if (rt != OPRT_OK) {
        return rt;
    }
    rt = tal_event_subscribe(EVENT_LINK_STATUS_CHG, "hshh_provision",
                             provisioning_link_status_handler, SUBSCRIBE_TYPE_NORMAL);
    if (rt != OPRT_OK) {
        return rt;
    }
    rt = netmgr_conn_set(NETCONN_WIFI, NETCONN_CMD_NETCFG,
                         &(netcfg_args_t){.type = NETCFG_TUYA_BLE});
    if (rt != OPRT_OK) {
        return rt;
    }
    rt = tuya_iot_start(&s_iot_client);
    if (rt != OPRT_OK) {
        return rt;
    }

    rt = tal_cli_cmd_register(s_provisioning_cli_commands,
                              sizeof(s_provisioning_cli_commands) / sizeof(s_provisioning_cli_commands[0]));
    if (rt != OPRT_OK) {
        PR_WARN("[HSHH PROVISION] status CLI registration failed, rt=%d", rt);
    }

    if (boot_count >= HSHH_RESET_COUNT_MAX) {
        reset_count_write(0u);
        if (tuya_iot_activated(&s_iot_client)) {
            PR_NOTICE("[HSHH PROVISION] three quick boots detected; clearing pairing data");
            (void)tuya_iot_reset(&s_iot_client);
        } else {
            (void)netmgr_conn_set(NETCONN_WIFI, NETCONN_CMD_RESET, NULL);
        }
    }

    thread_config.stackDepth = 1024u * 8u;
    thread_config.priority = THREAD_PRIO_2;
    thread_config.thrdname = "hshh_iot";
    rt = tal_thread_create_and_start(&s_iot_thread, NULL, NULL, iot_worker, NULL, &thread_config);
    if (rt != OPRT_OK) {
        return rt;
    }
    s_started = true;

    PR_NOTICE("[HSHH PROVISION] Tuya BLE provisioning started; credentials are not logged");
    return OPRT_OK;
}

bool app_hshh_provisioning_is_online(void)
{
    return __atomic_load_n(&s_online, __ATOMIC_ACQUIRE);
}

bool app_hshh_provisioning_is_pairing(void)
{
    return __atomic_load_n(&s_pairing, __ATOMIC_ACQUIRE);
}
