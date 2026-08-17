#include "motion_server.h"

#include <ArduinoJson.h>

#include <cstdlib>
#include <cstring>

#include "hmac_auth.h"
#include "time_utils.h"

namespace hshh {
namespace {

constexpr char kProtocolVersion[] = "hshh-lan-v1";
constexpr size_t kMaxRequestBytes = 4096;
constexpr int64_t kMaxClockSkewMs = 5000;
constexpr int64_t kMaxCommandTtlMs = 10000;

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
      "protocol_version", "target",     "command_id", "robot_id",
      "skill",            "issued_at",  "expires_at", "expected_device_state",
  };
  for (const char* allowed : kAllowed) {
    if (strcmp(key, allowed) == 0) return true;
  }
  return false;
}

bool isSkill(const String& value) {
  return value == "stop" || value == "approach_short" ||
         value == "turn_to_user" || value == "invite_hug" ||
         value == "release_hug";
}

bool isSafetyState(const String& value) {
  return value == "ready" || value == "stopped" || value == "fault";
}

bool isEscapeSkill(const String& value) {
  return value == "stop" || value == "release_hug";
}

MotionResult rejected(const char* reasonCode) {
  return MotionResult{String("rejected"), String(reasonCode), String()};
}

}  // namespace

MotionServer::MotionServer(uint16_t port) : server_(port) {}

void MotionServer::begin(const String& sharedSecret, const String& robotId,
                         MotionController& controller) {
  sharedSecret_ = sharedSecret;
  robotId_ = robotId;
  controller_ = &controller;

  static const char* kHeaders[] = {
      "Content-Type",
      "Idempotency-Key",
      "X-HSHH-Timestamp",
      "X-HSHH-Signature",
  };
  server_.collectHeaders(kHeaders, sizeof(kHeaders) / sizeof(kHeaders[0]));
  server_.on("/v1/motion/commands", HTTP_POST,
             [this]() { handleCommand(); });
  server_.on("/v1/motion/status", HTTP_GET, [this]() { handleStatus(); });
  server_.onNotFound([this]() { handleNotFound(); });
  server_.begin();
}

void MotionServer::handleClient() { server_.handleClient(); }

MotionServer::CachedResponse* MotionServer::findCached(
    const String& commandId) {
  for (CachedResponse& cached : cache_) {
    if (cached.commandId == commandId) return &cached;
  }
  return nullptr;
}

void MotionServer::remember(const String& commandId,
                            const String& requestFingerprint,
                            const MotionResult& result) {
  cache_[nextCacheIndex_] = CachedResponse{commandId, requestFingerprint, result};
  nextCacheIndex_ = (nextCacheIndex_ + 1U) %
                    (sizeof(cache_) / sizeof(cache_[0]));
}

void MotionServer::sendError(int httpStatus, const char* code) {
  JsonDocument response;
  response["error"] = code;
  String body;
  serializeJson(response, body);
  server_.send(httpStatus, "application/json", body);
}

void MotionServer::sendSignedJson(int httpStatus, const String& body) {
  const String timestamp = nowUtcIso8601();
  const String signature = hmacSha256Hex(sharedSecret_, timestamp, body);
  server_.sendHeader("Cache-Control", "no-store");
  server_.sendHeader("X-HSHH-Timestamp", timestamp);
  server_.sendHeader("X-HSHH-Signature", signature);
  server_.send(httpStatus, "application/json", body);
}

void MotionServer::sendMotionResponse(const String& commandId,
                                      const MotionResult& result) {
  JsonDocument response;
  response["protocol_version"] = kProtocolVersion;
  response["command_id"] = commandId;
  response["status"] = result.status;
  response["reason_code"] = result.reasonCode;
  response["observed_at"] = nowUtcIso8601();
  response["safety_state"] = controller_->safetyState();
  if (result.activeSkill.length() > 0) {
    response["active_skill"] = result.activeSkill;
  } else {
    response["active_skill"] = nullptr;
  }
  String body;
  serializeJson(response, body);
  sendSignedJson(200, body);
}

