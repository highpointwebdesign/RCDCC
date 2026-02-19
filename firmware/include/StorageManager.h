#ifndef STORAGE_MANAGER_H
#define STORAGE_MANAGER_H

#include "Config.h"
#include <ArduinoJson.h>
#include <SPIFFS.h>

class StorageManager {
private:
  SuspensionConfig config;
  ServoConfig servoConfig;
  BatteriesConfig batteryConfig;
  
public:
  void init() {
    loadDefaults();
    loadServoDefaults();
    loadBatteryDefaults();
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
  
  void loadBatteryDefaults() {
    strncpy(batteryConfig.battery1.name, DEFAULT_BATTERY_NAME, sizeof(batteryConfig.battery1.name) - 1);
    batteryConfig.battery1.cellCount = DEFAULT_BATTERY_CELL_COUNT;
    batteryConfig.battery1.plugAssignment = DEFAULT_BATTERY_PLUG;
    batteryConfig.battery1.showOnDashboard = DEFAULT_BATTERY_SHOW_DASHBOARD;
    
    strncpy(batteryConfig.battery2.name, DEFAULT_BATTERY_NAME, sizeof(batteryConfig.battery2.name) - 1);
    batteryConfig.battery2.cellCount = DEFAULT_BATTERY_CELL_COUNT;
    batteryConfig.battery2.plugAssignment = DEFAULT_BATTERY_PLUG;
    batteryConfig.battery2.showOnDashboard = DEFAULT_BATTERY_SHOW_DASHBOARD;
    
    strncpy(batteryConfig.battery3.name, DEFAULT_BATTERY_NAME, sizeof(batteryConfig.battery3.name) - 1);
    batteryConfig.battery3.cellCount = DEFAULT_BATTERY_CELL_COUNT;
    batteryConfig.battery3.plugAssignment = DEFAULT_BATTERY_PLUG;
    batteryConfig.battery3.showOnDashboard = DEFAULT_BATTERY_SHOW_DASHBOARD;
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
    
    // Load servo calibration if available
    if (doc.containsKey("servos")) {
      JsonObject servos = doc["servos"];
      if (servos.containsKey("frontLeft")) {
        servoConfig.frontLeft.trim = servos["frontLeft"]["trim"] | DEFAULT_SERVO_TRIM;
        servoConfig.frontLeft.minLimit = servos["frontLeft"]["min"] | DEFAULT_SERVO_MIN;
        servoConfig.frontLeft.maxLimit = servos["frontLeft"]["max"] | DEFAULT_SERVO_MAX;
        servoConfig.frontLeft.reversed = servos["frontLeft"]["reversed"] | DEFAULT_SERVO_REVERSED;
      }
      if (servos.containsKey("frontRight")) {
        servoConfig.frontRight.trim = servos["frontRight"]["trim"] | DEFAULT_SERVO_TRIM;
        servoConfig.frontRight.minLimit = servos["frontRight"]["min"] | DEFAULT_SERVO_MIN;
        servoConfig.frontRight.maxLimit = servos["frontRight"]["max"] | DEFAULT_SERVO_MAX;
        servoConfig.frontRight.reversed = servos["frontRight"]["reversed"] | DEFAULT_SERVO_REVERSED;
      }
      if (servos.containsKey("rearLeft")) {
        servoConfig.rearLeft.trim = servos["rearLeft"]["trim"] | DEFAULT_SERVO_TRIM;
        servoConfig.rearLeft.minLimit = servos["rearLeft"]["min"] | DEFAULT_SERVO_MIN;
        servoConfig.rearLeft.maxLimit = servos["rearLeft"]["max"] | DEFAULT_SERVO_MAX;
        servoConfig.rearLeft.reversed = servos["rearLeft"]["reversed"] | DEFAULT_SERVO_REVERSED;
      }
      if (servos.containsKey("rearRight")) {
        servoConfig.rearRight.trim = servos["rearRight"]["trim"] | DEFAULT_SERVO_TRIM;
        servoConfig.rearRight.minLimit = servos["rearRight"]["min"] | DEFAULT_SERVO_MIN;
        servoConfig.rearRight.maxLimit = servos["rearRight"]["max"] | DEFAULT_SERVO_MAX;
        servoConfig.rearRight.reversed = servos["rearRight"]["reversed"] | DEFAULT_SERVO_REVERSED;
      }
    }
    
    // Load battery configuration if available
    if (doc.containsKey("batteries")) {
      JsonObject batteries = doc["batteries"];
      if (batteries.containsKey("battery1")) {
        strncpy(batteryConfig.battery1.name, batteries["battery1"]["name"] | DEFAULT_BATTERY_NAME, sizeof(batteryConfig.battery1.name) - 1);
        batteryConfig.battery1.cellCount = batteries["battery1"]["cellCount"] | DEFAULT_BATTERY_CELL_COUNT;
        batteryConfig.battery1.plugAssignment = batteries["battery1"]["plugAssignment"] | DEFAULT_BATTERY_PLUG;
        batteryConfig.battery1.showOnDashboard = batteries["battery1"]["showOnDashboard"] | DEFAULT_BATTERY_SHOW_DASHBOARD;
      }
      if (batteries.containsKey("battery2")) {
        strncpy(batteryConfig.battery2.name, batteries["battery2"]["name"] | DEFAULT_BATTERY_NAME, sizeof(batteryConfig.battery2.name) - 1);
        batteryConfig.battery2.cellCount = batteries["battery2"]["cellCount"] | DEFAULT_BATTERY_CELL_COUNT;
        batteryConfig.battery2.plugAssignment = batteries["battery2"]["plugAssignment"] | DEFAULT_BATTERY_PLUG;
        batteryConfig.battery2.showOnDashboard = batteries["battery2"]["showOnDashboard"] | DEFAULT_BATTERY_SHOW_DASHBOARD;
      }
      if (batteries.containsKey("battery3")) {
        strncpy(batteryConfig.battery3.name, batteries["battery3"]["name"] | DEFAULT_BATTERY_NAME, sizeof(batteryConfig.battery3.name) - 1);
        batteryConfig.battery3.cellCount = batteries["battery3"]["cellCount"] | DEFAULT_BATTERY_CELL_COUNT;
        batteryConfig.battery3.plugAssignment = batteries["battery3"]["plugAssignment"] | DEFAULT_BATTERY_PLUG;
        batteryConfig.battery3.showOnDashboard = batteries["battery3"]["showOnDashboard"] | DEFAULT_BATTERY_SHOW_DASHBOARD;
      }
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
    
    // Save battery configuration
    JsonObject batteries = doc.createNestedObject("batteries");
    
    JsonObject b1 = batteries.createNestedObject("battery1");
    b1["name"] = batteryConfig.battery1.name;
    b1["cellCount"] = batteryConfig.battery1.cellCount;
    b1["plugAssignment"] = batteryConfig.battery1.plugAssignment;
    b1["showOnDashboard"] = batteryConfig.battery1.showOnDashboard;
    
    JsonObject b2 = batteries.createNestedObject("battery2");
    b2["name"] = batteryConfig.battery2.name;
    b2["cellCount"] = batteryConfig.battery2.cellCount;
    b2["plugAssignment"] = batteryConfig.battery2.plugAssignment;
    b2["showOnDashboard"] = batteryConfig.battery2.showOnDashboard;
    
    JsonObject b3 = batteries.createNestedObject("battery3");
    b3["name"] = batteryConfig.battery3.name;
    b3["cellCount"] = batteryConfig.battery3.cellCount;
    b3["plugAssignment"] = batteryConfig.battery3.plugAssignment;
    b3["showOnDashboard"] = batteryConfig.battery3.showOnDashboard;
    
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
  
  void updateServoParameter(const String& servo, const String& param, int value) {
    ServoCalibration* target = nullptr;
    
    if (servo == "frontLeft") target = &servoConfig.frontLeft;
    else if (servo == "frontRight") target = &servoConfig.frontRight;
    else if (servo == "rearLeft") target = &servoConfig.rearLeft;
    else if (servo == "rearRight") target = &servoConfig.rearRight;
    
    if (target) {
      if (param == "trim") target->trim = constrain(value, -45, 45);
      else if (param == "min") target->minLimit = constrain(value, 30, 90);
      else if (param == "max") target->maxLimit = constrain(value, 90, 150);
      else if (param == "reversed") target->reversed = (value != 0);
      
      saveConfig();
    }
  }
  
  // Battery configuration methods
  BatteriesConfig getBatteryConfig() const {
    return batteryConfig;
  }
  
  String getBatteryConfigJSON() {
    DynamicJsonDocument doc(1024);
    
    JsonArray batteries = doc.createNestedArray("batteries");
    
    JsonObject b1 = batteries.createNestedObject();
    b1["name"] = batteryConfig.battery1.name;
    b1["cellCount"] = batteryConfig.battery1.cellCount;
    b1["plugAssignment"] = batteryConfig.battery1.plugAssignment;
    b1["showOnDashboard"] = batteryConfig.battery1.showOnDashboard;
    
    JsonObject b2 = batteries.createNestedObject();
    b2["name"] = batteryConfig.battery2.name;
    b2["cellCount"] = batteryConfig.battery2.cellCount;
    b2["plugAssignment"] = batteryConfig.battery2.plugAssignment;
    b2["showOnDashboard"] = batteryConfig.battery2.showOnDashboard;
    
    JsonObject b3 = batteries.createNestedObject();
    b3["name"] = batteryConfig.battery3.name;
    b3["cellCount"] = batteryConfig.battery3.cellCount;
    b3["plugAssignment"] = batteryConfig.battery3.plugAssignment;
    b3["showOnDashboard"] = batteryConfig.battery3.showOnDashboard;
    
    String output;
    serializeJson(doc, output);
    return output;
  }
  
  void updateBatteryParameter(int batteryNum, const String& param, const String& value) {
    BatteryConfig* target = nullptr;
    
    if (batteryNum == 1) target = &batteryConfig.battery1;
    else if (batteryNum == 2) target = &batteryConfig.battery2;
    else if (batteryNum == 3) target = &batteryConfig.battery3;
    
    if (target) {
      if (param == "name") {
        strncpy(target->name, value.c_str(), sizeof(target->name) - 1);
        target->name[sizeof(target->name) - 1] = '\0';
      }
      else if (param == "cellCount") target->cellCount = constrain(value.toInt(), 2, 6);
      else if (param == "plugAssignment") target->plugAssignment = constrain(value.toInt(), 0, 3);
      else if (param == "showOnDashboard") target->showOnDashboard = (value == "true" || value == "1");
      
      saveConfig();
    }
  }
};

#endif
