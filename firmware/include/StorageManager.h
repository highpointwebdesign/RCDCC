#ifndef STORAGE_MANAGER_H
#define STORAGE_MANAGER_H

#include "Config.h"
#include <ArduinoJson.h>
#include <SPIFFS.h>

class StorageManager {
private:
  SuspensionConfig config;
  ServoConfig servoConfig;
  bool servoTrimResetWarning = false;
  
public:
  void init() {
    loadDefaults();
    loadServoDefaults();
  }
  
  void loadDefaults() {
    config.reactionSpeed = DEFAULT_REACTION_SPEED;
    config.rideHeightOffset = DEFAULT_RIDE_HEIGHT;
    config.rangeLimit = DEFAULT_RANGE_LIMIT;
    config.damping = DEFAULT_DAMPING;
    config.frontRearBalance = DEFAULT_FRONT_REAR_BALANCE;
    config.stiffness = DEFAULT_STIFFNESS;
    config.sampleRate = SUSPENSION_SAMPLE_RATE_HZ;
    config.telemetryRate = DEFAULT_TELEMETRY_RATE_HZ;
    config.mpuOrientation = DEFAULT_MPU6050_ORIENTATION;
    config.fpvAutoMode = DEFAULT_FPV_AUTO_MODE;
  }
  
  void loadServoDefaults() {
    servoConfig.frontLeft = {DEFAULT_SERVO_TRIM, DEFAULT_SERVO_MIN, DEFAULT_SERVO_MAX, DEFAULT_SERVO_REVERSED};
    servoConfig.frontRight = {DEFAULT_SERVO_TRIM, DEFAULT_SERVO_MIN, DEFAULT_SERVO_MAX, DEFAULT_SERVO_REVERSED};
    servoConfig.rearLeft = {DEFAULT_SERVO_TRIM, DEFAULT_SERVO_MIN, DEFAULT_SERVO_MAX, DEFAULT_SERVO_REVERSED};
    servoConfig.rearRight = {DEFAULT_SERVO_TRIM, DEFAULT_SERVO_MIN, DEFAULT_SERVO_MAX, DEFAULT_SERVO_REVERSED};
  }
  
  void loadConfig() {
    if (!SPIFFS.exists(CONFIG_SPIFFS_PATH)) {
      Serial.println("Config file not found, using defaults");
      return;
    }
    
    File file = SPIFFS.open(CONFIG_SPIFFS_PATH, "r");
    if (!file) {
      Serial.println("Failed to open config file");
      return;
    }
    
    DynamicJsonDocument doc(1024);
    DeserializationError error = deserializeJson(doc, file);
    file.close();
    
    if (error) {
      Serial.print("JSON parsing failed: ");
      Serial.println(error.c_str());
      return;
    }
    
    config.reactionSpeed = doc["reactionSpeed"] | DEFAULT_REACTION_SPEED;
    config.rideHeightOffset = doc["rideHeightOffset"] | DEFAULT_RIDE_HEIGHT;
    config.rangeLimit = doc["rangeLimit"] | DEFAULT_RANGE_LIMIT;
    config.damping = doc["damping"] | DEFAULT_DAMPING;
    config.frontRearBalance = doc["frontRearBalance"] | DEFAULT_FRONT_REAR_BALANCE;
    config.stiffness = doc["stiffness"] | DEFAULT_STIFFNESS;
    config.sampleRate = doc["sampleRate"] | SUSPENSION_SAMPLE_RATE_HZ;
    config.telemetryRate = doc["telemetryRate"] | DEFAULT_TELEMETRY_RATE_HZ;
    config.mpuOrientation = doc["mpuOrientation"] | DEFAULT_MPU6050_ORIENTATION;
    config.fpvAutoMode = doc["fpvAutoMode"] | DEFAULT_FPV_AUTO_MODE;
    
    bool trimWasReset = false;
    auto sanitizeTrim = [&](const char* servoName, int value) {
      if (value < -20 || value > 20) {
        trimWasReset = true;
        servoTrimResetWarning = true;
        Serial.printf("Servo %s trim out of range (%d) - reset to 0\n", servoName, value);
        return 0;
      }
      return value;
    };
    
    // Load servo calibration if available
    if (doc.containsKey("servos")) {
      JsonObject servos = doc["servos"];
      if (servos.containsKey("frontLeft")) {
        int trimValue = servos["frontLeft"]["trim"] | DEFAULT_SERVO_TRIM;
        servoConfig.frontLeft.trim = sanitizeTrim("frontLeft", trimValue);
        servoConfig.frontLeft.minLimit = servos["frontLeft"]["min"] | DEFAULT_SERVO_MIN;
        servoConfig.frontLeft.maxLimit = servos["frontLeft"]["max"] | DEFAULT_SERVO_MAX;
        servoConfig.frontLeft.reversed = servos["frontLeft"]["reversed"] | DEFAULT_SERVO_REVERSED;
      }
      if (servos.containsKey("frontRight")) {
        int trimValue = servos["frontRight"]["trim"] | DEFAULT_SERVO_TRIM;
        servoConfig.frontRight.trim = sanitizeTrim("frontRight", trimValue);
        servoConfig.frontRight.minLimit = servos["frontRight"]["min"] | DEFAULT_SERVO_MIN;
        servoConfig.frontRight.maxLimit = servos["frontRight"]["max"] | DEFAULT_SERVO_MAX;
        servoConfig.frontRight.reversed = servos["frontRight"]["reversed"] | DEFAULT_SERVO_REVERSED;
      }
      if (servos.containsKey("rearLeft")) {
        int trimValue = servos["rearLeft"]["trim"] | DEFAULT_SERVO_TRIM;
        servoConfig.rearLeft.trim = sanitizeTrim("rearLeft", trimValue);
        servoConfig.rearLeft.minLimit = servos["rearLeft"]["min"] | DEFAULT_SERVO_MIN;
        servoConfig.rearLeft.maxLimit = servos["rearLeft"]["max"] | DEFAULT_SERVO_MAX;
        servoConfig.rearLeft.reversed = servos["rearLeft"]["reversed"] | DEFAULT_SERVO_REVERSED;
      }
      if (servos.containsKey("rearRight")) {
        int trimValue = servos["rearRight"]["trim"] | DEFAULT_SERVO_TRIM;
        servoConfig.rearRight.trim = sanitizeTrim("rearRight", trimValue);
        servoConfig.rearRight.minLimit = servos["rearRight"]["min"] | DEFAULT_SERVO_MIN;
        servoConfig.rearRight.maxLimit = servos["rearRight"]["max"] | DEFAULT_SERVO_MAX;
        servoConfig.rearRight.reversed = servos["rearRight"]["reversed"] | DEFAULT_SERVO_REVERSED;
      }
    }
    
    if (trimWasReset) {
      saveConfig();
    }
    
    Serial.println("Config loaded from SPIFFS");
  }
  
