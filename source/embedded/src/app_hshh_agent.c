#include "app_hshh_agent.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "app_hshh_audio.h"
#include "app_hshh_display.h"
#include "app_hshh_effects.h"
#include "app_hshh_lan.h"
#include "app_hshh_lan_config.h"
#include "app_hshh_provisioning.h"
#include "app_hshh_voice.h"
#include "cJSON.h"
#include "http_client_interface.h"
#include "tal_api.h"
#include "tal_time_service.h"

#define HSHH_AGENT_EFFECTS_PATH       "/v1/device/effects"
#define HSHH_AGENT_EVENTS_PATH        "/v1/device/events"
#define HSHH_AGENT_CAPTURE_PATH       "/v1/device/captures"
#define HSHH_AGENT_SPEECH_PATH        "/v1/device/speech"
#define HSHH_AGENT_TIMESTAMP_LENGTH   24u
#define HSHH_AGENT_MAX_EFFECTS        8u
#define HSHH_AGENT_AUTH_BYTES         640u
#define HSHH_AGENT_PATH_BYTES         256u
#define HSHH_AGENT_BODY_BYTES         1400u
#define HSHH_AGENT_SPEECH_ID_MAX      80u

#define HSHH_AGENT_PENDING_SPEECH_START (1u << 0)
#define HSHH_AGENT_PENDING_SPEECH_END   (1u << 1)
#define HSHH_AGENT_PENDING_APPROACH_OK  (1u << 2)
#define HSHH_AGENT_PENDING_HUG_OK       (1u << 3)
#define HSHH_AGENT_PENDING_REJECT       (1u << 4)
#define HSHH_AGENT_PENDING_STOP         (1u << 5)
#define HSHH_AGENT_PENDING_CAPTURE      (1u << 6)
#define HSHH_AGENT_PENDING_USER_CAPTURE (1u << 7)

static THREAD_HANDLE s_agent_thread;
static volatile uint32_t s_pending_requests;
static volatile uint32_t s_local_events;
static volatile bool s_started;
static volatile bool s_ready;
static OPERATE_RET s_last_poll_rt;
static uint32_t s_last_poll_http;
static OPERATE_RET s_last_utterance_rt;
static uint32_t s_last_utterance_http;
static uint32_t s_effect_cursor;
static uint32_t s_event_sequence;
static char s_authorization[HSHH_AGENT_AUTH_BYTES];

static size_t app_hshh_bounded_length(const char *text, size_t maximum)
{
    size_t length = 0u;

    if (text == NULL) {
        return 0u;
    }
    while (length <= maximum && text[length] != '\0') {
        length++;
    }
    return length;
}

static bool app_hshh_agent_config_valid(void)
{
    size_t host_length = app_hshh_bounded_length(HSHH_AGENT_HOST, 253u);
    size_t token_length = app_hshh_bounded_length(HSHH_AGENT_DEVICE_TOKEN, 512u);
    size_t user_length = app_hshh_bounded_length(HSHH_AGENT_USER_ID, 128u);

    return host_length >= 1u && host_length <= 253u && strstr(HSHH_AGENT_HOST, "://") == NULL &&
           strchr(HSHH_AGENT_HOST, '/') == NULL && token_length >= 16u && token_length <= 512u &&
           user_length >= 1u && user_length <= 128u && HSHH_AGENT_PORT > 0;
}

static bool app_hshh_format_utc(uint64_t epoch_ms, char output[HSHH_AGENT_TIMESTAMP_LENGTH + 1u])
{
    TIME_T seconds = (TIME_T)(epoch_ms / 1000u);
    POSIX_TM_S utc = {0};
    int written;

    if (tal_time_gmtime_r(&seconds, &utc) == NULL || utc.tm_year + 1900 < 2024 || utc.tm_year + 1900 > 2099) {
        return false;
    }
    written = snprintf(output, HSHH_AGENT_TIMESTAMP_LENGTH + 1u, "%04d-%02d-%02dT%02d:%02d:%02d.%03uZ",
                       utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec,
                       (unsigned int)(epoch_ms % 1000u));
    return written == (int)HSHH_AGENT_TIMESTAMP_LENGTH;
}

