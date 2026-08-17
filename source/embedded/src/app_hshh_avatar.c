#include "app_hshh_avatar.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "app_hshh_lan.h"
#include "app_hshh_lan_config.h"
#include "cJSON.h"
#include "http_client_interface.h"
#include "tal_api.h"
#include "tal_fs.h"
#include "tal_hash.h"
#include "tal_image.h"

#define HSHH_AVATAR_STATUS_PATH          "/v1/device/avatar-pack"
#define HSHH_AVATAR_SLOT_META_A          "/hshh-avatar-a.json"
#define HSHH_AVATAR_SLOT_META_B          "/hshh-avatar-b.json"
#define HSHH_AVATAR_SLOT_META_TMP_A      "/hshh-avatar-a.tmp"
#define HSHH_AVATAR_SLOT_META_TMP_B      "/hshh-avatar-b.tmp"
#define HSHH_AVATAR_SLOT_IMAGE_A         "/hshh-avatar-a.jpg"
#define HSHH_AVATAR_SLOT_IMAGE_B         "/hshh-avatar-b.jpg"
#define HSHH_AVATAR_SLOT_IMAGE_TMP_A     "/hshh-avatar-a-img.tmp"
#define HSHH_AVATAR_SLOT_IMAGE_TMP_B     "/hshh-avatar-b-img.tmp"
#define HSHH_AVATAR_POINTER_PATH         "/hshh-avatar-active.json"
#define HSHH_AVATAR_POINTER_TMP_PATH     "/hshh-avatar-active.tmp"
#define HSHH_AVATAR_EXPRESSION_COUNT     9u
#define HSHH_AVATAR_FRAMES_PER_EXPRESSION 5u
#define HSHH_AVATAR_FRAME_COUNT          45u
#define HSHH_AVATAR_WIDTH                320u
#define HSHH_AVATAR_HEIGHT               240u
#define HSHH_AVATAR_MAX_META_BYTES       (12u * 1024u)
#define HSHH_AVATAR_MAX_FRAME_BYTES      (128u * 1024u)
#define HSHH_AVATAR_MAX_IDENTITY_BYTES   (48u * 1024u)
#define HSHH_AVATAR_MAX_ASSET_ID         128u
#define HSHH_AVATAR_MAX_REMOTE_PATH      180u
#define HSHH_AVATAR_AUTH_BYTES           640u
#define HSHH_AVATAR_HTTP_PATH_BYTES      384u
#define HSHH_AVATAR_SHA_HEX_BYTES        64u
#define HSHH_AVATAR_POLL_INTERVAL_MS     5000u
#define HSHH_AVATAR_FAILURE_BACKOFF_MS   30000u

typedef struct {
    char asset_id[HSHH_AVATAR_MAX_ASSET_ID + 1u];
    char manifest_sha256[HSHH_AVATAR_SHA_HEX_BYTES + 1u];
    char identity_remote_path[HSHH_AVATAR_MAX_REMOTE_PATH + 1u];
    char identity_sha256[HSHH_AVATAR_SHA_HEX_BYTES + 1u];
    char remote_paths[HSHH_AVATAR_FRAME_COUNT][HSHH_AVATAR_MAX_REMOTE_PATH + 1u];
    char frame_sha256[HSHH_AVATAR_FRAME_COUNT][HSHH_AVATAR_SHA_HEX_BYTES + 1u];
} app_hshh_avatar_deployment_t;

static const char *s_expression_names[HSHH_AVATAR_EXPRESSION_COUNT] = {
    "idle", "noticed", "listening", "thinking", "happy",
    "confused", "sad", "sleeping", "angry",
};

static THREAD_HANDLE s_avatar_thread;
static volatile bool s_started;
static volatile bool s_active;
static volatile char s_active_slot;
static char s_active_asset_id[HSHH_AVATAR_MAX_ASSET_ID + 1u];
static char s_authorization[HSHH_AVATAR_AUTH_BYTES];
static char s_failed_asset_id[HSHH_AVATAR_MAX_ASSET_ID + 1u];
static uint32_t s_failed_at_ms;

static app_hshh_avatar_deployment_t *app_hshh_avatar_deployment_alloc(void)
{
#if defined(ENABLE_EXT_RAM) && (ENABLE_EXT_RAM == 1)
    return tal_psram_malloc(sizeof(app_hshh_avatar_deployment_t));
#else
    return tal_malloc(sizeof(app_hshh_avatar_deployment_t));
#endif
}

