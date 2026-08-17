#ifndef APP_HSHH_STATE_H
#define APP_HSHH_STATE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The network adapter must stamp incoming envelopes with the device's
 * monotonic tal_system_get_millisecond() clock. Wall-clock timestamps do not
 * belong in this safety boundary.
 */
#define APP_HSHH_COMMAND_TTL_MAX_MS 30000u
#define APP_HSHH_EVENT_TTL_MAX_MS   10000u
#define APP_HSHH_CLOUD_TIMEOUT_MS   15000u
#define APP_HSHH_VLM_TIMEOUT_MS     12000u
#define APP_HSHH_LOCAL_DISTANCE_MAX_AGE_MS 500u
#define APP_HSHH_MOTION_HEARTBEAT_TIMEOUT_MS 500u
#define APP_HSHH_OBSTACLE_STOP_DISTANCE_CM 25u
#define APP_HSHH_NEAR_USER_MAX_DISTANCE_CM 45u

typedef enum {
    APP_HSHH_STATE_BOOT = 0,
    APP_HSHH_STATE_IDLE,
    APP_HSHH_STATE_NOTICED,
    APP_HSHH_STATE_LISTENING,
    APP_HSHH_STATE_THINKING,
    APP_HSHH_STATE_RESPONDING,
    APP_HSHH_STATE_APPROACHING,
    APP_HSHH_STATE_HUGGING,
    APP_HSHH_STATE_SAFE_STOP,
    APP_HSHH_STATE_FAULT,
    /* Appended states preserve the numeric values of the original protocol. */
    APP_HSHH_STATE_NEAR_USER,
    APP_HSHH_STATE_HELD,
    APP_HSHH_STATE_RELEASED,
    APP_HSHH_STATE_LOW_BATTERY,
} app_hshh_state_t;

typedef enum {
    APP_HSHH_COMMAND_IDLE = 0,
    APP_HSHH_COMMAND_NOTICE,
    APP_HSHH_COMMAND_LISTEN,
    APP_HSHH_COMMAND_THINK,
    APP_HSHH_COMMAND_RESPOND,
    APP_HSHH_COMMAND_TURN_TO_USER,
    APP_HSHH_COMMAND_APPROACH_SHORT,
    APP_HSHH_COMMAND_HUG,
    APP_HSHH_COMMAND_COMPLETE,
    APP_HSHH_COMMAND_STOP,
    APP_HSHH_COMMAND_RELEASE_HUG,
    APP_HSHH_COMMAND_REPORT_FAULT,
} app_hshh_command_t;

typedef enum {
    APP_HSHH_EVENT_BOOT_COMPLETED = 0,
    APP_HSHH_EVENT_USER_DETECTED,
    APP_HSHH_EVENT_USER_LEFT,
    APP_HSHH_EVENT_SPEECH_STARTED,
    APP_HSHH_EVENT_SPEECH_ENDED,
    /* A camera/audio context bundle is queued for the cloud/VLM. */
    APP_HSHH_EVENT_CONTEXT_READY,
    APP_HSHH_EVENT_RESPONSE_STARTED,
    APP_HSHH_EVENT_RESPONSE_FINISHED,
    APP_HSHH_EVENT_ACTION_COMPLETED,
    APP_HSHH_EVENT_LOCAL_STOP,
    APP_HSHH_EVENT_FALL_DETECTED,
    APP_HSHH_EVENT_ACTUATOR_FAULT,
    /* Emitted only by the local safety controller after the fault is gone. */
    APP_HSHH_EVENT_LOCAL_RECOVERY_CONFIRMED,
    /* Validated heartbeat from the local motion controller; no bus is implied. */
    APP_HSHH_EVENT_MOTION_HEARTBEAT,
    /* Appended events preserve the numeric values of the original protocol. */
    APP_HSHH_EVENT_PICKED_UP,
    APP_HSHH_EVENT_PUT_DOWN_STABLE,
    APP_HSHH_EVENT_LOW_BATTERY,
} app_hshh_event_t;

