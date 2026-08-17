#include "app_hshh_state.h"

#include <stddef.h>

#include "app_hshh_effects.h"
#include "tal_api.h"

#define APP_HSHH_LOOP_INTERVAL_MS 50u
#define APP_HSHH_STATUS_LOG_MS    5000u

typedef struct {
    app_hshh_state_snapshot_t snapshot;
    bool initialized;
    uint32_t last_sequence;
    uint32_t last_status_log_ms;
} app_hshh_machine_t;

static app_hshh_machine_t s_machine;

static bool app_hshh_time_elapsed(uint32_t now_ms, uint32_t start_ms, uint32_t duration_ms)
{
    return (uint32_t)(now_ms - start_ms) >= duration_ms;
}

static bool app_hshh_deadline_reached(uint32_t now_ms, uint32_t deadline_ms)
{
    return (int32_t)(now_ms - deadline_ms) >= 0;
}

const char *app_hshh_state_name(app_hshh_state_t state)
{
    switch (state) {
    case APP_HSHH_STATE_BOOT:
        return "BOOT";
    case APP_HSHH_STATE_IDLE:
        return "IDLE";
    case APP_HSHH_STATE_NOTICED:
        return "NOTICED";
    case APP_HSHH_STATE_LISTENING:
        return "LISTENING";
    case APP_HSHH_STATE_THINKING:
        return "THINKING";
    case APP_HSHH_STATE_RESPONDING:
        return "RESPONDING";
    case APP_HSHH_STATE_APPROACHING:
        return "APPROACHING";
    case APP_HSHH_STATE_HUGGING:
        return "HUGGING";
    case APP_HSHH_STATE_SAFE_STOP:
        return "SAFE_STOP";
    case APP_HSHH_STATE_FAULT:
        return "FAULT";
    case APP_HSHH_STATE_NEAR_USER:
        return "NEAR_USER";
    case APP_HSHH_STATE_HELD:
        return "HELD";
    case APP_HSHH_STATE_RELEASED:
        return "RELEASED";
    case APP_HSHH_STATE_LOW_BATTERY:
        return "LOW_BATTERY";
    default:
        return "UNKNOWN";
    }
}

static void app_hshh_clear_command_lease(void)
{
    s_machine.snapshot.command_active = false;
    s_machine.snapshot.motion_watchdog_active = false;
    s_machine.snapshot.active_sequence = 0u;
    s_machine.snapshot.command_deadline_ms = 0u;
    s_machine.snapshot.last_motion_heartbeat_ms = 0u;
}

static void app_hshh_clear_cloud_reply_wait(void)
{
    s_machine.snapshot.cloud_reply_pending = false;
    s_machine.snapshot.cloud_reply_deadline_ms = 0u;
}

static void app_hshh_start_cloud_reply_wait(uint32_t now_ms)
{
    s_machine.snapshot.cloud_reply_pending = true;
    s_machine.snapshot.cloud_reply_deadline_ms = now_ms + APP_HSHH_VLM_TIMEOUT_MS;
}

static void app_hshh_transition(app_hshh_state_t next, app_hshh_stop_reason_t reason, uint32_t now_ms)
{
    const app_hshh_state_t previous = s_machine.snapshot.state;

    if (previous == next && s_machine.snapshot.stop_reason == reason) {
        return;
    }

    s_machine.snapshot.state = next;
    s_machine.snapshot.state_since_ms = now_ms;
    s_machine.snapshot.stop_reason = reason;
    if (next != APP_HSHH_STATE_THINKING) {
        app_hshh_clear_cloud_reply_wait();
    }

    PR_INFO("[HSHH] state %s -> %s, reason=%u", app_hshh_state_name(previous), app_hshh_state_name(next),
            (unsigned int)reason);
}

static bool app_hshh_state_is_moving(void)
{
    return s_machine.snapshot.state == APP_HSHH_STATE_APPROACHING ||
           s_machine.snapshot.state == APP_HSHH_STATE_HUGGING;
}

static void app_hshh_return_to_idle(uint32_t now_ms)
{
    app_hshh_clear_command_lease();
    app_hshh_clear_cloud_reply_wait();
    app_hshh_transition(APP_HSHH_STATE_IDLE, APP_HSHH_STOP_REASON_NONE, now_ms);
}

