#include "mx1508_driver.h"

#include <esp_arduino_version.h>

#include "board_config.h"

namespace hshh {
namespace {

constexpr uint32_t kMaxDuty = (1U << board::kMotorPwmBits) - 1U;

int clampPercent(int value) {
  if (value > HSHH_MAX_MOTOR_PERCENT) return HSHH_MAX_MOTOR_PERCENT;
  if (value < -HSHH_MAX_MOTOR_PERCENT) return -HSHH_MAX_MOTOR_PERCENT;
  return value;
}

uint32_t percentToDuty(int percent) {
  const int magnitude = percent < 0 ? -percent : percent;
  return static_cast<uint32_t>(magnitude) * kMaxDuty / 100U;
}

}  // namespace

bool Mx1508Driver::attachPwm(uint8_t pin, uint8_t channel) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  return ledcAttachChannel(pin, board::kMotorPwmHz, board::kMotorPwmBits,
                           channel);
#else
  const double configured =
      ledcSetup(channel, board::kMotorPwmHz, board::kMotorPwmBits);
  if (configured <= 0.0) return false;
  ledcAttachPin(pin, channel);
  return true;
#endif
}

void Mx1508Driver::writeOutput(uint8_t pin, uint8_t channel, uint32_t duty) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(pin, duty);
#else
  (void)pin;
  ledcWrite(channel, duty);
#endif
}

bool Mx1508Driver::begin() {
  const uint8_t pins[] = {
      board::kMotorAIn1Pin,
      board::kMotorAIn2Pin,
      board::kMotorBIn3Pin,
      board::kMotorBIn4Pin,
  };
  const uint8_t channels[] = {
      board::kMotorAIn1Channel,
      board::kMotorAIn2Channel,
      board::kMotorBIn3Channel,
      board::kMotorBIn4Channel,
  };

  // Load the output latch with LOW before changing direction to prevent a
  // startup pulse on any MX1508 input.
  for (uint8_t pin : pins) {
    digitalWrite(pin, LOW);
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }

  ready_ = true;
  for (size_t index = 0; index < sizeof(pins); ++index) {
    if (!attachPwm(pins[index], channels[index])) {
      ready_ = false;
    }
  }
  coastAll();
  return ready_;
}

bool Mx1508Driver::ready() const { return ready_; }

void Mx1508Driver::setMotor(uint8_t forwardPin, uint8_t forwardChannel,
                            uint8_t reversePin, uint8_t reverseChannel,
                            int percent) {
  const int limited = clampPercent(percent);
  if (limited > 0) {
    writeOutput(reversePin, reverseChannel, 0);
    writeOutput(forwardPin, forwardChannel, percentToDuty(limited));
    return;
  }
  if (limited < 0) {
    writeOutput(forwardPin, forwardChannel, 0);
    writeOutput(reversePin, reverseChannel, percentToDuty(limited));
    return;
  }
  writeOutput(forwardPin, forwardChannel, 0);
  writeOutput(reversePin, reverseChannel, 0);
}

void Mx1508Driver::drive(int leftPercent, int rightPercent) {
  if (!ready_) return;
  lastLeftPercent_ = clampPercent(leftPercent);
  lastRightPercent_ = clampPercent(rightPercent);
  setMotor(board::kMotorAIn1Pin, board::kMotorAIn1Channel,
           board::kMotorAIn2Pin, board::kMotorAIn2Channel, leftPercent);
  setMotor(board::kMotorBIn3Pin, board::kMotorBIn3Channel,
           board::kMotorBIn4Pin, board::kMotorBIn4Channel, rightPercent);
}

void Mx1508Driver::brakeAll() {
  if (!ready_) return;
  lastLeftPercent_ = 0;
  lastRightPercent_ = 0;
  writeOutput(board::kMotorAIn1Pin, board::kMotorAIn1Channel, kMaxDuty);
  writeOutput(board::kMotorAIn2Pin, board::kMotorAIn2Channel, kMaxDuty);
  writeOutput(board::kMotorBIn3Pin, board::kMotorBIn3Channel, kMaxDuty);
  writeOutput(board::kMotorBIn4Pin, board::kMotorBIn4Channel, kMaxDuty);
}

void Mx1508Driver::coastAll() {
  lastLeftPercent_ = 0;
  lastRightPercent_ = 0;
  writeOutput(board::kMotorAIn1Pin, board::kMotorAIn1Channel, 0);
  writeOutput(board::kMotorAIn2Pin, board::kMotorAIn2Channel, 0);
  writeOutput(board::kMotorBIn3Pin, board::kMotorBIn3Channel, 0);
  writeOutput(board::kMotorBIn4Pin, board::kMotorBIn4Channel, 0);
}

MotorPinSnapshot Mx1508Driver::snapshot() const {
  MotorPinSnapshot pins;
  pins.in1 = digitalRead(board::kMotorAIn1Pin);
  pins.in2 = digitalRead(board::kMotorAIn2Pin);
  pins.in3 = digitalRead(board::kMotorBIn3Pin);
  pins.in4 = digitalRead(board::kMotorBIn4Pin);
  pins.leftPercent = lastLeftPercent_;
  pins.rightPercent = lastRightPercent_;
  pins.driveMode = "pwm";
  return pins;
}

}  // namespace hshh

