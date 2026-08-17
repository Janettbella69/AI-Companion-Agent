#pragma once

#include <Arduino.h>

namespace hshh {

class ServoDriver {
 public:
  bool begin();
  bool ready() const;
  bool writeAngle(int angle);
  void disable();

 private:
  void writeDuty(uint32_t duty);

  bool ready_ = false;
};

}  // namespace hshh

