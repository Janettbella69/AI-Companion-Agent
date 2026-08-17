/**
 * @file app_hshh_lan.c
 * @brief Authenticated LAN client for the HSHH ESP32-S3 motion controller.
 */

#include "app_hshh_lan.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "app_hshh_lan_config.h"
#include "cJSON.h"
#include "http_client_interface.h"
#include "netmgr.h"
#include "tal_api.h"
#include "tal_hash.h"
#include "tal_time_service.h"
#include "tal_wifi.h"

#define HSHH_LAN_PROTOCOL_VERSION       "hshh-lan-v1"
#define HSHH_LAN_MOTION_TARGET          "motion_controller"
#define HSHH_LAN_STATUS_PATH            "/v1/motion/status"
#define HSHH_LAN_COMMAND_PATH           "/v1/motion/commands"
#define HSHH_LAN_TIMESTAMP_LENGTH       24u
#define HSHH_LAN_SIGNATURE_HEX_LENGTH   64u
#define HSHH_LAN_MAX_CLOCK_SKEW_MS      5000u
#define HSHH_LAN_COMMAND_BODY_BYTES     768u
#define HSHH_LAN_COMMAND_ID_BYTES       48u

typedef struct {
    char safety_state[17];
    bool motion_stopped;
    bool motor_ready;
    bool servo_ready;
} hshh_motion_status_t;

typedef struct {
    char status[17];
    char reason_code[65];
    char safety_state[17];
} hshh_command_response_t;

typedef struct {
    bool valid;
    app_hshh_lan_skill_t skill;
    uint32_t sequence;
    uint32_t requested_at_ms;
} hshh_pending_command_t;

static THREAD_HANDLE s_lan_thread;
static MUTEX_HANDLE s_pending_mutex;
static volatile bool s_started;
static volatile bool s_link_up;
static volatile bool s_clock_trusted;
static volatile bool s_boot_stop_confirmed;
static volatile bool s_ready;
static hshh_pending_command_t s_pending;
static uint32_t s_next_pending_sequence;
static uint32_t s_next_command_id;

static bool station_ipv4_ready(NW_IP_S *ip);

static size_t bounded_text_length(const char *text, size_t limit)
{
    size_t length = 0;

    if (text == NULL) {
        return 0;
    }
    while (length <= limit && text[length] != '\0') {
        length++;
    }
    return length;
}

static bool monotonic_elapsed(uint32_t now_ms, uint32_t then_ms, uint32_t interval_ms)
{
    return (uint32_t)(now_ms - then_ms) >= interval_ms;
}

static char ascii_lower(char value)
{
    if (value >= 'A' && value <= 'Z') {
        return (char)(value + ('a' - 'A'));
    }
    return value;
}

static bool ascii_equal_case_insensitive(const uint8_t *left, size_t left_length, const char *right)
{
    size_t index;
    size_t right_length = strlen(right);

    if (left_length != right_length) {
        return false;
    }
    for (index = 0; index < left_length; index++) {
        if (ascii_lower((char)left[index]) != ascii_lower(right[index])) {
            return false;
        }
    }
    return true;
}

static bool ascii_starts_with_case_insensitive(const char *text, const char *prefix)
{
    size_t index;
    size_t prefix_length = strlen(prefix);

    if (strlen(text) < prefix_length) {
        return false;
    }
    for (index = 0; index < prefix_length; index++) {
        if (ascii_lower(text[index]) != ascii_lower(prefix[index])) {
            return false;
        }
    }
    return true;
}

static bool response_header_value(const http_client_response_t *response, const char *name,
                                  char *output, size_t output_size)
{
    size_t cursor = 0;
    bool found = false;

    if (response == NULL || response->headers == NULL || name == NULL || output == NULL || output_size == 0) {
        return false;
    }
    output[0] = '\0';

    while (cursor < response->headers_length) {
        size_t line_start = cursor;
        size_t line_end;
        size_t colon;
        size_t key_end;
        size_t value_start;
        size_t value_end;
        size_t value_length;

        while (cursor < response->headers_length && response->headers[cursor] != '\n') {
            cursor++;
        }
        line_end = cursor;
        if (cursor < response->headers_length) {
            cursor++;
        }
        while (line_end > line_start &&
               (response->headers[line_end - 1] == '\r' || response->headers[line_end - 1] == ' ' ||
                response->headers[line_end - 1] == '\t')) {
            line_end--;
        }

        colon = line_start;
        while (colon < line_end && response->headers[colon] != ':') {
            colon++;
        }
        if (colon == line_end) {
            continue;
        }
        key_end = colon;
        while (key_end > line_start &&
               (response->headers[key_end - 1] == ' ' || response->headers[key_end - 1] == '\t')) {
            key_end--;
        }
        if (!ascii_equal_case_insensitive(response->headers + line_start, key_end - line_start, name)) {
            continue;
        }
        if (found) {
            output[0] = '\0';
            return false;
        }

        value_start = colon + 1;
        while (value_start < line_end &&
               (response->headers[value_start] == ' ' || response->headers[value_start] == '\t')) {
            value_start++;
        }
        value_end = line_end;
        while (value_end > value_start &&
               (response->headers[value_end - 1] == ' ' || response->headers[value_end - 1] == '\t')) {
            value_end--;
        }
        value_length = value_end - value_start;
        if (value_length == 0 || value_length + 1 > output_size) {
            output[0] = '\0';
            return false;
        }
        memcpy(output, response->headers + value_start, value_length);
        output[value_length] = '\0';
        found = true;
    }

    return found;
}

