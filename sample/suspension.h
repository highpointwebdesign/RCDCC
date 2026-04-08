#pragma once
#include <Arduino.h>
#include <ESP32Servo.h>
#include <Preferences.h>

// ─────────────────────────────────────────────
//  GPIO Pin assignments
//    FL → GPIO 25
//    FR → GPIO 26
//    RL → GPIO 17
//    RR → GPIO 18
// ─────────────────────────────────────────────
#define SERVO_FL_PIN   25
#define SERVO_FR_PIN   26
#define SERVO_RL_PIN   17
#define SERVO_RR_PIN   18

// Conservative pulse range for typical 180° hobby servos (µs)
#define PULSE_MIN      1000
#define PULSE_MAX      2000

// Safe mechanical envelope for 180° servos:
// center 90°, limited to ±85° to avoid hard-stop binding.
#define SERVO_DEG_MIN    5.0f
#define SERVO_DEG_MAX  175.0f
#define SERVO_DEG_MID   90.0f

// How many degrees = full suspension travel
#define SUSPENSION_TRAVEL_DEG  60.0f

// Mechanical travel envelope used by control math (tighter than servo hard-stop limits).
// Start with full-travel-derived bounds; tune these once measured on the truck.
#define SERVO_MECH_DEG_MIN (SERVO_DEG_MID - (SUSPENSION_TRAVEL_DEG / 2.0f))
#define SERVO_MECH_DEG_MAX (SERVO_DEG_MID + (SUSPENSION_TRAVEL_DEG / 2.0f))

// Leveling tolerance (degrees)
#define LEVEL_TOLERANCE  3.0f

// MPU settle time on boot (ms)
#define MPU_SETTLE_MS   5000

// Calibration: readings averaged for baseline
#define BASELINE_SAMPLES  50

// ─────────────────────────────────────────────
//  MPU Orientation presets
// ─────────────────────────────────────────────
enum class MPUOrientation : uint8_t {
    Z_UP_X_FWD   = 0,
    Z_UP_X_BACK  = 1,
    Z_UP_X_LEFT  = 2,
    Z_UP_X_RIGHT = 3,
    Z_DOWN_X_FWD = 4,
    Z_DOWN_X_BACK= 5
};

inline void applyOrientation(MPUOrientation ori, float rawPitch, float rawRoll,
                              float &outPitch, float &outRoll) {
    switch (ori) {
        case MPUOrientation::Z_UP_X_FWD:
            outPitch =  rawPitch; outRoll  =  rawRoll;  break;
        case MPUOrientation::Z_UP_X_BACK:
            outPitch = -rawPitch; outRoll  = -rawRoll;  break;
        case MPUOrientation::Z_UP_X_LEFT:
            outPitch =  rawRoll;  outRoll  = -rawPitch; break;
        case MPUOrientation::Z_UP_X_RIGHT:
            outPitch = -rawRoll;  outRoll  =  rawPitch; break;
        case MPUOrientation::Z_DOWN_X_FWD:
            outPitch = -rawPitch; outRoll  =  rawRoll;  break;
        case MPUOrientation::Z_DOWN_X_BACK:
            outPitch =  rawPitch; outRoll  = -rawRoll;  break;
        default:
            outPitch =  rawPitch; outRoll  =  rawRoll;  break;
    }
}

// ─────────────────────────────────────────────
//  ServoChannel — one suspension corner
// ─────────────────────────────────────────────
struct ServoChannel {
    const char* name;       // "FL", "FR", "RL", "RR"
    uint8_t     pin;
    bool        inverted;   // Flip direction for left/right side mounting
    float       currentDeg; // Last commanded logical position (pre-inversion)
    float       trimDeg = 0.0f;
    float       mechMinDeg = SERVO_MECH_DEG_MIN;
    float       mechMaxDeg = SERVO_MECH_DEG_MAX;
    Servo       servo;

        ServoChannel(const char* n = "",
                                 uint8_t p = 0,
                                 bool inv = false,
                                 float cur = SERVO_DEG_MID,
                                 float trim = 0.0f,
                                 float minDeg = SERVO_MECH_DEG_MIN,
                                 float maxDeg = SERVO_MECH_DEG_MAX)
                : name(n), pin(p), inverted(inv), currentDeg(cur),
                    trimDeg(trim), mechMinDeg(minDeg), mechMaxDeg(maxDeg), servo() {}

