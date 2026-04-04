#ifndef PWM_OUTPUTS_H
#define PWM_OUTPUTS_H

#include "Config.h"
#include <Arduino.h>

class PWMOutputs {
private:
  // PWM channel assignments (using direct GPIO PWM)
  uint8_t channels[4] = {PWM_FL_PIN, PWM_FR_PIN, PWM_RL_PIN, PWM_RR_PIN};
  bool initialized = false;
  
  // PWM parameters for servo control
  // ESP32 PWM: 50 Hz for servos (20ms period)
  // Min pulse: 1ms (0°), Max pulse: 2ms (180°), Center: 1.5ms (90°)
  static constexpr uint32_t PWM_BASE_FREQ = 50;  // 50 Hz
  static constexpr uint8_t SUSPENSION_PWM_RESOLUTION = 10;  // 10-bit (0-1023)
  static constexpr uint32_t SERVO_PERIOD_US = 1000000UL / PWM_BASE_FREQ;
  static constexpr uint16_t SERVO_MIN_US = 1000;
  static constexpr uint16_t SERVO_CENTER_US = 1500;
  static constexpr uint16_t SERVO_MAX_US = 2000;
  static constexpr uint16_t PWM_MAX_DUTY = (1U << SUSPENSION_PWM_RESOLUTION) - 1;

  uint16_t microsecondsToDuty(uint16_t microseconds) const {
    microseconds = constrain(microseconds, SERVO_MIN_US, SERVO_MAX_US);
    const float duty = (static_cast<float>(microseconds) / static_cast<float>(SERVO_PERIOD_US)) * static_cast<float>(PWM_MAX_DUTY);
    return static_cast<uint16_t>(constrain(duty, 0.0f, static_cast<float>(PWM_MAX_DUTY)));
  }
  
public:
  void init() {
    // Configure PWM pins
    for (int i = 0; i < 4; i++) {
      ledcSetup(i, PWM_BASE_FREQ, SUSPENSION_PWM_RESOLUTION);
      ledcAttachPin(channels[i], i);
      ledcWrite(i, microsecondsToDuty(SERVO_CENTER_US));  // Initialize to center (1.5ms)
    }
    initialized = true;
    Serial.println("PWM outputs initialized");
  }
  
  void setChannel(uint8_t channel, float angle) {
    if (!initialized) return;
    if (channel >= 4) return;

    angle = constrain(angle, 0.0f, 180.0f);
    const uint16_t microseconds = static_cast<uint16_t>(SERVO_MIN_US + ((SERVO_MAX_US - SERVO_MIN_US) * (angle / 180.0f)));
    ledcWrite(channel, microsecondsToDuty(microseconds));
  }
  
  void setChannel(uint8_t channel, float angle, const ServoCalibration& cal) {
    if (!initialized) return;
    if (channel >= 4) return;
    
    // 1. Apply trim offset
    angle += cal.trim;
    
    // 2. Apply per-servo limits (final authority on safe travel)
    angle = constrain(angle, (float)cal.minLimit, (float)cal.maxLimit);
    
    // 3. Apply reverse if needed
    if (cal.reversed) {
      angle = 180.0f - angle;
    }
    
    // 4. Convert to PWM and send
    const uint16_t microseconds = static_cast<uint16_t>(SERVO_MIN_US + ((SERVO_MAX_US - SERVO_MIN_US) * (angle / 180.0f)));
    ledcWrite(channel, microsecondsToDuty(microseconds));
  }
  
  void setChannelMicroseconds(uint8_t channel, uint16_t microseconds) {
    if (!initialized) return;
    if (channel >= 4) return;
    
    ledcWrite(channel, microsecondsToDuty(microseconds));
  }

  // ==================== Aux Servo Outputs (Phase 4) ====================
  // Aux slots 0-9 use LEDC channels 4-13 on AUX_SERVO_PINS[].
  // Call initAux() once from setup() after init().

  void initAux() {
    if (!initialized) return;
    for (int i = 0; i < MAX_AUX_SERVOS; i++) {
      uint8_t pin = AUX_SERVO_PINS[i];
      int ch = 4 + i;
      ledcSetup(ch, PWM_BASE_FREQ, SUSPENSION_PWM_RESOLUTION);
      ledcAttachPin(pin, ch);
      ledcWrite(ch, microsecondsToDuty(SERVO_CENTER_US));  // center / stop (1.5 ms)
    }
    Serial.println("Aux PWM outputs initialized");
  }

  // Positional or pan servo: drive to microsecond position (900-2100 µs)
  void setAuxPositional(uint8_t slot, int32_t microseconds) {
    if (!initialized) return;
    if (slot >= MAX_AUX_SERVOS) return;
    microseconds = constrain(microseconds, (int32_t)900, (int32_t)2100);
    ledcWrite(4 + slot, microsecondsToDuty(static_cast<uint16_t>(microseconds)));
  }

  // Continuous servo: speed -100..100 (0 = stop, maps to 1000-2000 µs)
  void setAuxContinuous(uint8_t slot, int32_t speedPct) {
    if (!initialized) return;
    if (slot >= MAX_AUX_SERVOS) return;
    speedPct = constrain(speedPct, (int32_t)-100, (int32_t)100);
    int32_t us = 1500L + (speedPct * 5L);  // -100→1000 µs, 0→1500 µs, +100→2000 µs
    ledcWrite(4 + slot, microsecondsToDuty(static_cast<uint16_t>(us)));
  }

  // Relay: full-duty HIGH (on) or zero LOW (off)
  // Both relay and PWM types use LEDC so the pin stays configured; duty 0/255
  // gives a clean digital signal at 50 Hz that any relay module accepts.
  void setAuxRelay(uint8_t slot, bool on) {
    if (!initialized) return;
    if (slot >= MAX_AUX_SERVOS) return;
    ledcWrite(4 + slot, on ? PWM_MAX_DUTY : 0);
  }

  // Stop a single aux slot (center / stop for any type)
  void stopAux(uint8_t slot) {
    if (!initialized) return;
    if (slot >= MAX_AUX_SERVOS) return;
    ledcWrite(4 + slot, microsecondsToDuty(SERVO_CENTER_US));
  }
};

#endif
