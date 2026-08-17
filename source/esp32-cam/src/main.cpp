#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_camera.h>

#include <cstdlib>
#include <cstring>

#include "hmac_auth.h"
#include "hshh_lan_secrets.h"
#include "time_utils.h"

#ifndef HSHH_LAN_WIFI_SSID
#error "HSHH_LAN_WIFI_SSID is required"
#endif

#ifndef HSHH_LAN_WIFI_PASSWORD
#error "HSHH_LAN_WIFI_PASSWORD is required"
#endif

#ifndef HSHH_LAN_CAMERA_SHARED_SECRET
#error "HSHH_LAN_CAMERA_SHARED_SECRET is required and must differ from the motion secret"
#endif

#ifndef HSHH_LAN_ROBOT_ID
#error "HSHH_LAN_ROBOT_ID is required"
#endif

#ifndef HSHH_LAN_CAMERA_PORT
#define HSHH_LAN_CAMERA_PORT 80
#endif

static_assert(sizeof(HSHH_LAN_CAMERA_SHARED_SECRET) >= 33,
              "HSHH_LAN_CAMERA_SHARED_SECRET must contain at least 32 characters");

namespace {

constexpr char kHostname[] = "hshh-camera";
constexpr char kProtocolVersion[] = "hshh-lan-v1";
constexpr uint32_t kConnectTimeoutMs = 30000;
constexpr uint32_t kReconnectIntervalMs = 5000;
constexpr uint32_t kCaptureRateLimitMs = 1000;
constexpr size_t kMaxRequestBytes = 2048;
constexpr size_t kReplayCacheSize = 12;
constexpr int64_t kMaxClockSkewMs = 5000;
constexpr int64_t kMaxCaptureTtlMs = 10000;

// AI Thinker ESP32-CAM / OV2640 pin map confirmed by the user-supplied
// datasheet. No unconfirmed external sensor pins are used here.
constexpr int kPinPwdn = 32;
constexpr int kPinReset = -1;
constexpr int kPinXclk = 0;
constexpr int kPinSiod = 26;
constexpr int kPinSioc = 27;
constexpr int kPinY9 = 35;
constexpr int kPinY8 = 34;
constexpr int kPinY7 = 39;
constexpr int kPinY6 = 36;
constexpr int kPinY5 = 21;
constexpr int kPinY4 = 19;
constexpr int kPinY3 = 18;
constexpr int kPinY2 = 5;
constexpr int kPinVsync = 25;
constexpr int kPinHref = 23;
constexpr int kPinPclk = 22;

WebServer g_server(HSHH_LAN_CAMERA_PORT);
bool g_camera_ready = false;
bool g_mdns_ready = false;
uint16_t g_sensor_pid = 0;
pixformat_t g_pixel_format = PIXFORMAT_JPEG;
uint32_t g_last_reconnect_ms = 0;
uint32_t g_last_capture_ms = 0;
String g_seen_capture_ids[kReplayCacheSize];
size_t g_next_replay_slot = 0;

bool validBoundedString(JsonVariantConst value, size_t minimum,
                        size_t maximum) {
  if (!value.is<const char*>()) return false;
  const char* text = value.as<const char*>();
  if (text == nullptr) return false;
  const size_t length = strlen(text);
  return length >= minimum && length <= maximum;
}

bool isAllowedField(const char* key) {
  static constexpr const char* kAllowed[] = {
      "capture_id", "robot_id", "issued_at", "expires_at", "trigger_reason",
  };
  for (const char* allowed : kAllowed) {
    if (strcmp(key, allowed) == 0) return true;
  }
  return false;
}

bool isTriggerReason(const String& value) {
  return value == "presence_event" || value == "user_request" ||
         value == "diagnostic";
}

bool replaySeen(const String& captureId) {
  for (const String& seen : g_seen_capture_ids) {
    if (seen == captureId) return true;
  }
  return false;
}

void rememberCapture(const String& captureId) {
  g_seen_capture_ids[g_next_replay_slot] = captureId;
  g_next_replay_slot = (g_next_replay_slot + 1U) % kReplayCacheSize;
}

void sendSignedJpeg(const String& captureId, const String& triggerReason,
                    const uint8_t* jpeg, size_t jpegLen);

void sendError(int httpStatus, const char* code) {
  JsonDocument response;
  response["error"] = code;
  String body;
  serializeJson(response, body);
  g_server.sendHeader("Cache-Control", "no-store");
  g_server.send(httpStatus, "application/json", body);
}

void sendSignedJson(int httpStatus, const String& body) {
  const String timestamp = hshh::nowUtcIso8601();
  const String signature = hshh::hmacSha256Hex(
      HSHH_LAN_CAMERA_SHARED_SECRET, timestamp, body);
  g_server.sendHeader("Cache-Control", "no-store");
  g_server.sendHeader("X-HSHH-Timestamp", timestamp);
  g_server.sendHeader("X-HSHH-Signature", signature);
  g_server.send(httpStatus, "application/json", body);
}

bool requestSignatureIsValid(const String& body) {
  if (!hshh::clockIsTrusted()) {
    sendError(503, "camera_clock_not_ready");
    return false;
  }

  const String timestamp = g_server.header("X-HSHH-Timestamp");
  const String suppliedSignature = g_server.header("X-HSHH-Signature");
  if (timestamp.length() == 0 || suppliedSignature.length() == 0) {
    sendError(400, "request_invalid");
    return false;
  }

  const String expectedSignature = hshh::hmacSha256Hex(
      HSHH_LAN_CAMERA_SHARED_SECRET, timestamp, body);
  if (expectedSignature.length() != 64 ||
      !hshh::constantTimeHexEquals(suppliedSignature, expectedSignature)) {
    sendError(401, "request_auth_failed");
    return false;
  }

  int64_t timestampMs = 0;
  if (!hshh::parseUtcIso8601(timestamp, timestampMs) ||
      llabs(hshh::nowEpochMilliseconds() - timestampMs) > kMaxClockSkewMs) {
    sendError(401, "request_timestamp_invalid");
    return false;
  }
  return true;
}

const char* pixelFormatName(pixformat_t format) {
  switch (format) {
    case PIXFORMAT_JPEG:
      return "jpeg";
    case PIXFORMAT_RGB565:
      return "rgb565";
    case PIXFORMAT_YUV422:
      return "yuv422";
    case PIXFORMAT_GRAYSCALE:
      return "grayscale";
    default:
      return "other";
  }
}

void fillCameraPins(camera_config_t* config) {
  config->ledc_channel = LEDC_CHANNEL_0;
  config->ledc_timer = LEDC_TIMER_0;
  config->pin_d0 = kPinY2;
  config->pin_d1 = kPinY3;
  config->pin_d2 = kPinY4;
  config->pin_d3 = kPinY5;
  config->pin_d4 = kPinY6;
  config->pin_d5 = kPinY7;
  config->pin_d6 = kPinY8;
  config->pin_d7 = kPinY9;
  config->pin_xclk = kPinXclk;
  config->pin_pclk = kPinPclk;
  config->pin_vsync = kPinVsync;
  config->pin_href = kPinHref;
  config->pin_sccb_sda = kPinSiod;
  config->pin_sccb_scl = kPinSioc;
  config->pin_pwdn = kPinPwdn;
  config->pin_reset = kPinReset;
}

bool tryInitCamera(pixformat_t format, int xclkHz, framesize_t frameSize,
                   int fbCount, const char* label) {
  (void)esp_camera_deinit();
  delay(80);

  camera_config_t config = {};
  fillCameraPins(&config);
  config.xclk_freq_hz = xclkHz;
  config.pixel_format = format;
  config.frame_size = frameSize;
  config.jpeg_quality = 12;
  config.fb_count = fbCount;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;

  Serial.printf("Camera try %s\n", label);
  const esp_err_t error = esp_camera_init(&config);
  if (error != ESP_OK) {
    Serial.printf("Camera init failed: 0x%04x (%s)\n",
                  static_cast<unsigned int>(error), label);
    return false;
  }

  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor != nullptr) {
    g_sensor_pid = sensor->id.PID;
    sensor->set_framesize(sensor, frameSize);
    if (sensor->id.PID == OV3660_PID) {
      sensor->set_vflip(sensor, 1);
      sensor->set_brightness(sensor, 1);
      sensor->set_saturation(sensor, -2);
    }
  }

