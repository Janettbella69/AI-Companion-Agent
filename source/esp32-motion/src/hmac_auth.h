#pragma once

#include <Arduino.h>

namespace hshh {

String hmacSha256Hex(const String& secret, const String& timestamp,
                     const String& body);
bool constantTimeHexEquals(const String& actual, const String& expected);

}  // namespace hshh

