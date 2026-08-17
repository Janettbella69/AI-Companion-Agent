#include "app_hshh_display.h"

#include <stddef.h>
#include <string.h>

#include "app_hshh_expression_assets.h"
#include "app_hshh_avatar.h"
#include "tal_api.h"
#include "tal_image.h"
#include "tdd_disp_st7789.h"
#include "tdd_display_spi.h"
#include "tdl_display_manage.h"
#include "tkl_gpio.h"

#define APP_HSHH_DISPLAY_FRAME_INTERVAL_MS 320u
#define APP_HSHH_DISPLAY_BRIGHTNESS        100u
#define APP_HSHH_RGB565_BYTES_PER_PIXEL    2u
#define APP_HSHH_DISPLAY_SPLASH_RGB565     0xF800u
#define APP_HSHH_DISPLAY_HOLD_SPLASH_MS    1500u
#define APP_HSHH_DISPLAY_SPI_SETTLE_MS     200u
#define APP_HSHH_DISPLAY_BL_PIN            TUYA_GPIO_NUM_9
#define APP_HSHH_DISPLAY_RST_PIN           TUYA_GPIO_NUM_6
#define APP_HSHH_DISPLAY_CS_PIN            TUYA_GPIO_NUM_45
#define APP_HSHH_DISPLAY_DC_PIN            TUYA_GPIO_NUM_47
#define APP_HSHH_DISPLAY_SPI_PORT          TUYA_SPI_NUM_0

static TDL_DISP_HANDLE_T s_display;
static TDL_DISP_DEV_INFO_T s_info;
static TDL_DISP_FRAME_BUFF_T *s_source_frame;
static TDL_DISP_FRAME_BUFF_T *s_rotated_frame;
static TDL_DISP_FRAME_BUFF_T *s_panel_frame;
static TDL_DISP_FRAME_BUFF_T *s_panel_frames[2];
static uint8_t s_panel_count;
static uint8_t s_panel_index;
static app_hshh_expression_t s_requested_expression = APP_HSHH_EXPRESSION_IDLE;
static app_hshh_expression_t s_rendered_expression = APP_HSHH_EXPRESSION_ANGRY;
static uint8_t s_frame_index;
static uint32_t s_last_frame_ms;
static bool s_ready;
static bool s_catalog_valid;
static OPERATE_RET s_last_init_rt = OPRT_COM_ERROR;
static TUYA_GPIO_NUM_E s_bl_pin = APP_HSHH_DISPLAY_BL_PIN;
static TUYA_GPIO_LEVEL_E s_bl_level = TUYA_GPIO_LEVEL_HIGH;
static uint32_t s_hold_splash_until_ms;

static TDL_DISP_FRAME_BUFF_T *app_hshh_acquire_panel_frame(void);

static void app_hshh_overlay_pixel(int x, int y, uint16_t color)
{
    uint16_t *pixels = (uint16_t *)s_source_frame->frame;

    if (x >= 0 && x < (int)APP_HSHH_EXPRESSION_WIDTH &&
        y >= 0 && y < (int)APP_HSHH_EXPRESSION_HEIGHT) {
        pixels[(size_t)y * APP_HSHH_EXPRESSION_WIDTH + (size_t)x] = color;
    }
}

static void app_hshh_overlay_ellipse(int center_x, int center_y, int radius_x, int radius_y,
                                     uint16_t color)
{
    int y;
    int x;
    const int64_t rx2 = (int64_t)radius_x * radius_x;
    const int64_t ry2 = (int64_t)radius_y * radius_y;
    const int64_t bound = rx2 * ry2;

    for (y = -radius_y; y <= radius_y; y++) {
        for (x = -radius_x; x <= radius_x; x++) {
            if ((int64_t)x * x * ry2 + (int64_t)y * y * rx2 <= bound) {
                app_hshh_overlay_pixel(center_x + x, center_y + y, color);
            }
        }
    }
}