static void app_hshh_safe_stop(app_hshh_stop_reason_t reason, uint32_t now_ms)
{
    app_hshh_clear_command_lease();
    app_hshh_clear_cloud_reply_wait();

    /* Lower-priority stop requests must never erase a more specific latched
     * local safety condition. Only LOCAL_RECOVERY_CONFIRMED may clear these. */
    if (s_machine.snapshot.state == APP_HSHH_STATE_FAULT ||
        s_machine.snapshot.state == APP_HSHH_STATE_LOW_BATTERY ||
        s_machine.snapshot.state == APP_HSHH_STATE_HELD) {
        return;
    }
    app_hshh_transition(APP_HSHH_STATE_SAFE_STOP, reason, now_ms);
}

static void app_hshh_fault(uint32_t now_ms)
{
    app_hshh_clear_command_lease();
    app_hshh_clear_cloud_reply_wait();
    app_hshh_transition(APP_HSHH_STATE_FAULT, APP_HSHH_STOP_REASON_FAULT, now_ms);
}

static void app_hshh_low_battery(uint32_t now_ms)
{
    app_hshh_clear_command_lease();
    app_hshh_clear_cloud_reply_wait();
    if (s_machine.snapshot.state == APP_HSHH_STATE_FAULT) {
        return;
    }
    app_hshh_transition(APP_HSHH_STATE_LOW_BATTERY, APP_HSHH_STOP_REASON_LOW_BATTERY, now_ms);
}

static void app_hshh_held(uint32_t now_ms)
{
    app_hshh_clear_command_lease();
    app_hshh_clear_cloud_reply_wait();
    if (s_machine.snapshot.state == APP_HSHH_STATE_FAULT ||
        s_machine.snapshot.state == APP_HSHH_STATE_LOW_BATTERY) {
        return;
    }
    app_hshh_transition(APP_HSHH_STATE_HELD, APP_HSHH_STOP_REASON_LOCAL_REQUEST, now_ms);
}

static bool app_hshh_state_is_one_of(app_hshh_state_t first, app_hshh_state_t second,
                                     app_hshh_state_t third, app_hshh_state_t fourth)
{
    const app_hshh_state_t state = s_machine.snapshot.state;

    return state == first || state == second || state == third || state == fourth;
}

static bool app_hshh_command_is_unconditional_safety(app_hshh_command_t command)
{
    return command == APP_HSHH_COMMAND_STOP || command == APP_HSHH_COMMAND_RELEASE_HUG ||
           command == APP_HSHH_COMMAND_REPORT_FAULT;
}

static bool app_hshh_command_requires_motion_safety(app_hshh_command_t command)
{
    return command == APP_HSHH_COMMAND_TURN_TO_USER || command == APP_HSHH_COMMAND_APPROACH_SHORT ||
           command == APP_HSHH_COMMAND_HUG;
}

static bool app_hshh_command_requires_consent(app_hshh_command_t command)
{
    return command == APP_HSHH_COMMAND_APPROACH_SHORT || command == APP_HSHH_COMMAND_HUG;
}

static bool app_hshh_event_is_unconditional_safety(app_hshh_event_t event)
{
    return event == APP_HSHH_EVENT_LOCAL_STOP || event == APP_HSHH_EVENT_FALL_DETECTED ||
           event == APP_HSHH_EVENT_ACTUATOR_FAULT || event == APP_HSHH_EVENT_PICKED_UP ||
           event == APP_HSHH_EVENT_LOW_BATTERY;
}

static bool app_hshh_envelope_is_fresh(uint32_t observed_at_ms, uint32_t ttl_ms, uint32_t ttl_max_ms,
                                       uint32_t now_ms)
{
    if (ttl_ms == 0u || ttl_ms > ttl_max_ms) {
        return false;
    }

    return !app_hshh_deadline_reached(now_ms, observed_at_ms + ttl_ms);
}

static bool app_hshh_observation_age_is_valid(uint32_t observed_at_ms, uint32_t max_age_ms, uint32_t now_ms)
{
    const int32_t signed_age_ms = (int32_t)(now_ms - observed_at_ms);

    return signed_age_ms >= 0 && (uint32_t)signed_age_ms <= max_age_ms;
}

static void app_hshh_start_command_lease(const app_hshh_command_envelope_t *envelope, uint32_t now_ms)
{
    s_machine.snapshot.command_active = true;
    s_machine.snapshot.active_sequence = envelope->sequence;
    s_machine.snapshot.command_deadline_ms = envelope->received_at_ms + envelope->ttl_ms;
    s_machine.snapshot.motion_watchdog_active = app_hshh_command_requires_motion_safety(envelope->command);
    s_machine.snapshot.last_motion_heartbeat_ms =
        s_machine.snapshot.motion_watchdog_active ? now_ms : 0u;
}

