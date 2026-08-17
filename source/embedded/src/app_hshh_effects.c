#include "app_hshh_effects.h"

#include <stddef.h>

#include "app_hshh_agent.h"
#include "app_hshh_audio.h"
#include "app_hshh_button.h"
#include "app_hshh_display.h"
#include "app_hshh_lan.h"
#include "app_hshh_state.h"
#include "app_hshh_voice.h"
#include "tal_api.h"

static app_hshh_state_t s_last_state = (app_hshh_state_t)0xff;
static app_hshh_consent_scope_t s_offered_scope;
static app_hshh_consent_scope_t s_confirmed_scope;
static uint32_t s_offer_expires_at_ms;
static volatile uint32_t s_remote_expression;
static volatile uint32_t s_remote_expression_duration_ms;
static volatile uint32_t s_remote_sound;
static bool s_agent_connected;
static bool s_remote_expression_active;
static bool s_remote_response_active;
static uint32_t s_remote_expression_until_ms;
static uint32_t s_remote_response_until_ms;

static bool app_hshh_deadline_reached(uint32_t now_ms, uint32_t deadline_ms)
{
    return (int32_t)(now_ms - deadline_ms) >= 0;
}

static app_hshh_expression_t app_hshh_expression_for_state(app_hshh_state_t state)
{
    switch (state) {
    case APP_HSHH_STATE_NOTICED:
        return APP_HSHH_EXPRESSION_NOTICED;
    case APP_HSHH_STATE_LISTENING:
        return APP_HSHH_EXPRESSION_LISTENING;
    case APP_HSHH_STATE_THINKING:
        return APP_HSHH_EXPRESSION_THINKING;
    case APP_HSHH_STATE_RESPONDING:
    case APP_HSHH_STATE_APPROACHING:
    case APP_HSHH_STATE_NEAR_USER:
    case APP_HSHH_STATE_HUGGING:
    case APP_HSHH_STATE_HELD:
    case APP_HSHH_STATE_RELEASED:
        return APP_HSHH_EXPRESSION_HAPPY;
    case APP_HSHH_STATE_SAFE_STOP:
        return APP_HSHH_EXPRESSION_CONFUSED;
    case APP_HSHH_STATE_FAULT:
        return APP_HSHH_EXPRESSION_SAD;
    case APP_HSHH_STATE_LOW_BATTERY:
        return APP_HSHH_EXPRESSION_SLEEPING;
    case APP_HSHH_STATE_BOOT:
    case APP_HSHH_STATE_IDLE:
    default:
        return APP_HSHH_EXPRESSION_IDLE;
    }
}

static void app_hshh_post_simple_event(app_hshh_event_t event, uint32_t now_ms)
{
    app_hshh_event_envelope_t envelope = {0};

    envelope.event = event;
    envelope.observed_at_ms = now_ms;
    envelope.ttl_ms = 1000u;
    (void)app_hshh_state_post_event(&envelope, now_ms);
}

static bool app_hshh_state_has_physical_action(app_hshh_state_t state)
{
    return state == APP_HSHH_STATE_APPROACHING || state == APP_HSHH_STATE_HUGGING ||
           state == APP_HSHH_STATE_HELD;
}

static bool app_hshh_state_requires_local_override(app_hshh_state_t state)
{
    return state == APP_HSHH_STATE_SAFE_STOP || state == APP_HSHH_STATE_FAULT ||
           state == APP_HSHH_STATE_LOW_BATTERY || state == APP_HSHH_STATE_HELD;
}

OPERATE_RET app_hshh_effects_init(void)
{
    OPERATE_RET first_error = OPRT_OK;
    OPERATE_RET rt;

    if (!app_hshh_display_is_ready()) {
        rt = app_hshh_display_init();
        if (rt != OPRT_OK) {
            first_error = rt;
            PR_ERR("[HSHH EFFECTS] display degraded, rt=%d", rt);
        }
    }
    rt = app_hshh_audio_init();
    if (rt != OPRT_OK) {
        if (first_error == OPRT_OK) {
            first_error = rt;
        }
        PR_ERR("[HSHH EFFECTS] audio degraded, rt=%d", rt);
    }
    rt = app_hshh_button_init();
    if (rt != OPRT_OK) {
        if (first_error == OPRT_OK) {
            first_error = rt;
        }
        PR_ERR("[HSHH EFFECTS] button degraded, rt=%d", rt);
    }
    return first_error;
}

void app_hshh_effects_offer_consent(app_hshh_consent_scope_t scope, uint32_t expires_at_ms)
{
    if (scope != APP_HSHH_CONSENT_APPROACH && scope != APP_HSHH_CONSENT_HUG) {
        s_offered_scope = APP_HSHH_CONSENT_NONE;
        s_offer_expires_at_ms = 0u;
        return;
    }
    s_confirmed_scope = APP_HSHH_CONSENT_NONE;
    s_offered_scope = scope;
    s_offer_expires_at_ms = expires_at_ms;
}