static void app_hshh_overlay_line(int x0, int y0, int x1, int y1, int thickness, uint16_t color)
{
    int dx = x1 >= x0 ? x1 - x0 : x0 - x1;
    int sx = x0 < x1 ? 1 : -1;
    int dy_abs = y1 >= y0 ? y1 - y0 : y0 - y1;
    int dy = -dy_abs;
    int sy = y0 < y1 ? 1 : -1;
    int error = dx + dy;
    int radius = thickness / 2;

    while (true) {
        int ox;
        int oy;
        for (oy = -radius; oy <= radius; oy++) {
            for (ox = -radius; ox <= radius; ox++) {
                app_hshh_overlay_pixel(x0 + ox, y0 + oy, color);
            }
        }
        if (x0 == x1 && y0 == y1) {
            break;
        }
        {
            const int twice_error = 2 * error;
            if (twice_error >= dy) {
                error += dy;
                x0 += sx;
            }
            if (twice_error <= dx) {
                error += dx;
                y0 += sy;
            }
        }
    }
}

static void app_hshh_overlay_curve(int x0, int y0, int control_x, int control_y,
                                   int x1, int y1, int thickness, uint16_t color)
{
    int step;
    int previous_x = x0;
    int previous_y = y0;

    for (step = 1; step <= 16; step++) {
        const int inverse = 16 - step;
        const int x = (inverse * inverse * x0 + 2 * inverse * step * control_x +
                       step * step * x1) / 256;
        const int y = (inverse * inverse * y0 + 2 * inverse * step * control_y +
                       step * step * y1) / 256;
        app_hshh_overlay_line(previous_x, previous_y, x, y, thickness, color);
        previous_x = x;
        previous_y = y;
    }
}

static void app_hshh_overlay_expression(app_hshh_expression_t expression, uint8_t frame)
{
    const uint16_t outline = 0xffffu;
    const uint16_t ink = 0x1082u;
    const int phase = frame > 2u ? (int)frame - 2 : 2 - (int)frame;
    const int eye_y = 96 + phase;
    int mouth_x0 = 126;
    int mouth_y0 = 150;
    int mouth_cx = 160;
    int mouth_cy = 162;
    int mouth_x1 = 194;
    int mouth_y1 = 150;
    bool blink = frame == 2u || expression == APP_HSHH_EXPRESSION_SLEEPING;
    int eye_radius_y = expression == APP_HSHH_EXPRESSION_NOTICED ? 16 : 10;

    if (blink) {
        app_hshh_overlay_line(94, eye_y, 118, eye_y, 7, outline);
        app_hshh_overlay_line(202, eye_y, 226, eye_y, 7, outline);
        app_hshh_overlay_line(96, eye_y, 116, eye_y, 3, ink);
        app_hshh_overlay_line(204, eye_y, 224, eye_y, 3, ink);
    } else {
        app_hshh_overlay_ellipse(106, eye_y, 13, eye_radius_y + 3, outline);
        app_hshh_overlay_ellipse(214, eye_y, 13, eye_radius_y + 3, outline);
        app_hshh_overlay_ellipse(106, eye_y, 9, eye_radius_y, ink);
        app_hshh_overlay_ellipse(214, eye_y, 9, eye_radius_y, ink);
    }

    switch (expression) {
        case APP_HSHH_EXPRESSION_NOTICED:
            mouth_x0 = 148; mouth_y0 = 150; mouth_cy = 168; mouth_x1 = 172; mouth_y1 = 150;
            break;
        case APP_HSHH_EXPRESSION_LISTENING:
            mouth_x0 = 130; mouth_y0 = 151; mouth_cy = 166; mouth_x1 = 190; mouth_y1 = 151;
            break;
        case APP_HSHH_EXPRESSION_THINKING:
            mouth_x0 = 142; mouth_y0 = 154; mouth_cy = 146; mouth_x1 = 178; mouth_y1 = 154;
            break;
        case APP_HSHH_EXPRESSION_HAPPY:
            mouth_x0 = 112; mouth_y0 = 144; mouth_cy = 188; mouth_x1 = 208; mouth_y1 = 144;
            break;
        case APP_HSHH_EXPRESSION_CONFUSED:
            mouth_x0 = 124; mouth_y0 = 156; mouth_cy = 138; mouth_x1 = 160; mouth_y1 = 156;
            break;
        case APP_HSHH_EXPRESSION_SAD:
            mouth_x0 = 120; mouth_y0 = 166; mouth_cy = 130; mouth_x1 = 200; mouth_y1 = 166;
            break;
        case APP_HSHH_EXPRESSION_SLEEPING:
            mouth_x0 = 142; mouth_y0 = 155; mouth_cy = 162; mouth_x1 = 178; mouth_y1 = 155;
            break;
        case APP_HSHH_EXPRESSION_ANGRY:
            mouth_x0 = 122; mouth_y0 = 164; mouth_cy = 134; mouth_x1 = 198; mouth_y1 = 164;
            app_hshh_overlay_line(78, 76, 126, 90, 7, outline);
            app_hshh_overlay_line(242, 76, 194, 90, 7, outline);
            app_hshh_overlay_line(80, 77, 124, 89, 3, ink);
            app_hshh_overlay_line(240, 77, 196, 89, 3, ink);
            break;
        case APP_HSHH_EXPRESSION_IDLE:
        default:
            break;
    }
    if (expression == APP_HSHH_EXPRESSION_CONFUSED) {
        app_hshh_overlay_line(82, 78, 124, 72, 7, outline);
        app_hshh_overlay_line(238, 72, 196, 80, 7, outline);
        app_hshh_overlay_line(84, 78, 122, 73, 3, ink);
        app_hshh_overlay_line(236, 73, 198, 79, 3, ink);
        app_hshh_overlay_curve(160, 156, 178, 174, 196, 156, 7, outline);
        app_hshh_overlay_curve(160, 156, 178, 174, 196, 156, 3, ink);
    }
    app_hshh_overlay_curve(mouth_x0, mouth_y0, mouth_cx, mouth_cy,
                           mouth_x1, mouth_y1, 7, outline);
    app_hshh_overlay_curve(mouth_x0, mouth_y0, mouth_cx, mouth_cy,
                           mouth_x1, mouth_y1, 3, ink);
}