static OPERATE_RET hmac_sha256_hex(const char *timestamp, const uint8_t *body, size_t body_length,
                                   char output[HSHH_LAN_SIGNATURE_HEX_LENGTH + 1])
{
    static const char hex[] = "0123456789abcdef";
    static const uint8_t newline = '\n';
    tal_hash_mac_context_t context = {0};
    uint8_t digest[32] = {0};
    OPERATE_RET rt;
    OPERATE_RET free_rt;
    size_t index;
    bool initialized = false;

    if (timestamp == NULL || body == NULL || output == NULL) {
        return OPRT_INVALID_PARM;
    }

    rt = tal_sha256_mac_create_init(&context);
    if (rt != OPRT_OK) {
        return rt;
    }
    initialized = true;
    rt = tal_sha256_mac_starts(&context, (const uint8_t *)HSHH_LAN_MOTION_SHARED_SECRET,
                               strlen(HSHH_LAN_MOTION_SHARED_SECRET));
    if (rt == OPRT_OK) {
        rt = tal_sha256_mac_update(&context, (const uint8_t *)timestamp, strlen(timestamp));
    }
    if (rt == OPRT_OK) {
        rt = tal_sha256_mac_update(&context, &newline, 1);
    }
    if (rt == OPRT_OK && body_length > 0) {
        rt = tal_sha256_mac_update(&context, body, body_length);
    }
    if (rt == OPRT_OK) {
        rt = tal_sha256_mac_finish(&context, digest);
    }

    if (initialized) {
        free_rt = tal_sha256_mac_free(&context);
        if (rt == OPRT_OK && free_rt != OPRT_OK) {
            rt = free_rt;
        }
    }
    if (rt != OPRT_OK) {
        memset(digest, 0, sizeof(digest));
        return rt;
    }

    for (index = 0; index < sizeof(digest); index++) {
        output[index * 2] = hex[digest[index] >> 4];
        output[index * 2 + 1] = hex[digest[index] & 0x0f];
    }
    output[HSHH_LAN_SIGNATURE_HEX_LENGTH] = '\0';
    memset(digest, 0, sizeof(digest));
    return OPRT_OK;
}

static OPERATE_RET hmac_known_answer_test(void)
{
    static const uint8_t message[] = "Hi There";
    static const uint8_t expected[32] = {
        0xb0, 0x34, 0x4c, 0x61, 0xd8, 0xdb, 0x38, 0x53,
        0x5c, 0xa8, 0xaf, 0xce, 0xaf, 0x0b, 0xf1, 0x2b,
        0x88, 0x1d, 0xc2, 0x00, 0xc9, 0x83, 0x3d, 0xa7,
        0x26, 0xe9, 0x37, 0x6c, 0x2e, 0x32, 0xcf, 0xf7,
    };
    uint8_t key[20];
    uint8_t digest[32] = {0};
    uint8_t difference = 0;
    OPERATE_RET rt;
    size_t index;

    memset(key, 0x0b, sizeof(key));
    rt = tal_sha256_mac(key, sizeof(key), message, sizeof(message) - 1, digest);
    if (rt == OPRT_OK) {
        for (index = 0; index < sizeof(digest); index++) {
            difference |= (uint8_t)(digest[index] ^ expected[index]);
        }
        if (difference != 0) {
            rt = OPRT_COM_ERROR;
        }
    }
    memset(key, 0, sizeof(key));
    memset(digest, 0, sizeof(digest));
    return rt;
}

static bool constant_time_signature_matches(const char *supplied, const char *expected)
{
    size_t index;
    uint8_t difference = 0;

    if (supplied == NULL || expected == NULL || strlen(supplied) != HSHH_LAN_SIGNATURE_HEX_LENGTH ||
        strlen(expected) != HSHH_LAN_SIGNATURE_HEX_LENGTH) {
        return false;
    }
    for (index = 0; index < HSHH_LAN_SIGNATURE_HEX_LENGTH; index++) {
        char normalized = ascii_lower(supplied[index]);
        bool valid_hex = (normalized >= '0' && normalized <= '9') || (normalized >= 'a' && normalized <= 'f');

        difference |= (uint8_t)(normalized ^ expected[index]);
        difference |= valid_hex ? 0u : 1u;
    }
    return difference == 0;
}

