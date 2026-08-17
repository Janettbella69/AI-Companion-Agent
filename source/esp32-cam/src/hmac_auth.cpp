#include "hmac_auth.h"

#include <mbedtls/md.h>

namespace hshh {
namespace {

String signBytes(const String& secret, const String& timestamp,
                 const uint8_t* body, size_t bodyLength) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr || (body == nullptr && bodyLength != 0)) return String();

  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  if (mbedtls_md_setup(&context, info, 1) != 0 ||
      mbedtls_md_hmac_starts(
          &context, reinterpret_cast<const unsigned char*>(secret.c_str()),
          secret.length()) != 0 ||
      mbedtls_md_hmac_update(
          &context, reinterpret_cast<const unsigned char*>(timestamp.c_str()),
          timestamp.length()) != 0) {
    mbedtls_md_free(&context);
    return String();
  }

  constexpr unsigned char newline = '\n';
  unsigned char digest[32]{};
  if (mbedtls_md_hmac_update(&context, &newline, 1) != 0 ||
      (bodyLength != 0 &&
       mbedtls_md_hmac_update(&context, body, bodyLength) != 0) ||
      mbedtls_md_hmac_finish(&context, digest) != 0) {
    mbedtls_md_free(&context);
    return String();
  }
  mbedtls_md_free(&context);

  static constexpr char kHex[] = "0123456789abcdef";
  char encoded[65]{};
  for (size_t index = 0; index < sizeof(digest); ++index) {
    encoded[index * 2] = kHex[digest[index] >> 4U];
    encoded[index * 2 + 1] = kHex[digest[index] & 0x0FU];
  }
  return String(encoded);
}

}  // namespace

String hmacSha256Hex(const String& secret, const String& timestamp,
                     const String& body) {
  return signBytes(secret, timestamp,
                   reinterpret_cast<const uint8_t*>(body.c_str()),
                   body.length());
}

String hmacSha256Hex(const String& secret, const String& timestamp,
                     const uint8_t* body, size_t bodyLength) {
  return signBytes(secret, timestamp, body, bodyLength);
}

bool constantTimeHexEquals(const String& actual, const String& expected) {
  if (actual.length() != 64 || expected.length() != 64) return false;
  uint8_t difference = 0;
  for (size_t index = 0; index < 64; ++index) {
    const char value = actual[index];
    if (!((value >= '0' && value <= '9') ||
          (value >= 'a' && value <= 'f'))) {
      difference |= 1U;
    }
    difference |= static_cast<uint8_t>(value ^ expected[index]);
  }
  return difference == 0;
}

}  // namespace hshh
