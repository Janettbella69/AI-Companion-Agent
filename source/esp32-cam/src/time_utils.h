#pragma once

#include <Arduino.h>

#include <cstdint>

namespace hshh {

bool clockIsTrusted();
bool parseUtcIso8601(const String& value, int64_t& epochMilliseconds);
int64_t nowEpochMilliseconds();
String nowUtcIso8601();

}  // namespace hshh