static uint32_t app_hshh_crc32(const uint8_t *data, uint32_t length)
{
    uint32_t crc = 0xffffffffu;
    uint32_t index;
    uint8_t bit;

    for (index = 0; index < length; index++) {
        crc ^= data[index];
        for (bit = 0; bit < 8u; bit++) {
            crc = (crc >> 1u) ^ (0xedb88320u & (uint32_t)-(int32_t)(crc & 1u));
        }
    }
    return ~crc;
}

static bool app_hshh_validate_asset(const app_hshh_expression_asset_t *asset)
{
    TAL_IMAGE_JPEG_INFO_T info = {0};

    if (asset == NULL || asset->data == NULL || asset->length < TAL_IMAGE_JPEG_MIN_READ_SIZE ||
        app_hshh_crc32(asset->data, asset->length) != asset->crc32) {
        return false;
    }
    if (tal_image_jpeg_get_info(asset->data, asset->length, &info) != OPRT_OK) {
        return false;
    }
    return info.width == APP_HSHH_EXPRESSION_WIDTH && info.height == APP_HSHH_EXPRESSION_HEIGHT;
}

static bool app_hshh_validate_dynamic_jpeg(const uint8_t *data, uint32_t length)
{
    TAL_IMAGE_JPEG_INFO_T info = {0};

    return data != NULL && length >= TAL_IMAGE_JPEG_MIN_READ_SIZE &&
           tal_image_jpeg_get_info(data, length, &info) == OPRT_OK &&
           info.width == APP_HSHH_EXPRESSION_WIDTH && info.height == APP_HSHH_EXPRESSION_HEIGHT;
}

static bool app_hshh_validate_catalog(void)
{
    uint8_t expression;
    uint8_t frame;

    for (expression = 0; expression < APP_HSHH_EXPRESSION_ASSET_COUNT; expression++) {
        for (frame = 0; frame < APP_HSHH_EXPRESSION_FRAME_COUNT; frame++) {
            if (!app_hshh_validate_asset(app_hshh_expression_asset_get(expression, frame))) {
                PR_ERR("[HSHH DISPLAY] invalid asset %s/%u", app_hshh_expression_asset_name(expression),
                       (unsigned int)(frame + 1u));
                return false;
            }
        }
    }
    return true;
}

