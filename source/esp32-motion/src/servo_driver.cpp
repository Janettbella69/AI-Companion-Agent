#include "servo_driver.h"

#include <esp_arduino_version.h>

#include "board_config.h"

namespace hshh {
namespace {

constexpr uint32_t kServoPeriodUs = 20000;
constexpr uint32_t kServoMinPulseUs = 500;
constexpr uint32_t kServoMaxPulseUs = 2500;
constexpr uint32_t kServoMaxDuty = (1U << board::kServoPwmBits) - 1U;

}  // namespace

void ServoDriver::writeDuty(uint32_t duty) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(board::kServoSignalPin, duty);
#else
  ledcWrite(board::kServoChannel, duty);
#endif
}

bool ServoDriver::begin() {
#if HSHH_ENABLE_SERVO
  digitalWrite(board::kServoSignalPin, LOW);
  pinMode(board::kServoSignalPin, OUTPUT);
  digitalWrite(board::kServoSignalPin, LOW);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ready_ = ledcAttachChannel(board::kServoSignalPin, board::kServoPwmHz,
                             board::kServoPwmBits, board::kServoChannel);
#else
  ready_ = ledcSetup(board::kServoChannel, board::kServoPwmHz,
                     board::kServoPwmBits) > 0.0;
  if (ready_) {
    ledcAttachPin(board::kServoSignalPin, board::kServoChannel);
  }
#endif
  if (ready_) writeDuty(0);
#else
  ready_ = false;
#endif
  return ready_;
}

bool ServoDriver::ready() const { return ready_; }

bool ServoDriver::writeAngle(int angle) {
  if (!ready_) return false;
  if (angle < 0) angle = 0;
  if (angle > 180) angle = 180;
  const uint32_t pulseUs =
      kServoMinPulseUs +
      static_cast<uint32_t>(angle) * (kServoMaxPulseUs - kServoMinPulseUs) /
          180U;
  writeDuty(pulseUs * kServoMaxDuty / kServoPeriodUs);
  return true;
}

void ServoDriver::disable() {
  if (!ready_) return;
  writeDuty(0);
}

}  // namespace hshh