static bool app_hshh_parse_digits(const char *text, size_t count, int *value)
{
    size_t index;
    int parsed = 0;

    for (index = 0u; index < count; index++) {
        if (text[index] < '0' || text[index] > '9') {
            return false;
        }
        parsed = parsed * 10 + (text[index] - '0');
    }
    *value = parsed;
    return true;
}

static bool app_hshh_parse_utc(const char *timestamp, uint64_t *epoch_ms)
{
    POSIX_TM_S utc = {0};
    TIME_T epoch;
    int year;
    int month;
    int day;
    int hour;
    int minute;
    int second;
    int millisecond;

    if (timestamp == NULL || epoch_ms == NULL || strlen(timestamp) != HSHH_AGENT_TIMESTAMP_LENGTH ||
        timestamp[4] != '-' || timestamp[7] != '-' || timestamp[10] != 'T' || timestamp[13] != ':' ||
        timestamp[16] != ':' || timestamp[19] != '.' || timestamp[23] != 'Z' ||
        !app_hshh_parse_digits(timestamp, 4u, &year) ||
        !app_hshh_parse_digits(timestamp + 5, 2u, &month) ||
        !app_hshh_parse_digits(timestamp + 8, 2u, &day) ||
        !app_hshh_parse_digits(timestamp + 11, 2u, &hour) ||
        !app_hshh_parse_digits(timestamp + 14, 2u, &minute) ||
        !app_hshh_parse_digits(timestamp + 17, 2u, &second) ||
        !app_hshh_parse_digits(timestamp + 20, 3u, &millisecond) || year < 2024 || year > 2099 ||
        month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
        return false;
    }
    utc.tm_year = year - 1900;
    utc.tm_mon = month - 1;
    utc.tm_mday = day;
    utc.tm_hour = hour;
    utc.tm_min = minute;
    utc.tm_sec = second;
    epoch = tal_time_mktime(&utc);
    if (epoch <= 0) {
        return false;
    }
    *epoch_ms = (uint64_t)epoch * 1000u + (uint64_t)millisecond;
    return true;
}

static const char *app_hshh_json_text(cJSON *object, const char *name)
{
    cJSON *item = cJSON_GetObjectItemCaseSensitive(object, name);

    return cJSON_IsString(item) ? cJSON_GetStringValue(item) : NULL;
}

static OPERATE_RET app_hshh_http_request(const char *path, const char *method, const uint8_t *body,
                                         size_t body_length, http_client_header_t *headers,
                                         uint8_t headers_count, uint32_t timeout_ms,
                                         size_t max_response_bytes, http_client_response_t *response)
{
    http_client_status_t status;

    status = http_client_request(
        &(const http_client_request_t){
            .host = HSHH_AGENT_HOST,
            .port = HSHH_AGENT_PORT,
            .path = path,
            .method = method,
            .headers = headers,
            .headers_count = headers_count,
            .body = body == NULL ? (const uint8_t *)"" : body,
            .body_length = body_length,
            .timeout_ms = timeout_ms,
        },
        response);
    if (status != HTTP_CLIENT_SUCCESS || response->body == NULL) {
        return OPRT_COM_ERROR;
    }
    if (max_response_bytes > 0u && response->body_length > max_response_bytes) {
        return OPRT_COM_ERROR;
    }
    return OPRT_OK;
}

static OPERATE_RET app_hshh_http_json(const char *path, const char *method, const char *body,
                                      http_client_response_t *response)
{
    http_client_header_t headers[] = {
        {.key = "Authorization", .value = s_authorization},
        {.key = "Accept", .value = "application/json"},
        {.key = "Content-Type", .value = "application/json"},
    };

    return app_hshh_http_request(path, method, (const uint8_t *)(body == NULL ? "" : body),
                                 body == NULL ? 0u : strlen(body), headers,
                                 (uint8_t)(sizeof(headers) / sizeof(headers[0])),
                                 HSHH_AGENT_HTTP_TIMEOUT_MS, HSHH_AGENT_MAX_RESPONSE_BYTES,
                                 response);
}

