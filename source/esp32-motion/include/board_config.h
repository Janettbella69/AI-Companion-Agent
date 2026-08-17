#pragma once

#include <Arduino.h>

#ifndef HSHH_MAX_MOTOR_PERCENT
#define HSHH_MAX_MOTOR_PERCENT 60
#endif

#ifndef HSHH_MOTOR_BRAKE_MS
#define HSHH_MOTOR_BRAKE_MS 80
#endif

#ifndef HSHH_ENABLE_SERVO
#define HSHH_ENABLE_SERVO 0
#endif

#ifndef HSHH_ALLOW_UNSENSORED_MOTION
#define HSHH_ALLOW_UNSENSORED_MOTION 0
#endif

#ifndef HSHH_ENABLE_SERIAL_BENCH
#define HSHH_ENABLE_SERIAL_BENCH 0
#endif

namespace hshh {
namespace board {

constexpr uint8_t kMotorAIn1Pin = 10;
constexpr uint8_t kMotorAIn2Pin = 11;
constexpr uint8_t kMotorBIn3Pin = 12;
constexpr uint8_t kMotorBIn4Pin = 13;
constexpr uint8_t kServoSignalPin = 17;

constexpr uint8_t kMotorAIn1Channel = 0;
constexpr uint8_t kMotorAIn2Channel = 1;
constexpr uint8_t kMotorBIn3Channel = 2;
constexpr uint8_t kMotorBIn4Channel = 3;
constexpr uint8_t kServoChannel = 4;

// TC1508 VINH is 2.0 V. 20 kHz at 30% produced no motion; GPIO 3.3 V full-on
// did. 1 kHz lets each high pulse sit above VINH long enough to switch.
constexpr uint32_t kMotorPwmHz = 1000;
constexpr uint8_t kMotorPwmBits = 8;
constexpr uint32_t kServoPwmHz = 50;
constexpr uint8_t kServoPwmBits = 14;

constexpr uint32_t kMotionHeartbeatTimeoutMs = 4000;
constexpr uint32_t kApproachDurationMs = 3000;
constexpr uint32_t kTurnDurationMs = 400;
constexpr uint32_t kMaxBenchDurationMs = 300;
constexpr uint32_t kBenchArmWindowMs = 30000;

constexpr int kServoReleaseAngle = 35;
constexpr int kServoInviteAngle = 110;

static_assert(HSHH_MAX_MOTOR_PERCENT > 0 && HSHH_MAX_MOTOR_PERCENT <= 70,
              "Unsensored bring-up motor limit must remain between 1% and 70%");
static_assert(HSHH_MOTOR_BRAKE_MS > 0 && HSHH_MOTOR_BRAKE_MS <= 150,
              "MX1508 dynamic brake must remain short and bounded");

}  // namespace board
}  // namespace hshh