  camera_fb_t* warmup = esp_camera_fb_get();
  if (warmup == nullptr) {
    Serial.printf("Camera warmup frame missing (%s)\n", label);
    (void)esp_camera_deinit();
    return false;
  }
  Serial.printf("Warmup frame: %ux%u %s %u bytes\n", warmup->width,
                warmup->height, pixelFormatName(warmup->format),
                static_cast<unsigned int>(warmup->len));
  esp_camera_fb_return(warmup);

  g_pixel_format = format;
  Serial.printf("Camera ready, sensor PID: 0x%04x, PSRAM: %s, format: %s\n",
                g_sensor_pid, psramFound() ? "yes" : "no",
                pixelFormatName(format));
  return true;
}

bool initCamera() {
  Serial.printf("PSRAM: %s\n", psramFound() ? "yes" : "no");
  const bool psram = psramFound();
  const framesize_t jpegSize = psram ? FRAMESIZE_VGA : FRAMESIZE_QVGA;
  if (tryInitCamera(PIXFORMAT_JPEG, 20000000, jpegSize, psram ? 2 : 1,
                    "jpeg-20mhz") ||
      tryInitCamera(PIXFORMAT_JPEG, 10000000, jpegSize, 1, "jpeg-10mhz") ||
      tryInitCamera(PIXFORMAT_JPEG, 10000000, FRAMESIZE_QVGA, 1,
                    "jpeg-10mhz-qvga") ||
      tryInitCamera(PIXFORMAT_RGB565, 10000000, FRAMESIZE_QVGA, 1,
                    "rgb565-10mhz-qvga") ||
      tryInitCamera(PIXFORMAT_YUV422, 10000000, FRAMESIZE_QVGA, 1,
                    "yuv422-10mhz-qvga")) {
    return true;
  }
  Serial.println("Camera init exhausted all format fallbacks");
  return false;
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(kHostname);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(HSHH_LAN_WIFI_SSID, HSHH_LAN_WIFI_PASSWORD);

  Serial.print("Connecting to Wi-Fi");
  const uint32_t startedMs = millis();
  while (WiFi.status() != WL_CONNECTED &&
         millis() - startedMs < kConnectTimeoutMs) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("ESP32-CAM IP: ");
    Serial.println(WiFi.localIP());
    configTime(0, 0, "pool.ntp.org", "time.cloudflare.com", "time.google.com");
    g_mdns_ready = MDNS.begin(kHostname);
    if (g_mdns_ready) MDNS.addService("http", "tcp", HSHH_LAN_CAMERA_PORT);
  } else {
    Serial.println("Wi-Fi connect timed out; background reconnect remains enabled");
  }
}