static bool parse_digits(const char *text, size_t count, int *value)
{
    size_t index;
    int parsed = 0;

    for (index = 0; index < count; index++) {
        if (text[index] < '0' || text[index] > '9') {
            return false;
        }
        parsed = parsed * 10 + (text[index] - '0');
    }
    *value = parsed;
    return true;
}

static bool leap_year(int year)
{
    return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

static int days_in_month(int year, int month)
{
    static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};

    if (month == 2 && leap_year(year)) {
        return 29;
    }
    return days[month - 1];
}

static bool parse_utc_iso8601(const char *timestamp, uint64_t *epoch_ms)
{
    int year;
    int month;
    int day;
    int hour;
    int minute;
    int second;
    int millisecond;
    POSIX_TM_S utc = {0};
    TIME_T epoch;

    if (timestamp == NULL || epoch_ms == NULL || strlen(timestamp) != HSHH_LAN_TIMESTAMP_LENGTH ||
        timestamp[4] != '-' || timestamp[7] != '-' || timestamp[10] != 'T' || timestamp[13] != ':' ||
        timestamp[16] != ':' || timestamp[19] != '.' || timestamp[23] != 'Z' ||
        !parse_digits(timestamp, 4, &year) || !parse_digits(timestamp + 5, 2, &month) ||
        !parse_digits(timestamp + 8, 2, &day) || !parse_digits(timestamp + 11, 2, &hour) ||
        !parse_digits(timestamp + 14, 2, &minute) || !parse_digits(timestamp + 17, 2, &second) ||
        !parse_digits(timestamp + 20, 3, &millisecond)) {
        return false;
    }
    if (year < 2024 || year > 2099 || month < 1 || month > 12 || day < 1 || day > days_in_month(year, month) ||
        hour > 23 || minute > 59 || second > 59) {
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

static bool format_utc_iso8601(uint64_t epoch_ms, char output[HSHH_LAN_TIMESTAMP_LENGTH + 1])
{
    TIME_T seconds = (TIME_T)(epoch_ms / 1000u);
    POSIX_TM_S utc = {0};
    int length;

    if (tal_time_gmtime_r(&seconds, &utc) == NULL) {
        return false;
    }
    if (utc.tm_year + 1900 < 2024 || utc.tm_year + 1900 > 2099) {
        return false;
    }
    length = snprintf(output, HSHH_LAN_TIMESTAMP_LENGTH + 1, "%04d-%02d-%02dT%02d:%02d:%02d.%03uZ",
                      utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec,
                      (unsigned int)(epoch_ms % 1000u));
    return length == (int)HSHH_LAN_TIMESTAMP_LENGTH;
}

static uint64_t unsigned_distance(uint64_t left, uint64_t right)
{
    return left >= right ? left - right : right - left;
}

static bool allowed_safety_state(const char *state)
{
    return strcmp(state, "ready") == 0 || strcmp(state, "stopped") == 0 || strcmp(state, "fault") == 0;
}

static bool allowed_skill_text(const char *skill)
{
    return strcmp(skill, "stop") == 0 || strcmp(skill, "approach_short") == 0 ||
           strcmp(skill, "turn_to_user") == 0 || strcmp(skill, "invite_hug") == 0 ||
           strcmp(skill, "release_hug") == 0;
}

static bool allowed_command_status(const char *status)
{
    return strcmp(status, "accepted") == 0 || strcmp(status, "rejected") == 0 ||
           strcmp(status, "completed") == 0 || strcmp(status, "stopped") == 0 || strcmp(status, "failed") == 0;
}

static bool copy_json_string(cJSON *item, char *output, size_t output_size)
{
    const char *value;
    size_t length;

    if (!cJSON_IsString(item) || output == NULL || output_size == 0) {
        return false;
    }
    value = cJSON_GetStringValue(item);
    if (value == NULL) {
        return false;
    }
    length = strlen(value);
    if (length == 0 || length + 1 > output_size) {
        return false;
    }
    memcpy(output, value, length + 1);
    return true;
}

static OPERATE_RET verify_signed_response(const http_client_response_t *response, bool enforce_freshness,
                                          uint64_t *signed_timestamp_ms)
{
    char content_type[64];
    char timestamp[HSHH_LAN_TIMESTAMP_LENGTH + 1];
    char supplied_signature[HSHH_LAN_SIGNATURE_HEX_LENGTH + 1];
    char expected_signature[HSHH_LAN_SIGNATURE_HEX_LENGTH + 1];
    uint64_t parsed_timestamp_ms;
    uint64_t local_time_ms;
    OPERATE_RET rt;

    if (response == NULL || response->body == NULL || response->body_length == 0 ||
        response->body_length > HSHH_LAN_MAX_RESPONSE_BYTES ||
        !response_header_value(response, "Content-Type", content_type, sizeof(content_type)) ||
        !ascii_starts_with_case_insensitive(content_type, "application/json") ||
        !response_header_value(response, "X-HSHH-Timestamp", timestamp, sizeof(timestamp)) ||
        !response_header_value(response, "X-HSHH-Signature", supplied_signature, sizeof(supplied_signature))) {
        return OPRT_COM_ERROR;
    }

    rt = hmac_sha256_hex(timestamp, response->body, response->body_length, expected_signature);
    if (rt != OPRT_OK || !constant_time_signature_matches(supplied_signature, expected_signature) ||
        !parse_utc_iso8601(timestamp, &parsed_timestamp_ms)) {
        memset(expected_signature, 0, sizeof(expected_signature));
        return OPRT_COM_ERROR;
    }
    memset(expected_signature, 0, sizeof(expected_signature));

    if (enforce_freshness) {
        if (!s_clock_trusted) {
            return OPRT_RESOURCE_NOT_READY;
        }
        local_time_ms = (uint64_t)tal_time_get_posix_ms();
        if (unsigned_distance(local_time_ms, parsed_timestamp_ms) > HSHH_LAN_MAX_CLOCK_SKEW_MS) {
            return OPRT_COM_ERROR;
        }
    }
    *signed_timestamp_ms = parsed_timestamp_ms;
    return OPRT_OK;
}

static OPERATE_RET parse_motion_status(const uint8_t *body, size_t body_length, uint64_t signed_timestamp_ms,
                                       hshh_motion_status_t *status)
{
    cJSON *root;
    cJSON *protocol;
    cJSON *observed_at;
    cJSON *safety_state;
    cJSON *motion_stopped;
    cJSON *motor_ready;
    cJSON *servo_ready;
    cJSON *active_skill;
    const char *protocol_value;
    const char *observed_value;
    const char *active_value;
    uint64_t observed_ms;
    OPERATE_RET rt = OPRT_COM_ERROR;

    root = cJSON_ParseWithLength((const char *)body, body_length);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return OPRT_COM_ERROR;
    }
    protocol = cJSON_GetObjectItemCaseSensitive(root, "protocol_version");
    observed_at = cJSON_GetObjectItemCaseSensitive(root, "observed_at");
    safety_state = cJSON_GetObjectItemCaseSensitive(root, "safety_state");
    motion_stopped = cJSON_GetObjectItemCaseSensitive(root, "motion_stopped");
    motor_ready = cJSON_GetObjectItemCaseSensitive(root, "motor_ready");
    servo_ready = cJSON_GetObjectItemCaseSensitive(root, "servo_ready");
    active_skill = cJSON_GetObjectItemCaseSensitive(root, "active_skill");

    protocol_value = cJSON_GetStringValue(protocol);
    observed_value = cJSON_GetStringValue(observed_at);
    if (protocol_value == NULL || strcmp(protocol_value, HSHH_LAN_PROTOCOL_VERSION) != 0 || observed_value == NULL ||
        !parse_utc_iso8601(observed_value, &observed_ms) ||
        unsigned_distance(observed_ms, signed_timestamp_ms) > HSHH_LAN_MAX_CLOCK_SKEW_MS ||
        !copy_json_string(safety_state, status->safety_state, sizeof(status->safety_state)) ||
        !allowed_safety_state(status->safety_state) || !cJSON_IsBool(motion_stopped) || !cJSON_IsBool(motor_ready) ||
        !cJSON_IsBool(servo_ready)) {
        goto exit;
    }
    if (!cJSON_IsNull(active_skill)) {
        active_value = cJSON_GetStringValue(active_skill);
        if (active_value == NULL || !allowed_skill_text(active_value)) {
            goto exit;
        }
    }
    status->motion_stopped = cJSON_IsTrue(motion_stopped);
    status->motor_ready = cJSON_IsTrue(motor_ready);
    status->servo_ready = cJSON_IsTrue(servo_ready);
    rt = OPRT_OK;

exit:
    cJSON_Delete(root);
    return rt;
}

static OPERATE_RET parse_command_response(const uint8_t *body, size_t body_length, uint64_t signed_timestamp_ms,
                                          const char *expected_command_id, hshh_command_response_t *result)
{
    cJSON *root;
    cJSON *protocol;
    cJSON *command_id;
    cJSON *status;
    cJSON *reason_code;
    cJSON *observed_at;
    cJSON *safety_state;
    cJSON *active_skill;
    const char *protocol_value;
    const char *command_id_value;
    const char *observed_value;
    const char *active_value;
    uint64_t observed_ms;
    OPERATE_RET rt = OPRT_COM_ERROR;

    root = cJSON_ParseWithLength((const char *)body, body_length);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return OPRT_COM_ERROR;
    }
    protocol = cJSON_GetObjectItemCaseSensitive(root, "protocol_version");
    command_id = cJSON_GetObjectItemCaseSensitive(root, "command_id");
    status = cJSON_GetObjectItemCaseSensitive(root, "status");
    reason_code = cJSON_GetObjectItemCaseSensitive(root, "reason_code");
    observed_at = cJSON_GetObjectItemCaseSensitive(root, "observed_at");
    safety_state = cJSON_GetObjectItemCaseSensitive(root, "safety_state");
    active_skill = cJSON_GetObjectItemCaseSensitive(root, "active_skill");

    protocol_value = cJSON_GetStringValue(protocol);
    command_id_value = cJSON_GetStringValue(command_id);
    observed_value = cJSON_GetStringValue(observed_at);
    if (protocol_value == NULL || strcmp(protocol_value, HSHH_LAN_PROTOCOL_VERSION) != 0 ||
        command_id_value == NULL || strcmp(command_id_value, expected_command_id) != 0 || observed_value == NULL ||
        !parse_utc_iso8601(observed_value, &observed_ms) ||
        unsigned_distance(observed_ms, signed_timestamp_ms) > HSHH_LAN_MAX_CLOCK_SKEW_MS ||
        !copy_json_string(status, result->status, sizeof(result->status)) ||
        !allowed_command_status(result->status) ||
        !copy_json_string(reason_code, result->reason_code, sizeof(result->reason_code)) ||
        !copy_json_string(safety_state, result->safety_state, sizeof(result->safety_state)) ||
        !allowed_safety_state(result->safety_state)) {
        goto exit;
    }
    if (!cJSON_IsNull(active_skill)) {
        active_value = cJSON_GetStringValue(active_skill);
        if (active_value == NULL || !allowed_skill_text(active_value)) {
            goto exit;
        }
    }
    rt = OPRT_OK;

exit:
    cJSON_Delete(root);
    return rt;
}