static OPERATE_RET app_hshh_render_asset(app_hshh_expression_t expression, uint8_t frame)
{
    const app_hshh_expression_asset_t *asset;
    const uint8_t *encoded_data;
    uint32_t encoded_length;
    uint8_t *dynamic_data = NULL;
    TAL_IMAGE_JPEG_OUTPUT_T output;
    TDL_DISP_FRAME_BUFF_T *target;
    OPERATE_RET rt;
    const bool dynamic_requested = app_hshh_avatar_is_active();
    bool dynamic_rendered = false;

    if (dynamic_requested) {
        rt = app_hshh_avatar_load_frame((uint8_t)expression, frame, &dynamic_data, &encoded_length);
        if (rt != OPRT_OK || !app_hshh_validate_dynamic_jpeg(dynamic_data, encoded_length)) {
            if (dynamic_data != NULL) {
                tal_free(dynamic_data);
            }
            dynamic_data = NULL;
            app_hshh_avatar_mark_runtime_invalid();
        }
    }
    if (dynamic_data != NULL) {
        encoded_data = dynamic_data;
        dynamic_rendered = true;
    } else {
        asset = app_hshh_expression_asset_get((uint8_t)expression, frame);
        if (!app_hshh_validate_asset(asset)) {
            return OPRT_COM_ERROR;
        }
        encoded_data = asset->data;
        encoded_length = asset->length;
    }

    memset(&output, 0, sizeof(output));
    output.out_buf = s_source_frame->frame;
    output.out_buf_size = s_source_frame->len;
    output.out_width = APP_HSHH_EXPRESSION_WIDTH;
    output.out_height = APP_HSHH_EXPRESSION_HEIGHT;
    rt = tal_image_jpeg_decode_rgb565(encoded_data, encoded_length, &output);
    if (rt != OPRT_OK) {
        if (dynamic_data != NULL) {
            tal_free(dynamic_data);
            app_hshh_avatar_mark_runtime_invalid();
        }
        return rt;
    }
    if (dynamic_data != NULL) {
        tal_free(dynamic_data);
    }
    if (dynamic_rendered) {
        app_hshh_overlay_expression(expression, frame);
    }

    target = app_hshh_acquire_panel_frame();
    if (s_info.rotation != TUYA_DISPLAY_ROTATION_0) {
        rt = tdl_disp_draw_rotate(s_info.rotation, s_source_frame, target, s_info.is_swap);
        if (rt != OPRT_OK) {
            return rt;
        }
    } else {
        if (target != s_source_frame) {
            memcpy(target->frame, s_source_frame->frame, s_source_frame->len);
        }
        if (s_info.is_swap) {
            rt = tdl_disp_dev_rgb565_swap((uint16_t *)target->frame,
                                          APP_HSHH_EXPRESSION_WIDTH * APP_HSHH_EXPRESSION_HEIGHT);
            if (rt != OPRT_OK) {
                return rt;
            }
        }
    }

    return tdl_disp_dev_flush(s_display, target);
}

static TDL_DISP_FRAME_BUFF_T *app_hshh_alloc_frame(uint16_t width, uint16_t height)
{
    const uint32_t frame_length = (uint32_t)width * (uint32_t)height * APP_HSHH_RGB565_BYTES_PER_PIXEL;
    TDL_DISP_FRAME_BUFF_T *frame;

    frame = tdl_disp_create_frame_buff(DISP_FB_TP_PSRAM, frame_length);
    if (frame == NULL) {
        return NULL;
    }
    frame->x_start = 0;
    frame->y_start = 0;
    frame->fmt = TUYA_PIXEL_FMT_RGB565;
    frame->width = width;
    frame->height = height;
    frame->len = frame_length;
    return frame;
}

