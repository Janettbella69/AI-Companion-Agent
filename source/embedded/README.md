# T5AI embedded firmware

The T5AI application runs the HSHH state machine, local expression/audio/button
feedback, an authenticated Agent event/effect client, a verified pet-avatar
loader, Tuya BLE Wi-Fi provisioning/cloud activation, and a separate signed LAN
worker for the ESP32-S3 motion controller.

## Local configuration

Copy the example and fill in local-only values:

```bash
cp include/hshh_lan_secrets.example.h include/hshh_lan_secrets.h
cp include/tuya_config_secrets.example.h include/tuya_config_secrets.h
```

Both copied files are ignored by git. `tuya_config_secrets.h` contains the
device UUID/AuthKey; the Product ID is bound in `tuyaopen.project.ini`.
`hshh_lan_secrets.h` contains motion/camera hosts, robot ID, separate
motion/camera secrets, and the Agent host/device token/user binding. Its Wi-Fi
fields remain only because the independent ESP32-CAM build imports that file;
the T5 does not compile or log them. The motion secret must match
`source/esp32-motion/include/secrets.h`; the camera secret must match the
ESP32-CAM build. Credentials, request bodies, tokens, and signatures are never
written to application logs.

The four `HSHH_AGENT_*` values are required for device events, remote
expression/sound effects and avatar deployment. If they are absent, the
firmware still boots with built-in local expressions and safety controls, but
does not pretend the Agent link is active.

## Boot safety flow

1. Restore a previously provisioned Wi-Fi network, or wait for Tuya BLE
   provisioning when the device is unactivated.
2. Read `GET /v1/motion/status` from the ESP32-S3.
3. Verify `HMAC-SHA256(timestamp + "\\n" + exact_body)` before parsing JSON.
4. Bootstrap UTC only from that authenticated response.
5. Send a signed `stop` SafeSkill and require a signed matching response.
6. Poll authenticated status every five seconds. A link or authentication
   failure clears readiness and causes the safe stop to be retried after
   reconnection.

Only the five high-level SafeSkills from `docs/lan-protocol.md` are exposed.
There is no GPIO, PWM, motor percentage, wheel direction, or servo angle in the
T5AI LAN API. Non-escape commands are discarded if they wait longer than one
second; `stop` and `release_hug` retain their escape-action semantics.

The ESP32-S3 safe firmware still rejects autonomous movement while distance and
pose sensors are absent. Flashing this T5AI firmware does not unlock that gate.

## Local feedback and avatar behavior

- The ST7789 display verifies and animates nine built-in expressions with five
  JPEG frames each.
- The microphone emits bounded VAD start/end events; the speaker plays local
  semantic cues even when cloud speech is unavailable.
- A short button press confirms only a currently offered scoped invitation, a
  double press rejects it, and a long press performs local stop plus arm
  release.
- A pet package is activated only after the T5 streams and hashes all 45 device
  frames, verifies the compact identity JPEG, writes it to the inactive slot,
  revalidates it from flash, and atomically switches the active pointer.
- Because the confirmed `tuya_data` partition is only 196 KB, the two flash
  slots retain compact identity JPEGs while expressions are rendered by the
  deterministic `hshh-overlay-v1` renderer. Any download, checksum, decode or
  flash error keeps the current or built-in package active.

## Build and flash

```bash
tos.py check
tos.py build
tos.py flash -p /dev/cu.<confirmed-t5ai-port>
```

Enumerate ports with `tyutool_cli list-ports --json` immediately before
flashing. macOS `/dev/cu.*` paths can change after reconnecting.

After flashing, follow `docs/TUYA_T5AI_WIFI_SETUP.md`. The T5, ESP32-CAM,
ESP32-S3, and Agent host must ultimately be reachable on the same 2.4 GHz LAN.

## Runtime log port

On this T5AI target, the USB download connection uses UART0 while full
application logs are configured for UART1 at 460800 baud (GPIO0 TX, GPIO1 RX).
The USB UART0 CLI exposes the secret-safe `hshh_status` command for provisioning,
Wi-Fi, activation, MQTT, uptime, reset-reason, and last-IoT-error checks. Attach
a 3.3 V USB-to-UART adapter to UART1, with a shared ground, when full `PR_*` logs
or direct confirmation of the signed boot-stop exchange is required.
