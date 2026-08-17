#pragma once

#include <Arduino.h>

#include <cstddef>
#include <cstdint>

namespace hshh {

String hmacSha256Hex(const String& secret, const String& timestamp,
                     const String& body);
String hmacSha256Hex(const String& secret, const String& timestamp,
                     const uint8_t* body, size_t bodyLength);
bool constantTimeHexEquals(const String& actual, const String& expected);

}  // namespace hshh