static void app_hshh_avatar_deployment_free(app_hshh_avatar_deployment_t *deployment)
{
    if (deployment == NULL) {
        return;
    }
#if defined(ENABLE_EXT_RAM) && (ENABLE_EXT_RAM == 1)
    tal_psram_free(deployment);
#else
    tal_free(deployment);
#endif
}

static bool app_hshh_avatar_hex64(const char *value)
{
    size_t index;

    if (value == NULL || strlen(value) != HSHH_AVATAR_SHA_HEX_BYTES) {
        return false;
    }
    for (index = 0u; index < HSHH_AVATAR_SHA_HEX_BYTES; index++) {
        if (!((value[index] >= '0' && value[index] <= '9') ||
              (value[index] >= 'a' && value[index] <= 'f'))) {
            return false;
        }
    }
    return true;
}

static bool app_hshh_avatar_safe_id(const char *value)
{
    size_t length;
    size_t index;

    if (value == NULL) {
        return false;
    }
    length = strlen(value);
    if (length < 1u || length > HSHH_AVATAR_MAX_ASSET_ID) {
        return false;
    }
    for (index = 0u; index < length; index++) {
        const char ch = value[index];
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
              (ch >= '0' && ch <= '9') || ch == '_' || ch == '-')) {
            return false;
        }
    }
    return true;
}

static bool app_hshh_avatar_safe_remote_path(const char *value)
{
    size_t length;
    size_t index;

    if (value == NULL || strncmp(value, "device/", 7u) != 0 || strstr(value, "..") != NULL) {
        return false;
    }
    length = strlen(value);
    if (length < 12u || length > HSHH_AVATAR_MAX_REMOTE_PATH ||
        strcmp(value + length - 4u, ".jpg") != 0) {
        return false;
    }
    for (index = 0u; index < length; index++) {
        const char ch = value[index];
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
              (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' || ch == '/' || ch == '.')) {
            return false;
        }
    }
    return true;
}

static OPERATE_RET app_hshh_avatar_sha256(const uint8_t *data, size_t length,
                                          char output[HSHH_AVATAR_SHA_HEX_BYTES + 1u])
{
    static const char hex[] = "0123456789abcdef";
    TKL_HASH_HANDLE context = NULL;
    uint8_t digest[32];
    OPERATE_RET rt;
    OPERATE_RET free_rt;
    size_t index;

    if (data == NULL || output == NULL) {
        return OPRT_INVALID_PARM;
    }
    rt = tal_sha256_create_init(&context);
    if (rt == OPRT_OK) {
        rt = tal_sha256_starts_ret(context, 0);
    }
    if (rt == OPRT_OK) {
        rt = tal_sha256_update_ret(context, data, length);
    }
    if (rt == OPRT_OK) {
        rt = tal_sha256_finish_ret(context, digest);
    }
    if (context != NULL) {
        free_rt = tal_sha256_free(context);
        if (rt == OPRT_OK && free_rt != OPRT_OK) {
            rt = free_rt;
        }
    }
    if (rt != OPRT_OK) {
        memset(digest, 0, sizeof(digest));
        return rt;
    }
    for (index = 0u; index < sizeof(digest); index++) {
        output[index * 2u] = hex[digest[index] >> 4u];
        output[index * 2u + 1u] = hex[digest[index] & 0x0fu];
    }
    output[HSHH_AVATAR_SHA_HEX_BYTES] = '\0';
    memset(digest, 0, sizeof(digest));
    return OPRT_OK;
}

static const char *app_hshh_avatar_identity_path(char slot)
{
    return slot == 'a' ? HSHH_AVATAR_SLOT_IMAGE_A : HSHH_AVATAR_SLOT_IMAGE_B;
}

static const char *app_hshh_avatar_identity_tmp_path(char slot)
{
    return slot == 'a' ? HSHH_AVATAR_SLOT_IMAGE_TMP_A : HSHH_AVATAR_SLOT_IMAGE_TMP_B;
}

static const char *app_hshh_avatar_meta_path(char slot)
{
    return slot == 'a' ? HSHH_AVATAR_SLOT_META_A : HSHH_AVATAR_SLOT_META_B;
}

static const char *app_hshh_avatar_meta_tmp_path(char slot)
{
    return slot == 'a' ? HSHH_AVATAR_SLOT_META_TMP_A : HSHH_AVATAR_SLOT_META_TMP_B;
}