bool app_hshh_effects_take_confirmation(app_hshh_consent_scope_t *scope)
{
    if (scope == NULL || s_confirmed_scope == APP_HSHH_CONSENT_NONE) {
        return false;
    }
    *scope = s_confirmed_scope;
    s_confirmed_scope = APP_HSHH_CONSENT_NONE;
    return true;
}

void app_hshh_effects_local_stop(uint32_t now_ms)
{
    s_offered_scope = APP_HSHH_CONSENT_NONE;
    s_confirmed_scope = APP_HSHH_CONSENT_NONE;
    s_offer_expires_at_ms = 0u;
    app_hshh_audio_stop();
    app_hshh_voice_stop();
    app_hshh_post_simple_event(APP_HSHH_EVENT_LOCAL_STOP, now_ms);
    /* release_hug also stops the base in the ESP32-S3 controller. */
    (void)app_hshh_lan_request_skill(APP_HSHH_LAN_SKILL_RELEASE_HUG);
    (void)app_hshh_audio_play_cue(APP_HSHH_AUDIO_CUE_STOP);
    app_hshh_agent_notify_stop();
}

OPERATE_RET app_hshh_effects_queue_expression(uint8_t expression, uint32_t duration_ms)
{
    if (expression > (uint8_t)APP_HSHH_EXPRESSION_ANGRY || duration_ms < 100u || duration_ms > 30000u) {
        return OPRT_INVALID_PARM;
    }
    __atomic_store_n(&s_remote_expression_duration_ms, duration_ms, __ATOMIC_RELEASE);
    __atomic_store_n(&s_remote_expression, (uint32_t)expression + 1u, __ATOMIC_RELEASE);
    return OPRT_OK;
}

OPERATE_RET app_hshh_effects_queue_sound(uint8_t sound)
{
    if (sound > (uint8_t)APP_HSHH_AUDIO_CUE_STOP) {
        return OPRT_INVALID_PARM;
    }
    __atomic_store_n(&s_remote_sound, (uint32_t)sound + 1u, __ATOMIC_RELEASE);
    return OPRT_OK;
}