    void sanitizeLimits() {
        mechMinDeg = constrain(mechMinDeg, SERVO_DEG_MIN, SERVO_DEG_MAX);
        mechMaxDeg = constrain(mechMaxDeg, SERVO_DEG_MIN, SERVO_DEG_MAX);
        if (mechMinDeg > mechMaxDeg) {
            float t = mechMinDeg;
            mechMinDeg = mechMaxDeg;
            mechMaxDeg = t;
        }
        if ((mechMaxDeg - mechMinDeg) < 1.0f) {
            mechMaxDeg = min((float)SERVO_DEG_MAX, mechMinDeg + 1.0f);
        }
    }

    float applyServoLimits(float deg) const {
        return constrain(deg + trimDeg, mechMinDeg, mechMaxDeg);
    }

    bool wouldSaturate(float deg) const {
        float withTrim = deg + trimDeg;
        return (withTrim < mechMinDeg || withTrim > mechMaxDeg);
    }

    void begin() {
        sanitizeLimits();
        servo.setPeriodHertz(50);
        servo.attach(pin, PULSE_MIN, PULSE_MAX);
        Serial.printf("[SERVO] %s attached to pin %d\n", name, pin);
        writeDeg(SERVO_DEG_MID);
        Serial.printf("[SERVO] %s -> center (%.1f deg)\n", name, SERVO_DEG_MID);
    }

    // Write degrees, respects inversion and safe mechanical limits
    void writeDeg(float deg) {
        currentDeg = deg;
        deg = applyServoLimits(deg);

        if (inverted) {
            deg = SERVO_DEG_MID - (deg - SERVO_DEG_MID);
        }

        deg = constrain(deg, SERVO_DEG_MIN, SERVO_DEG_MAX);

        float pulse = PULSE_MIN + (deg / SERVO_DEG_MAX) * (float)(PULSE_MAX - PULSE_MIN);
        int pulseInt = (int)constrain(pulse, (float)PULSE_MIN, (float)PULSE_MAX);

        // Serial.printf("[SERVO] %s deg=%.1f pulse=%d us\n", name, deg, pulseInt);
        servo.writeMicroseconds(pulseInt);
    }

    void savePrefs(Preferences &prefs) const {
        prefs.putBool((String(name) + "_inv").c_str(), inverted);
        prefs.putFloat((String(name) + "_trim").c_str(), trimDeg);
        prefs.putFloat((String(name) + "_min").c_str(), mechMinDeg);
        prefs.putFloat((String(name) + "_max").c_str(), mechMaxDeg);
    }

    void loadPrefs(Preferences &prefs) {
        inverted = prefs.getBool((String(name) + "_inv").c_str(), false);
        trimDeg = prefs.getFloat((String(name) + "_trim").c_str(), 0.0f);
        mechMinDeg = prefs.getFloat((String(name) + "_min").c_str(), SERVO_MECH_DEG_MIN);
        mechMaxDeg = prefs.getFloat((String(name) + "_max").c_str(), SERVO_MECH_DEG_MAX);
        trimDeg = constrain(trimDeg, -30.0f, 30.0f);
        sanitizeLimits();
    }
};

// ─────────────────────────────────────────────
//  SuspensionConfig — global tuning parameters
// ─────────────────────────────────────────────
struct SuspensionConfig {
    float   rideHeight    = 0.0f;   // -1.0 (low) ... 0.0 (center) ... +1.0 (high)
    float   reactionSpeed = 0.4f;   // 0.0 (lazy) ... 1.0 (instant setpoint tracking)
    float   range         = 1.0f;   // 0.1 (small throw) ... 2.0 (large throw)
    float   inputDeadband = 0.30f;  // 0.00 ... 1.00 deg  — noise gate around zero
    float   inputHyst     = 0.15f;  // 0.00 ... 0.50 deg  — hysteresis to avoid chatter
    float   omegaN        = 3.0f;   // 0.5 ... 15.0 rad/s  — natural frequency (oscillation speed)
    float   zeta          = 0.25f;  // 0.05 ... 0.95  — damping ratio (<1.0 = underdamped = oscillates)
    float   balance       = 0.0f;   // -1.0 (all rear) ... +1.0 (all front)
    uint8_t refreshRateHz = 25;
    MPUOrientation mpuOrientation = MPUOrientation::Z_UP_X_FWD;
    bool    active        = true;

    void save(Preferences &prefs) const {
        prefs.putFloat("rideH",  rideHeight);
        prefs.putFloat("react",  reactionSpeed);
        prefs.putFloat("range",  range);
        prefs.putFloat("inDb",   inputDeadband);
        prefs.putFloat("inHy",   inputHyst);
        prefs.putFloat("omegaN", omegaN);
        prefs.putFloat("zeta",   zeta);
        prefs.putFloat("bal",    balance);
        prefs.putUChar("hz",     refreshRateHz);
        prefs.putUChar("ori",    (uint8_t)mpuOrientation);
        prefs.putBool("active",  active);
    }

