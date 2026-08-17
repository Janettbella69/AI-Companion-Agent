#pragma once

#include <Arduino.h>
#include <WebServer.h>

#include "motion_controller.h"

namespace hshh {

class MotionServer {
 public:
  explicit MotionServer(uint16_t port = 80);

  void begin(const String& sharedSecret, const String& robotId,
             MotionController& controller);
  void handleClient();

 private:
  struct CachedResponse {
    String commandId;
    String requestFingerprint;
    MotionResult result;
  };

  void handleCommand();
  void handleStatus();
  void handleNotFound();
  void sendError(int httpStatus, const char* code);
  void sendMotionResponse(const String& commandId, const MotionResult& result);
  void sendSignedJson(int httpStatus, const String& body);
  CachedResponse* findCached(const String& commandId);
  void remember(const String& commandId, const String& requestFingerprint,
                const MotionResult& result);

  WebServer server_;
  String sharedSecret_;
  String robotId_;
  MotionController* controller_ = nullptr;
  CachedResponse cache_[8]{};
  size_t nextCacheIndex_ = 0;
};

}  // namespace hshh

