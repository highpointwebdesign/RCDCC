#ifndef PWM_OUTPUTS_H
#define PWM_OUTPUTS_H

#include "Config.h"
#include <Arduino.h>

class PWMOutputs {
private:
  // PWM channel assignments (using direct GPIO PWM)
  uint8_t channels[4] = {PWM_FL_PIN, PWM_FR_PIN, PWM_RL_PIN, PWM_RR_PIN};
  
  // PWM parameters for servo control
  // ESP32 PWM: 50 Hz for servos (20ms period)
  // Min pulse: 1ms (0°), Max pulse: 2ms (180°), Center: 1.5ms (90°)
  static constexpr uint32_t PWM_BASE_FREQ = 50;  // 50 Hz
  static constexpr uint8_t SUSPENSION_PWM_RESOLUTION = 8;   // 8-bit (0-255)
  
public:
  void init() {
    // Configure PWM pins
    for (int i = 0; i < 4; i++) {
      ledcSetup(i, PWM_BASE_FREQ, SUSPENSION_PWM_RESOLUTION);
      ledcAttachPin(channels[i], i);
      ledcWrite(i, 128);  // Initialize to center (1.5ms)
    }
    Serial.println("PWM outputs initialized");
  }
  
  void setChannel(uint8_t channel, float angle) {
    if (channel >= 4) return;
    
    // Convert angle (0-180) to PWM value (0-255)
    // 0° = 1ms = 51 counts (at 50Hz, 8-bit)
    // 90° = 1.5ms = 76 counts
    // 180° = 2ms = 102 counts
    
    // Map 0-180 degrees to 51-102 PWM counts
    float pwmValue = 51.0f + (angle / 180.0f) * 51.0f;
    pwmValue = constrain(pwmValue, 51.0f, 102.0f);
    
    ledcWrite(channel, (uint8_t)pwmValue);
  }
  
  void setChannel(uint8_t channel, float angle, const ServoCalibration& cal) {
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
    float pwmValue = 51.0f + (angle / 180.0f) * 51.0f;
    pwmValue = constrain(pwmValue, 51.0f, 102.0f);
    
    ledcWrite(channel, (uint8_t)pwmValue);
  }
  
  void setChannelMicroseconds(uint8_t channel, uint16_t microseconds) {
    if (channel >= 4) return;
    
    // Convert microseconds to PWM value at 50Hz, 8-bit resolution
    // 1000us = 51 counts, 2000us = 102 counts
    // Resolution: 20000us / 256 = 78.125us per count
    
    microseconds = constrain(microseconds, (uint16_t)1000, (uint16_t)2000);
    uint8_t pwmValue = ((microseconds - 1000) / 78.125f) + 51.0f;
    
    ledcWrite(channel, pwmValue);
  }

  // ==================== Aux Servo Outputs (Phase 4) ====================
  // Aux slots 0-9 use LEDC channels 4-13 on AUX_SERVO_PINS[].
  // Call initAux() once from setup() after init().

  void initAux() {
    for (int i = 0; i < MAX_AUX_SERVOS; i++) {
      uint8_t pin = AUX_SERVO_PINS[i];
      int ch = 4 + i;
      ledcSetup(ch, PWM_BASE_FREQ, SUSPENSION_PWM_RESOLUTION);
      ledcAttachPin(pin, ch);
      ledcWrite(ch, 128);  // center / stop (1.5 ms)
    }
    Serial.println("Aux PWM outputs initialized");
  }

  // Positional or pan servo: drive to microsecond position (900-2100 µs)
  void setAuxPositional(uint8_t slot, int32_t microseconds) {
    if (slot >= MAX_AUX_SERVOS) return;
    microseconds = constrain(microseconds, (int32_t)900, (int32_t)2100);
    uint8_t pwmValue = (uint8_t)(((microseconds - 1000) / 78.125f) + 51.0f);
    ledcWrite(4 + slot, pwmValue);
  }

  // Continuous servo: speed -100..100 (0 = stop, maps to 1000-2000 µs)
  void setAuxContinuous(uint8_t slot, int32_t speedPct) {
    if (slot >= MAX_AUX_SERVOS) return;
    speedPct = constrain(speedPct, (int32_t)-100, (int32_t)100);
    int32_t us = 1500L + (speedPct * 5L);  // -100→1000 µs, 0→1500 µs, +100→2000 µs
    uint8_t pwmValue = (uint8_t)(((us - 1000) / 78.125f) + 51.0f);
    ledcWrite(4 + slot, pwmValue);
  }

  // Relay: full-duty HIGH (on) or zero LOW (off)
  // Both relay and PWM types use LEDC so the pin stays configured; duty 0/255
  // gives a clean digital signal at 50 Hz that any relay module accepts.
  void setAuxRelay(uint8_t slot, bool on) {
    if (slot >= MAX_AUX_SERVOS) return;
    ledcWrite(4 + slot, on ? 255 : 0);
  }

  // Stop a single aux slot (center / stop for any type)
  void stopAux(uint8_t slot) {
    if (slot >= MAX_AUX_SERVOS) return;
    ledcWrite(4 + slot, 128);
  }
};

#endif