static OPERATE_RET app_hshh_avatar_write_file(const char *path, const uint8_t *data, size_t length)
{
    TUYA_FILE file;
    int written;
    int sync_rt;

    if (path == NULL || data == NULL || length < 1u || length > (size_t)INT32_MAX) {
        return OPRT_INVALID_PARM;
    }
    file = tal_fopen(path, "wb");
    if (file == NULL) {
        return OPRT_FILE_OPEN_FAILED;
    }
    written = tal_fwrite((void *)data, (int)length, file);
    sync_rt = written == (int)length ? tal_fsync(file) : OPRT_COM_ERROR;
    (void)tal_fclose(file);
    if (written != (int)length || sync_rt != OPRT_OK) {
        (void)tal_fs_remove(path);
        return OPRT_FILE_WRITE_FAILED;
    }
    return OPRT_OK;
}

static OPERATE_RET app_hshh_avatar_read_file(const char *path, uint32_t maximum,
                                             uint8_t **data, uint32_t *length)
{
    TUYA_FILE file;
    int64_t size;
    uint8_t *buffer;
    int read_length;

    if (path == NULL || data == NULL || length == NULL) {
        return OPRT_INVALID_PARM;
    }
    *data = NULL;
    *length = 0u;
    file = tal_fopen(path, "rb");
    if (file == NULL) {
        return OPRT_FILE_OPEN_FAILED;
    }
    if (tal_fseek(file, 0, SEEK_END) != OPRT_OK) {
        (void)tal_fclose(file);
        return OPRT_FILE_READ_FAILED;
    }
    size = tal_ftell(file);
    if (size < 1 || size > (int64_t)maximum || tal_fseek(file, 0, SEEK_SET) != OPRT_OK) {
        (void)tal_fclose(file);
        return OPRT_FILE_READ_FAILED;
    }
    buffer = tal_malloc((size_t)size + 1u);
    if (buffer == NULL) {
        (void)tal_fclose(file);
        return OPRT_MALLOC_FAILED;
    }
    read_length = tal_fread(buffer, (int)size, file);
    (void)tal_fclose(file);
    if (read_length != (int)size) {
        tal_free(buffer);
        return OPRT_FILE_READ_FAILED;
    }
    buffer[size] = '\0';
    *data = buffer;
    *length = (uint32_t)size;
    return OPRT_OK;
}

static OPERATE_RET app_hshh_avatar_http(const char *path, const char *method,
                                        const char *body, const char *accept,
                                        http_client_response_t *response)
{
    http_client_header_t headers[] = {
        {.key = "Authorization", .value = s_authorization},
        {.key = "Accept", .value = accept},
        {.key = "Content-Type", .value = "application/json"},
    };
    http_client_status_t status;

    status = http_client_request(
        &(const http_client_request_t){
            .host = HSHH_AGENT_HOST,
            .port = HSHH_AGENT_PORT,
            .path = path,
            .method = method,
            .headers = headers,
            .headers_count = sizeof(headers) / sizeof(headers[0]),
            .body = (const uint8_t *)(body == NULL ? "" : body),
            .body_length = body == NULL ? 0u : strlen(body),
            .timeout_ms = HSHH_AGENT_HTTP_TIMEOUT_MS,
        },
        response);
    return status == HTTP_CLIENT_SUCCESS && response->body != NULL ? OPRT_OK : OPRT_COM_ERROR;
}

static const char *app_hshh_avatar_json_text(cJSON *object, const char *key)
{
    cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);

    return cJSON_IsString(value) ? cJSON_GetStringValue(value) : NULL;
}