void handleHealth() {
  String body = F("{\"service\":\"hshh-camera\",\"ready\":");
  body += (g_camera_ready && hshh::clockIsTrusted()) ? F("true") : F("false");
  body += F("}");
  g_server.sendHeader("Cache-Control", "no-store");
  g_server.send(200, "application/json", body);
}

void handleStatus() {
  if (!requestSignatureIsValid(String())) return;

  JsonDocument response;
  response["protocol_version"] = kProtocolVersion;
  response["observed_at"] = hshh::nowUtcIso8601();
  response["camera_ready"] = g_camera_ready;
  response["clock_trusted"] = hshh::clockIsTrusted();
  response["sensor_pid"] = g_sensor_pid;
  response["pixel_format"] = pixelFormatName(g_pixel_format);
  response["psram"] = psramFound();
  response["wifi_connected"] = WiFi.status() == WL_CONNECTED;
  String body;
  serializeJson(response, body);
  sendSignedJson(200, body);
}

void handleCapture() {
  if (!g_camera_ready) {
    sendError(503, "camera_not_ready");
    return;
  }

  const String contentType = g_server.header("Content-Type");
  const String idempotencyKey = g_server.header("Idempotency-Key");
  const String body = g_server.arg("plain");
  if (!contentType.startsWith("application/json") || body.length() == 0 ||
      body.length() > kMaxRequestBytes || idempotencyKey.length() == 0) {
    sendError(400, "request_invalid");
    return;
  }
  if (!requestSignatureIsValid(body)) return;

  JsonDocument request;
  const DeserializationError parseError = deserializeJson(request, body);
  if (parseError || !request.is<JsonObjectConst>()) {
    sendError(400, "request_json_invalid");
    return;
  }
  const JsonObjectConst object = request.as<JsonObjectConst>();
  if (object.size() != 5) {
    sendError(400, "request_schema_invalid");
    return;
  }
  for (JsonPairConst field : object) {
    if (!isAllowedField(field.key().c_str())) {
      sendError(400, "request_schema_invalid");
      return;
    }
  }
  if (!validBoundedString(object["capture_id"], 1, 128) ||
      !validBoundedString(object["robot_id"], 1, 128) ||
      !validBoundedString(object["issued_at"], 24, 24) ||
      !validBoundedString(object["expires_at"], 24, 24) ||
      !validBoundedString(object["trigger_reason"], 1, 32)) {
    sendError(400, "request_schema_invalid");
    return;
  }

  const String captureId = object["capture_id"].as<const char*>();
  const String robotId = object["robot_id"].as<const char*>();
  const String issuedAt = object["issued_at"].as<const char*>();
  const String expiresAt = object["expires_at"].as<const char*>();
  const String triggerReason = object["trigger_reason"].as<const char*>();
  if (captureId != idempotencyKey || robotId != HSHH_LAN_ROBOT_ID ||
      !isTriggerReason(triggerReason)) {
    sendError(400, "request_schema_invalid");
    return;
  }

  int64_t issuedAtMs = 0;
  int64_t expiresAtMs = 0;
  const String signedTimestamp = g_server.header("X-HSHH-Timestamp");
  int64_t signedTimestampMs = 0;
  if (!hshh::parseUtcIso8601(issuedAt, issuedAtMs) ||
      !hshh::parseUtcIso8601(expiresAt, expiresAtMs) ||
      !hshh::parseUtcIso8601(signedTimestamp, signedTimestampMs) ||
      llabs(issuedAtMs - signedTimestampMs) > kMaxClockSkewMs ||
      expiresAtMs < issuedAtMs || expiresAtMs - issuedAtMs > kMaxCaptureTtlMs ||
      hshh::nowEpochMilliseconds() > expiresAtMs) {
    sendError(400, "request_time_invalid");
    return;
  }
  if (replaySeen(captureId)) {
    sendError(409, "capture_replayed");
    return;
  }
  if (g_last_capture_ms != 0 &&
      millis() - g_last_capture_ms < kCaptureRateLimitMs) {
    sendError(429, "capture_rate_limited");
    return;
  }
  g_last_capture_ms = millis();

  // Discard the currently queued frame, then request a new one. A failure never
  // falls back to an earlier JPEG.
  camera_fb_t* stale = esp_camera_fb_get();
  if (stale != nullptr) esp_camera_fb_return(stale);
  delay(40);
  camera_fb_t* frame = esp_camera_fb_get();
  if (frame == nullptr || frame->len == 0) {
    if (frame != nullptr) esp_camera_fb_return(frame);
    sendError(500, "capture_failed");
    return;
  }

  rememberCapture(captureId);
  if (frame->format == PIXFORMAT_JPEG) {
    sendSignedJpeg(captureId, triggerReason, frame->buf, frame->len);
    esp_camera_fb_return(frame);
    return;
  }

  uint8_t* jpeg = nullptr;
  size_t jpegLen = 0;
  const bool converted = frame2jpg(frame, 12, &jpeg, &jpegLen);
  esp_camera_fb_return(frame);
  if (!converted || jpeg == nullptr || jpegLen == 0) {
    if (jpeg != nullptr) free(jpeg);
    sendError(500, "capture_failed");
    return;
  }
  sendSignedJpeg(captureId, triggerReason, jpeg, jpegLen);
  free(jpeg);
}

