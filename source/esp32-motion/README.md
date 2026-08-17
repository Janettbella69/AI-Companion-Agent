# HSHH ESP32-S3 motion controller

Independent Arduino/C++ firmware for the YD-ESP32-23 / YD-ESP32-S3 board with
an ESP32-S3-WROOM-1-N16R8 module.

## Confirmed actuator pins

| Device | Signal | GPIO |
|---|---|---:|
| TC1508 | IN1 / MOTOR-A | 10 |
| TC1508 | IN2 / MOTOR-A | 11 |
| TC1508 | IN3 / MOTOR-B | 12 |
| TC1508 | IN4 / MOTOR-B | 13 |
| SG90 | signal | 17 |

The default `yd_esp32_s3_safe` build keeps the servo disabled and rejects all
autonomous movement while distance and pose sensors are unavailable. The motor
driver still initializes so every TC1508 input is driven LOW at boot.

## Local configuration

Copy the example without committing the resulting file:

```bash
cp include/secrets.example.h include/secrets.h
```

Set the 2.4 GHz Wi-Fi credentials and a random motion-controller secret of at
least 32 characters. If this file is absent or invalid, the firmware remains
`SAFE LOCKED` and does not start Wi-Fi or the HTTP server.

## Build and flash

```bash
pio run -e yd_esp32_s3_safe
pio run -e yd_esp32_s3_safe -t upload --upload-port /dev/cu.<port>
pio device monitor --port /dev/cu.<port> --baud 115200
```

Use the board's CH343 USB-to-UART Type-C port for the most predictable upload
and log path. The build targets 16 MB Quad-SPI flash plus 8 MB Octal-SPI PSRAM.

## Deliberate bench build

Only use this with the wheels off the ground and the actuator supply verified:

```bash
pio run -e yd_esp32_s3_bench -t upload --upload-port /dev/cu.<port>
```

The serial console remains disarmed after boot. Commands are:

```text
ARM BENCH
MOTOR <left-percent> <right-percent> <duration-ms>
STOP
```

Percentages are limited to `-30..30`, duration to `1..300 ms`, and the arm
window expires after 30 seconds. `STOP` applies an 80 ms MX1508 dynamic brake
and then places all inputs LOW for coast/standby.

## Power boundary

The verified PPMD20 power bank provides 5 V at 2.4 A total across all ports.
It is suitable for staged, wheels-up testing. Motor and servo current must not
pass through the ESP32 board, and all supplies must share ground. The motors'
published no-load points are 130 mA maximum at 3 V and 220 mA maximum at 6 V;
stall current remains unknown.