static OPERATE_RET fetch_motion_status(bool bootstrap_clock, hshh_motion_status_t *status)
{
    http_client_header_t headers[] = {
        {.key = "Accept", .value = "application/json"},
    };
    http_client_response_t response = {0};
    http_client_status_t http_status;
    uint64_t signed_timestamp_ms = 0;
    OPERATE_RET rt = OPRT_COM_ERROR;

    http_status = http_client_request(
        &(const http_client_request_t){
            .host = HSHH_LAN_MOTION_HOST,
            .port = HSHH_LAN_MOTION_PORT,
            .path = HSHH_LAN_STATUS_PATH,
            .method = "GET",
            .headers = headers,
            .headers_count = sizeof(headers) / sizeof(headers[0]),
            .body = (const uint8_t *)"",
            .body_length = 0,
            .timeout_ms = HSHH_LAN_HTTP_TIMEOUT_MS,
        },
        &response);
    if (http_status != HTTP_CLIENT_SUCCESS) {
        PR_WARN("[HSHH LAN] status request transport failure, code=%d", (int)http_status);
        goto exit;
    }
    if (response.status_code != 200) {
        PR_WARN("[HSHH LAN] status request HTTP %u", (unsigned int)response.status_code);
        goto exit;
    }
    rt = verify_signed_response(&response, !bootstrap_clock, &signed_timestamp_ms);
    if (rt != OPRT_OK) {
        PR_WARN("[HSHH LAN] status response authentication failed");
        goto exit;
    }
    rt = parse_motion_status(response.body, response.body_length, signed_timestamp_ms, status);
    if (rt != OPRT_OK) {
        PR_WARN("[HSHH LAN] authenticated status schema invalid");
        goto exit;
    }
    if (bootstrap_clock) {
        rt = tal_time_set_posix((TIME_T)(signed_timestamp_ms / 1000u), 2);
        if (rt != OPRT_OK) {
            goto exit;
        }
        s_clock_trusted = true;
    }

exit:
    http_client_free(&response);
    return rt;
}

