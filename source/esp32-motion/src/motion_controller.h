#pragma once

#include <Arduino.h>

#include "mx1508_driver.h"
#include "servo_driver.h"

namespace hshh {

struct MotionResult {
  String status;
  String reasonCode;
  String activeSkill;
};

class MotionController {
 public:
  void begin(Mx1508Driver& motors, ServoDriver& servo);
  void tick(uint32_t nowMs);

  MotionResult execute(const String& skill, uint32_t nowMs);
  bool runBench(int leftPercent, int rightPercent, uint32_t durationMs,
                uint32_t nowMs);
  void requestStop(uint32_t nowMs);
  void setSensorsHealthy(bool healthy);

  const char* safetyState() const;
  const String& activeSkill() const;
  bool motionStopped() const;
  bool motorReady() const;
  bool servoReady() const;
  MotorPinSnapshot motorPins() const;

 private:
  void startTimedMotion(const String& skill, int leftPercent,
                        int rightPercent, uint32_t durationMs,
                        uint32_t nowMs);

  Mx1508Driver* motors_ = nullptr;
  ServoDriver* servo_ = nullptr;
  String activeSkill_;
  bool sensorsHealthy_ = false;
  bool fault_ = true;
  bool motorActive_ = false;
  bool braking_ = false;
  uint32_t brakeDeadlineMs_ = 0;
  uint32_t motionDeadlineMs_ = 0;
  uint32_t heartbeatDeadlineMs_ = 0;
};

}  // namespace hshh