static bool app_hshh_avatar_parse_deployment(cJSON *root, app_hshh_avatar_deployment_t *deployment)
{
    cJSON *envelope;
    cJSON *manifest;
    cJSON *expressions;
    cJSON *identity;
    cJSON *value;
    char *canonical = NULL;
    char computed_sha[HSHH_AVATAR_SHA_HEX_BYTES + 1u];
    const char *asset_id;
    const char *manifest_sha;
    uint8_t expression;
    uint8_t frame;

    if (!cJSON_IsObject(root) || deployment == NULL) {
        return false;
    }
    envelope = cJSON_GetObjectItemCaseSensitive(root, "deployment");
    if (cJSON_IsNull(envelope)) {
        return false;
    }
    if (!cJSON_IsObject(envelope)) {
        return false;
    }
    asset_id = app_hshh_avatar_json_text(envelope, "asset_id");
    manifest_sha = app_hshh_avatar_json_text(envelope, "manifest_sha256");
    manifest = cJSON_GetObjectItemCaseSensitive(envelope, "manifest");
    if (!app_hshh_avatar_safe_id(asset_id) || !app_hshh_avatar_hex64(manifest_sha) ||
        !cJSON_IsObject(manifest)) {
        return false;
    }
    value = cJSON_GetObjectItemCaseSensitive(manifest, "schema_version");
    if (!cJSON_IsNumber(value) || value->valueint != 1 ||
        strcmp(app_hshh_avatar_json_text(manifest, "encoding") == NULL ? "" :
                   app_hshh_avatar_json_text(manifest, "encoding"), "jpeg") != 0) {
        return false;
    }
    if (strcmp(app_hshh_avatar_json_text(manifest, "renderer_contract") == NULL ? "" :
                   app_hshh_avatar_json_text(manifest, "renderer_contract"), "hshh-overlay-v1") != 0) {
        return false;
    }
    value = cJSON_GetObjectItemCaseSensitive(manifest, "width");
    if (!cJSON_IsNumber(value) || value->valueint != HSHH_AVATAR_WIDTH) {
        return false;
    }
    value = cJSON_GetObjectItemCaseSensitive(manifest, "height");
    if (!cJSON_IsNumber(value) || value->valueint != HSHH_AVATAR_HEIGHT) {
        return false;
    }
    value = cJSON_GetObjectItemCaseSensitive(manifest, "frame_count");
    if (!cJSON_IsNumber(value) || value->valueint != HSHH_AVATAR_FRAME_COUNT) {
        return false;
    }
    identity = cJSON_GetObjectItemCaseSensitive(manifest, "identity");
    if (!cJSON_IsObject(identity) ||
        !app_hshh_avatar_safe_remote_path(app_hshh_avatar_json_text(identity, "path")) ||
        !app_hshh_avatar_hex64(app_hshh_avatar_json_text(identity, "sha256"))) {
        return false;
    }
    expressions = cJSON_GetObjectItemCaseSensitive(manifest, "expressions");
    if (!cJSON_IsObject(expressions) || cJSON_GetArraySize(expressions) != HSHH_AVATAR_EXPRESSION_COUNT) {
        return false;
    }
    memset(deployment, 0, sizeof(*deployment));
    memcpy(deployment->asset_id, asset_id, strlen(asset_id) + 1u);
    memcpy(deployment->manifest_sha256, manifest_sha, HSHH_AVATAR_SHA_HEX_BYTES + 1u);
    memcpy(deployment->identity_remote_path, app_hshh_avatar_json_text(identity, "path"),
           strlen(app_hshh_avatar_json_text(identity, "path")) + 1u);
    memcpy(deployment->identity_sha256, app_hshh_avatar_json_text(identity, "sha256"),
           HSHH_AVATAR_SHA_HEX_BYTES + 1u);
    for (expression = 0u; expression < HSHH_AVATAR_EXPRESSION_COUNT; expression++) {
        cJSON *frames = cJSON_GetObjectItemCaseSensitive(expressions, s_expression_names[expression]);
        if (!cJSON_IsArray(frames) || cJSON_GetArraySize(frames) != HSHH_AVATAR_FRAMES_PER_EXPRESSION) {
            return false;
        }
        for (frame = 0u; frame < HSHH_AVATAR_FRAMES_PER_EXPRESSION; frame++) {
            const uint8_t index = (uint8_t)(expression * HSHH_AVATAR_FRAMES_PER_EXPRESSION + frame);
            cJSON *item = cJSON_GetArrayItem(frames, frame);
            const char *remote_path = app_hshh_avatar_json_text(item, "path");
            const char *checksum = app_hshh_avatar_json_text(item, "sha256");
            uint8_t prior;

            if (!cJSON_IsObject(item) || !app_hshh_avatar_safe_remote_path(remote_path) ||
                !app_hshh_avatar_hex64(checksum)) {
                return false;
            }
            for (prior = 0u; prior < index; prior++) {
                if (strcmp(deployment->remote_paths[prior], remote_path) == 0) {
                    return false;
                }
            }
            if (strcmp(deployment->identity_remote_path, remote_path) == 0) {
                return false;
            }
            memcpy(deployment->remote_paths[index], remote_path, strlen(remote_path) + 1u);
            memcpy(deployment->frame_sha256[index], checksum, HSHH_AVATAR_SHA_HEX_BYTES + 1u);
        }
    }
    canonical = cJSON_PrintUnformatted(manifest);
    if (canonical == NULL ||
        app_hshh_avatar_sha256((const uint8_t *)canonical, strlen(canonical), computed_sha) != OPRT_OK ||
        strcmp(computed_sha, deployment->manifest_sha256) != 0) {
        cJSON_free(canonical);
        return false;
    }
    cJSON_free(canonical);
    return true;
}