static OPERATE_RET send_signed_skill(app_hshh_lan_skill_t skill)
{
    hshh_motion_status_t motion_status = {0};
    hshh_command_response_t command_result = {0};
    char timestamp[HSHH_LAN_TIMESTAMP_LENGTH + 1];
    char expires_at[HSHH_LAN_TIMESTAMP_LENGTH + 1];
    char command_id[HSHH_LAN_COMMAND_ID_BYTES];
    char body[HSHH_LAN_COMMAND_BODY_BYTES];
    char signature[HSHH_LAN_SIGNATURE_HEX_LENGTH + 1];
    uint64_t now_ms;
    int written;
    OPERATE_RET rt;
    http_client_status_t http_status;
    http_client_response_t response = {0};
    uint64_t signed_response_ms = 0;

    rt = fetch_motion_status(true, &motion_status);
    if (rt != OPRT_OK) {
        return rt;
    }

    now_ms = (uint64_t)tal_time_get_posix_ms();
    if (!format_utc_iso8601(now_ms, timestamp) ||
        !format_utc_iso8601(now_ms + HSHH_LAN_COMMAND_TTL_MS, expires_at)) {
        return OPRT_COM_ERROR;
    }
    s_next_command_id++;
    written = snprintf(command_id, sizeof(command_id), "t5-%llu-%lu", (unsigned long long)now_ms,
                       (unsigned long)s_next_command_id);
    if (written <= 0 || (size_t)written >= sizeof(command_id)) {
        return OPRT_COM_ERROR;
    }
    written = snprintf(body, sizeof(body),
                       "{\"protocol_version\":\"%s\",\"target\":\"%s\",\"command_id\":\"%s\","
                       "\"robot_id\":\"%s\",\"skill\":\"%s\",\"issued_at\":\"%s\","
                       "\"expires_at\":\"%s\",\"expected_device_state\":\"%s\"}",
                       HSHH_LAN_PROTOCOL_VERSION, HSHH_LAN_MOTION_TARGET, command_id, HSHH_LAN_ROBOT_ID,
                       app_hshh_lan_skill_name(skill), timestamp, expires_at, motion_status.safety_state);
    if (written <= 0 || (size_t)written >= sizeof(body)) {
        return OPRT_COM_ERROR;
    }
    rt = hmac_sha256_hex(timestamp, (const uint8_t *)body, (size_t)written, signature);
    if (rt != OPRT_OK) {
        memset(body, 0, sizeof(body));
        return rt;
    }

    {
        http_client_header_t headers[] = {
            {.key = "Content-Type", .value = "application/json"},
            {.key = "Accept", .value = "application/json"},
            {.key = "Idempotency-Key", .value = command_id},
            {.key = "X-HSHH-Timestamp", .value = timestamp},
            {.key = "X-HSHH-Signature", .value = signature},
        };

        http_status = http_client_request(
            &(const http_client_request_t){
                .host = HSHH_LAN_MOTION_HOST,
                .port = HSHH_LAN_MOTION_PORT,
                .path = HSHH_LAN_COMMAND_PATH,
                .method = "POST",
                .headers = headers,
                .headers_count = sizeof(headers) / sizeof(headers[0]),
                .body = (const uint8_t *)body,
                .body_length = (size_t)written,
                .timeout_ms = HSHH_LAN_HTTP_TIMEOUT_MS,
            },
            &response);
    }
    memset(signature, 0, sizeof(signature));
    memset(body, 0, sizeof(body));

    if (http_status != HTTP_CLIENT_SUCCESS) {
        PR_WARN("[HSHH LAN] command transport failure, code=%d", (int)http_status);
        rt = OPRT_COM_ERROR;
        goto exit;
    }
    if (response.status_code != 200) {
        PR_WARN("[HSHH LAN] command HTTP %u", (unsigned int)response.status_code);
        rt = OPRT_COM_ERROR;
        goto exit;
    }
    rt = verify_signed_response(&response, true, &signed_response_ms);
    if (rt != OPRT_OK) {
        PR_WARN("[HSHH LAN] command response authentication failed");
        goto exit;
    }
    rt = parse_command_response(response.body, response.body_length, signed_response_ms, command_id, &command_result);
    if (rt != OPRT_OK) {
        PR_WARN("[HSHH LAN] authenticated command schema invalid");
        goto exit;
    }

    PR_NOTICE("[HSHH LAN] command=%s result=%s reason=%s state=%s", app_hshh_lan_skill_name(skill),
              command_result.status, command_result.reason_code, command_result.safety_state);
    if (strcmp(command_result.status, "rejected") == 0 || strcmp(command_result.status, "failed") == 0) {
        rt = OPRT_NOT_SUPPORTED;
    } else {
        rt = OPRT_OK;
    }

exit:
    http_client_free(&response);
    return rt;
}

