#ifndef SENSOR_FUSION_H
#define SENSOR_FUSION_H

#include <Arduino.h>
#include <cmath>
#include "Config.h"

class SensorFusion {
private:
  // Complementary filter coefficients
  static constexpr float ALPHA = 0.95f;  // Accel weight: 5%, Gyro weight: 95%
  
  // Euler angles
  float roll = 0.0f;
  float pitch = 0.0f;
  float yaw = 0.0f;
  
  // Calibration offsets
  float rollOffset = 0.0f;
  float pitchOffset = 0.0f;
  
  // Filtered acceleration
  float verticalAccel = 0.0f;
  float filteredVerticalAccel = 0.0f;
  
  // Last update time
  unsigned long lastUpdateTime = 0;
  float dt = 0.02f;  // Default 50 Hz
  
  // Gravity reference
  static constexpr float GRAVITY = 9.81f;
  
  // MPU6050 orientation
  uint8_t mpuOrientation = ARROW_FORWARD_UP;
  
  // Remap sensor axes to vehicle axes based on orientation
  void remapAxes(float sensorX, float sensorY, float sensorZ, 
                 float& vehicleForward, float& vehicleRight, float& vehicleUp) {
    switch (mpuOrientation) {
      case ARROW_FORWARD_UP:  // Default: Arrow forward, chip up
        vehicleForward = sensorX;
        vehicleRight = sensorY;
        vehicleUp = sensorZ;
        break;
      case ARROW_UP_FORWARD:  // Arrow up, chip forward
        vehicleForward = -sensorZ;
        vehicleRight = sensorY;
        vehicleUp = sensorX;
        break;
      case ARROW_BACKWARD_UP:  // Arrow backward, chip up
        vehicleForward = -sensorX;
        vehicleRight = -sensorY;
        vehicleUp = sensorZ;
        break;
      case ARROW_DOWN_FORWARD:  // Arrow down, chip forward
        vehicleForward = sensorZ;
        vehicleRight = sensorY;
        vehicleUp = -sensorX;
        break;
      case ARROW_RIGHT_UP:  // Arrow right, chip up
        vehicleForward = -sensorY;
        vehicleRight = sensorX;
        vehicleUp = sensorZ;
        break;
      case ARROW_LEFT_UP:  // Arrow left, chip up
        vehicleForward = sensorY;
        vehicleRight = -sensorX;
        vehicleUp = sensorZ;
        break;
      default:
        vehicleForward = sensorX;
        vehicleRight = sensorY;
        vehicleUp = sensorZ;
        break;
    }
  }

public:
  void init(uint16_t sampleRate) {
    dt = 1.0f / sampleRate;
    lastUpdateTime = millis();
  }
  
  void setOrientation(uint8_t orientation) {
    mpuOrientation = orientation;
  }
  
  void update(float ax, float ay, float az, float gx, float gy, float gz) {
    // Remap sensor axes to vehicle coordinate system
    float axVehicle, ayVehicle, azVehicle;
    float gxVehicle, gyVehicle, gzVehicle;
    
    remapAxes(ax, ay, az, axVehicle, ayVehicle, azVehicle);
    remapAxes(gx, gy, gz, gxVehicle, gyVehicle, gzVehicle);
    
    // Calculate time delta
    unsigned long currentTime = millis();
    dt = (currentTime - lastUpdateTime) / 1000.0f;
    lastUpdateTime = currentTime;
    
    if (dt > 0.1f) dt = 0.02f;  // Clamp to prevent jumps
    
    // Accelerometer angles (using remapped vehicle axes)
    float accelRoll = atan2f(ayVehicle, azVehicle) * 57.2957795f;  // rad to deg
    float accelPitch = atan2f(axVehicle, sqrtf(ayVehicle * ayVehicle + azVehicle * azVehicle)) * 57.2957795f;
    
    // Complementary filter for roll and pitch (using remapped vehicle gyro axes)
    roll = ALPHA * (roll + gxVehicle * dt) + (1.0f - ALPHA) * accelRoll;
    pitch = ALPHA * (pitch + gyVehicle * dt) + (1.0f - ALPHA) * accelPitch;
    yaw += gzVehicle * dt;
    
    // Calculate vertical acceleration in world frame (using remapped vehicle axes)
    // Remove gravity component
    verticalAccel = azVehicle - 1.0f;  // Gravity is 1.0g when level
    
    // Low-pass filter vertical acceleration
    filteredVerticalAccel = 0.9f * filteredVerticalAccel + 0.1f * verticalAccel;
  }
  
  template<typename StatusCallback>
  void calibrate(MPU6050& mpu, StatusCallback statusFn, uint16_t samples = 100) {
    statusFn("Calibrating IMU... Keep vehicle still!");
    Serial.println("Calibrating IMU... Keep vehicle still!");
    
    float rollSum = 0.0f;
    float pitchSum = 0.0f;
    
    for (uint16_t i = 0; i < samples; i++) {
      int16_t ax, ay, az, gx, gy, gz;
      mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
      
      // Convert to g's
      float accelX = ax / 16384.0f;
      float accelY = ay / 16384.0f;
      float accelZ = az / 16384.0f;
      
      // Calculate angles from accelerometer
      float accelRoll = atan2f(accelY, accelZ) * 57.2957795f;
      float accelPitch = atan2f(accelX, sqrtf(accelY * accelY + accelZ * accelZ)) * 57.2957795f;
      
      rollSum += accelRoll;
      pitchSum += accelPitch;
      
      delay(10);  // 10ms between samples
    }
    
    rollOffset = rollSum / samples;
    pitchOffset = pitchSum / samples;
    
    String completeMsg = "Calibration complete! Roll: " + String(rollOffset, 1) + "°, Pitch: " + String(pitchOffset, 1) + "°";
    statusFn(completeMsg);
    
    Serial.print("Calibration complete! Roll offset: ");
    Serial.print(rollOffset);
    Serial.print("°, Pitch offset: ");
    Serial.print(pitchOffset);
    Serial.println("°");
  }
  
  float getRoll() const { return roll - rollOffset; }
  float getPitch() const { return pitch - pitchOffset; }
  float getYaw() const { return yaw; }
  float getVerticalAcceleration() const { return filteredVerticalAccel; }
};

#endif
