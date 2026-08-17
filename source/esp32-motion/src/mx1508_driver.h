#pragma once

#include <Arduino.h>

namespace hshh {

struct MotorPinSnapshot {
  int in1 = 0;
  int in2 = 0;
  int in3 = 0;
  int in4 = 0;
  int leftPercent = 0;
  int rightPercent = 0;
  const char* driveMode = "pwm";
};

class Mx1508Driver {
 public:
  bool begin();
  bool ready() const;

  void drive(int leftPercent, int rightPercent);
  void brakeAll();
  void coastAll();
  MotorPinSnapshot snapshot() const;

 private:
  bool attachPwm(uint8_t pin, uint8_t channel);
  void writeOutput(uint8_t pin, uint8_t channel, uint32_t duty);
  void setMotor(uint8_t forwardPin, uint8_t forwardChannel,
                uint8_t reversePin, uint8_t reverseChannel, int percent);

  bool ready_ = false;
  int lastLeftPercent_ = 0;
  int lastRightPercent_ = 0;
};

}  // namespace hshh