static TDL_DISP_FRAME_BUFF_T *app_hshh_acquire_panel_frame(void)
{
    if (s_panel_count > 1u) {
        s_panel_index = (uint8_t)((s_panel_index + 1u) % s_panel_count);
    }
    s_panel_frame = s_panel_frames[s_panel_index];
    if (s_info.rotation != TUYA_DISPLAY_ROTATION_0) {
        s_rotated_frame = s_panel_frame;
    }
    return s_panel_frame;
}

static void app_hshh_display_claim_gpio(TUYA_GPIO_NUM_E pin, TUYA_GPIO_LEVEL_E level)
{
    TUYA_GPIO_BASE_CFG_T cfg = {
        .mode = TUYA_GPIO_PUSH_PULL,
        .direct = TUYA_GPIO_OUTPUT,
        .level = level,
    };

    /* tkl_gpio_init unmaps the pad first. tkl_io_pinmux_config(TUYA_GPIO) is a no-op on T5. */
    (void)tkl_gpio_init(pin, &cfg);
    (void)tkl_gpio_write(pin, level);
}

static void app_hshh_display_drive_backlight(void)
{
    /* Keep LCD_RST out of reset. Later Wi-Fi/audio inits remap GPIO6/9. */
    app_hshh_display_claim_gpio(APP_HSHH_DISPLAY_RST_PIN, TUYA_GPIO_LEVEL_HIGH);
    app_hshh_display_claim_gpio(s_bl_pin, s_bl_level);
}

OPERATE_RET app_hshh_display_drive_pin(uint32_t pin, uint8_t level)
{
    if (pin > 55u || pin == 10u || pin == 11u) {
        return OPRT_INVALID_PARM;
    }
    s_bl_pin = (TUYA_GPIO_NUM_E)pin;
    s_bl_level = (level != 0u) ? TUYA_GPIO_LEVEL_HIGH : TUYA_GPIO_LEVEL_LOW;
    app_hshh_display_drive_backlight();
    return OPRT_OK;
}

static void app_hshh_display_wake_panel(void)
{
    DISP_SPI_BASE_CFG_T cfg;

    /* Do not pulse RST / SWRESET here: TDL already ran the full ST7789 seq, and
     * a software reset would drop MADCTL while the SPI driver still caches the
     * window. Just steal GPIO6/9/45/47 back if later inits remapped them. */
    app_hshh_display_claim_gpio(APP_HSHH_DISPLAY_CS_PIN, TUYA_GPIO_LEVEL_HIGH);
    app_hshh_display_claim_gpio(APP_HSHH_DISPLAY_DC_PIN, TUYA_GPIO_LEVEL_HIGH);
    app_hshh_display_drive_backlight();

    memset(&cfg, 0, sizeof(cfg));
    cfg.port = APP_HSHH_DISPLAY_SPI_PORT;
    cfg.cs_pin = APP_HSHH_DISPLAY_CS_PIN;
    cfg.dc_pin = APP_HSHH_DISPLAY_DC_PIN;
    cfg.rst_pin = APP_HSHH_DISPLAY_RST_PIN;
    (void)tdd_disp_spi_send_cmd(&cfg, ST7789_SLPOUT);
    tal_system_sleep(120);
    (void)tdd_disp_spi_send_cmd(&cfg, ST7789_INVON);
    (void)tdd_disp_spi_send_cmd(&cfg, ST7789_DISPON);
    tal_system_sleep(20);
}

static OPERATE_RET app_hshh_display_flush_color(uint16_t color)
{
    TDL_DISP_FRAME_BUFF_T *frame;
    uint16_t pixel = color;
    uint32_t count;
    uint32_t index;
    uint16_t *pixels;

    frame = app_hshh_acquire_panel_frame();
    if (frame == NULL || frame->frame == NULL) {
        return OPRT_INVALID_PARM;
    }
    if (s_info.is_swap) {
        pixel = (uint16_t)((pixel << 8u) | (pixel >> 8u));
    }
    count = (uint32_t)frame->width * (uint32_t)frame->height;
    pixels = (uint16_t *)frame->frame;
    for (index = 0u; index < count; index++) {
        pixels[index] = pixel;
    }
    return tdl_disp_dev_flush(s_display, frame);
}

