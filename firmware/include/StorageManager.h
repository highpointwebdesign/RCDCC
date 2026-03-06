#ifndef STORAGE_MANAGER_H
#define STORAGE_MANAGER_H

#include "Config.h"
#include <ArduinoJson.h>
#include <SPIFFS.h>
#include <cstring>

class StorageManager {
private:
  SuspensionConfig config;
  ServoConfig servoConfig;
  LEDConfig ledConfig;
  LightsConfig lightsConfig;
  NewLightsConfig newLightsConfig = {};  // Extended lights config for dynamic groups
  bool servoTrimResetWarning = false;
  
public:
  void init() {
    loadDefaults();
    loadServoDefaults();
    loadLEDDefaults();
    initLightsDefaults();
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
    strncpy(config.deviceName, DEFAULT_DEVICE_NAME, sizeof(config.deviceName) - 1);
    config.deviceName[sizeof(config.deviceName) - 1] = '\0';
  }
  
  void loadServoDefaults() {
    servoConfig.frontLeft = {DEFAULT_SERVO_TRIM, DEFAULT_SERVO_MIN, DEFAULT_SERVO_MAX, DEFAULT_SERVO_REVERSED};
    servoConfig.frontRight = {DEFAULT_SERVO_TRIM, DEFAULT_SERVO_MIN, DEFAULT_SERVO_MAX, DEFAULT_SERVO_REVERSED};
    servoConfig.rearLeft = {DEFAULT_SERVO_TRIM, DEFAULT_SERVO_MIN, DEFAULT_SERVO_MAX, DEFAULT_SERVO_REVERSED};
    servoConfig.rearRight = {DEFAULT_SERVO_TRIM, DEFAULT_SERVO_MIN, DEFAULT_SERVO_MAX, DEFAULT_SERVO_REVERSED};
  }
  
  void loadLEDDefaults() {
    ledConfig.color = DEFAULT_LED_COLOR;
  }
  
  void initLightsDefaults() {
    lightsConfig.headlights = {DEFAULT_HEADLIGHTS_ENABLED, DEFAULT_HEADLIGHTS_BRIGHTNESS, DEFAULT_HEADLIGHTS_MODE, DEFAULT_HEADLIGHTS_BLINK_RATE};
    lightsConfig.tailLights = {DEFAULT_TAILLIGHTS_ENABLED, DEFAULT_TAILLIGHTS_BRIGHTNESS, DEFAULT_TAILLIGHTS_MODE, DEFAULT_TAILLIGHTS_BLINK_RATE};
    lightsConfig.emergencyLights = {DEFAULT_EMERGENCY_LIGHTS_ENABLED, DEFAULT_EMERGENCY_LIGHTS_BRIGHTNESS, DEFAULT_EMERGENCY_LIGHTS_MODE, DEFAULT_EMERGENCY_LIGHTS_BLINK_RATE};

    memset(&newLightsConfig, 0, sizeof(NewLightsConfig));
    newLightsConfig.useLegacyMode = false;
    newLightsConfig.groupCount = 0;
    newLightsConfig.legacy = lightsConfig;
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
    
    // Load device name from JSON
    const char* deviceNameStr = doc["deviceName"] | DEFAULT_DEVICE_NAME;
    if (deviceNameStr == nullptr || strlen(deviceNameStr) == 0) {
      deviceNameStr = DEFAULT_DEVICE_NAME;
    }
    strncpy(config.deviceName, deviceNameStr, sizeof(config.deviceName) - 1);
    config.deviceName[sizeof(config.deviceName) - 1] = '\0';
    
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
    
    // Load LED configuration
    if (doc.containsKey("ledColor")) {
      String colorStr = doc["ledColor"] | "red";
      if (colorStr == "red") ledConfig.color = LED_COLOR_RED;
      else if (colorStr == "green") ledConfig.color = LED_COLOR_GREEN;
      else if (colorStr == "blue") ledConfig.color = LED_COLOR_BLUE;
      else ledConfig.color = DEFAULT_LED_COLOR;
    }
    
    if (trimWasReset) {
      saveConfig();
    }
    
    Serial.println("Config loaded from SPIFFS");
  }
  