static void app_hshh_initialize(uint32_t now_ms)
{
    s_machine.snapshot.state = APP_HSHH_STATE_BOOT;
    s_machine.snapshot.stop_reason = APP_HSHH_STOP_REASON_NONE;
    s_machine.snapshot.cloud_connected = false;
    s_machine.snapshot.command_active = false;
    s_machine.snapshot.motion_watchdog_active = false;
    s_machine.snapshot.cloud_reply_pending = false;
    s_machine.snapshot.active_sequence = 0u;
    s_machine.snapshot.state_since_ms = now_ms;
    s_machine.snapshot.command_deadline_ms = 0u;
    s_machine.snapshot.last_motion_heartbeat_ms = 0u;
    s_machine.snapshot.last_cloud_seen_ms = now_ms;
    s_machine.snapshot.cloud_reply_deadline_ms = 0u;
    s_machine.initialized = true;
    s_machine.last_sequence = 0u;
    s_machine.last_status_log_ms = now_ms;

    PR_INFO("[HSHH] state machine ready; outputs remain disabled until adapters are connected");
}

void app_hshh_state_set_cloud_connected(bool connected, uint32_t now_ms)
{
    if (!s_machine.initialized) {
        app_hshh_initialize(now_ms);
    }

    if (connected) {
        s_machine.snapshot.cloud_connected = true;
        s_machine.snapshot.last_cloud_seen_ms = now_ms;
        PR_INFO("[HSHH] cloud connected");
        return;
    }

    if (s_machine.snapshot.cloud_connected) {
        PR_WARN("[HSHH] cloud disconnected");
        s_machine.snapshot.cloud_connected = false;
        if (app_hshh_state_is_moving()) {
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_CLOUD_DISCONNECTED, now_ms);
        } else {
            app_hshh_return_to_idle(now_ms);
        }
        return;
    }
    s_machine.snapshot.cloud_connected = false;
}

void app_hshh_state_cloud_heartbeat(uint32_t now_ms)
{
    if (!s_machine.initialized) {
        app_hshh_initialize(now_ms);
    }

    s_machine.snapshot.cloud_connected = true;
    s_machine.snapshot.last_cloud_seen_ms = now_ms;
}