static OPERATE_RET link_status_callback(void *data)
{
    netmgr_status_e status;

    if (data == NULL) {
        return OPRT_INVALID_PARM;
    }
    status = *(netmgr_status_e *)data;
    if (status == NETMGR_LINK_UP || status == NETMGR_LINK_UP_SWITH) {
        NW_IP_S ip = {0};

        s_link_up = true;
        if (station_ipv4_ready(&ip)) {
            PR_NOTICE("[HSHH LAN] Wi-Fi link up T5AI IPv4=%s", ip.ip);
        } else {
            PR_NOTICE("[HSHH LAN] Wi-Fi associated, waiting for IPv4");
        }
        return OPRT_OK;
    }
    if (s_link_up) {
        PR_NOTICE("[HSHH LAN] Wi-Fi link down");
    }
    s_link_up = false;
    s_clock_trusted = false;
    s_boot_stop_confirmed = false;
    s_ready = false;
    return OPRT_OK;
}

static bool pending_snapshot(hshh_pending_command_t *snapshot)
{
    bool valid;

    tal_mutex_lock(s_pending_mutex);
    *snapshot = s_pending;
    valid = s_pending.valid;
    tal_mutex_unlock(s_pending_mutex);
    return valid;
}

static void pending_complete(uint32_t sequence)
{
    tal_mutex_lock(s_pending_mutex);
    if (s_pending.valid && s_pending.sequence == sequence) {
        memset(&s_pending, 0, sizeof(s_pending));
    }
    tal_mutex_unlock(s_pending_mutex);
}