void sendSignedJpeg(const String& captureId, const String& triggerReason,
                    const uint8_t* jpeg, size_t jpegLen) {
  const String responseTimestamp = hshh::nowUtcIso8601();
  const String responseSignature = hshh::hmacSha256Hex(
      HSHH_LAN_CAMERA_SHARED_SECRET, responseTimestamp, jpeg, jpegLen);
  g_server.sendHeader("Cache-Control", "no-store");
  g_server.sendHeader("Content-Disposition", "inline; filename=capture.jpg");
  g_server.sendHeader("X-HSHH-Capture-Id", captureId);
  g_server.sendHeader("X-HSHH-Observed-At", responseTimestamp);
  g_server.sendHeader("X-HSHH-Timestamp", responseTimestamp);
  g_server.sendHeader("X-HSHH-Signature", responseSignature);
  g_server.send_P(200, PSTR("image/jpeg"),
                  reinterpret_cast<const char*>(jpeg), jpegLen);
  Serial.printf("Signed JPEG capture sent: %u bytes, reason=%s\n",
                static_cast<unsigned int>(jpegLen), triggerReason.c_str());
}

void registerHttpRoutes() {
  static const char* kHeaders[] = {
      "Content-Type",       "Idempotency-Key", "X-HSHH-Timestamp",
      "X-HSHH-Signature",
  };
  g_server.collectHeaders(kHeaders, sizeof(kHeaders) / sizeof(kHeaders[0]));
  g_server.on("/healthz", HTTP_GET, handleHealth);
  g_server.on("/v1/camera/status", HTTP_GET, handleStatus);
  g_server.on("/v1/camera/captures", HTTP_POST, handleCapture);
  g_server.onNotFound([]() { sendError(404, "not_found"); });
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("HSHH ESP32-CAM boot");

  g_camera_ready = initCamera();
  connectWiFi();
  registerHttpRoutes();
  g_server.begin();
  Serial.println("Signed camera HTTP service started");
}

void loop() {
  g_server.handleClient();

  if (WiFi.status() != WL_CONNECTED &&
      millis() - g_last_reconnect_ms >= kReconnectIntervalMs) {
    g_last_reconnect_ms = millis();
    WiFi.reconnect();
  }

  delay(2);
}
