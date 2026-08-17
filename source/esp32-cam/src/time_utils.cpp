#include "time_utils.h"

#include <sys/time.h>
#include <time.h>

namespace hshh {
namespace {

bool isDigitAt(const String& value, size_t index) {
  return index < value.length() && value[index] >= '0' && value[index] <= '9';
}

int parseDigits(const String& value, size_t index, size_t count) {
  int parsed = 0;
  for (size_t offset = 0; offset < count; ++offset) {
    if (!isDigitAt(value, index + offset)) return -1;
    parsed = parsed * 10 + (value[index + offset] - '0');
  }
  return parsed;
}

bool isLeapYear(int year) {
  return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

int daysInMonth(int year, int month) {
  static constexpr int kDays[] = {31, 28, 31, 30, 31, 30,
                                  31, 31, 30, 31, 30, 31};
  if (month == 2 && isLeapYear(year)) return 29;
  return kDays[month - 1];
}

int64_t daysFromCivil(int year, unsigned month, unsigned day) {
  year -= month <= 2U;
  const int era = (year >= 0 ? year : year - 399) / 400;
  const unsigned yearOfEra = static_cast<unsigned>(year - era * 400);
  const unsigned adjustedMonth = month > 2U ? month - 3U : month + 9U;
  const unsigned dayOfYear =
      (153U * adjustedMonth + 2U) / 5U + day - 1U;
  const unsigned dayOfEra =
      yearOfEra * 365U + yearOfEra / 4U - yearOfEra / 100U + dayOfYear;
  return static_cast<int64_t>(era) * 146097LL + dayOfEra - 719468LL;
}

}  // namespace

int64_t nowEpochMilliseconds() {
  timeval now{};
  gettimeofday(&now, nullptr);
  return static_cast<int64_t>(now.tv_sec) * 1000LL + now.tv_usec / 1000LL;
}

bool clockIsTrusted() {
  return nowEpochMilliseconds() >= 1704067200000LL;
}

bool parseUtcIso8601(const String& value, int64_t& epochMilliseconds) {
  if (value.length() != 24 || value[4] != '-' || value[7] != '-' ||
      value[10] != 'T' || value[13] != ':' || value[16] != ':' ||
      value[19] != '.' || value[23] != 'Z') {
    return false;
  }

  const int year = parseDigits(value, 0, 4);
  const int month = parseDigits(value, 5, 2);
  const int day = parseDigits(value, 8, 2);
  const int hour = parseDigits(value, 11, 2);
  const int minute = parseDigits(value, 14, 2);
  const int second = parseDigits(value, 17, 2);
  const int millisecond = parseDigits(value, 20, 3);
  if (year < 2024 || year > 2100 || month < 1 || month > 12 || day < 1 ||
      day > daysInMonth(year, month) || hour < 0 || hour > 23 ||
      minute < 0 || minute > 59 || second < 0 || second > 59 ||
      millisecond < 0) {
    return false;
  }

  const int64_t seconds =
      daysFromCivil(year, static_cast<unsigned>(month),
                    static_cast<unsigned>(day)) *
          86400LL +
      static_cast<int64_t>(hour) * 3600LL + minute * 60LL + second;
  epochMilliseconds = seconds * 1000LL + millisecond;
  return true;
}

String nowUtcIso8601() {
  timeval now{};
  gettimeofday(&now, nullptr);
  tm utc{};
  gmtime_r(&now.tv_sec, &utc);
  char buffer[25]{};
  snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ",
           utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, utc.tm_hour,
           utc.tm_min, utc.tm_sec, now.tv_usec / 1000L);
  return String(buffer);
}

}  // namespace hshh
