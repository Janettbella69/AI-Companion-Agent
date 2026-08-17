#include "motion_controller.h"

#include "board_config.h"

namespace hshh {
namespace {

bool deadlineReached(uint32_t nowMs, uint32_t deadlineMs) {
  return static_cast<int32_t>(nowMs - deadlineMs) >= 0;
}

MotionResult result(const char* status, const char* reasonCode,
                    const String& activeSkill = String()) {
  return MotionResult{String(status), String(reasonCode), activeSkill};
}

}  // namespace

void MotionController::begin(Mx1508Driver& motors, ServoDriver& servo) {
  motors_ = &motors;
  servo_ = &servo;
  fault_ = !motors.ready();
  activeSkill_ = String();
  motorActive_ = false;
  braking_ = false;
  motors.coastAll();
}

void MotionController::setSensorsHealthy(bool healthy) {
  sensorsHealthy_ = healthy;
  if (!healthy && motorActive_) requestStop(millis());
}

void MotionController::requestStop(uint32_t nowMs) {
  activeSkill_ = String();
  motorActive_ = false;
  motionDeadlineMs_ = 0;
  heartbeatDeadlineMs_ = 0;
  if (motors_ == nullptr || !motors_->ready()) {
    fault_ = true;
    return;
  }
  motors_->brakeAll();
  braking_ = true;
  brakeDeadlineMs_ = nowMs + HSHH_MOTOR_BRAKE_MS;
}

void MotionController::startTimedMotion(const String& skill, int leftPercent,
                                        int rightPercent,
                                        uint32_t durationMs,
                                        uint32_t nowMs) {
  braking_ = false;
  motors_->drive(leftPercent, rightPercent);
  activeSkill_ = skill;
  motorActive_ = true;
  motionDeadlineMs_ = nowMs + durationMs;
  heartbeatDeadlineMs_ = nowMs + board::kMotionHeartbeatTimeoutMs;
}

MotionResult MotionController::execute(const String& skill, uint32_t nowMs) {
  if (skill == "stop") {
    requestStop(nowMs);
    return result("stopped", "local_stop_applied");
  }
  if (skill == "release_hug") {
    requestStop(nowMs);
    if (servo_ != nullptr && servo_->ready()) {
      servo_->writeAngle(board::kServoReleaseAngle);
      return result("stopped", "local_release_applied");
    }
    return result("stopped", "local_stop_applied_servo_unavailable");
  }
  if (fault_ || motors_ == nullptr || !motors_->ready()) {
    return result("rejected", "motor_driver_fault");
  }
  if (!sensorsHealthy_ && !HSHH_ALLOW_UNSENSORED_MOTION) {
    return result("rejected", "safety_sensors_unavailable");
  }
  if (skill == "approach_short") {
    startTimedMotion(skill, HSHH_MAX_MOTOR_PERCENT, HSHH_MAX_MOTOR_PERCENT,
                     board::kApproachDurationMs, nowMs);
    return result("accepted", "motion_command_accepted", skill);
  }
  if (skill == "turn_to_user") {
    startTimedMotion(skill, HSHH_MAX_MOTOR_PERCENT, -HSHH_MAX_MOTOR_PERCENT,
                     board::kTurnDurationMs, nowMs);
    return result("accepted", "motion_command_accepted", skill);
  }
  if (skill == "invite_hug") {
    requestStop(nowMs);
    if (servo_ == nullptr || !servo_->ready()) {
      return result("rejected", "servo_unavailable");
    }
    servo_->writeAngle(board::kServoInviteAngle);
    activeSkill_ = skill;
    return result("accepted", "motion_command_accepted", skill);
  }
  return result("rejected", "motion_skill_unsupported");
}

bool MotionController::runBench(int leftPercent, int rightPercent,
                                uint32_t durationMs, uint32_t nowMs) {
#if HSHH_ENABLE_SERIAL_BENCH
  if (fault_ || motors_ == nullptr || !motors_->ready() || durationMs == 0 ||
      durationMs > board::kMaxBenchDurationMs) {
    return false;
  }
  if (leftPercent > HSHH_MAX_MOTOR_PERCENT ||
      leftPercent < -HSHH_MAX_MOTOR_PERCENT ||
      rightPercent > HSHH_MAX_MOTOR_PERCENT ||
      rightPercent < -HSHH_MAX_MOTOR_PERCENT) {
    return false;
  }
  startTimedMotion("bench", leftPercent, rightPercent, durationMs, nowMs);
  return true;
#else
  (void)leftPercent;
  (void)rightPercent;
  (void)durationMs;
  (void)nowMs;
  return false;
#endif
}

void MotionController::tick(uint32_t nowMs) {
  if (braking_ && deadlineReached(nowMs, brakeDeadlineMs_)) {
    motors_->coastAll();
    braking_ = false;
  }
  if (motorActive_ &&
      (deadlineReached(nowMs, motionDeadlineMs_) ||
       deadlineReached(nowMs, heartbeatDeadlineMs_))) {
    requestStop(nowMs);
  }
}

const char* MotionController::safetyState() const {
  if (fault_) return "fault";
  if (motorActive_ || sensorsHealthy_) return "ready";
  // Idle unsensored demo stays "stopped" so Agent expected_device_state matches.
  // execute() still accepts approach_short / turn_to_user when the flag is set.
  return "stopped";
}

const String& MotionController::activeSkill() const { return activeSkill_; }

bool MotionController::motionStopped() const { return !motorActive_; }

bool MotionController::motorReady() const {
  return motors_ != nullptr && motors_->ready();
}

bool MotionController::servoReady() const {
  return servo_ != nullptr && servo_->ready();
}

MotorPinSnapshot MotionController::motorPins() const {
  if (motors_ == nullptr) return MotorPinSnapshot{};
  return motors_->snapshot();
}

}  // namespace hshh