void MotionServer::handleCommand() {
  if (controller_ == nullptr || !clockIsTrusted()) {
    sendError(503, "controller_not_ready");
    return;
  }

  const String contentType = server_.header("Content-Type");
  const String timestamp = server_.header("X-HSHH-Timestamp");
  const String suppliedSignature = server_.header("X-HSHH-Signature");
  const String idempotencyKey = server_.header("Idempotency-Key");
  const String body = server_.arg("plain");
  if (!contentType.startsWith("application/json") || body.length() == 0 ||
      body.length() > kMaxRequestBytes || timestamp.length() == 0 ||
      suppliedSignature.length() == 0 || idempotencyKey.length() == 0) {
    sendError(400, "request_invalid");
    return;
  }

  const String expectedSignature =
      hmacSha256Hex(sharedSecret_, timestamp, body);
  if (expectedSignature.length() != 64 ||
      !constantTimeHexEquals(suppliedSignature, expectedSignature)) {
    sendError(401, "request_auth_failed");
    return;
  }

  int64_t timestampMs = 0;
  if (!parseUtcIso8601(timestamp, timestampMs) ||
      llabs(nowEpochMilliseconds() - timestampMs) > kMaxClockSkewMs) {
    sendError(401, "request_timestamp_invalid");
    return;
  }

  JsonDocument request;
  const DeserializationError parseError = deserializeJson(request, body);
  if (parseError || !request.is<JsonObjectConst>()) {
    sendError(400, "request_json_invalid");
    return;
  }
  const JsonObjectConst object = request.as<JsonObjectConst>();
  if (object.size() != 8) {
    sendError(400, "request_schema_invalid");
    return;
  }
  for (JsonPairConst field : object) {
    if (!isAllowedField(field.key().c_str())) {
      sendError(400, "request_schema_invalid");
      return;
    }
  }
  if (!validBoundedString(object["command_id"], 1, 128) ||
      !validBoundedString(object["robot_id"], 1, 128) ||
      !validBoundedString(object["skill"], 1, 32) ||
      !validBoundedString(object["issued_at"], 24, 24) ||
      !validBoundedString(object["expires_at"], 24, 24) ||
      !validBoundedString(object["expected_device_state"], 1, 16) ||
      !object["protocol_version"].is<const char*>() ||
      !object["target"].is<const char*>()) {
    sendError(400, "request_schema_invalid");
    return;
  }

  const String protocol = object["protocol_version"].as<const char*>();
  const String target = object["target"].as<const char*>();
  const String commandId = object["command_id"].as<const char*>();
  const String robotId = object["robot_id"].as<const char*>();
  const String skill = object["skill"].as<const char*>();
  const String issuedAt = object["issued_at"].as<const char*>();
  const String expiresAt = object["expires_at"].as<const char*>();
  const String expectedState =
      object["expected_device_state"].as<const char*>();
  if (protocol != kProtocolVersion || target != "motion_controller" ||
      robotId != robotId_ || commandId != idempotencyKey || !isSkill(skill) ||
      !isSafetyState(expectedState)) {
    sendError(400, "request_schema_invalid");
    return;
  }

  int64_t issuedAtMs = 0;
  int64_t expiresAtMs = 0;
  if (!parseUtcIso8601(issuedAt, issuedAtMs) ||
      !parseUtcIso8601(expiresAt, expiresAtMs) ||
      llabs(issuedAtMs - timestampMs) > kMaxClockSkewMs ||
      expiresAtMs < issuedAtMs ||
      expiresAtMs - issuedAtMs > kMaxCommandTtlMs) {
    sendError(400, "request_time_invalid");
    return;
  }

  const String fingerprint =
      hmacSha256Hex(sharedSecret_, String("idempotency"), body);
  if (CachedResponse* cached = findCached(commandId)) {
    if (cached->requestFingerprint != fingerprint) {
      sendMotionResponse(commandId, rejected("idempotency_conflict"));
      return;
    }
    sendMotionResponse(commandId, cached->result);
    return;
  }

  if (nowEpochMilliseconds() > expiresAtMs && !isEscapeSkill(skill)) {
    const MotionResult expired = rejected("motion_command_expired");
    remember(commandId, fingerprint, expired);
    sendMotionResponse(commandId, expired);
    return;
  }
  if (!isEscapeSkill(skill) && expectedState != controller_->safetyState()) {
    const MotionResult mismatch = rejected("device_state_mismatch");
    remember(commandId, fingerprint, mismatch);
    sendMotionResponse(commandId, mismatch);
    return;
  }

  const MotionResult result = controller_->execute(skill, millis());
  remember(commandId, fingerprint, result);
  sendMotionResponse(commandId, result);
}

void MotionServer::handleStatus() {
  if (controller_ == nullptr || !clockIsTrusted()) {
    sendError(503, "controller_not_ready");
    return;
  }
  JsonDocument response;
  response["protocol_version"] = kProtocolVersion;
  response["observed_at"] = nowUtcIso8601();
  response["safety_state"] = controller_->safetyState();
  response["motion_stopped"] = controller_->motionStopped();
  response["motor_ready"] = controller_->motorReady();
  response["servo_ready"] = controller_->servoReady();
  if (controller_->activeSkill().length() > 0) {
    response["active_skill"] = controller_->activeSkill();
  } else {
    response["active_skill"] = nullptr;
  }
  const MotorPinSnapshot pins = controller_->motorPins();
  response["drive_mode"] = pins.driveMode;
  response["drive_left"] = pins.leftPercent;
  response["drive_right"] = pins.rightPercent;
  response["in1"] = pins.in1;
  response["in2"] = pins.in2;
  response["in3"] = pins.in3;
  response["in4"] = pins.in4;
  String body;
  serializeJson(response, body);
  sendSignedJson(200, body);
}

void MotionServer::handleNotFound() { sendError(404, "not_found"); }

}  // namespace hshh