  void loadLights() {
    if (!SPIFFS.exists(LIGHTS_SPIFFS_PATH)) {
      Serial.println("Lights config file not found, using defaults");
      return;
    }
    
    File file = SPIFFS.open(LIGHTS_SPIFFS_PATH, "r");
    if (!file) {
      Serial.println("Failed to open lights config file");
      return;
    }
    
    DynamicJsonDocument doc(1024);
    DeserializationError error = deserializeJson(doc, file);
    file.close();
    
    if (error) {
      Serial.print("Lights JSON parsing failed: ");
      Serial.println(error.c_str());
      return;
    }
    
    // Load legacy light groups
    if (doc.containsKey("lightGroups")) {
      JsonObject groups = doc["lightGroups"];
      
      if (groups.containsKey("headlights")) {
        JsonObject hl = groups["headlights"];
        lightsConfig.headlights.enabled = hl["enabled"] | DEFAULT_HEADLIGHTS_ENABLED;
        lightsConfig.headlights.brightness = hl["brightness"] | DEFAULT_HEADLIGHTS_BRIGHTNESS;
        lightsConfig.headlights.mode = hl["mode"] | DEFAULT_HEADLIGHTS_MODE;
        lightsConfig.headlights.blinkRate = hl["blinkRate"] | DEFAULT_HEADLIGHTS_BLINK_RATE;
      }
      
      if (groups.containsKey("tailLights")) {
        JsonObject tl = groups["tailLights"];
        lightsConfig.tailLights.enabled = tl["enabled"] | DEFAULT_TAILLIGHTS_ENABLED;
        lightsConfig.tailLights.brightness = tl["brightness"] | DEFAULT_TAILLIGHTS_BRIGHTNESS;
        lightsConfig.tailLights.mode = tl["mode"] | DEFAULT_TAILLIGHTS_MODE;
        lightsConfig.tailLights.blinkRate = tl["blinkRate"] | DEFAULT_TAILLIGHTS_BLINK_RATE;
      }
      
      if (groups.containsKey("emergencyLights")) {
        JsonObject el = groups["emergencyLights"];
        lightsConfig.emergencyLights.enabled = el["enabled"] | DEFAULT_EMERGENCY_LIGHTS_ENABLED;
        lightsConfig.emergencyLights.brightness = el["brightness"] | DEFAULT_EMERGENCY_LIGHTS_BRIGHTNESS;
        lightsConfig.emergencyLights.mode = el["mode"] | DEFAULT_EMERGENCY_LIGHTS_MODE;
        lightsConfig.emergencyLights.blinkRate = el["blinkRate"] | DEFAULT_EMERGENCY_LIGHTS_BLINK_RATE;
      }
    }

    // Keep legacy snapshot in dynamic config for compatibility
    newLightsConfig.legacy = lightsConfig;

    // Load dynamic light groups (source of truth for modern UI)
    if (doc.containsKey("lightGroupsArray")) {
      JsonArray groupsArray = doc["lightGroupsArray"];
      newLightsConfig.useLegacyMode = false;
      newLightsConfig.groupCount = 0;

      for (JsonObject groupObj : groupsArray) {
        if (newLightsConfig.groupCount >= 10) break;

        ExtendedLightGroup& group = newLightsConfig.groups[newLightsConfig.groupCount];
        memset(&group, 0, sizeof(ExtendedLightGroup));

        const char* name = groupObj["name"] | "";
        strncpy(group.name, name, sizeof(group.name) - 1);
        group.name[sizeof(group.name) - 1] = '\0';

        const char* pattern = groupObj["pattern"] | "Steady";
        strncpy(group.pattern, pattern, sizeof(group.pattern) - 1);
        group.pattern[sizeof(group.pattern) - 1] = '\0';

        group.enabled = groupObj["enabled"] | false;
        group.brightness = groupObj["brightness"] | 255;
        group.mode = groupObj["mode"] | LIGHT_MODE_SOLID;
        group.blinkRate = groupObj["blinkRate"] | 500;
        group.color = groupObj["color"] | 0xFF0000;
        group.color2 = groupObj["color2"] | 0x000000;

        group.ledCount = 0;
        if (groupObj.containsKey("indices")) {
          JsonArray indicesArray = groupObj["indices"];
          for (uint16_t idx : indicesArray) {
            if (group.ledCount >= 100) break;
            group.ledIndices[group.ledCount++] = idx;
          }
        }

        newLightsConfig.groupCount++;
      }
    }
    
    Serial.println("Lights config loaded from SPIFFS");
  }
  