  void saveConfig() {
    DynamicJsonDocument doc(2048);  // Increased size for servo config
    
    doc["reactionSpeed"] = config.reactionSpeed;
    doc["rideHeightOffset"] = config.rideHeightOffset;
    doc["rangeLimit"] = config.rangeLimit;
    doc["damping"] = config.damping;
    doc["frontRearBalance"] = config.frontRearBalance;
    doc["stiffness"] = config.stiffness;
    doc["sampleRate"] = config.sampleRate;
    doc["telemetryRate"] = config.telemetryRate;
    doc["mpuOrientation"] = config.mpuOrientation;
    doc["fpvAutoMode"] = config.fpvAutoMode;
    
    // Save servo calibration
    JsonObject servos = doc.createNestedObject("servos");
    
    JsonObject fl = servos.createNestedObject("frontLeft");
    fl["trim"] = servoConfig.frontLeft.trim;
    fl["min"] = servoConfig.frontLeft.minLimit;
    fl["max"] = servoConfig.frontLeft.maxLimit;
    fl["reversed"] = servoConfig.frontLeft.reversed;
    
    JsonObject fr = servos.createNestedObject("frontRight");
    fr["trim"] = servoConfig.frontRight.trim;
    fr["min"] = servoConfig.frontRight.minLimit;
    fr["max"] = servoConfig.frontRight.maxLimit;
    fr["reversed"] = servoConfig.frontRight.reversed;
    
    JsonObject rl = servos.createNestedObject("rearLeft");
    rl["trim"] = servoConfig.rearLeft.trim;
    rl["min"] = servoConfig.rearLeft.minLimit;
    rl["max"] = servoConfig.rearLeft.maxLimit;
    rl["reversed"] = servoConfig.rearLeft.reversed;
    
    JsonObject rr = servos.createNestedObject("rearRight");
    rr["trim"] = servoConfig.rearRight.trim;
    rr["min"] = servoConfig.rearRight.minLimit;
    rr["max"] = servoConfig.rearRight.maxLimit;
    rr["reversed"] = servoConfig.rearRight.reversed;
    
    File file = SPIFFS.open(CONFIG_SPIFFS_PATH, "w");
    if (!file) {
      Serial.println("Failed to create config file");
      return;
    }
    
    serializeJson(doc, file);
    file.close();
    
    Serial.println("Config saved to SPIFFS");
  }
  
