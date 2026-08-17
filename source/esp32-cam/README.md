# ESP32-CAM signed trigger-capture service

This PlatformIO project targets the user-confirmed AI Thinker ESP32-CAM and
OV2640. It provides event-triggered still images only; it does not expose a
video stream or unauthenticated capture endpoint.

Wi-Fi and device values come from the ignored local file
`../embedded/include/hshh_lan_secrets.h`. Copy the adjacent
`hshh_lan_secrets.example.h` when starting a local setup. Camera and motion
must use different random secrets of at least 32 characters.

## HTTP endpoints

- `GET /healthz` - minimal unauthenticated readiness probe; no image or network
  details
- `GET /v1/camera/status` - authenticated, signed camera status
- `POST /v1/camera/captures` - authenticated, expiring, idempotency-keyed fresh
  JPEG capture

Requests and responses follow `docs/lan-protocol.md`. The service requires a
trusted NTP clock, validates a five-second request skew and ten-second maximum
TTL, rejects duplicate capture IDs, limits captures to one per second, and
never substitutes an old frame after a failed capture. The only accepted
trigger reasons are `presence_event`, `user_request`, and `diagnostic`.

## Build and flash

```bash
pio run
pio run --target upload --upload-port /dev/cu.<confirmed-camera-port>
pio device monitor --port /dev/cu.<confirmed-camera-port> --baud 115200
```

If automatic bootloader entry fails, hold GPIO0 low (or hold BOOT), press RESET
once, begin the upload, then release BOOT after writing starts.