void app_hshh_effects_tick(uint32_t now_ms)
{
    app_hshh_state_snapshot_t snapshot = {0};
    const uint32_t audio_events = app_hshh_audio_take_events();
    const uint32_t button_events = app_hshh_button_take_events();
    const uint32_t remote_expression = __atomic_exchange_n(&s_remote_expression, 0u, __ATOMIC_ACQ_REL);
    uint32_t remote_expression_duration_ms = 0u;
    const uint32_t remote_sound = __atomic_exchange_n(&s_remote_sound, 0u, __ATOMIC_ACQ_REL);
    const uint32_t agent_events = app_hshh_agent_take_local_events();
    const bool agent_ready = app_hshh_agent_is_ready();

    if (agent_ready) {
        app_hshh_state_cloud_heartbeat(now_ms);
    } else if (s_agent_connected) {
        app_hshh_state_set_cloud_connected(false, now_ms);
    }
    s_agent_connected = agent_ready;

    if ((agent_events & APP_HSHH_AGENT_LOCAL_CONTEXT_READY) != 0u) {
        app_hshh_post_simple_event(APP_HSHH_EVENT_CONTEXT_READY, now_ms);
    }

    if (remote_expression > 0u) {
        remote_expression_duration_ms =
            __atomic_exchange_n(&s_remote_expression_duration_ms, 0u, __ATOMIC_ACQ_REL);
        app_hshh_display_set_expression((app_hshh_expression_t)(remote_expression - 1u));
        s_remote_expression_active = true;
        s_remote_expression_until_ms = now_ms +
            (remote_expression_duration_ms >= 100u ? remote_expression_duration_ms : 3000u);
        app_hshh_state_get_snapshot(&snapshot);
        if (snapshot.state == APP_HSHH_STATE_THINKING || snapshot.state == APP_HSHH_STATE_LISTENING) {
            app_hshh_post_simple_event(APP_HSHH_EVENT_RESPONSE_STARTED, now_ms);
            s_remote_response_active = true;
            s_remote_response_until_ms = s_remote_expression_until_ms;
        }
    }
    if (remote_sound > 0u) {
        (void)app_hshh_audio_play_cue((app_hshh_audio_cue_t)(remote_sound - 1u));
        app_hshh_state_get_snapshot(&snapshot);
        if (!s_remote_response_active &&
            (snapshot.state == APP_HSHH_STATE_THINKING || snapshot.state == APP_HSHH_STATE_LISTENING)) {
            app_hshh_post_simple_event(APP_HSHH_EVENT_RESPONSE_STARTED, now_ms);
            s_remote_response_active = true;
            s_remote_response_until_ms = now_ms + 1500u;
        }
    }

    if ((audio_events & APP_HSHH_AUDIO_EVENT_VAD_START) != 0u) {
        app_hshh_voice_on_vad(true);
        app_hshh_post_simple_event(APP_HSHH_EVENT_SPEECH_STARTED, now_ms);
        app_hshh_agent_notify_speech(true);
    }
    if ((audio_events & APP_HSHH_AUDIO_EVENT_VAD_END) != 0u) {
        app_hshh_voice_on_vad(false);
        app_hshh_post_simple_event(APP_HSHH_EVENT_SPEECH_ENDED, now_ms);
        app_hshh_agent_notify_speech(false);
    }
    (void)app_hshh_voice_get_state();

    if (s_offered_scope != APP_HSHH_CONSENT_NONE &&
        app_hshh_deadline_reached(now_ms, s_offer_expires_at_ms)) {
        PR_INFO("[HSHH CONSENT] invitation expired without pressure");
        s_offered_scope = APP_HSHH_CONSENT_NONE;
        s_offer_expires_at_ms = 0u;
    }
    if ((button_events & APP_HSHH_BUTTON_EVENT_EMERGENCY_RELEASE) != 0u) {
        PR_WARN("[HSHH BUTTON] local stop and release");
        app_hshh_effects_local_stop(now_ms);
    } else if ((button_events & APP_HSHH_BUTTON_EVENT_REJECT) != 0u) {
        app_hshh_state_get_snapshot(&snapshot);
        s_offered_scope = APP_HSHH_CONSENT_NONE;
        s_confirmed_scope = APP_HSHH_CONSENT_NONE;
        s_offer_expires_at_ms = 0u;
        PR_INFO("[HSHH CONSENT] invitation rejected; it will not be repeated this scene");
        app_hshh_agent_notify_reject();
        if (app_hshh_state_has_physical_action(snapshot.state)) {
            app_hshh_effects_local_stop(now_ms);
        }
    } else if ((button_events & APP_HSHH_BUTTON_EVENT_CONFIRM) != 0u) {
        if (s_offered_scope != APP_HSHH_CONSENT_NONE &&
            !app_hshh_deadline_reached(now_ms, s_offer_expires_at_ms)) {
            s_confirmed_scope = s_offered_scope;
            s_offered_scope = APP_HSHH_CONSENT_NONE;
            s_offer_expires_at_ms = 0u;
            (void)app_hshh_audio_play_cue(APP_HSHH_AUDIO_CUE_CONFIRM);
            PR_INFO("[HSHH CONSENT] explicit button confirmation recorded");
            app_hshh_agent_notify_confirmation(s_confirmed_scope == APP_HSHH_CONSENT_HUG);
        } else {
            PR_DEBUG("[HSHH BUTTON] confirmation ignored: no current invitation");
        }
    }

    if (s_remote_expression_active &&
        app_hshh_deadline_reached(now_ms, s_remote_expression_until_ms)) {
        s_remote_expression_active = false;
        app_hshh_state_get_snapshot(&snapshot);
        app_hshh_display_set_expression(app_hshh_expression_for_state(snapshot.state));
    }
    if (s_remote_response_active &&
        app_hshh_deadline_reached(now_ms, s_remote_response_until_ms)) {
        s_remote_response_active = false;
        app_hshh_post_simple_event(APP_HSHH_EVENT_RESPONSE_FINISHED, now_ms);
    }

    app_hshh_state_get_snapshot(&snapshot);
    if (snapshot.state != s_last_state) {
        if (!s_remote_expression_active || app_hshh_state_requires_local_override(snapshot.state)) {
            app_hshh_display_set_expression(app_hshh_expression_for_state(snapshot.state));
        }
        if (app_hshh_state_requires_local_override(snapshot.state)) {
            s_remote_expression_active = false;
            s_remote_response_active = false;
        }
        if (snapshot.state == APP_HSHH_STATE_NOTICED) {
            (void)app_hshh_audio_play_cue(APP_HSHH_AUDIO_CUE_NOTICED);
        } else if (snapshot.state == APP_HSHH_STATE_HELD || snapshot.state == APP_HSHH_STATE_HUGGING) {
            (void)app_hshh_audio_play_cue(APP_HSHH_AUDIO_CUE_HAPPY);
        } else if (snapshot.state == APP_HSHH_STATE_SAFE_STOP || snapshot.state == APP_HSHH_STATE_FAULT) {
            (void)app_hshh_audio_play_cue(APP_HSHH_AUDIO_CUE_CONFUSED);
        }
        s_last_state = snapshot.state;
    }
    app_hshh_display_tick(now_ms);
}