static OPERATE_RET app_hshh_avatar_validate_jpeg(const uint8_t *data, uint32_t length,
                                                 const char *expected_sha)
{
    TAL_IMAGE_JPEG_INFO_T info = {0};
    char checksum[HSHH_AVATAR_SHA_HEX_BYTES + 1u];

    if (data == NULL || length < TAL_IMAGE_JPEG_MIN_READ_SIZE || !app_hshh_avatar_hex64(expected_sha) ||
        app_hshh_avatar_sha256(data, length, checksum) != OPRT_OK || strcmp(checksum, expected_sha) != 0 ||
        tal_image_jpeg_get_info(data, length, &info) != OPRT_OK ||
        info.width != HSHH_AVATAR_WIDTH || info.height != HSHH_AVATAR_HEIGHT) {
        return OPRT_COM_ERROR;
    }
    return OPRT_OK;
}

static OPERATE_RET app_hshh_avatar_validate_slot(char slot,
                                                 const app_hshh_avatar_deployment_t *deployment)
{
    uint8_t *bytes = NULL;
    uint32_t length = 0u;
    OPERATE_RET rt;

    if (slot != 'a' && slot != 'b') {
        return OPRT_INVALID_PARM;
    }
    rt = app_hshh_avatar_read_file(app_hshh_avatar_identity_path(slot),
                                   HSHH_AVATAR_MAX_IDENTITY_BYTES, &bytes, &length);
    if (rt == OPRT_OK) {
        rt = app_hshh_avatar_validate_jpeg(bytes, length, deployment->identity_sha256);
    }
    if (bytes != NULL) {
        tal_free(bytes);
    }
    return rt;
}

static OPERATE_RET app_hshh_avatar_load_slot_metadata(char slot,
                                                      app_hshh_avatar_deployment_t *deployment)
{
    uint8_t *bytes = NULL;
    uint32_t length = 0u;
    cJSON *root = NULL;
    OPERATE_RET rt;

    rt = app_hshh_avatar_read_file(app_hshh_avatar_meta_path(slot), HSHH_AVATAR_MAX_META_BYTES,
                                   &bytes, &length);
    if (rt != OPRT_OK) {
        return rt;
    }
    root = cJSON_ParseWithLength((const char *)bytes, length);
    if (!app_hshh_avatar_parse_deployment(root, deployment)) {
        rt = OPRT_COM_ERROR;
    }
    cJSON_Delete(root);
    tal_free(bytes);
    return rt;
}

static void app_hshh_avatar_load_active(void)
{
    uint8_t *pointer_bytes = NULL;
    uint32_t pointer_length = 0u;
    cJSON *pointer = NULL;
    const char *slot_text;
    const char *asset_id;
    const char *manifest_sha;
    app_hshh_avatar_deployment_t *deployment = NULL;
    char slot;

    s_active = false;
    s_active_slot = 0;
    memset(s_active_asset_id, 0, sizeof(s_active_asset_id));
    if (app_hshh_avatar_read_file(HSHH_AVATAR_POINTER_PATH, 512u, &pointer_bytes, &pointer_length) != OPRT_OK) {
        return;
    }
    pointer = cJSON_ParseWithLength((const char *)pointer_bytes, pointer_length);
    slot_text = app_hshh_avatar_json_text(pointer, "slot");
    asset_id = app_hshh_avatar_json_text(pointer, "asset_id");
    manifest_sha = app_hshh_avatar_json_text(pointer, "manifest_sha256");
    if (!cJSON_IsObject(pointer) || slot_text == NULL || strlen(slot_text) != 1u ||
        (slot_text[0] != 'a' && slot_text[0] != 'b') || !app_hshh_avatar_safe_id(asset_id) ||
        !app_hshh_avatar_hex64(manifest_sha)) {
        goto exit;
    }
    deployment = app_hshh_avatar_deployment_alloc();
    if (deployment == NULL) {
        PR_WARN("[HSHH AVATAR] persisted pack skipped; deployment allocation failed");
        goto exit;
    }
    slot = slot_text[0];
    if (app_hshh_avatar_load_slot_metadata(slot, deployment) != OPRT_OK ||
        strcmp(asset_id, deployment->asset_id) != 0 ||
        strcmp(manifest_sha, deployment->manifest_sha256) != 0 ||
        app_hshh_avatar_validate_slot(slot, deployment) != OPRT_OK) {
        PR_WARN("[HSHH AVATAR] persisted slot invalid; built-in basic remains active");
        goto exit;
    }
    memcpy(s_active_asset_id, deployment->asset_id, strlen(deployment->asset_id) + 1u);
    s_active_slot = slot;
    s_active = true;
    PR_NOTICE("[HSHH AVATAR] restored verified pet pack asset=%s slot=%c", s_active_asset_id, slot);

exit:
    app_hshh_avatar_deployment_free(deployment);
    cJSON_Delete(pointer);
    tal_free(pointer_bytes);
}