  SuspensionConfig getConfig() const {
    return config;
  }
  
  void setConfig(const SuspensionConfig& newConfig) {
    config = newConfig;
    saveConfig();
  }
  
  void updateParameter(const String& key, float value) {
    if (key == "reactionSpeed") config.reactionSpeed = value;
    else if (key == "rideHeightOffset") config.rideHeightOffset = value;
    else if (key == "rangeLimit") config.rangeLimit = value;
    else if (key == "damping") config.damping = value;
    else if (key == "frontRearBalance") config.frontRearBalance = value;
    else if (key == "stiffness") config.stiffness = value;
    else if (key == "sampleRate") config.sampleRate = constrain((uint16_t)value, 5, 50);
    else if (key == "telemetryRate") config.telemetryRate = constrain((uint8_t)value, 1, 10);
    else if (key == "mpuOrientation") config.mpuOrientation = constrain((uint8_t)value, 0, 5);
    else if (key == "fpvAutoMode") config.fpvAutoMode = (value != 0.0f);
    saveConfig();
  }
  
  void resetToDefaults() {
    loadDefaults();
    saveConfig();
    Serial.println("Config reset to defaults");
  }
  
  String getConfigJSON() {
    DynamicJsonDocument doc(2048);
    
    doc["reactionSpeed"] = config.reactionSpeed;
    doc["rideHeightOffset"] = config.rideHeightOffset;
    doc["rangeLimit"] = config.rangeLimit;
    doc["damping"] = config.damping;
    doc["frontRearBalance"] = config.frontRearBalance;
    doc["stiffness"] = config.stiffness;
    doc["sampleRate"] = config.sampleRate;
    doc["telemetryRate"] = config.telemetryRate;
    doc["mpuOrientation"] = config.mpuOrientation;
    
    String output;
    serializeJson(doc, output);
    return output;
  }
  
  ServoConfig getServoConfig() const {
    return servoConfig;
  }
  
  String getServoConfigJSON() {
    DynamicJsonDocument doc(1024);
    
    JsonObject fl = doc.createNestedObject("frontLeft");
    fl["trim"] = servoConfig.frontLeft.trim;
    fl["min"] = servoConfig.frontLeft.minLimit;
    fl["max"] = servoConfig.frontLeft.maxLimit;
    fl["reversed"] = servoConfig.frontLeft.reversed;
    
    JsonObject fr = doc.createNestedObject("frontRight");
    fr["trim"] = servoConfig.frontRight.trim;
    fr["min"] = servoConfig.frontRight.minLimit;
    fr["max"] = servoConfig.frontRight.maxLimit;
    fr["reversed"] = servoConfig.frontRight.reversed;
    
    JsonObject rl = doc.createNestedObject("rearLeft");
    rl["trim"] = servoConfig.rearLeft.trim;
    rl["min"] = servoConfig.rearLeft.minLimit;
    rl["max"] = servoConfig.rearLeft.maxLimit;
    rl["reversed"] = servoConfig.rearLeft.reversed;
    
    JsonObject rr = doc.createNestedObject("rearRight");
    rr["trim"] = servoConfig.rearRight.trim;
    rr["min"] = servoConfig.rearRight.minLimit;
    rr["max"] = servoConfig.rearRight.maxLimit;
    rr["reversed"] = servoConfig.rearRight.reversed;
    
    String output;
    serializeJson(doc, output);
    return output;
  }
  
  bool consumeServoTrimResetWarning() {
    bool warning = servoTrimResetWarning;
    servoTrimResetWarning = false;
    return warning;
  }
  
  void updateServoParameter(const String& servo, const String& param, int value) {
    ServoCalibration* target = nullptr;
    
    if (servo == "frontLeft") target = &servoConfig.frontLeft;
    else if (servo == "frontRight") target = &servoConfig.frontRight;
    else if (servo == "rearLeft") target = &servoConfig.rearLeft;
    else if (servo == "rearRight") target = &servoConfig.rearRight;
    
    if (target) {
      if (param == "trim") {
        if (value < -20 || value > 20) {
          target->trim = 0;
          servoTrimResetWarning = true;
          Serial.printf("Servo %s trim out of range (%d) - reset to 0\n", servo.c_str(), value);
        } else {
          target->trim = value;
        }
      }
      else if (param == "min") target->minLimit = constrain(value, 0, 180);
      else if (param == "max") target->maxLimit = constrain(value, 0, 180);
      else if (param == "reversed") target->reversed = (value != 0);
      
      saveConfig();
    }
  }
};

#endif
