#include <Arduino.h>
#include <ESPmDNS.h>
#include <WiFi.h>

#include <cstring>

#include "board_config.h"
#include "motion_controller.h"
#include "motion_server.h"
#include "mx1508_driver.h"
#include "runtime_config.h"
#include "servo_driver.h"
#include "time_utils.h"

namespace {

hshh::Mx1508Driver motors;
hshh::ServoDriver servo;
hshh::MotionController controller;
hshh::MotionServer motionServer;

bool configurationReady = false;
bool servicesStarted = false;
bool timeConfigurationStarted = false;
bool wasConnected = false;
uint32_t lastWifiAttemptMs = 0;

#if HSHH_ENABLE_SERIAL_BENCH
String serialLine;
uint32_t benchArmDeadlineMs = 0;
#endif

bool validRuntimeConfiguration() {
  const size_t ssidLength = strlen(HSHH_WIFI_SSID);
  const size_t secretLength = strlen(HSHH_MOTION_SHARED_SECRET);
  const size_t robotIdLength = strlen(HSHH_ROBOT_ID);
  const size_t hostnameLength = strlen(HSHH_MDNS_HOSTNAME);
  return ssidLength >= 1 && ssidLength <= 32 && secretLength >= 32 &&
         secretLength <= 512 && robotIdLength >= 1 && robotIdLength <= 128 &&
         hostnameLength >= 1 && hostnameLength <= 63;
}

void connectWifi(uint32_t nowMs) {
  if (!configurationReady ||
      static_cast<int32_t>(nowMs - lastWifiAttemptMs) < 10000) {
    return;
  }
  lastWifiAttemptMs = nowMs;
  Serial.printf("[network] connecting to configured 2.4 GHz Wi-Fi; last_status=%d\n",
                static_cast<int>(WiFi.status()));
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HSHH_MDNS_HOSTNAME);
  WiFi.begin(HSHH_WIFI_SSID, HSHH_WIFI_PASSWORD);
}

void startServicesWhenReady() {
  if (servicesStarted || WiFi.status() != WL_CONNECTED) return;
  if (!timeConfigurationStarted) {
    configTime(0, 0, "pool.ntp.org", "time.cloudflare.com", "time.google.com");
    timeConfigurationStarted = true;
    Serial.println("[network] Wi-Fi connected; waiting for trusted UTC time");
  }
  if (!hshh::clockIsTrusted()) return;

  if (MDNS.begin(HSHH_MDNS_HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
  }
  motionServer.begin(HSHH_MOTION_SHARED_SECRET, HSHH_ROBOT_ID, controller);
  servicesStarted = true;
  Serial.printf("[network] motion API ready at http://%s.local\n",
                HSHH_MDNS_HOSTNAME);
  Serial.printf("[network] IPv4: %s\n", WiFi.localIP().toString().c_str());
}

#if HSHH_ENABLE_SERIAL_BENCH
bool benchArmed(uint32_t nowMs) {
  return benchArmDeadlineMs != 0 &&
         static_cast<int32_t>(benchArmDeadlineMs - nowMs) > 0;
}

void processBenchLine(String line, uint32_t nowMs) {
  line.trim();
  if (line == "STOP") {
    controller.requestStop(nowMs);
    benchArmDeadlineMs = 0;
    Serial.println("[bench] stopped and disarmed");
    return;
  }
  if (line == "ARM BENCH") {
    benchArmDeadlineMs = nowMs + hshh::board::kBenchArmWindowMs;
    Serial.println("[bench] armed for 30 seconds; wheels must be off the ground");
    return;
  }

  int left = 0;
  int right = 0;
  unsigned long duration = 0;
  if (sscanf(line.c_str(), "MOTOR %d %d %lu", &left, &right, &duration) == 3) {
    if (!benchArmed(nowMs)) {
      Serial.println("[bench] rejected: send ARM BENCH first");
      return;
    }
    if (!controller.runBench(left, right, static_cast<uint32_t>(duration),
                             nowMs)) {
      Serial.println("[bench] rejected: use -30..30 percent and 1..300 ms");
      return;
    }
    Serial.printf("[bench] running left=%d right=%d duration=%lu ms\n", left,
                  right, duration);
    return;
  }
  Serial.println("[bench] commands: ARM BENCH | MOTOR <left> <right> <ms> | STOP");
}

void handleBenchConsole(uint32_t nowMs) {
  while (Serial.available() > 0) {
    const char value = static_cast<char>(Serial.read());
    if (value == '\n') {
      processBenchLine(serialLine, nowMs);
      serialLine = String();
    } else if (value != '\r' && serialLine.length() < 96) {
      serialLine += value;
    }
  }
  if (benchArmDeadlineMs != 0 && !benchArmed(nowMs)) {
    benchArmDeadlineMs = 0;
    controller.requestStop(nowMs);
    Serial.println("[bench] arm window expired; stopped and disarmed");
  }
}
#endif

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(250);
  Serial.println();
  Serial.println("HSHH ESP32-S3 motion controller starting");
  Serial.println("[safety] MX1508 inputs are initialized LOW before networking");

  const bool motorReady = motors.begin();
  const bool servoReady = servo.begin();
  controller.begin(motors, servo);
  controller.setSensorsHealthy(false);
#if HSHH_ALLOW_UNSENSORED_MOTION
  Serial.printf(
      "[hardware] motor=%s servo=%s unsensored_demo=enabled duration=%ums pwm=%dHz duty=%d\n",
      motorReady ? "ready" : "fault", servoReady ? "ready" : "disabled",
      static_cast<unsigned>(hshh::board::kApproachDurationMs),
      static_cast<int>(hshh::board::kMotorPwmHz), HSHH_MAX_MOTOR_PERCENT);
#else
  Serial.printf("[hardware] motor=%s servo=%s autonomous_motion=locked\n",
                motorReady ? "ready" : "fault",
                servoReady ? "ready" : "disabled");
#endif

#if HSHH_ENABLE_SERIAL_BENCH
  Serial.println("[bench] build enabled; no motion until ARM BENCH is entered");
#endif

  configurationReady = validRuntimeConfiguration();
  if (!configurationReady) {
    Serial.println(
        "[config] SAFE LOCKED: copy include/secrets.example.h to "
        "include/secrets.h and fill local values");
    return;
  }

  lastWifiAttemptMs = millis() - 10000U;
  connectWifi(millis());
}

void loop() {
  const uint32_t nowMs = millis();
  controller.tick(nowMs);

#if HSHH_ENABLE_SERIAL_BENCH
  handleBenchConsole(nowMs);
#endif

  if (!configurationReady) {
    delay(2);
    return;
  }

  const bool connected = WiFi.status() == WL_CONNECTED;
  if (!connected) {
    if (wasConnected) {
      Serial.println("[network] disconnected; local stop applied");
      controller.requestStop(nowMs);
    }
    wasConnected = false;
    connectWifi(nowMs);
  } else {
    wasConnected = true;
    startServicesWhenReady();
    if (servicesStarted) motionServer.handleClient();
  }
  delay(2);
}