static bool app_hshh_expression_from_text(const char *text, uint8_t *expression)
{
    static const char *names[] = {"idle", "noticed", "listening", "thinking", "happy",
                                  "confused", "sad", "sleeping", "angry"};
    uint8_t index;

    if (text == NULL || expression == NULL) {
        return false;
    }
    for (index = 0u; index < sizeof(names) / sizeof(names[0]); index++) {
        if (strcmp(text, names[index]) == 0) {
            *expression = index;
            return true;
        }
    }
    return false;
}

static bool app_hshh_sound_from_text(const char *text, uint8_t *sound)
{
    if (text == NULL || sound == NULL) {
        return false;
    }
    if (strcmp(text, "notice") == 0 || strcmp(text, "listening") == 0) {
        *sound = APP_HSHH_AUDIO_CUE_NOTICED;
    } else if (strcmp(text, "confirm") == 0) {
        *sound = APP_HSHH_AUDIO_CUE_CONFIRM;
    } else if (strcmp(text, "success") == 0 || strcmp(text, "sleepy") == 0) {
        *sound = APP_HSHH_AUDIO_CUE_HAPPY;
    } else if (strcmp(text, "confused") == 0) {
        *sound = APP_HSHH_AUDIO_CUE_CONFUSED;
    } else if (strcmp(text, "stop") == 0) {
        *sound = APP_HSHH_AUDIO_CUE_STOP;
    } else {
        return false;
    }
    return true;
}