OPERATE_RET app_hshh_display_init(void)
{
    OPERATE_RET rt;

    if (s_ready) {
        app_hshh_display_drive_backlight();
        TUYA_CALL_ERR_LOG(tdl_disp_set_brightness(s_display, APP_HSHH_DISPLAY_BRIGHTNESS));
        s_last_init_rt = OPRT_OK;
        return OPRT_OK;
    }

    s_display = tdl_disp_find_dev(DISPLAY_NAME);
    if (s_display == NULL) {
        PR_ERR("[HSHH DISPLAY] '%s' was not registered", DISPLAY_NAME);
        s_last_init_rt = OPRT_NOT_FOUND;
        return OPRT_NOT_FOUND;
    }
    memset(&s_info, 0, sizeof(s_info));
    rt = tdl_disp_dev_get_info(s_display, &s_info);
    if (rt != OPRT_OK) {
        s_last_init_rt = rt;
        return rt;
    }
    if (s_info.fmt != TUYA_PIXEL_FMT_RGB565) {
        PR_ERR("[HSHH DISPLAY] RGB565 required, got fmt=%d", s_info.fmt);
        s_last_init_rt = OPRT_NOT_SUPPORTED;
        return OPRT_NOT_SUPPORTED;
    }
    rt = tdl_disp_dev_open(s_display);
    if (rt != OPRT_OK) {
        PR_ERR("[HSHH DISPLAY] open failed, rt=%d", rt);
        s_last_init_rt = rt;
        return rt;
    }
    app_hshh_display_wake_panel();
    TUYA_CALL_ERR_LOG(tdl_disp_set_brightness(s_display, APP_HSHH_DISPLAY_BRIGHTNESS));

    s_panel_frames[0] = app_hshh_alloc_frame(s_info.width, s_info.height);
    if (s_panel_frames[0] == NULL) {
        s_last_init_rt = OPRT_MALLOC_FAILED;
        return OPRT_MALLOC_FAILED;
    }
    s_panel_count = 1u;
    s_panel_index = 0u;
    s_panel_frame = s_panel_frames[0];
    s_panel_frames[1] = app_hshh_alloc_frame(s_info.width, s_info.height);
    if (s_panel_frames[1] != NULL) {
        s_panel_count = 2u;
    }
    if (s_info.rotation != TUYA_DISPLAY_ROTATION_0) {
        s_rotated_frame = s_panel_frame;
        s_source_frame = app_hshh_alloc_frame(APP_HSHH_EXPRESSION_WIDTH, APP_HSHH_EXPRESSION_HEIGHT);
        if (s_source_frame == NULL) {
            tdl_disp_free_frame_buff(s_panel_frames[0]);
            if (s_panel_frames[1] != NULL) {
                tdl_disp_free_frame_buff(s_panel_frames[1]);
            }
            s_panel_frames[0] = NULL;
            s_panel_frames[1] = NULL;
            s_panel_frame = NULL;
            s_rotated_frame = NULL;
            s_panel_count = 0u;
            s_last_init_rt = OPRT_MALLOC_FAILED;
            return OPRT_MALLOC_FAILED;
        }
    } else {
        s_source_frame = s_panel_frame;
    }

    rt = app_hshh_display_flush_color(APP_HSHH_DISPLAY_SPLASH_RGB565);
    if (rt != OPRT_OK) {
        PR_ERR("[HSHH DISPLAY] splash flush failed, rt=%d", rt);
        s_last_init_rt = rt;
        return rt;
    }
    /* SPI flush only queues the framebuffer pointer. Wait so later inits cannot
     * overwrite pixels still on the wire, and GPIO9 cannot be stolen mid-transfer. */
    tal_system_sleep(APP_HSHH_DISPLAY_SPI_SETTLE_MS);
    app_hshh_display_drive_backlight();
    s_ready = true;
    s_frame_index = 0u;
    s_last_frame_ms = 0u;
    s_hold_splash_until_ms = tal_system_get_millisecond() + APP_HSHH_DISPLAY_HOLD_SPLASH_MS;
    s_catalog_valid = app_hshh_validate_catalog();
    s_last_init_rt = OPRT_OK;
    PR_NOTICE("[HSHH DISPLAY] red splash %ux%u rotation=%d catalog=%u pingpong=%u", s_info.width,
              s_info.height, s_info.rotation, s_catalog_valid ? 1u : 0u, s_panel_count);
    return OPRT_OK;
}