    void load(Preferences &prefs) {
        rideHeight    = prefs.getFloat("rideH",  0.0f);
        reactionSpeed = prefs.getFloat("react",  0.4f);
        range         = prefs.getFloat("range",  1.0f);
        inputDeadband = prefs.getFloat("inDb",   0.30f);
        inputHyst     = prefs.getFloat("inHy",   0.15f);
        omegaN        = prefs.getFloat("omegaN", 3.0f);
        zeta          = prefs.getFloat("zeta",   0.25f);
        balance       = prefs.getFloat("bal",    0.0f);
        refreshRateHz = prefs.getUChar("hz",     25);
        mpuOrientation = (MPUOrientation)prefs.getUChar("ori", 0);
        active        = prefs.getBool("active",  true);
    }
};

// ─────────────────────────────────────────────
//  Corner target math
// ─────────────────────────────────────────────
struct CornerTargets {
    float fl, fr, rl, rr;   // absolute servo degrees
    bool  satFL, satFR, satRL, satRR;  // true = corner hit a servo limit
};

inline CornerTargets computeTargets(float pitch, float roll,
                                    const SuspensionConfig &cfg) {
    float rideOffsetDeg = cfg.rideHeight * (SUSPENSION_TRAVEL_DEG / 2.0f);
    float effectRange = constrain(cfg.range, 0.1f, 4.0f);

    float baseCorrect = SUSPENSION_TRAVEL_DEG / 2.0f;
    // pitch/roll here are the spring-damper output positions (posP/posR from main.cpp).
    // range scales how many servo degrees correspond to unit spring displacement.
    float p = constrain(pitch * effectRange, -baseCorrect, baseCorrect);
    float r = constrain(roll  * effectRange, -baseCorrect, baseCorrect);

    float frontW = constrain(1.0f + cfg.balance, 0.0f, 2.0f);
    float rearW  = constrain(1.0f - cfg.balance, 0.0f, 2.0f);

    CornerTargets t;
    t.fl = SERVO_DEG_MID + rideOffsetDeg + (p * frontW) + ( r);
    t.fr = SERVO_DEG_MID + rideOffsetDeg + (p * frontW) + (-r);
    t.rl = SERVO_DEG_MID + rideOffsetDeg + (-p * rearW) + ( r);
    t.rr = SERVO_DEG_MID + rideOffsetDeg + (-p * rearW) + (-r);

    // Detect saturation before group shift using mechanical travel envelope.
    t.satFL = (t.fl < SERVO_MECH_DEG_MIN || t.fl > SERVO_MECH_DEG_MAX);
    t.satFR = (t.fr < SERVO_MECH_DEG_MIN || t.fr > SERVO_MECH_DEG_MAX);
    t.satRL = (t.rl < SERVO_MECH_DEG_MIN || t.rl > SERVO_MECH_DEG_MAX);
    t.satRR = (t.rr < SERVO_MECH_DEG_MIN || t.rr > SERVO_MECH_DEG_MAX);

    // Shift the whole pattern to fit inside the mechanical envelope
    // rather than pinning individual corners independently.
    float maxTarget = max(max(t.fl, t.fr), max(t.rl, t.rr));
    float minTarget = min(min(t.fl, t.fr), min(t.rl, t.rr));
    float shift = 0.0f;

    if (maxTarget > SERVO_MECH_DEG_MAX) {
        shift = SERVO_MECH_DEG_MAX - maxTarget;
    }
    if (minTarget + shift < SERVO_MECH_DEG_MIN) {
        shift += SERVO_MECH_DEG_MIN - (minTarget + shift);
    }

    t.fl += shift;
    t.fr += shift;
    t.rl += shift;
    t.rr += shift;

    t.fl = constrain(t.fl, SERVO_MECH_DEG_MIN, SERVO_MECH_DEG_MAX);
    t.fr = constrain(t.fr, SERVO_MECH_DEG_MIN, SERVO_MECH_DEG_MAX);
    t.rl = constrain(t.rl, SERVO_MECH_DEG_MIN, SERVO_MECH_DEG_MAX);
    t.rr = constrain(t.rr, SERVO_MECH_DEG_MIN, SERVO_MECH_DEG_MAX);

    return t;
}