static OPERATE_RET app_hshh_avatar_download_and_validate(const char *remote_path,
                                                         const char *expected_sha,
                                                         uint32_t maximum_bytes,
                                                         uint8_t **validated_bytes,
                                                         uint32_t *validated_length,
                                                         const app_hshh_avatar_deployment_t *deployment)
{
    char http_path[HSHH_AVATAR_HTTP_PATH_BYTES];
    http_client_response_t response = {0};
    int written;
    OPERATE_RET rt;

    if (validated_bytes != NULL) {
        *validated_bytes = NULL;
    }
    if (validated_length != NULL) {
        *validated_length = 0u;
    }
    written = snprintf(http_path, sizeof(http_path), "/v1/device/avatar-pack/%s/files/%s",
                       deployment->asset_id, remote_path);
    if (written <= 0 || (size_t)written >= sizeof(http_path)) {
        return OPRT_BUFFER_NOT_ENOUGH;
    }
    rt = app_hshh_avatar_http(http_path, "GET", NULL, "image/jpeg", &response);
    if (rt != OPRT_OK || response.status_code != 200u || response.body_length > maximum_bytes) {
        rt = OPRT_COM_ERROR;
        goto exit;
    }
    rt = app_hshh_avatar_validate_jpeg(response.body, (uint32_t)response.body_length,
                                       expected_sha);
    if (rt == OPRT_OK && validated_bytes != NULL && validated_length != NULL) {
        *validated_bytes = tal_malloc(response.body_length);
        if (*validated_bytes == NULL) {
            rt = OPRT_MALLOC_FAILED;
        } else {
            memcpy(*validated_bytes, response.body, response.body_length);
            *validated_length = (uint32_t)response.body_length;
        }
    }

exit:
    http_client_free(&response);
    return rt;
}

static OPERATE_RET app_hshh_avatar_commit(char slot, const uint8_t *metadata, uint32_t metadata_length,
                                          const app_hshh_avatar_deployment_t *deployment)
{
    char pointer[384];
    int written;
    OPERATE_RET rt;

    rt = app_hshh_avatar_write_file(app_hshh_avatar_meta_tmp_path(slot), metadata, metadata_length);
    if (rt != OPRT_OK || tal_fs_rename(app_hshh_avatar_meta_tmp_path(slot), app_hshh_avatar_meta_path(slot)) != OPRT_OK) {
        return OPRT_COM_ERROR;
    }
    written = snprintf(pointer, sizeof(pointer),
                       "{\"slot\":\"%c\",\"asset_id\":\"%s\",\"manifest_sha256\":\"%s\"}",
                       slot, deployment->asset_id, deployment->manifest_sha256);
    if (written <= 0 || (size_t)written >= sizeof(pointer)) {
        return OPRT_BUFFER_NOT_ENOUGH;
    }
    rt = app_hshh_avatar_write_file(HSHH_AVATAR_POINTER_TMP_PATH, (const uint8_t *)pointer, (size_t)written);
    if (rt != OPRT_OK || tal_fs_rename(HSHH_AVATAR_POINTER_TMP_PATH, HSHH_AVATAR_POINTER_PATH) != OPRT_OK) {
        return OPRT_COM_ERROR;
    }
    memcpy(s_active_asset_id, deployment->asset_id, strlen(deployment->asset_id) + 1u);
    s_active_slot = slot;
    s_active = true;
    return OPRT_OK;
}

