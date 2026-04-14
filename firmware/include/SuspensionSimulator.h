#ifndef SUSPENSION_SIMULATOR_H
#define SUSPENSION_SIMULATOR_H

#include "Config.h"
#include <cmath>
#include <Arduino.h>

// ── Suspension travel envelope (degrees) ────────────────────────────────────
// Center at 90°, ±80° travel = 160° total (mechanical 10..170 window).
static constexpr float SUSP_SIM_DEG_MID      = 90.0f;
static constexpr float SUSP_SIM_TRAVEL_DEG   = 160.0f;
static constexpr float SUSP_SIM_MECH_MIN     = SUSP_SIM_DEG_MID - (SUSP_SIM_TRAVEL_DEG / 2.0f);  // 10°
static constexpr float SUSP_SIM_MECH_MAX     = SUSP_SIM_DEG_MID + (SUSP_SIM_TRAVEL_DEG / 2.0f);  // 170°

class SuspensionSimulator {
private:
  SuspensionConfig config;
  ServoConfig      servoConfig;

  // ── Spring-damper physics state ──────────────────────────────────────────
  float posP = 0.0f;   // spring output — pitch axis (degrees from neutral)
  float posR = 0.0f;   // spring output — roll axis  (degrees from neutral)
  float velP = 0.0f;   // body velocity — pitch axis (deg/s)
  float velR = 0.0f;   // body velocity — roll axis  (deg/s)
  float setP = 0.0f;   // equilibrium target — slews toward measured pitch
  float setR = 0.0f;   // equilibrium target — slews toward measured roll

  // Deadband hysteresis engagement flags
  bool pitchEngaged = false;
  bool rollEngaged  = false;

  // Mild input IIR smoothing state
  float inPitch = 0.0f;
  float inRoll  = 0.0f;

  // dt tracking
  uint32_t lastUpdateUs = 0;

  // Per-corner output cache (degrees, 0-180)
  float outFL = SUSP_SIM_DEG_MID;
  float outFR = SUSP_SIM_DEG_MID;
  float outRL = SUSP_SIM_DEG_MID;
  float outRR = SUSP_SIM_DEG_MID;

  // ── Deadband + hysteresis gate ──────────────────────────────────────────
  float applyDeadbandHyst(float in, bool& engaged) const {
    float a   = fabsf(in);
    float db  = constrain(config.inputDeadband, 0.0f, 1.0f);
    float hy  = constrain(config.inputHyst,     0.0f, 0.5f);

    if (engaged) {
      if (a <= db) { engaged = false; return 0.0f; }
      return copysignf(fmaxf(0.0f, a - db), in);
    }
    if (a >= (db + hy)) {
      engaged = true;
      return copysignf(fmaxf(0.0f, a - db), in);
    }
    return 0.0f;
  }

