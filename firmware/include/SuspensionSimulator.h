#ifndef SUSPENSION_SIMULATOR_H
#define SUSPENSION_SIMULATOR_H

#include "Config.h"
#include <cmath>

class SuspensionSimulator {
private:
  SuspensionConfig config;
  ServoConfig servoConfig;
  
  // Suspension state for each corner
  struct CornerState {
    float position = 0.0f;  // 0-180 servo position
    float velocity = 0.0f;
    float target = 0.0f;
  };
  
  CornerState frontLeft;
  CornerState frontRight;
  CornerState rearLeft;
  CornerState rearRight;
  
  float lastRoll = 0.0f;
  float lastPitch = 0.0f;
  float lastVerticalAccel = 0.0f;
  
  float calculatedCenterPosition = 90.0f;  // Default to middle

public:
  void init(const SuspensionConfig& cfg, const ServoConfig& servoCfg) {
    config = cfg;
    servoConfig = servoCfg;
    
    // Calculate center position based on servo ranges
    calculatedCenterPosition = calculateCenterPosition();
    
    // Initialize all corners to center position
    frontLeft.position = calculatedCenterPosition;
    frontRight.position = calculatedCenterPosition;
    rearLeft.position = calculatedCenterPosition;
    rearRight.position = calculatedCenterPosition;
  }
  
  void update(float roll, float pitch, float verticalAccel) {
    // Roll effect on suspension (negative roll = left drops, right rises)
    float rollEffect = roll * config.stiffness;
    
    // Pitch effect (negative pitch = front drops, rear rises)
    float pitchEffect = pitch * config.stiffness;
    
    // Vertical acceleration effect (compressed under acceleration)
    float verticalEffect = -verticalAccel * config.damping;
    
    // Front/Rear balance distribution
    float frontPitchFactor = config.frontRearBalance;
    float rearPitchFactor = 1.0f - config.frontRearBalance;
    
    // Calculate target positions for each corner
    // Front Left = center + pitch effect (front) + roll effect (left) + vertical
    frontLeft.target = calculatedCenterPosition 
                      + (pitchEffect * frontPitchFactor)
                      + (rollEffect)
                      + verticalEffect;
    
    // Front Right = center + pitch effect (front) - roll effect (right) + vertical
    frontRight.target = calculatedCenterPosition 
                       + (pitchEffect * frontPitchFactor)
                       - (rollEffect)
                       + verticalEffect;
    
    // Rear Left = center - pitch effect (rear) + roll effect (left) + vertical
    rearLeft.target = calculatedCenterPosition 
                     - (pitchEffect * rearPitchFactor)
                     + (rollEffect)
                     + verticalEffect;
    
    // Rear Right = center - pitch effect (rear) - roll effect (right) + vertical
    rearRight.target = calculatedCenterPosition 
                      - (pitchEffect * rearPitchFactor)
                      - (rollEffect)
                      + verticalEffect;
    
    // Apply range limits
    clampPosition(frontLeft);
    clampPosition(frontRight);
    clampPosition(rearLeft);
    clampPosition(rearRight);
    
    // Smooth movement with damping (reaction speed)
    float smoothing = 1.0f / (1.0f + (5.0f / config.reactionSpeed));
    
    frontLeft.position = frontLeft.position * (1.0f - smoothing) + frontLeft.target * smoothing;
    frontRight.position = frontRight.position * (1.0f - smoothing) + frontRight.target * smoothing;
    rearLeft.position = rearLeft.position * (1.0f - smoothing) + rearLeft.target * smoothing;
    rearRight.position = rearRight.position * (1.0f - smoothing) + rearRight.target * smoothing;
  }
  
  float getFrontLeftOutput() const { return constrain(frontLeft.position, 0.0f, 180.0f); }
  float getFrontRightOutput() const { return constrain(frontRight.position, 0.0f, 180.0f); }
  float getRearLeftOutput() const { return constrain(rearLeft.position, 0.0f, 180.0f); }
  float getRearRightOutput() const { return constrain(rearRight.position, 0.0f, 180.0f); }

private:
  // Calculate center position based on servo ranges and rideHeightOffset percentage
  float calculateCenterPosition() {
    // Average the min and max limits from all 4 servos
    float avgMin = (servoConfig.frontLeft.minLimit + servoConfig.frontRight.minLimit + 
                    servoConfig.rearLeft.minLimit + servoConfig.rearRight.minLimit) / 4.0f;
    float avgMax = (servoConfig.frontLeft.maxLimit + servoConfig.frontRight.maxLimit + 
                    servoConfig.rearLeft.maxLimit + servoConfig.rearRight.maxLimit) / 4.0f;
    
    // Map rideHeightOffset (0-100%) to servo degrees
    // 0% = avgMin (lowest), 50% = middle, 100% = avgMax (highest)
    float percent = config.rideHeightOffset / 100.0f;
    float centerPos = avgMin + (percent * (avgMax - avgMin));
    
    return centerPos;
  }
  
  void clampPosition(CornerState& corner) {
    // Use individual servo's min/max limits for clamping, not the center-based limits
    // This ensures we respect the full range of each servo
    float minPos = 0.0f;
    float maxPos = 180.0f;
    corner.target = constrain(corner.target, minPos, maxPos);
  }
};

#endif