static bool station_ipv4_ready(NW_IP_S *ip)
{
    if (tal_wifi_get_ip(WF_STATION, ip) != OPRT_OK) {
        return false;
    }
    return ip->ip[0] != '\0' && strcmp(ip->ip, "0.0.0.0") != 0;
}

static void lan_worker(void *args)
{
    uint32_t last_attempt_ms = 0;
    uint32_t last_status_ms = 0;
    bool address_logged = false;

    (void)args;
    while (true) {
        uint32_t now_ms = tal_system_get_millisecond();

        if (!s_link_up) {
            NW_IP_S ip = {0};

            if (station_ipv4_ready(&ip)) {
                s_link_up = true;
                PR_NOTICE("[HSHH LAN] Wi-Fi link up T5AI IPv4=%s", ip.ip);
                address_logged = true;
            } else {
                address_logged = false;
                tal_system_sleep(200);
                continue;
            }
        }
        if (!address_logged) {
            NW_IP_S ip = {0};

            if (station_ipv4_ready(&ip)) {
                PR_NOTICE("[HSHH LAN] T5AI IPv4=%s", ip.ip);
            }
            address_logged = true;
        }

        if (!s_boot_stop_confirmed) {
            if (last_attempt_ms == 0 || monotonic_elapsed(now_ms, last_attempt_ms, HSHH_LAN_RETRY_INTERVAL_MS)) {
                OPERATE_RET rt;

                last_attempt_ms = now_ms;
                rt = send_signed_skill(APP_HSHH_LAN_SKILL_STOP);
                if (rt == OPRT_OK) {
                    s_boot_stop_confirmed = true;
                    s_ready = true;
                    last_status_ms = tal_system_get_millisecond();
                    PR_NOTICE("[HSHH LAN] authenticated boot stop confirmed");
                } else {
                    s_ready = false;
                    PR_WARN("[HSHH LAN] boot stop not confirmed, retrying safely, rt=%d", rt);
                }
            }
            tal_system_sleep(100);
            continue;
        }

        {
            hshh_pending_command_t command;

            if (pending_snapshot(&command)) {
                bool escape_skill = command.skill == APP_HSHH_LAN_SKILL_STOP ||
                                    command.skill == APP_HSHH_LAN_SKILL_RELEASE_HUG;
                OPERATE_RET rt;

                if (!escape_skill &&
                    monotonic_elapsed(now_ms, command.requested_at_ms, HSHH_LAN_PENDING_TTL_MS)) {
                    PR_WARN("[HSHH LAN] stale queued command discarded");
                    pending_complete(command.sequence);
                } else {
                    rt = send_signed_skill(command.skill);
                    pending_complete(command.sequence);
                    if (rt != OPRT_OK && rt != OPRT_NOT_SUPPORTED) {
                        s_ready = false;
                        s_boot_stop_confirmed = false;
                    }
                }
            }
        }

        now_ms = tal_system_get_millisecond();
        if (monotonic_elapsed(now_ms, last_status_ms, HSHH_LAN_STATUS_INTERVAL_MS)) {
            hshh_motion_status_t status = {0};
            OPERATE_RET rt = fetch_motion_status(true, &status);

            last_status_ms = now_ms;
            if (rt == OPRT_OK) {
                s_ready = true;
                PR_DEBUG("[HSHH LAN] signed status state=%s stopped=%s motor=%s servo=%s", status.safety_state,
                         status.motion_stopped ? "yes" : "no", status.motor_ready ? "ready" : "not-ready",
                         status.servo_ready ? "ready" : "not-ready");
            } else {
                s_ready = false;
                s_boot_stop_confirmed = false;
                PR_WARN("[HSHH LAN] signed status unavailable, fail-safe stop will be retried");
            }
        }
        tal_system_sleep(100);
    }
}