  // ── Corner target computation ────────────────────────────────────────────
  // pitch / roll are the spring-damper outputs (posP, posR) already in degrees.
  // Writes results directly to outFL/FR/RL/RR.
  void computeCorners(float pitch, float roll) {
    // Ride-height offset: rideHeightOffset 0-100 → -30..+30 deg from centre
    float rideOffsetDeg = ((config.rideHeightOffset / 100.0f) - 0.5f) * SUSP_SIM_TRAVEL_DEG;

    float effectRange = constrain(config.range, 0.1f, 4.0f);
    float baseLimit   = SUSP_SIM_TRAVEL_DEG / 2.0f;

    float p = constrain(pitch * effectRange, -baseLimit, baseLimit);
    float r = constrain(roll  * effectRange, -baseLimit, baseLimit);

    // frontRearBalance: 0.0 = all rear, 1.0 = all front → convert to -1..+1
    float bal  = constrain(config.frontRearBalance * 2.0f - 1.0f, -1.0f, 1.0f);
    float fntW = constrain(1.0f + bal, 0.0f, 2.0f);
    float rearW = constrain(1.0f - bal, 0.0f, 2.0f);

    float fl = SUSP_SIM_DEG_MID + rideOffsetDeg + (p * fntW) + ( r);
    float fr = SUSP_SIM_DEG_MID + rideOffsetDeg + (p * fntW) + (-r);
    float rl = SUSP_SIM_DEG_MID + rideOffsetDeg + (-p * rearW) + ( r);
    float rr = SUSP_SIM_DEG_MID + rideOffsetDeg + (-p * rearW) + (-r);

    // Group-shift to stay inside mechanical envelope rather than
    // pinning corners independently.
    float maxT = fmaxf(fmaxf(fl, fr), fmaxf(rl, rr));
    float minT = fminf(fminf(fl, fr), fminf(rl, rr));
    float shift = 0.0f;
    if (maxT > SUSP_SIM_MECH_MAX) shift = SUSP_SIM_MECH_MAX - maxT;
    if ((minT + shift) < SUSP_SIM_MECH_MIN) shift += SUSP_SIM_MECH_MIN - (minT + shift);

    outFL = constrain(fl + shift, SUSP_SIM_MECH_MIN, SUSP_SIM_MECH_MAX);
    outFR = constrain(fr + shift, SUSP_SIM_MECH_MIN, SUSP_SIM_MECH_MAX);
    outRL = constrain(rl + shift, SUSP_SIM_MECH_MIN, SUSP_SIM_MECH_MAX);
    outRR = constrain(rr + shift, SUSP_SIM_MECH_MIN, SUSP_SIM_MECH_MAX);
  }

public:
  void init(const SuspensionConfig& cfg, const ServoConfig& servoCfg) {
    config     = cfg;
    servoConfig = servoCfg;
    // Reset physics state on config change so the truck snaps cleanly.
    posP = 0.0f; posR = 0.0f;
    velP = 0.0f; velR = 0.0f;
    setP = 0.0f; setR = 0.0f;
    pitchEngaged = false;
    rollEngaged  = false;
    inPitch = 0.0f;
    inRoll  = 0.0f;
    lastUpdateUs = 0;
    computeCorners(0.0f, 0.0f);
  }

  // Called once per sensor loop.  roll / pitch are in degrees; verticalAccel unused
  // (retained in signature for API compatibility — could be used for bump detection later).
  void update(float roll, float pitch, float /*verticalAccel*/) {
    // ── dt ────────────────────────────────────────────────────────────────
    uint32_t nowUs = micros();
    float dt = (lastUpdateUs == 0)
               ? (1.0f / SUSPENSION_SAMPLE_RATE_HZ)
               : constrain(static_cast<float>(nowUs - lastUpdateUs) / 1e6f, 0.001f, 0.1f);
    lastUpdateUs = nowUs;

    // ── Deadband + hysteresis ────────────────────────────────────────────
    float gatedPitch = applyDeadbandHyst(pitch, pitchEngaged);
    float gatedRoll  = applyDeadbandHyst(roll,  rollEngaged);

    // ── Mild IIR input smoothing (α ≈ 0.28 matches sample/main.cpp) ─────
    const float inputAlpha = 0.28f;
    inPitch += inputAlpha * (gatedPitch - inPitch);
    inRoll  += inputAlpha * (gatedRoll  - inRoll);

    // ── Slew equilibrium target toward measured angle ────────────────────
    // reactionSpeed 0-100 → slewMax 1 … 100 deg/s
    float slewMax = fmaxf(0.1f, config.reactionSpeed) * 50.0f * dt;
    setP += constrain(inPitch - setP, -slewMax, slewMax);
    setR += constrain(inRoll  - setR, -slewMax, slewMax);

    // ── 2nd-order underdamped spring-damper (Euler integration) ─────────
    //   acceleration = ωₙ²(setPoint − pos) − 2ζωₙ·vel
    float wn   = constrain(config.omegaN, 0.5f, 15.0f);
    float wn2  = wn * wn;
    float c2wn = 2.0f * constrain(config.zeta, 0.05f, 0.95f) * wn;

    velP += (wn2 * (setP - posP) - c2wn * velP) * dt;
    velR += (wn2 * (setR - posR) - c2wn * velR) * dt;
    posP += velP * dt;
    posR += velR * dt;

    // ── Map physics outputs to 4 corner servo degrees ────────────────────
    computeCorners(posP, posR);
  }

  float getFrontLeftOutput()  const { return outFL; }
  float getFrontRightOutput() const { return outFR; }
  float getRearLeftOutput()   const { return outRL; }
  float getRearRightOutput()  const { return outRR; }
};

#endif