OPERATE_RET app_hshh_display_force_lit(void)
{
    OPERATE_RET rt;

    if (!s_ready) {
        rt = app_hshh_display_init();
        if (rt != OPRT_OK) {
            return rt;
        }
    }
    app_hshh_display_wake_panel();
    TUYA_CALL_ERR_LOG(tdl_disp_set_brightness(s_display, APP_HSHH_DISPLAY_BRIGHTNESS));
    rt = app_hshh_display_flush_color(APP_HSHH_DISPLAY_SPLASH_RGB565);
    tal_system_sleep(APP_HSHH_DISPLAY_SPI_SETTLE_MS);
    app_hshh_display_drive_backlight();
    s_hold_splash_until_ms = tal_system_get_millisecond() + APP_HSHH_DISPLAY_HOLD_SPLASH_MS;
    s_last_init_rt = rt;
    return rt;
}

void app_hshh_display_set_expression(app_hshh_expression_t expression)
{
    if ((uint8_t)expression >= APP_HSHH_EXPRESSION_ASSET_COUNT) {
        expression = APP_HSHH_EXPRESSION_CONFUSED;
    }
    if (!s_catalog_valid && expression != APP_HSHH_EXPRESSION_IDLE) {
        expression = APP_HSHH_EXPRESSION_IDLE;
    }
    s_requested_expression = expression;
}

void app_hshh_display_tick(uint32_t now_ms)
{
    OPERATE_RET rt;

    if (!s_ready) {
        return;
    }
    /* GPIO 9 is LCD backlight and also the default I2S1_DOUT / Wi-Fi DEBUG7 pad.
     * Later inits remap it; a GPIO write without unmap leaves the panel dark. */
    app_hshh_display_drive_backlight();
    if (s_hold_splash_until_ms != 0u && (int32_t)(now_ms - s_hold_splash_until_ms) < 0) {
        return;
    }
    s_hold_splash_until_ms = 0u;
    if (!s_catalog_valid) {
        return;
    }
    if (s_requested_expression != s_rendered_expression) {
        s_rendered_expression = s_requested_expression;
        s_frame_index = 0u;
        s_last_frame_ms = 0u;
    }
    if (s_last_frame_ms != 0u &&
        (uint32_t)(now_ms - s_last_frame_ms) < APP_HSHH_DISPLAY_FRAME_INTERVAL_MS) {
        return;
    }
    s_last_frame_ms = now_ms;
    rt = app_hshh_render_asset(s_rendered_expression, s_frame_index);
    if (rt != OPRT_OK) {
        PR_ERR("[HSHH DISPLAY] render %s/%u failed, rt=%d; falling back to idle",
               app_hshh_expression_asset_name((uint8_t)s_rendered_expression),
               (unsigned int)(s_frame_index + 1u), rt);
        s_rendered_expression = APP_HSHH_EXPRESSION_IDLE;
        s_requested_expression = APP_HSHH_EXPRESSION_IDLE;
        s_frame_index = 0u;
        (void)app_hshh_render_asset(APP_HSHH_EXPRESSION_IDLE, 0u);
        return;
    }
    s_frame_index = (uint8_t)((s_frame_index + 1u) % APP_HSHH_EXPRESSION_FRAME_COUNT);
}

app_hshh_expression_t app_hshh_display_current_expression(void)
{
    return s_requested_expression;
}

bool app_hshh_display_is_ready(void)
{
    return s_ready;
}

OPERATE_RET app_hshh_display_last_init_rt(void)
{
    return s_last_init_rt;
}