typedef enum {
    APP_HSHH_STOP_REASON_NONE = 0,
    APP_HSHH_STOP_REASON_REMOTE_REQUEST,
    APP_HSHH_STOP_REASON_LOCAL_REQUEST,
    APP_HSHH_STOP_REASON_CLOUD_DISCONNECTED,
    APP_HSHH_STOP_REASON_CLOUD_TIMEOUT,
    APP_HSHH_STOP_REASON_CLOUD_RESPONSE_TIMEOUT,
    APP_HSHH_STOP_REASON_COMMAND_EXPIRED,
    APP_HSHH_STOP_REASON_EVENT_EXPIRED,
    APP_HSHH_STOP_REASON_REPLAYED_COMMAND,
    APP_HSHH_STOP_REASON_CONSENT_REQUIRED,
    APP_HSHH_STOP_REASON_SAFETY_NOT_READY,
    APP_HSHH_STOP_REASON_INVALID_TRANSITION,
    APP_HSHH_STOP_REASON_FAULT,
    APP_HSHH_STOP_REASON_DISTANCE_INVALID,
    APP_HSHH_STOP_REASON_DISTANCE_STALE,
    APP_HSHH_STOP_REASON_POSE_UNSAFE,
    APP_HSHH_STOP_REASON_LOW_BATTERY,
    APP_HSHH_STOP_REASON_MOTION_NOT_STOPPED,
    APP_HSHH_STOP_REASON_SERVO_UNHEALTHY,
    APP_HSHH_STOP_REASON_MOTION_HEARTBEAT_TIMEOUT,
    APP_HSHH_STOP_REASON_OBSTACLE_TOO_CLOSE,
    APP_HSHH_STOP_REASON_HEARTBEAT_SEQUENCE_MISMATCH,
} app_hshh_stop_reason_t;

typedef struct {
    app_hshh_command_t command;
    uint32_t sequence;
    uint32_t received_at_ms;
    uint32_t ttl_ms;
    /* Set by the policy adapter; vision inference alone must never set this. */
    bool user_consent_confirmed;
    /* Set only after the local motion controller reports its safety gate ready. */
    bool local_safety_ready;
    /* Required for APPROACH_SHORT; sampled on the same monotonic clock. */
    bool local_distance_valid;
    uint32_t local_distance_observed_at_ms;
    uint16_t local_distance_cm;
    bool local_pose_upright;
    bool battery_normal;
    /* Required for HUG; the base must already be stationary. */
    bool motion_stopped;
    bool servo_healthy;
} app_hshh_command_envelope_t;

typedef struct {
    app_hshh_event_t event;
    uint32_t observed_at_ms;
    uint32_t ttl_ms;
    /* MOTION_HEARTBEAT must match the currently active command. */
    uint32_t active_sequence;
    bool local_safety_ready;
    bool local_distance_valid;
    uint32_t local_distance_observed_at_ms;
    uint16_t local_distance_cm;
    bool local_pose_upright;
    bool battery_normal;
    bool motion_stopped;
    bool servo_healthy;
} app_hshh_event_envelope_t;

typedef struct {
    app_hshh_state_t state;
    app_hshh_stop_reason_t stop_reason;
    bool cloud_connected;
    bool command_active;
    bool motion_watchdog_active;
    bool cloud_reply_pending;
    uint32_t active_sequence;
    uint32_t state_since_ms;
    uint32_t command_deadline_ms;
    uint32_t last_motion_heartbeat_ms;
    uint32_t last_cloud_seen_ms;
    uint32_t cloud_reply_deadline_ms;
} app_hshh_state_snapshot_t;

/** Start the MVP state task. This function intentionally does not return. */
void app_hshh_state_run(void);

/**
 * Mark cloud transport state. A connected-to-disconnected transition enters
 * SAFE_STOP immediately. Calling this does not establish a motion lease.
 */
void app_hshh_state_set_cloud_connected(bool connected, uint32_t now_ms);

/** Mark a validated cloud heartbeat and refresh the liveness deadline. */
void app_hshh_state_cloud_heartbeat(uint32_t now_ms);

/**
 * Apply a high-level command. Raw motor values are deliberately absent from
 * this contract. Returns false when the command is stale, replayed, unsafe, or
 * invalid for the current state.
 */
bool app_hshh_state_apply_command(const app_hshh_command_envelope_t *envelope, uint32_t now_ms);

/** Apply a time-bounded local observation or safety event. */
bool app_hshh_state_post_event(const app_hshh_event_envelope_t *envelope, uint32_t now_ms);

/** Run lease and cloud-liveness checks. Call frequently from the app task. */
void app_hshh_state_tick(uint32_t now_ms);

/** Copy the current state without exposing mutable internal storage. */
void app_hshh_state_get_snapshot(app_hshh_state_snapshot_t *snapshot);

const char *app_hshh_state_name(app_hshh_state_t state);

#ifdef __cplusplus
}
#endif

#endif /* APP_HSHH_STATE_H */