static bool lan_config_valid(void)
{
    size_t host_length = bounded_text_length(HSHH_LAN_MOTION_HOST, 253);
    size_t secret_length = bounded_text_length(HSHH_LAN_MOTION_SHARED_SECRET, 256);
    size_t robot_id_length = bounded_text_length(HSHH_LAN_ROBOT_ID, 128);

    return host_length >= 1 && host_length <= 253 &&
           strstr(HSHH_LAN_MOTION_HOST, "://") == NULL && strchr(HSHH_LAN_MOTION_HOST, '/') == NULL &&
           secret_length >= 32 && secret_length <= 256 && robot_id_length >= 1 && robot_id_length <= 128 &&
           HSHH_LAN_MOTION_PORT > 0;
}

OPERATE_RET app_hshh_lan_init(void)
{
    THREAD_CFG_T thread_config = {0};
    netmgr_status_e link_status = NETMGR_LINK_DOWN;
    OPERATE_RET rt;

    if (s_started) {
        return OPRT_OK;
    }
    if (!lan_config_valid()) {
        PR_ERR("[HSHH LAN] local configuration missing or invalid; network control remains disabled");
        return OPRT_INVALID_PARM;
    }

    rt = hmac_known_answer_test();
    if (rt != OPRT_OK) {
        PR_ERR("[HSHH LAN] HMAC self-test failed, rt=%d", rt);
        return rt;
    }
    rt = tal_mutex_create_init(&s_pending_mutex);
    if (rt != OPRT_OK) {
        return rt;
    }

    rt = tal_event_subscribe(EVENT_LINK_STATUS_CHG, "hshh_lan", link_status_callback,
                             SUBSCRIBE_TYPE_NORMAL);
    if (rt != OPRT_OK) {
        return rt;
    }
    if (netmgr_conn_get(NETCONN_WIFI, NETCONN_CMD_STATUS, &link_status) == OPRT_OK) {
        (void)link_status_callback(&link_status);
    }

    thread_config.stackDepth = 1024 * 8;
    thread_config.priority = THREAD_PRIO_2;
    thread_config.thrdname = "hshh_lan";
    rt = tal_thread_create_and_start(&s_lan_thread, NULL, NULL, lan_worker, NULL, &thread_config);
    if (rt != OPRT_OK) {
        return rt;
    }
    s_started = true;

    PR_NOTICE("[HSHH LAN] signed motion client started on provisioned Wi-Fi");
    return OPRT_OK;
}

OPERATE_RET app_hshh_lan_request_skill(app_hshh_lan_skill_t skill)
{
    bool escape_skill;

    if (skill < APP_HSHH_LAN_SKILL_STOP || skill > APP_HSHH_LAN_SKILL_RELEASE_HUG) {
        return OPRT_INVALID_PARM;
    }
    if (!s_started || s_pending_mutex == NULL) {
        return OPRT_RESOURCE_NOT_READY;
    }
    escape_skill = skill == APP_HSHH_LAN_SKILL_STOP || skill == APP_HSHH_LAN_SKILL_RELEASE_HUG;
    if (!escape_skill && !s_ready) {
        return OPRT_RESOURCE_NOT_READY;
    }

    tal_mutex_lock(s_pending_mutex);
    if (s_pending.valid && !escape_skill) {
        tal_mutex_unlock(s_pending_mutex);
        return OPRT_RESOURCE_NOT_READY;
    }
    s_next_pending_sequence++;
    s_pending.valid = true;
    s_pending.skill = skill;
    s_pending.sequence = s_next_pending_sequence;
    s_pending.requested_at_ms = tal_system_get_millisecond();
    tal_mutex_unlock(s_pending_mutex);
    return OPRT_OK;
}

bool app_hshh_lan_is_ready(void)
{
    return s_ready;
}

bool app_hshh_lan_clock_is_trusted(void)
{
    return s_clock_trusted;
}

bool app_hshh_lan_link_is_up(void)
{
    return s_link_up;
}

const char *app_hshh_lan_skill_name(app_hshh_lan_skill_t skill)
{
    switch (skill) {
    case APP_HSHH_LAN_SKILL_STOP:
        return "stop";
    case APP_HSHH_LAN_SKILL_APPROACH_SHORT:
        return "approach_short";
    case APP_HSHH_LAN_SKILL_TURN_TO_USER:
        return "turn_to_user";
    case APP_HSHH_LAN_SKILL_INVITE_HUG:
        return "invite_hug";
    case APP_HSHH_LAN_SKILL_RELEASE_HUG:
        return "release_hug";
    default:
        return "invalid";
    }
}