bool app_hshh_state_apply_command(const app_hshh_command_envelope_t *envelope, uint32_t now_ms)
{
    bool accepted = false;
    bool approach_target_already_reached = false;

    if (!s_machine.initialized) {
        app_hshh_initialize(now_ms);
    }
    if (envelope == NULL) {
        app_hshh_safe_stop(APP_HSHH_STOP_REASON_INVALID_TRANSITION, now_ms);
        return false;
    }

    if (app_hshh_command_is_unconditional_safety(envelope->command)) {
        if (envelope->command == APP_HSHH_COMMAND_REPORT_FAULT) {
            app_hshh_fault(now_ms);
        } else if (envelope->command == APP_HSHH_COMMAND_RELEASE_HUG) {
            app_hshh_clear_command_lease();
            app_hshh_clear_cloud_reply_wait();

            /* Release must always be accepted, but it must not clear a latched
             * SAFE_STOP, FAULT, or LOW_BATTERY condition. The actuator adapter
             * may still use the accepted command to move toward its safe-open
             * posture. */
            if (s_machine.snapshot.state != APP_HSHH_STATE_SAFE_STOP &&
                s_machine.snapshot.state != APP_HSHH_STATE_FAULT &&
                s_machine.snapshot.state != APP_HSHH_STATE_LOW_BATTERY &&
                s_machine.snapshot.state != APP_HSHH_STATE_HELD) {
                app_hshh_transition(APP_HSHH_STATE_RELEASED, APP_HSHH_STOP_REASON_NONE, now_ms);
            }
        } else {
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_REMOTE_REQUEST, now_ms);
        }
        return true;
    }

    if (!app_hshh_envelope_is_fresh(envelope->received_at_ms, envelope->ttl_ms,
                                    APP_HSHH_COMMAND_TTL_MAX_MS, now_ms)) {
        PR_WARN("[HSHH] rejected expired command seq=%u", (unsigned int)envelope->sequence);
        app_hshh_safe_stop(APP_HSHH_STOP_REASON_COMMAND_EXPIRED, now_ms);
        return false;
    }

    if (envelope->sequence == 0u ||
        (s_machine.last_sequence != 0u && (int32_t)(envelope->sequence - s_machine.last_sequence) <= 0)) {
        PR_WARN("[HSHH] rejected replayed command seq=%u", (unsigned int)envelope->sequence);
        app_hshh_safe_stop(APP_HSHH_STOP_REASON_REPLAYED_COMMAND, now_ms);
        return false;
    }

    s_machine.last_sequence = envelope->sequence;

    if (!s_machine.snapshot.cloud_connected) {
        app_hshh_safe_stop(APP_HSHH_STOP_REASON_CLOUD_DISCONNECTED, now_ms);
        return false;
    }

    if (app_hshh_command_requires_motion_safety(envelope->command) && !envelope->local_safety_ready) {
        PR_WARN("[HSHH] rejected motion command: local safety gate is not ready");
        app_hshh_safe_stop(APP_HSHH_STOP_REASON_SAFETY_NOT_READY, now_ms);
        return false;
    }

    if (app_hshh_command_requires_consent(envelope->command) && !envelope->user_consent_confirmed) {
        PR_WARN("[HSHH] rejected motion command: explicit consent is missing");
        app_hshh_safe_stop(APP_HSHH_STOP_REASON_CONSENT_REQUIRED, now_ms);
        return false;
    }

    if (envelope->command == APP_HSHH_COMMAND_APPROACH_SHORT) {
        if (!envelope->local_distance_valid) {
            PR_WARN("[HSHH] rejected approach: local distance is invalid");
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_DISTANCE_INVALID, now_ms);
            return false;
        }
        if (!app_hshh_observation_age_is_valid(envelope->local_distance_observed_at_ms,
                                               APP_HSHH_LOCAL_DISTANCE_MAX_AGE_MS, now_ms)) {
            PR_WARN("[HSHH] rejected approach: local distance is older than %u ms",
                    (unsigned int)APP_HSHH_LOCAL_DISTANCE_MAX_AGE_MS);
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_DISTANCE_STALE, now_ms);
            return false;
        }
        if (!envelope->local_pose_upright) {
            PR_WARN("[HSHH] rejected approach: local pose is not upright");
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_POSE_UNSAFE, now_ms);
            return false;
        }
        if (!envelope->battery_normal) {
            PR_WARN("[HSHH] rejected approach: battery is not normal");
            app_hshh_low_battery(now_ms);
            return false;
        }
        if (envelope->local_distance_cm < APP_HSHH_OBSTACLE_STOP_DISTANCE_CM) {
            PR_WARN("[HSHH] rejected approach: obstacle at %u cm",
                    (unsigned int)envelope->local_distance_cm);
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_OBSTACLE_TOO_CLOSE, now_ms);
            return false;
        }
        approach_target_already_reached =
            envelope->local_distance_cm <= APP_HSHH_NEAR_USER_MAX_DISTANCE_CM;
    }

    if (envelope->command == APP_HSHH_COMMAND_HUG) {
        if (!envelope->battery_normal) {
            PR_WARN("[HSHH] rejected hug: battery is not normal");
            app_hshh_low_battery(now_ms);
            return false;
        }
        if (!envelope->motion_stopped) {
            PR_WARN("[HSHH] rejected hug: base motion has not stopped");
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_MOTION_NOT_STOPPED, now_ms);
            return false;
        }
        if (!envelope->servo_healthy) {
            PR_WARN("[HSHH] rejected hug: servo health check failed");
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_SERVO_UNHEALTHY, now_ms);
            return false;
        }
    }

    switch (envelope->command) {
    case APP_HSHH_COMMAND_IDLE:
        if (app_hshh_state_is_one_of(APP_HSHH_STATE_IDLE, APP_HSHH_STATE_NOTICED,
                                     APP_HSHH_STATE_LISTENING, APP_HSHH_STATE_THINKING) ||
            s_machine.snapshot.state == APP_HSHH_STATE_RESPONDING) {
            app_hshh_clear_command_lease();
            app_hshh_transition(APP_HSHH_STATE_IDLE, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_COMMAND_NOTICE:
        if (s_machine.snapshot.state == APP_HSHH_STATE_IDLE) {
            app_hshh_transition(APP_HSHH_STATE_NOTICED, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_COMMAND_LISTEN:
        if (app_hshh_state_is_one_of(APP_HSHH_STATE_IDLE, APP_HSHH_STATE_NOTICED,
                                     APP_HSHH_STATE_RESPONDING, APP_HSHH_STATE_LISTENING)) {
            app_hshh_transition(APP_HSHH_STATE_LISTENING, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_COMMAND_THINK:
        if (s_machine.snapshot.state == APP_HSHH_STATE_LISTENING) {
            app_hshh_transition(APP_HSHH_STATE_THINKING, APP_HSHH_STOP_REASON_NONE, now_ms);
            app_hshh_start_cloud_reply_wait(now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_COMMAND_RESPOND:
        if (s_machine.snapshot.state == APP_HSHH_STATE_THINKING ||
            s_machine.snapshot.state == APP_HSHH_STATE_LISTENING) {
            app_hshh_transition(APP_HSHH_STATE_RESPONDING, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_COMMAND_TURN_TO_USER:
        if (s_machine.snapshot.state == APP_HSHH_STATE_IDLE ||
            s_machine.snapshot.state == APP_HSHH_STATE_NOTICED ||
            s_machine.snapshot.state == APP_HSHH_STATE_RESPONDING) {
            app_hshh_transition(APP_HSHH_STATE_NOTICED, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_COMMAND_APPROACH_SHORT:
        if (s_machine.snapshot.state == APP_HSHH_STATE_IDLE ||
            s_machine.snapshot.state == APP_HSHH_STATE_NOTICED ||
            s_machine.snapshot.state == APP_HSHH_STATE_RESPONDING) {
            app_hshh_transition(approach_target_already_reached ? APP_HSHH_STATE_NEAR_USER
                                                                : APP_HSHH_STATE_APPROACHING,
                                APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_COMMAND_HUG:
        if (s_machine.snapshot.state == APP_HSHH_STATE_IDLE ||
            s_machine.snapshot.state == APP_HSHH_STATE_NOTICED ||
            s_machine.snapshot.state == APP_HSHH_STATE_RESPONDING) {
            app_hshh_transition(APP_HSHH_STATE_HUGGING, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_COMMAND_COMPLETE:
        if (app_hshh_state_is_one_of(APP_HSHH_STATE_NOTICED, APP_HSHH_STATE_LISTENING,
                                     APP_HSHH_STATE_THINKING, APP_HSHH_STATE_RESPONDING) ||
            s_machine.snapshot.state == APP_HSHH_STATE_APPROACHING ||
            s_machine.snapshot.state == APP_HSHH_STATE_NEAR_USER ||
            s_machine.snapshot.state == APP_HSHH_STATE_RELEASED) {
            app_hshh_clear_command_lease();
            app_hshh_transition(APP_HSHH_STATE_IDLE, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_COMMAND_STOP:
    case APP_HSHH_COMMAND_RELEASE_HUG:
    case APP_HSHH_COMMAND_REPORT_FAULT:
    default:
        break;
    }

    if (!accepted) {
        PR_WARN("[HSHH] rejected command=%u in state=%s", (unsigned int)envelope->command,
                app_hshh_state_name(s_machine.snapshot.state));
        app_hshh_safe_stop(APP_HSHH_STOP_REASON_INVALID_TRANSITION, now_ms);
        return false;
    }

    if (envelope->command != APP_HSHH_COMMAND_IDLE && envelope->command != APP_HSHH_COMMAND_COMPLETE &&
        !(envelope->command == APP_HSHH_COMMAND_APPROACH_SHORT && approach_target_already_reached)) {
        app_hshh_start_command_lease(envelope, now_ms);
    }

    return true;
}

bool app_hshh_state_post_event(const app_hshh_event_envelope_t *envelope, uint32_t now_ms)
{
    bool accepted = false;

    if (!s_machine.initialized) {
        app_hshh_initialize(now_ms);
    }
    if (envelope == NULL) {
        return false;
    }

    if (app_hshh_event_is_unconditional_safety(envelope->event)) {
        if (envelope->event == APP_HSHH_EVENT_LOCAL_STOP) {
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_LOCAL_REQUEST, now_ms);
        } else if (envelope->event == APP_HSHH_EVENT_PICKED_UP) {
            app_hshh_held(now_ms);
        } else if (envelope->event == APP_HSHH_EVENT_LOW_BATTERY) {
            app_hshh_low_battery(now_ms);
        } else {
            app_hshh_fault(now_ms);
        }
        return true;
    }

    if (!app_hshh_envelope_is_fresh(envelope->observed_at_ms, envelope->ttl_ms,
                                    APP_HSHH_EVENT_TTL_MAX_MS, now_ms)) {
        PR_WARN("[HSHH] rejected expired local event=%u", (unsigned int)envelope->event);
        app_hshh_safe_stop(APP_HSHH_STOP_REASON_EVENT_EXPIRED, now_ms);
        return false;
    }

    switch (envelope->event) {
    case APP_HSHH_EVENT_BOOT_COMPLETED:
        if (s_machine.snapshot.state == APP_HSHH_STATE_BOOT) {
            app_hshh_transition(APP_HSHH_STATE_IDLE, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_USER_DETECTED:
        if (s_machine.snapshot.state == APP_HSHH_STATE_IDLE) {
            app_hshh_transition(APP_HSHH_STATE_NOTICED, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_USER_LEFT:
        if (app_hshh_state_is_one_of(APP_HSHH_STATE_NOTICED, APP_HSHH_STATE_LISTENING,
                                     APP_HSHH_STATE_THINKING, APP_HSHH_STATE_RESPONDING) ||
            s_machine.snapshot.state == APP_HSHH_STATE_NEAR_USER) {
            app_hshh_clear_command_lease();
            app_hshh_transition(APP_HSHH_STATE_IDLE, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        } else if (s_machine.snapshot.state == APP_HSHH_STATE_APPROACHING ||
                   s_machine.snapshot.state == APP_HSHH_STATE_HUGGING) {
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_LOCAL_REQUEST, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_SPEECH_STARTED:
        if (s_machine.snapshot.state == APP_HSHH_STATE_IDLE || s_machine.snapshot.state == APP_HSHH_STATE_NOTICED ||
            s_machine.snapshot.state == APP_HSHH_STATE_RESPONDING) {
            app_hshh_transition(APP_HSHH_STATE_LISTENING, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_SPEECH_ENDED:
        if (s_machine.snapshot.state == APP_HSHH_STATE_LISTENING) {
            if (!s_machine.snapshot.cloud_connected) {
                /* Mic glitches must not latch SAFE_STOP. Keep the idle face. */
                app_hshh_return_to_idle(now_ms);
                accepted = true;
                break;
            }
            app_hshh_transition(APP_HSHH_STATE_THINKING, APP_HSHH_STOP_REASON_NONE, now_ms);
            app_hshh_start_cloud_reply_wait(now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_CONTEXT_READY:
        if (s_machine.snapshot.state == APP_HSHH_STATE_NOTICED ||
            s_machine.snapshot.state == APP_HSHH_STATE_LISTENING) {
            if (!s_machine.snapshot.cloud_connected) {
                app_hshh_return_to_idle(now_ms);
                accepted = true;
                break;
            }
            app_hshh_transition(APP_HSHH_STATE_THINKING, APP_HSHH_STOP_REASON_NONE, now_ms);
            app_hshh_start_cloud_reply_wait(now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_RESPONSE_STARTED:
        if (s_machine.snapshot.state == APP_HSHH_STATE_THINKING) {
            app_hshh_transition(APP_HSHH_STATE_RESPONDING, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_RESPONSE_FINISHED:
        if (s_machine.snapshot.state == APP_HSHH_STATE_RESPONDING) {
            app_hshh_clear_command_lease();
            app_hshh_transition(APP_HSHH_STATE_IDLE, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_ACTION_COMPLETED:
        if (s_machine.snapshot.state == APP_HSHH_STATE_APPROACHING ||
            s_machine.snapshot.state == APP_HSHH_STATE_NOTICED ||
            s_machine.snapshot.state == APP_HSHH_STATE_RELEASED) {
            app_hshh_clear_command_lease();
            app_hshh_transition(APP_HSHH_STATE_IDLE, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        } else if (s_machine.snapshot.state == APP_HSHH_STATE_HUGGING) {
            /* Servo travel may be complete, but the hug remains active and
             * monitored until an explicit RELEASE_HUG command preempts it. */
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_MOTION_HEARTBEAT:
        if (s_machine.snapshot.motion_watchdog_active) {
            if (envelope->active_sequence == 0u ||
                envelope->active_sequence != s_machine.snapshot.active_sequence) {
                PR_WARN("[HSHH] rejected heartbeat for seq=%u; active seq=%u",
                        (unsigned int)envelope->active_sequence,
                        (unsigned int)s_machine.snapshot.active_sequence);
                app_hshh_safe_stop(APP_HSHH_STOP_REASON_HEARTBEAT_SEQUENCE_MISMATCH, now_ms);
                return false;
            }
            if (!app_hshh_observation_age_is_valid(envelope->observed_at_ms,
                                                   APP_HSHH_MOTION_HEARTBEAT_TIMEOUT_MS, now_ms)) {
                PR_WARN("[HSHH] rejected stale motion heartbeat");
                app_hshh_safe_stop(APP_HSHH_STOP_REASON_MOTION_HEARTBEAT_TIMEOUT, now_ms);
                return false;
            }
            if (!envelope->local_safety_ready) {
                PR_WARN("[HSHH] motion heartbeat reports local safety not ready");
                app_hshh_safe_stop(APP_HSHH_STOP_REASON_SAFETY_NOT_READY, now_ms);
                return false;
            }
            if (!envelope->local_distance_valid) {
                PR_WARN("[HSHH] motion heartbeat reports invalid distance");
                app_hshh_safe_stop(APP_HSHH_STOP_REASON_DISTANCE_INVALID, now_ms);
                return false;
            }
            if (!app_hshh_observation_age_is_valid(envelope->local_distance_observed_at_ms,
                                                   APP_HSHH_LOCAL_DISTANCE_MAX_AGE_MS, now_ms)) {
                PR_WARN("[HSHH] motion heartbeat reports stale distance");
                app_hshh_safe_stop(APP_HSHH_STOP_REASON_DISTANCE_STALE, now_ms);
                return false;
            }
            if (!envelope->local_pose_upright) {
                PR_WARN("[HSHH] motion heartbeat reports unsafe pose");
                app_hshh_safe_stop(APP_HSHH_STOP_REASON_POSE_UNSAFE, now_ms);
                return false;
            }
            if (!envelope->battery_normal) {
                PR_WARN("[HSHH] motion heartbeat reports low battery");
                app_hshh_low_battery(now_ms);
                return false;
            }
            if (!envelope->servo_healthy) {
                PR_WARN("[HSHH] motion heartbeat reports unhealthy servo");
                app_hshh_safe_stop(APP_HSHH_STOP_REASON_SERVO_UNHEALTHY, now_ms);
                return false;
            }
            if (s_machine.snapshot.state == APP_HSHH_STATE_HUGGING && !envelope->motion_stopped) {
                PR_WARN("[HSHH] hug heartbeat reports base motion");
                app_hshh_safe_stop(APP_HSHH_STOP_REASON_MOTION_NOT_STOPPED, now_ms);
                return false;
            }
            if (s_machine.snapshot.state != APP_HSHH_STATE_HUGGING &&
                envelope->local_distance_cm < APP_HSHH_OBSTACLE_STOP_DISTANCE_CM) {
                PR_WARN("[HSHH] motion heartbeat reports obstacle at %u cm",
                        (unsigned int)envelope->local_distance_cm);
                app_hshh_safe_stop(APP_HSHH_STOP_REASON_OBSTACLE_TOO_CLOSE, now_ms);
                return false;
            }
            if (s_machine.snapshot.state == APP_HSHH_STATE_APPROACHING &&
                envelope->local_distance_cm <= APP_HSHH_NEAR_USER_MAX_DISTANCE_CM) {
                PR_INFO("[HSHH] approach target reached at %u cm",
                        (unsigned int)envelope->local_distance_cm);
                app_hshh_clear_command_lease();
                app_hshh_transition(APP_HSHH_STATE_NEAR_USER, APP_HSHH_STOP_REASON_NONE, now_ms);
                accepted = true;
                break;
            }
            s_machine.snapshot.last_motion_heartbeat_ms = envelope->observed_at_ms;
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_LOCAL_RECOVERY_CONFIRMED:
        if ((s_machine.snapshot.state == APP_HSHH_STATE_SAFE_STOP ||
             s_machine.snapshot.state == APP_HSHH_STATE_FAULT ||
             s_machine.snapshot.state == APP_HSHH_STATE_LOW_BATTERY) &&
            envelope->local_safety_ready && envelope->local_pose_upright && envelope->battery_normal &&
            envelope->servo_healthy) {
            app_hshh_clear_command_lease();
            app_hshh_transition(APP_HSHH_STATE_IDLE, APP_HSHH_STOP_REASON_NONE, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_PUT_DOWN_STABLE:
        if (s_machine.snapshot.state == APP_HSHH_STATE_HELD) {
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_LOCAL_REQUEST, now_ms);
            accepted = true;
        }
        break;
    case APP_HSHH_EVENT_LOCAL_STOP:
    case APP_HSHH_EVENT_FALL_DETECTED:
    case APP_HSHH_EVENT_ACTUATOR_FAULT:
    case APP_HSHH_EVENT_PICKED_UP:
    case APP_HSHH_EVENT_LOW_BATTERY:
    default:
        break;
    }

    if (!accepted) {
        PR_DEBUG("[HSHH] ignored local event=%u in state=%s", (unsigned int)envelope->event,
                 app_hshh_state_name(s_machine.snapshot.state));
    }
    return accepted;
}

void app_hshh_state_tick(uint32_t now_ms)
{
    if (!s_machine.initialized) {
        app_hshh_initialize(now_ms);
    }

    if (s_machine.snapshot.command_active &&
        app_hshh_deadline_reached(now_ms, s_machine.snapshot.command_deadline_ms)) {
        PR_WARN("[HSHH] active command lease expired");
        app_hshh_safe_stop(APP_HSHH_STOP_REASON_COMMAND_EXPIRED, now_ms);
    }

    if (s_machine.snapshot.motion_watchdog_active &&
        (uint32_t)(now_ms - s_machine.snapshot.last_motion_heartbeat_ms) >
            APP_HSHH_MOTION_HEARTBEAT_TIMEOUT_MS) {
        PR_WARN("[HSHH] motion heartbeat timed out");
        app_hshh_safe_stop(APP_HSHH_STOP_REASON_MOTION_HEARTBEAT_TIMEOUT, now_ms);
    }

    if (s_machine.snapshot.cloud_connected &&
        app_hshh_time_elapsed(now_ms, s_machine.snapshot.last_cloud_seen_ms, APP_HSHH_CLOUD_TIMEOUT_MS)) {
        PR_WARN("[HSHH] cloud heartbeat timed out");
        s_machine.snapshot.cloud_connected = false;
        if (app_hshh_state_is_moving()) {
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_CLOUD_TIMEOUT, now_ms);
        } else {
            app_hshh_return_to_idle(now_ms);
        }
    }

    if (s_machine.snapshot.cloud_reply_pending &&
        app_hshh_deadline_reached(now_ms, s_machine.snapshot.cloud_reply_deadline_ms)) {
        PR_WARN("[HSHH] cloud/VLM response timed out");
        if (app_hshh_state_is_moving()) {
            app_hshh_safe_stop(APP_HSHH_STOP_REASON_CLOUD_RESPONSE_TIMEOUT, now_ms);
        } else {
            app_hshh_return_to_idle(now_ms);
        }
    }

    if (app_hshh_time_elapsed(now_ms, s_machine.last_status_log_ms, APP_HSHH_STATUS_LOG_MS)) {
        s_machine.last_status_log_ms = now_ms;
        PR_INFO("[HSHH] state=%s cloud=%s lease=%s motion_watchdog=%s inference=%s",
                app_hshh_state_name(s_machine.snapshot.state),
                s_machine.snapshot.cloud_connected ? "online" : "offline",
                s_machine.snapshot.command_active ? "active" : "none",
                s_machine.snapshot.motion_watchdog_active ? "active" : "none",
                s_machine.snapshot.cloud_reply_pending ? "pending" : "none");
    }
}

void app_hshh_state_get_snapshot(app_hshh_state_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }

    *snapshot = s_machine.snapshot;
}

void app_hshh_state_run(void)
{
    app_hshh_event_envelope_t boot_event = {0};
    uint32_t now_ms = tal_system_get_millisecond();

    app_hshh_initialize(now_ms);

    boot_event.event = APP_HSHH_EVENT_BOOT_COMPLETED;
    boot_event.observed_at_ms = now_ms;
    boot_event.ttl_ms = 1000u;
    (void)app_hshh_state_post_event(&boot_event, now_ms);

    while (true) {
        now_ms = tal_system_get_millisecond();
        app_hshh_state_tick(now_ms);
        app_hshh_effects_tick(now_ms);
        tal_system_sleep(APP_HSHH_LOOP_INTERVAL_MS);
    }
}