  void saveLights() {
    DynamicJsonDocument doc(8192);
    
    JsonObject groups = doc.createNestedObject("lightGroups");
    
    JsonObject hl = groups.createNestedObject("headlights");
    hl["enabled"] = lightsConfig.headlights.enabled;
    hl["brightness"] = lightsConfig.headlights.brightness;
    hl["mode"] = lightsConfig.headlights.mode;
    hl["blinkRate"] = lightsConfig.headlights.blinkRate;
    
    JsonObject tl = groups.createNestedObject("tailLights");
    tl["enabled"] = lightsConfig.tailLights.enabled;
    tl["brightness"] = lightsConfig.tailLights.brightness;
    tl["mode"] = lightsConfig.tailLights.mode;
    tl["blinkRate"] = lightsConfig.tailLights.blinkRate;
    
    JsonObject el = groups.createNestedObject("emergencyLights");
    el["enabled"] = lightsConfig.emergencyLights.enabled;
    el["brightness"] = lightsConfig.emergencyLights.brightness;
    el["mode"] = lightsConfig.emergencyLights.mode;
    el["blinkRate"] = lightsConfig.emergencyLights.blinkRate;
    
    JsonObject defaults = doc.createNestedObject("defaults");
    defaults["brightness"] = 100;
    defaults["blinkRate"] = 500;

    // Persist dynamic groups and their order as the source of truth.
    JsonArray dynamicGroups = doc.createNestedArray("lightGroupsArray");
    for (uint8_t i = 0; i < newLightsConfig.groupCount && i < 10; i++) {
      const ExtendedLightGroup& group = newLightsConfig.groups[i];
      JsonObject g = dynamicGroups.createNestedObject();
      g["name"] = group.name;
      g["pattern"] = group.pattern;
      g["enabled"] = group.enabled;
      g["brightness"] = group.brightness;
      g["mode"] = group.mode;
      g["blinkRate"] = group.blinkRate;
      g["color"] = group.color;
      g["color2"] = group.color2;

      JsonArray idx = g.createNestedArray("indices");
      for (uint8_t led = 0; led < group.ledCount && led < 100; led++) {
        idx.add(group.ledIndices[led]);
      }
    }
    
    File file = SPIFFS.open(LIGHTS_SPIFFS_PATH, "w");
    if (!file) {
      Serial.println("Failed to create lights config file");
      return;
    }
    
    serializeJson(doc, file);
    file.close();
    
    Serial.println("Lights config saved to SPIFFS");
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
    doc["deviceName"] = config.deviceName;
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
    
    // Save LED configuration
    const char* colorStr = "red";
    if (ledConfig.color == LED_COLOR_GREEN) colorStr = "green";
    else if (ledConfig.color == LED_COLOR_BLUE) colorStr = "blue";
    doc["ledColor"] = colorStr;
    
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
  
  const char* getDeviceName() const {
    if (config.deviceName[0] == '\0') {
      return DEFAULT_DEVICE_NAME;
    }
    return config.deviceName;
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
  
  void updateDeviceName(const String& newName) {
    if (newName.length() > 0 && newName.length() < sizeof(config.deviceName)) {
      strncpy(config.deviceName, newName.c_str(), sizeof(config.deviceName) - 1);
      config.deviceName[sizeof(config.deviceName) - 1] = '\0';
      saveConfig();
      Serial.printf("Device name updated to: %s\n", config.deviceName);
    } else {
      Serial.printf("Invalid device name (length: %d)\n", newName.length());
    }
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
    doc["deviceName"] = config.deviceName;
    
    // Add LED color
    const char* colorStr = "red";
    if (ledConfig.color == LED_COLOR_GREEN) colorStr = "green";
    else if (ledConfig.color == LED_COLOR_BLUE) colorStr = "blue";
    doc["ledColor"] = colorStr;
    
    String output;
    serializeJson(doc, output);
    return output;
  }
  
  void saveConfigFromJSON(const String& jsonStr) {
    DynamicJsonDocument doc(2048);
    DeserializationError error = deserializeJson(doc, jsonStr);
    
    if (error) {
      Serial.print("Failed to parse config JSON: ");
      Serial.println(error.c_str());
      return;
    }
    
    // Update config parameters if present in JSON
    if (doc.containsKey("reactionSpeed")) config.reactionSpeed = doc["reactionSpeed"];
    if (doc.containsKey("rideHeightOffset")) config.rideHeightOffset = doc["rideHeightOffset"];
    if (doc.containsKey("rangeLimit")) config.rangeLimit = doc["rangeLimit"];
    if (doc.containsKey("damping")) config.damping = doc["damping"];
    if (doc.containsKey("frontRearBalance")) config.frontRearBalance = doc["frontRearBalance"];
    if (doc.containsKey("stiffness")) config.stiffness = doc["stiffness"];
    if (doc.containsKey("sampleRate")) config.sampleRate = doc["sampleRate"];
    if (doc.containsKey("telemetryRate")) config.telemetryRate = doc["telemetryRate"];
    if (doc.containsKey("mpuOrientation")) config.mpuOrientation = doc["mpuOrientation"];
    if (doc.containsKey("deviceName")) {
      const char* name = doc["deviceName"];
      strncpy(config.deviceName, name, sizeof(config.deviceName) - 1);
      config.deviceName[sizeof(config.deviceName) - 1] = '\0';
    }
    
    // Update LED color if present
    if (doc.containsKey("ledColor")) {
      const char* colorStr = doc["ledColor"];
      if (strcmp(colorStr, "red") == 0) ledConfig.color = LED_COLOR_RED;
      else if (strcmp(colorStr, "green") == 0) ledConfig.color = LED_COLOR_GREEN;
      else if (strcmp(colorStr, "blue") == 0) ledConfig.color = LED_COLOR_BLUE;
    }
    
    // Save to SPIFFS
    saveConfig();
    Serial.println("Config updated from JSON via BLE");
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
  
  LEDConfig getLEDConfig() const {
    return ledConfig;
  }
  
  void setLEDColor(const String& colorName) {
    if (colorName == "red") ledConfig.color = LED_COLOR_RED;
    else if (colorName == "green") ledConfig.color = LED_COLOR_GREEN;
    else if (colorName == "blue") ledConfig.color = LED_COLOR_BLUE;
    saveConfig();
  }
  
  LightsConfig getLightsConfig() const {
    return lightsConfig;
  }
  
  String getLightsConfigJSON() {
    DynamicJsonDocument doc(8192);
    
    JsonObject groups = doc.createNestedObject("lightGroups");
    
    JsonObject hl = groups.createNestedObject("headlights");
    hl["enabled"] = lightsConfig.headlights.enabled;
    hl["brightness"] = lightsConfig.headlights.brightness;
    hl["mode"] = lightsConfig.headlights.mode;
    hl["blinkRate"] = lightsConfig.headlights.blinkRate;
    
    JsonObject tl = groups.createNestedObject("tailLights");
    tl["enabled"] = lightsConfig.tailLights.enabled;
    tl["brightness"] = lightsConfig.tailLights.brightness;
    tl["mode"] = lightsConfig.tailLights.mode;
    tl["blinkRate"] = lightsConfig.tailLights.blinkRate;
    
    JsonObject el = groups.createNestedObject("emergencyLights");
    el["enabled"] = lightsConfig.emergencyLights.enabled;
    el["brightness"] = lightsConfig.emergencyLights.brightness;
    el["mode"] = lightsConfig.emergencyLights.mode;
    el["blinkRate"] = lightsConfig.emergencyLights.blinkRate;

    JsonArray dynamicGroups = doc.createNestedArray("lightGroupsArray");
    for (uint8_t i = 0; i < newLightsConfig.groupCount && i < 10; i++) {
      const ExtendedLightGroup& group = newLightsConfig.groups[i];
      JsonObject g = dynamicGroups.createNestedObject();
      g["name"] = group.name;
      g["pattern"] = group.pattern;
      g["enabled"] = group.enabled;
      g["brightness"] = group.brightness;
      g["mode"] = group.mode;
      g["blinkRate"] = group.blinkRate;
      g["color"] = group.color;
      g["color2"] = group.color2;

      JsonArray idx = g.createNestedArray("indices");
      for (uint8_t led = 0; led < group.ledCount && led < 100; led++) {
        idx.add(group.ledIndices[led]);
      }
    }

    doc["useLegacyMode"] = newLightsConfig.useLegacyMode;
    doc["groupCount"] = newLightsConfig.groupCount;
    
    String output;
    serializeJson(doc, output);
    return output;
  }
  
  void updateLightsGroup(const String& groupName, JsonObject& updates) {
    LightGroup* target = nullptr;
    
    if (groupName == "headlights") target = &lightsConfig.headlights;
    else if (groupName == "tailLights") target = &lightsConfig.tailLights;
    else if (groupName == "emergencyLights") target = &lightsConfig.emergencyLights;
    
    if (target && updates.size() > 0) {
      if (updates.containsKey("enabled")) target->enabled = updates["enabled"];
      if (updates.containsKey("brightness")) target->brightness = constrain((uint8_t)updates["brightness"], 0, 255);
      if (updates.containsKey("mode")) target->mode = updates["mode"];
      if (updates.containsKey("blinkRate")) target->blinkRate = updates["blinkRate"];
      
      saveLights();
      Serial.printf("Updated lights group: %s\n", groupName.c_str());
    }
  }

  // Store new lights configuration in memory (for dynamic groups)
  void setNewLightsConfig(const NewLightsConfig& config) {
    newLightsConfig = config;
    newLightsConfig.legacy = lightsConfig;
    Serial.printf("[StorageManager] Updated new lights config: %d groups, legacy mode: %d\n", 
                  config.groupCount, config.useLegacyMode);
    saveLights();
  }

  // Get reference to current new lights config
  NewLightsConfig* getNewLightsConfig() {
    return &newLightsConfig;
  }

};

#endif