static bool app_hshh_speech_id_valid(const char *speech_id)
{
    size_t length;
    size_t index;

    if (speech_id == NULL) {
        return false;
    }
    length = strlen(speech_id);
    if (length < 8u || length > HSHH_AGENT_SPEECH_ID_MAX) {
        return false;
    }
    for (index = 0u; index < length; index++) {
        const char character = speech_id[index];

        if (!((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
              (character >= '0' && character <= '9') || character == '_' || character == '-')) {
            return false;
        }
    }
    return true;
}

static OPERATE_RET app_hshh_post_utterance(const uint8_t *pcm, uint32_t length, const char *utterance_id,
                                           uint32_t sample_rate)
{
    char sample_rate_text[12];
    http_client_response_t response = {0};
    int written;
    OPERATE_RET rt;
    http_client_header_t headers[] = {
        {.key = "Authorization", .value = s_authorization},
        {.key = "Content-Type", .value = "application/octet-stream"},
        {.key = "X-Hshh-Audio-Format", .value = "pcm_s16le"},
        {.key = "X-Hshh-Sample-Rate", .value = sample_rate_text},
        {.key = "X-Hshh-Channels", .value = "1"},
        {.key = "X-Hshh-Utterance-Id", .value = utterance_id},
    };

    if (pcm == NULL || length == 0u || utterance_id == NULL || utterance_id[0] == '\0') {
        return OPRT_INVALID_PARM;
    }
    written = snprintf(sample_rate_text, sizeof(sample_rate_text), "%lu", (unsigned long)sample_rate);
    if (written <= 0 || (size_t)written >= sizeof(sample_rate_text)) {
        return OPRT_COM_ERROR;
    }
    rt = app_hshh_http_request(HSHH_AGENT_UTTERANCES_PATH, "POST", pcm, length, headers,
                               (uint8_t)(sizeof(headers) / sizeof(headers[0])),
                               HSHH_AGENT_SPEECH_TIMEOUT_MS, HSHH_AGENT_MAX_RESPONSE_BYTES,
                               &response);
    PR_NOTICE("[HSHH AGENT] utterance POST bytes=%lu status=%u rt=%d", (unsigned long)length,
              (unsigned int)response.status_code, rt);
    s_last_utterance_http = response.status_code;
    if (rt == OPRT_OK && response.status_code != 202u) {
        rt = OPRT_COM_ERROR;
    }
    s_last_utterance_rt = rt;
    http_client_free(&response);
    return rt;
}

static OPERATE_RET app_hshh_play_speech(const char *speech_id, uint32_t sample_rate)
{
    char path[HSHH_AGENT_PATH_BYTES];
    http_client_response_t response = {0};
    int written;
    OPERATE_RET rt;
    http_client_header_t headers[] = {
        {.key = "Authorization", .value = s_authorization},
        {.key = "Accept", .value = "application/octet-stream"},
    };

    (void)sample_rate;
    written = snprintf(path, sizeof(path), "%s/%s", HSHH_AGENT_SPEECH_PATH, speech_id);
    if (written <= 0 || (size_t)written >= sizeof(path)) {
        return OPRT_COM_ERROR;
    }
    app_hshh_audio_stop();
    rt = app_hshh_http_request(path, "GET", NULL, 0u, headers,
                               (uint8_t)(sizeof(headers) / sizeof(headers[0])),
                               HSHH_AGENT_SPEECH_TIMEOUT_MS, HSHH_AGENT_SPEECH_MAX_BYTES, &response);
    PR_NOTICE("[HSHH AGENT] speech GET bytes=%lu status=%u rt=%d",
              (unsigned long)response.body_length, (unsigned int)response.status_code, rt);
    if (rt != OPRT_OK || response.status_code != 200u || response.body_length == 0u) {
        http_client_free(&response);
        return OPRT_COM_ERROR;
    }
    app_hshh_voice_set_speaking(true);
    rt = app_hshh_audio_play_pcm(response.body, (uint32_t)response.body_length);
    app_hshh_voice_set_speaking(false);
    http_client_free(&response);
    return rt;
}

static OPERATE_RET app_hshh_ack_effect(const char *effect_id, OPERATE_RET apply_result)
{
    char path[HSHH_AGENT_PATH_BYTES];
    char body[192];
    http_client_response_t response = {0};
    int written;
    OPERATE_RET rt;

    written = snprintf(path, sizeof(path), "/v1/device/effects/%s/ack", effect_id);
    if (written <= 0 || (size_t)written >= sizeof(path)) {
        return OPRT_COM_ERROR;
    }
    written = snprintf(body, sizeof(body), "{\"status\":\"%s\",\"reason_code\":\"%s\"}",
                       apply_result == OPRT_OK ? "completed" : "failed",
                       apply_result == OPRT_OK ? "t5_effect_applied" : "t5_effect_apply_failed");
    if (written <= 0 || (size_t)written >= sizeof(body)) {
        return OPRT_COM_ERROR;
    }
    rt = app_hshh_http_json(path, "POST", body, &response);
    if (rt == OPRT_OK && response.status_code != 200u) {
        rt = OPRT_COM_ERROR;
    }
    http_client_free(&response);
    return rt;
}

static OPERATE_RET app_hshh_apply_effect(cJSON *effect, uint32_t *sequence_out)
{
    cJSON *sequence_item = cJSON_GetObjectItemCaseSensitive(effect, "sequence");
    const char *effect_id = app_hshh_json_text(effect, "effect_id");
    const char *device_id = app_hshh_json_text(effect, "device_id");
    const char *type = app_hshh_json_text(effect, "type");
    const char *expires_at = app_hshh_json_text(effect, "expires_at");
    uint64_t expires_ms;
    uint64_t now_ms = (uint64_t)tal_time_get_posix_ms();
    uint32_t sequence;
    uint8_t semantic_value;
    OPERATE_RET rt;

    if (!cJSON_IsNumber(sequence_item) || sequence_item->valuedouble < 1.0 ||
        sequence_item->valuedouble > 4294967295.0 || effect_id == NULL || strlen(effect_id) > 128u ||
        device_id == NULL || strcmp(device_id, HSHH_LAN_ROBOT_ID) != 0 || type == NULL ||
        !app_hshh_parse_utc(expires_at, &expires_ms)) {
        return OPRT_COM_ERROR;
    }
    sequence = (uint32_t)sequence_item->valuedouble;
    if (sequence <= s_effect_cursor || expires_ms <= now_ms) {
        *sequence_out = sequence;
        return OPRT_OK;
    }

    if (strcmp(type, "set_expression") == 0 &&
        app_hshh_expression_from_text(app_hshh_json_text(effect, "expression"), &semantic_value)) {
        cJSON *duration_item = cJSON_GetObjectItemCaseSensitive(effect, "duration_ms");
        if (!cJSON_IsNumber(duration_item) || duration_item->valuedouble != (double)duration_item->valueint ||
            duration_item->valueint < 100 || duration_item->valueint > 30000) {
            rt = OPRT_INVALID_PARM;
        } else {
            rt = app_hshh_effects_queue_expression(semantic_value, (uint32_t)duration_item->valueint);
        }
    } else if (strcmp(type, "play_sound") == 0 &&
               app_hshh_sound_from_text(app_hshh_json_text(effect, "sound"), &semantic_value)) {
        rt = app_hshh_effects_queue_sound(semantic_value);
    } else if (strcmp(type, "offer_consent") == 0) {
        const char *scope = app_hshh_json_text(effect, "consent_scope");
        const uint64_t remaining_ms = expires_ms - now_ms;
        app_hshh_consent_scope_t consent_scope;

        if (scope != NULL && strcmp(scope, "approach_short") == 0) {
            consent_scope = APP_HSHH_CONSENT_APPROACH;
        } else if (scope != NULL && strcmp(scope, "invite_hug") == 0) {
            consent_scope = APP_HSHH_CONSENT_HUG;
        } else {
            *sequence_out = sequence;
            (void)app_hshh_ack_effect(effect_id, OPRT_INVALID_PARM);
            return OPRT_INVALID_PARM;
        }
        app_hshh_effects_offer_consent(
            consent_scope,
            tal_system_get_millisecond() + (uint32_t)(remaining_ms > 15000u ? 15000u : remaining_ms));
        rt = OPRT_OK;
    } else if (strcmp(type, "play_speech") == 0) {
        const char *speech_id = app_hshh_json_text(effect, "speech_id");
        const char *format = app_hshh_json_text(effect, "format");
        cJSON *sample_rate_item = cJSON_GetObjectItemCaseSensitive(effect, "sample_rate");
        uint32_t sample_rate;

        if (!app_hshh_speech_id_valid(speech_id) || format == NULL ||
            strcmp(format, "pcm_s16le") != 0 || !cJSON_IsNumber(sample_rate_item) ||
            sample_rate_item->valuedouble < 8000.0 || sample_rate_item->valuedouble > 24000.0) {
            rt = OPRT_INVALID_PARM;
        } else {
            sample_rate = (uint32_t)sample_rate_item->valuedouble;
            rt = app_hshh_play_speech(speech_id, sample_rate);
            if (rt != OPRT_OK) {
                (void)app_hshh_effects_queue_sound(APP_HSHH_AUDIO_CUE_CONFUSED);
            }
        }
    } else {
        rt = OPRT_NOT_SUPPORTED;
    }
    *sequence_out = sequence;
    (void)app_hshh_ack_effect(effect_id, rt);
    return rt;
}

static OPERATE_RET app_hshh_poll_effects(void)
{
    char path[HSHH_AGENT_PATH_BYTES];
    http_client_response_t response = {0};
    cJSON *root = NULL;
    cJSON *effects;
    cJSON *effect;
    size_t count = 0u;
    int written;
    OPERATE_RET rt;

    written = snprintf(path, sizeof(path), "%s?after=%lu&limit=%u", HSHH_AGENT_EFFECTS_PATH,
                       (unsigned long)s_effect_cursor, (unsigned int)HSHH_AGENT_MAX_EFFECTS);
    if (written <= 0 || (size_t)written >= sizeof(path)) {
        return OPRT_COM_ERROR;
    }
    rt = app_hshh_http_json(path, "GET", NULL, &response);
    s_last_poll_http = response.status_code;
    if (rt != OPRT_OK || response.status_code != 200u) {
        rt = OPRT_COM_ERROR;
        goto exit;
    }
    root = cJSON_ParseWithLength((const char *)response.body, response.body_length);
    effects = cJSON_GetObjectItemCaseSensitive(root, "effects");
    if (!cJSON_IsObject(root) || !cJSON_IsArray(effects) || cJSON_GetArraySize(effects) > HSHH_AGENT_MAX_EFFECTS) {
        rt = OPRT_COM_ERROR;
        goto exit;
    }
    cJSON_ArrayForEach(effect, effects) {
        uint32_t sequence = 0u;

        if (!cJSON_IsObject(effect) || app_hshh_apply_effect(effect, &sequence) != OPRT_OK) {
            PR_WARN("[HSHH AGENT] rejected invalid or unsupported T5 effect");
        }
        if (sequence > s_effect_cursor) {
            s_effect_cursor = sequence;
        }
        count++;
    }
    PR_DEBUG("[HSHH AGENT] effect poll ok count=%u cursor=%lu", (unsigned int)count,
             (unsigned long)s_effect_cursor);
    rt = OPRT_OK;

exit:
    s_last_poll_rt = rt;
    cJSON_Delete(root);
    http_client_free(&response);
    return rt;
}

static OPERATE_RET app_hshh_post_event(const char *event, const char *source, const char *payload)
{
    char timestamp[HSHH_AGENT_TIMESTAMP_LENGTH + 1u];
    char body[HSHH_AGENT_BODY_BYTES];
    char request_id[80];
    http_client_response_t response = {0};
    uint64_t now_ms = (uint64_t)tal_time_get_posix_ms();
    int written;
    OPERATE_RET rt;

    if (!app_hshh_format_utc(now_ms, timestamp)) {
        return OPRT_RESOURCE_NOT_READY;
    }
    s_event_sequence++;
    written = snprintf(request_id, sizeof(request_id), "t5-event-%llu-%lu", (unsigned long long)now_ms,
                       (unsigned long)s_event_sequence);
    if (written <= 0 || (size_t)written >= sizeof(request_id)) {
        return OPRT_COM_ERROR;
    }
    written = snprintf(body, sizeof(body),
                       "{\"device_id\":\"%s\",\"user_id\":\"%s\",\"event\":\"%s\","
                       "\"source\":\"%s\",\"request_id\":\"%s\",\"occurred_at\":\"%s\","
                       "\"payload\":%s}",
                       HSHH_LAN_ROBOT_ID, HSHH_AGENT_USER_ID, event, source, request_id, timestamp, payload);
    if (written <= 0 || (size_t)written >= sizeof(body)) {
        return OPRT_COM_ERROR;
    }
    rt = app_hshh_http_json(HSHH_AGENT_EVENTS_PATH, "POST", body, &response);
    if (rt == OPRT_OK && response.status_code != 202u) {
        rt = OPRT_COM_ERROR;
    }
    http_client_free(&response);
    return rt;
}

static OPERATE_RET app_hshh_post_capture(const char *trigger_reason)
{
    static const char presence_body[] = "{\"trigger_reason\":\"presence_event\"}";
    static const char user_body[] = "{\"trigger_reason\":\"user_request\"}";
    const char *body;
    http_client_response_t response = {0};
    cJSON *root = NULL;
    cJSON *accepted;
    OPERATE_RET rt;

    if (trigger_reason == NULL || strcmp(trigger_reason, "presence_event") == 0) {
        body = presence_body;
    } else if (strcmp(trigger_reason, "user_request") == 0) {
        body = user_body;
    } else {
        return OPRT_INVALID_PARM;
    }
    rt = app_hshh_http_json(HSHH_AGENT_CAPTURE_PATH, "POST", body, &response);
    if (rt != OPRT_OK || response.status_code != 202u) {
        rt = OPRT_COM_ERROR;
        goto exit;
    }
    root = cJSON_ParseWithLength((const char *)response.body, response.body_length);
    accepted = cJSON_GetObjectItemCaseSensitive(root, "accepted");
    if (!cJSON_IsObject(root) || !cJSON_IsTrue(accepted) || app_hshh_json_text(root, "capture_id") == NULL) {
        rt = OPRT_COM_ERROR;
        goto exit;
    }
    __atomic_fetch_or(&s_local_events, APP_HSHH_AGENT_LOCAL_CONTEXT_READY, __ATOMIC_RELEASE);
    rt = OPRT_OK;

exit:
    cJSON_Delete(root);
    http_client_free(&response);
    return rt;
}

static void app_hshh_process_pending(uint32_t pending)
{
    if ((pending & HSHH_AGENT_PENDING_STOP) != 0u) {
        (void)app_hshh_post_event("local_stop", "t5_button",
                                  "{\"gesture\":\"stop\",\"stop\":true,\"confidence\":1,"
                                  "\"summary\":\"Explicit local stop\"}");
    }
    if ((pending & HSHH_AGENT_PENDING_REJECT) != 0u) {
        (void)app_hshh_post_event("user_reject", "t5_button",
                                  "{\"gesture\":\"reject\",\"rejected\":true,\"confidence\":1,"
                                  "\"summary\":\"Explicit button rejection\"}");
    }
    if ((pending & HSHH_AGENT_PENDING_APPROACH_OK) != 0u) {
        (void)app_hshh_post_event("approach_consent_granted", "t5_button",
                                  "{\"gesture\":\"confirm\",\"explicit\":true,"
                                  "\"consent_scope\":\"approach_short\",\"confidence\":1,"
                                  "\"summary\":\"Explicit button consent for short approach\"}");
    }
    if ((pending & HSHH_AGENT_PENDING_HUG_OK) != 0u) {
        (void)app_hshh_post_event("hug_consent_granted", "t5_button",
                                  "{\"gesture\":\"confirm\",\"explicit\":true,"
                                  "\"consent_scope\":\"invite_hug\",\"confidence\":1,"
                                  "\"summary\":\"Explicit button consent for hug invitation\"}");
    }
    if ((pending & HSHH_AGENT_PENDING_SPEECH_START) != 0u) {
        (void)app_hshh_post_event("speech_started", "t5_microphone",
                                  "{\"confidence\":1,\"ttl_ms\":10000,"
                                  "\"summary\":\"Local VAD speech start\"}");
    }
    if ((pending & HSHH_AGENT_PENDING_SPEECH_END) != 0u) {
        (void)app_hshh_post_event("speech_ended", "t5_microphone",
                                  "{\"confidence\":1,\"ttl_ms\":10000,"
                                  "\"summary\":\"Local VAD speech end\"}");
    }
    if ((pending & HSHH_AGENT_PENDING_USER_CAPTURE) != 0u) {
        if (app_hshh_post_capture("user_request") != OPRT_OK) {
            PR_WARN("[HSHH AGENT] user-requested keyframe unavailable; no visual evidence fabricated");
        }
    } else if ((pending & HSHH_AGENT_PENDING_CAPTURE) != 0u) {
        if (app_hshh_post_capture("presence_event") != OPRT_OK) {
            PR_WARN("[HSHH AGENT] triggered keyframe unavailable; no visual evidence fabricated");
        }
    }
}

static void app_hshh_upload_ready_utterance(void)
{
    const uint8_t *pcm = NULL;
    uint32_t length = 0u;
    char utterance_id[33];
    uint32_t sample_rate = 16000u;
    OPERATE_RET rt;
    static bool retried;

    memset(utterance_id, 0, sizeof(utterance_id));
    if (!app_hshh_voice_take_ready(&pcm, &length, utterance_id, &sample_rate)) {
        return;
    }
    rt = app_hshh_post_utterance(pcm, length, utterance_id, sample_rate);
    if (rt != OPRT_OK && !retried) {
        retried = true;
        rt = app_hshh_post_utterance(pcm, length, utterance_id, sample_rate);
    }
    retried = false;
    app_hshh_voice_release();
    if (rt != OPRT_OK) {
        (void)app_hshh_effects_queue_sound(APP_HSHH_AUDIO_CUE_CONFUSED);
    }
}

static void app_hshh_agent_worker(void *args)
{
    uint32_t last_poll_ms = 0u;

    (void)args;
    while (true) {
        uint32_t now_ms = tal_system_get_millisecond();

        /* Voice and effects talk to the Agent over Wi-Fi. Motion-board HMAC
         * clock is required for SafeSkills, not for ASR/TTS. */
        if (!app_hshh_provisioning_is_online() && !app_hshh_lan_link_is_up()) {
            s_ready = false;
            tal_system_sleep(200u);
            continue;
        }
        if (last_poll_ms == 0u || (uint32_t)(now_ms - last_poll_ms) >= HSHH_AGENT_EFFECT_INTERVAL_MS) {
            last_poll_ms = now_ms;
            s_ready = app_hshh_poll_effects() == OPRT_OK;
        }
        if (s_ready) {
            const uint32_t pending = __atomic_exchange_n(&s_pending_requests, 0u, __ATOMIC_ACQ_REL);
            if (pending != 0u) {
                app_hshh_process_pending(pending);
            }
        }
        app_hshh_upload_ready_utterance();
        tal_system_sleep(100u);
    }
}

OPERATE_RET app_hshh_agent_init(void)
{
    THREAD_CFG_T thread_config = {0};
    int written;
    OPERATE_RET rt;

    if (s_started) {
        return OPRT_OK;
    }
    if (!app_hshh_agent_config_valid()) {
        PR_WARN("[HSHH AGENT] local Agent configuration absent; effects and events remain disabled");
        return OPRT_INVALID_PARM;
    }
    written = snprintf(s_authorization, sizeof(s_authorization), "Bearer %s", HSHH_AGENT_DEVICE_TOKEN);
    if (written <= 0 || (size_t)written >= sizeof(s_authorization)) {
        memset(s_authorization, 0, sizeof(s_authorization));
        return OPRT_INVALID_PARM;
    }
    thread_config.stackDepth = 1024u * 24u;
    thread_config.priority = THREAD_PRIO_2;
    thread_config.thrdname = "hshh_agent";
    rt = tal_thread_create_and_start(&s_agent_thread, NULL, NULL, app_hshh_agent_worker, NULL, &thread_config);
    if (rt == OPRT_OK) {
        s_started = true;
        PR_NOTICE("[HSHH AGENT] authenticated event/effect client started; token is not logged");
    }
    return rt;
}

void app_hshh_agent_notify_speech(bool started)
{
    __atomic_fetch_or(&s_pending_requests,
                      started ? HSHH_AGENT_PENDING_SPEECH_START : HSHH_AGENT_PENDING_SPEECH_END,
                      __ATOMIC_RELEASE);
    if (started) {
        __atomic_fetch_or(&s_pending_requests, HSHH_AGENT_PENDING_CAPTURE, __ATOMIC_RELEASE);
    }
}

void app_hshh_agent_notify_confirmation(bool hug_scope)
{
    __atomic_fetch_or(&s_pending_requests,
                      hug_scope ? HSHH_AGENT_PENDING_HUG_OK : HSHH_AGENT_PENDING_APPROACH_OK,
                      __ATOMIC_RELEASE);
    if (!hug_scope) {
        __atomic_fetch_or(&s_pending_requests, HSHH_AGENT_PENDING_USER_CAPTURE, __ATOMIC_RELEASE);
    }
}

void app_hshh_agent_notify_reject(void)
{
    __atomic_fetch_or(&s_pending_requests, HSHH_AGENT_PENDING_REJECT, __ATOMIC_RELEASE);
}

void app_hshh_agent_notify_stop(void)
{
    __atomic_fetch_or(&s_pending_requests, HSHH_AGENT_PENDING_STOP, __ATOMIC_RELEASE);
}

void app_hshh_agent_request_capture(void)
{
    __atomic_fetch_or(&s_pending_requests, HSHH_AGENT_PENDING_USER_CAPTURE, __ATOMIC_RELEASE);
}

bool app_hshh_agent_is_ready(void)
{
    return s_ready;
}

void app_hshh_agent_format_status(char *line, size_t size)
{
    if (line == NULL || size == 0u) {
        return;
    }
    snprintf(line, size,
             "HSHH_AGENT started=%u ready=%u config=%u wifi=%u lan_link=%u lan_clock=%u "
             "poll_rt=%d poll_http=%lu utt_rt=%d utt_http=%lu",
             s_started ? 1u : 0u, s_ready ? 1u : 0u, app_hshh_agent_config_valid() ? 1u : 0u,
             app_hshh_provisioning_is_online() ? 1u : 0u, app_hshh_lan_link_is_up() ? 1u : 0u,
             app_hshh_lan_clock_is_trusted() ? 1u : 0u, s_last_poll_rt,
             (unsigned long)s_last_poll_http, s_last_utterance_rt, (unsigned long)s_last_utterance_http);
}

uint32_t app_hshh_agent_take_local_events(void)
{
    return __atomic_exchange_n(&s_local_events, 0u, __ATOMIC_ACQ_REL);
}