static OPERATE_RET app_hshh_avatar_post_activation(const app_hshh_avatar_deployment_t *deployment)
{
    char path[HSHH_AVATAR_HTTP_PATH_BYTES];
    char body[256];
    http_client_response_t response = {0};
    int written;
    OPERATE_RET rt;

    written = snprintf(path, sizeof(path), "/v1/device/avatar-pack/%s/activate", deployment->asset_id);
    if (written <= 0 || (size_t)written >= sizeof(path)) {
        return OPRT_BUFFER_NOT_ENOUGH;
    }
    written = snprintf(body, sizeof(body),
                       "{\"manifest_sha256\":\"%s\",\"files_verified\":45,"
                       "\"identity_verified\":true,\"display_ready\":true}",
                       deployment->manifest_sha256);
    if (written <= 0 || (size_t)written >= sizeof(body)) {
        return OPRT_BUFFER_NOT_ENOUGH;
    }
    rt = app_hshh_avatar_http(path, "POST", body, "application/json", &response);
    if (rt == OPRT_OK && response.status_code != 200u) {
        rt = OPRT_COM_ERROR;
    }
    http_client_free(&response);
    return rt;
}

static OPERATE_RET app_hshh_avatar_poll_once(void)
{
    http_client_response_t response = {0};
    cJSON *root = NULL;
    cJSON *deployment_item;
    app_hshh_avatar_deployment_t *deployment = NULL;
    char slot;
    uint8_t index;
    uint8_t *identity_bytes = NULL;
    uint32_t identity_length = 0u;
    OPERATE_RET rt;
    uint32_t now_ms = tal_system_get_millisecond();

    rt = app_hshh_avatar_http(HSHH_AVATAR_STATUS_PATH, "GET", NULL, "application/json", &response);
    if (rt != OPRT_OK || response.status_code != 200u || response.body_length > HSHH_AVATAR_MAX_META_BYTES) {
        rt = OPRT_COM_ERROR;
        goto exit;
    }
    root = cJSON_ParseWithLength((const char *)response.body, response.body_length);
    deployment_item = cJSON_GetObjectItemCaseSensitive(root, "deployment");
    if (cJSON_IsNull(deployment_item)) {
        rt = OPRT_OK;
        goto exit;
    }
    deployment = app_hshh_avatar_deployment_alloc();
    if (deployment == NULL) {
        rt = OPRT_MALLOC_FAILED;
        goto exit;
    }
    if (!app_hshh_avatar_parse_deployment(root, deployment)) {
        rt = OPRT_COM_ERROR;
        goto exit;
    }
    if (s_active && strcmp(s_active_asset_id, deployment->asset_id) == 0) {
        rt = app_hshh_avatar_post_activation(deployment);
        goto exit;
    }
    if (strcmp(s_failed_asset_id, deployment->asset_id) == 0 &&
        (uint32_t)(now_ms - s_failed_at_ms) < HSHH_AVATAR_FAILURE_BACKOFF_MS) {
        rt = OPRT_RESOURCE_NOT_READY;
        goto exit;
    }
    slot = s_active_slot == 'a' ? 'b' : 'a';
    PR_NOTICE("[HSHH AVATAR] streaming 45-frame verification asset=%s inactive slot=%c",
              deployment->asset_id, slot);
    for (index = 0u; index < HSHH_AVATAR_FRAME_COUNT; index++) {
        rt = app_hshh_avatar_download_and_validate(deployment->remote_paths[index],
                                                   deployment->frame_sha256[index],
                                                   HSHH_AVATAR_MAX_FRAME_BYTES,
                                                   NULL, NULL, deployment);
        if (rt != OPRT_OK) {
            PR_WARN("[HSHH AVATAR] frame %u rejected, rt=%d; basic/current slot unchanged",
                    (unsigned int)index, rt);
            goto failed;
        }
    }
    rt = app_hshh_avatar_download_and_validate(deployment->identity_remote_path,
                                               deployment->identity_sha256,
                                               HSHH_AVATAR_MAX_IDENTITY_BYTES,
                                               &identity_bytes, &identity_length, deployment);
    if (rt != OPRT_OK || identity_bytes == NULL || identity_length == 0u) {
        goto failed;
    }
    rt = app_hshh_avatar_write_file(app_hshh_avatar_identity_tmp_path(slot),
                                    identity_bytes, identity_length);
    tal_free(identity_bytes);
    identity_bytes = NULL;
    if (rt != OPRT_OK ||
        tal_fs_rename(app_hshh_avatar_identity_tmp_path(slot),
                      app_hshh_avatar_identity_path(slot)) != OPRT_OK) {
        rt = OPRT_COM_ERROR;
        goto failed;
    }
    rt = app_hshh_avatar_validate_slot(slot, deployment);
    if (rt != OPRT_OK) {
        goto failed;
    }
    rt = app_hshh_avatar_commit(slot, response.body, (uint32_t)response.body_length, deployment);
    if (rt != OPRT_OK) {
        goto failed;
    }
    memset(s_failed_asset_id, 0, sizeof(s_failed_asset_id));
    rt = app_hshh_avatar_post_activation(deployment);
    PR_NOTICE("[HSHH AVATAR] atomic pet switch complete asset=%s slot=%c receipt=%d",
              deployment->asset_id, slot, rt);
    goto exit;

failed:
    (void)tal_fs_remove(app_hshh_avatar_identity_tmp_path(slot));
    memcpy(s_failed_asset_id, deployment->asset_id, strlen(deployment->asset_id) + 1u);
    s_failed_at_ms = now_ms;

exit:
    if (identity_bytes != NULL) {
        tal_free(identity_bytes);
    }
    app_hshh_avatar_deployment_free(deployment);
    cJSON_Delete(root);
    http_client_free(&response);
    return rt;
}

