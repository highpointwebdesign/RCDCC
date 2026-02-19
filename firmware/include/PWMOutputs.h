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
};

#endif