static void app_hshh_avatar_worker(void *args)
{
    uint32_t last_poll_ms = 0u;

    (void)args;
    while (true) {
        const uint32_t now_ms = tal_system_get_millisecond();

        if (app_hshh_lan_link_is_up() && app_hshh_lan_clock_is_trusted() &&
            (last_poll_ms == 0u || (uint32_t)(now_ms - last_poll_ms) >= HSHH_AVATAR_POLL_INTERVAL_MS)) {
            last_poll_ms = now_ms;
            (void)app_hshh_avatar_poll_once();
        }
        tal_system_sleep(250u);
    }
}

OPERATE_RET app_hshh_avatar_init(void)
{
    THREAD_CFG_T thread_config = {0};
    int written;
    OPERATE_RET rt;

    if (s_started) {
        return OPRT_OK;
    }
    app_hshh_avatar_load_active();
    if (strlen(HSHH_AGENT_HOST) < 1u || strlen(HSHH_AGENT_HOST) > 253u ||
        strlen(HSHH_AGENT_DEVICE_TOKEN) < 16u || strlen(HSHH_AGENT_DEVICE_TOKEN) > 512u ||
        strstr(HSHH_AGENT_HOST, "://") != NULL || strchr(HSHH_AGENT_HOST, '/') != NULL) {
        PR_WARN("[HSHH AVATAR] Agent configuration absent; persisted pack only");
        return OPRT_OK;
    }
    written = snprintf(s_authorization, sizeof(s_authorization), "Bearer %s", HSHH_AGENT_DEVICE_TOKEN);
    if (written <= 0 || (size_t)written >= sizeof(s_authorization)) {
        return OPRT_INVALID_PARM;
    }
    thread_config.stackDepth = 1024u * 10u;
    thread_config.priority = THREAD_PRIO_3;
    thread_config.thrdname = "hshh_avatar";
    rt = tal_thread_create_and_start(&s_avatar_thread, NULL, NULL, app_hshh_avatar_worker, NULL, &thread_config);
    if (rt == OPRT_OK) {
        s_started = true;
    }
    return rt;
}

OPERATE_RET app_hshh_avatar_load_frame(uint8_t expression, uint8_t frame,
                                      uint8_t **data, uint32_t *length)
{
    const char slot = s_active_slot;

    if (!s_active || (slot != 'a' && slot != 'b') || expression >= HSHH_AVATAR_EXPRESSION_COUNT ||
        frame >= HSHH_AVATAR_FRAMES_PER_EXPRESSION || data == NULL || length == NULL) {
        return OPRT_RESOURCE_NOT_READY;
    }
    return app_hshh_avatar_read_file(app_hshh_avatar_identity_path(slot),
                                     HSHH_AVATAR_MAX_IDENTITY_BYTES, data, length);
}

void app_hshh_avatar_mark_runtime_invalid(void)
{
    s_active = false;
    PR_WARN("[HSHH AVATAR] active pet frame failed at runtime; falling back to built-in basic");
}

bool app_hshh_avatar_is_active(void)
{
    return s_active;
}
