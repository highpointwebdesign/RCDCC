#include <Arduino.h>
#include <SPIFFS.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <MPU6050.h>
#include <Adafruit_NeoPixel.h>
#include "Config.h"
#include "SensorFusion.h"
#include "SuspensionSimulator.h"
#include "StorageManager.h"
#include "PWMOutputs.h"
#include "LightsEngine.h"
#include "BluetoothService.h"

// Global instances
MPU6050 mpu;
SensorFusion sensorFusion;
SuspensionSimulator suspensionSimulator;
StorageManager storageManager;
PWMOutputs pwmOutputs;
LightsEngine* lightsEngine = nullptr;  // Initialize as pointer in setup()
BluetoothService* bluetoothService = nullptr;  // Initialize in setup()

// LED feedback pin
#define LED_PIN 2
unsigned long ledBlinkEndTime = 0;

// Addressable LED (NeoPixel) - kept for backward compatibility
Adafruit_NeoPixel statusLED(STATUS_LED_COUNT, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);
uint32_t currentLEDColor = 0;

// Emergency light state variables
struct PatternStep {
  uint32_t led0Color;
  uint32_t led1Color;
  uint16_t duration;  // milliseconds
};

const uint8_t MAX_PATTERN_STEPS = 20;
struct EmergencyLightPattern {
  PatternStep steps[MAX_PATTERN_STEPS];
  uint8_t stepCount;
  bool isLooping;
};

bool emergencyLightsEnabled = false;
EmergencyLightPattern currentPattern = {};
uint8_t currentPatternStep = 0;
unsigned long patternStepStartTime = 0;
unsigned long emergencyLightLastUpdate = 0;

// Function to get RGB values from LED color enum
void getLEDColorRGB(LEDColor color, uint8_t& r, uint8_t& g, uint8_t& b) {
  switch(color) {
    case LED_COLOR_RED:
      r = 255; g = 0; b = 0;
      break;
    case LED_COLOR_GREEN:
      r = 0; g = 255; b = 0;
      break;
    case LED_COLOR_BLUE:
      r = 0; g = 0; b = 255;
      break;
    default:
      r = 255; g = 0; b = 0; // Default to red
  }
}

// Function to update addressable LED color from config
void updateStatusLEDColor() {
  LEDConfig ledConfig = storageManager.getLEDConfig();
  uint8_t r, g, b;
  getLEDColorRGB(ledConfig.color, r, g, b);
  currentLEDColor = statusLED.Color(r, g, b);
}

// Function to flash the alert LED (LED index 2)
void flashStatusLED() {
  statusLED.setPixelColor(2, currentLEDColor);
  statusLED.show();
}

// Function to update emergency lights with generic pattern sequencer
void updateEmergencyLights() {
  if (!emergencyLightsEnabled || currentPattern.stepCount == 0) {
    // Turn off emergency lights
    statusLED.setPixelColor(0, 0);
    statusLED.setPixelColor(1, 0);
    statusLED.show();
    return;
  }

  unsigned long now = millis();
  if (now - emergencyLightLastUpdate < 50) {
    return;  // Update at ~20Hz minimum
  }
  emergencyLightLastUpdate = now;

  // Check if current step has timed out
  if (now - patternStepStartTime >= currentPattern.steps[currentPatternStep].duration) {
    currentPatternStep++;
    
    // Loop or stop
    if (currentPatternStep >= currentPattern.stepCount) {
      if (currentPattern.isLooping) {
        currentPatternStep = 0;
      } else {
        currentPatternStep = currentPattern.stepCount - 1;  // Stay on last frame
      }
    }
    patternStepStartTime = now;
  }

  // Set current step colors
  statusLED.setPixelColor(0, currentPattern.steps[currentPatternStep].led0Color);
  statusLED.setPixelColor(1, currentPattern.steps[currentPatternStep].led1Color);
  statusLED.show();
}

// Timing variables
unsigned long lastMPUReadTime = 0;
unsigned long lastSimulationTime = 0;

// Development mode flag
bool mpuConnected = false;

// Sensor data for BLE telemetry
float currentRoll = 0.0f;
float currentPitch = 0.0f;
float currentYaw = 0.0f;
float currentVerticalAccel = 0.0f;
float currentAccelX = 0.0f;
float currentAccelY = 0.0f;
float currentAccelZ = 0.0f;

// Function to start LED blink (250ms)
void startLedBlink() {
  digitalWrite(LED_PIN, HIGH);
  flashStatusLED(); // Flash addressable LED too
  ledBlinkEndTime = millis() + 250; // Turn off after 250ms
}

uint32_t parseHexColor(const String& colorStr) {
  String normalized = colorStr;
  normalized.trim();
  if (normalized.startsWith("#")) {
    normalized.remove(0, 1);
  }
  if (normalized.length() == 0) {
    return 0;
  }
  return strtoul(normalized.c_str(), nullptr, 16) & 0xFFFFFF;
}

bool applyConfigUpdatePayload(const String& payload) {
  DynamicJsonDocument doc(2048);
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("BLE config JSON parse error: %s\n", error.c_str());
    return false;
  }

  if (doc.containsKey("reactionSpeed")) storageManager.updateParameter("reactionSpeed", doc["reactionSpeed"]);
  if (doc.containsKey("rideHeightOffset")) storageManager.updateParameter("rideHeightOffset", doc["rideHeightOffset"]);
  if (doc.containsKey("rangeLimit")) storageManager.updateParameter("rangeLimit", doc["rangeLimit"]);
  if (doc.containsKey("damping")) storageManager.updateParameter("damping", doc["damping"]);
  if (doc.containsKey("frontRearBalance")) storageManager.updateParameter("frontRearBalance", doc["frontRearBalance"]);
  if (doc.containsKey("stiffness")) storageManager.updateParameter("stiffness", doc["stiffness"]);
  if (doc.containsKey("sampleRate")) storageManager.updateParameter("sampleRate", doc["sampleRate"]);
  if (doc.containsKey("telemetryRate")) storageManager.updateParameter("telemetryRate", doc["telemetryRate"]);
  if (doc.containsKey("mpuOrientation")) {
    uint8_t orientation = doc["mpuOrientation"];
    storageManager.updateParameter("mpuOrientation", orientation);
    sensorFusion.setOrientation(orientation);
  }
  if (doc.containsKey("fpvAutoMode")) {
    bool autoMode = doc["fpvAutoMode"];
    storageManager.updateParameter("fpvAutoMode", autoMode ? 1.0f : 0.0f);
  }

  if (doc.containsKey("deviceName")) {
    storageManager.updateDeviceName(doc["deviceName"].as<String>());
  }

  if (doc.containsKey("ledColor")) {
    storageManager.setLEDColor(doc["ledColor"].as<String>());
    updateStatusLEDColor();
  }

  if (doc.containsKey("servos")) {
    JsonObject servos = doc["servos"];
    for (const char* servoName : {"frontLeft", "frontRight", "rearLeft", "rearRight"}) {
      if (!servos.containsKey(servoName)) continue;
      JsonObject servo = servos[servoName];
      if (servo.containsKey("min")) storageManager.updateServoParameter(servoName, "min", servo["min"]);
      if (servo.containsKey("max")) storageManager.updateServoParameter(servoName, "max", servo["max"]);
      if (servo.containsKey("trim")) storageManager.updateServoParameter(servoName, "trim", servo["trim"]);
      if (servo.containsKey("reversed")) storageManager.updateServoParameter(servoName, "reversed", servo["reversed"]);
    }
  }

  startLedBlink();
  return true;
}

bool applyServoConfigPayload(const String& payload) {
  DynamicJsonDocument doc(1024);
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("BLE servo JSON parse error: %s\n", error.c_str());
    return false;
  }

  if (!(doc.containsKey("servo") && doc.containsKey("param") && doc.containsKey("value"))) {
    return false;
  }

  storageManager.updateServoParameter(
    doc["servo"].as<String>(),
    doc["param"].as<String>(),
    doc["value"].as<int>()
  );

  startLedBlink();
  return true;
}

bool applyLightsPayload(const String& payload) {
  DynamicJsonDocument doc(4096);
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("BLE lights JSON parse error: %s\n", error.c_str());
    return false;
  }

  NewLightsConfig config;
  memset(&config, 0, sizeof(NewLightsConfig));

  if (doc.containsKey("lightGroupsArray")) {
    JsonArray groupsArray = doc["lightGroupsArray"];
    config.useLegacyMode = false;
    config.groupCount = 0;

    for (JsonObject groupObj : groupsArray) {
      if (config.groupCount >= 10) break;

      ExtendedLightGroup& group = config.groups[config.groupCount];
      memset(&group, 0, sizeof(ExtendedLightGroup));

      if (groupObj.containsKey("name")) {
        strncpy(group.name, groupObj["name"], sizeof(group.name) - 1);
        group.name[sizeof(group.name) - 1] = '\0';
      }

      const char* pattern = groupObj["pattern"] | "Steady";
      strncpy(group.pattern, pattern, sizeof(group.pattern) - 1);
      group.pattern[sizeof(group.pattern) - 1] = '\0';

      group.enabled = groupObj["enabled"] | false;
      group.brightness = groupObj["brightness"] | 255;
      group.mode = groupObj["mode"] | LIGHT_MODE_SOLID;
      group.blinkRate = groupObj["blinkRate"] | 500;

      if (groupObj.containsKey("color")) {
        if (groupObj["color"].is<const char*>()) {
          group.color = parseHexColor(groupObj["color"].as<String>());
        } else {
          group.color = groupObj["color"].as<uint32_t>();
        }
      }
      if (groupObj.containsKey("color2")) {
        if (groupObj["color2"].is<const char*>()) {
          group.color2 = parseHexColor(groupObj["color2"].as<String>());
        } else {
          group.color2 = groupObj["color2"].as<uint32_t>();
        }
      }

      if (groupObj.containsKey("indices")) {
        JsonArray indicesArray = groupObj["indices"];
        for (uint16_t idx : indicesArray) {
          if (group.ledCount >= 100) break;
          group.ledIndices[group.ledCount++] = idx;
        }
      }

      config.groupCount++;
    }
  } else if (doc.containsKey("lightGroups")) {
    JsonObject groups = doc["lightGroups"];
    config.useLegacyMode = true;
    config.groupCount = 0;

    if (groups.containsKey("headlights")) {
      JsonObject hl = groups["headlights"];
      config.legacy.headlights.enabled = hl["enabled"] | false;
      config.legacy.headlights.brightness = hl["brightness"] | 255;
      config.legacy.headlights.mode = hl["mode"] | LIGHT_MODE_SOLID;
      config.legacy.headlights.blinkRate = hl["blinkRate"] | 500;
    }
    if (groups.containsKey("tailLights")) {
      JsonObject tl = groups["tailLights"];
      config.legacy.tailLights.enabled = tl["enabled"] | false;
      config.legacy.tailLights.brightness = tl["brightness"] | 255;
      config.legacy.tailLights.mode = tl["mode"] | LIGHT_MODE_SOLID;
      config.legacy.tailLights.blinkRate = tl["blinkRate"] | 500;
    }
    if (groups.containsKey("emergencyLights")) {
      JsonObject el = groups["emergencyLights"];
      config.legacy.emergencyLights.enabled = el["enabled"] | false;
      config.legacy.emergencyLights.brightness = el["brightness"] | 255;
      config.legacy.emergencyLights.mode = el["mode"] | LIGHT_MODE_SOLID;
      config.legacy.emergencyLights.blinkRate = el["blinkRate"] | 500;
    }
  } else {
    return false;
  }

  storageManager.setNewLightsConfig(config);
  if (lightsEngine) {
    lightsEngine->updateFromPayload(config);
  }

  return true;
}

bool applySystemCommandPayload(const String& payload) {
  DynamicJsonDocument doc(512);
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("BLE system JSON parse error: %s\n", error.c_str());
    return false;
  }

  String command = doc["command"] | "";
  command.toLowerCase();

  if (command == "autolevel" || command == "resetgyro" || command == "calibrate") {
    if (mpuConnected) {
      sensorFusion.calibrate(mpu, [](const String& msg) {
        Serial.println(msg);
      });
    }
    return true;
  }

  if (command == "reset" || command == "resetconfig") {
    storageManager.resetToDefaults();
    return true;
  }

  return false;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  
  Serial.println("\n\nESP32 Active Suspension Simulator - Starting...");
  
  // Initialize SPIFFS
  if (!SPIFFS.begin(true)) {
    Serial.println("SPIFFS Mount Failed");
    return;
  }
  Serial.println("SPIFFS initialized");
  
  // Initialize LightsEngine (after SPIFFS, before other systems)
  lightsEngine = new LightsEngine(STATUS_LED_PIN, STATUS_LED_COUNT);
  Serial.printf("LightsEngine initialized: %d LED capacity\n", STATUS_LED_COUNT);
  
  // Load configuration from storage
  storageManager.init();
  storageManager.loadConfig();
  storageManager.loadLights();
  if (lightsEngine) {
    NewLightsConfig* persistedLights = storageManager.getNewLightsConfig();
    if (persistedLights) {
      lightsEngine->updateFromPayload(*persistedLights);
      Serial.printf("Applied persisted lights config on boot (%d groups)\n", persistedLights->groupCount);
    }
  }
  SuspensionConfig config = storageManager.getConfig();
  ServoConfig servoConfig = storageManager.getServoConfig();
  
  // Initialize I2C and MPU6050
  Wire.begin(21, 22); // SDA=21, SCL=22 for most ESP32 boards
  delay(100);
  
  Serial.println("Testing MPU6050 connection...");
  Serial.println("Scanning I2C bus...");
  
  // Scan I2C bus
  byte error, address;
  int nDevices = 0;
  for(address = 1; address < 127; address++ ) {
    Wire.beginTransmission(address);
    error = Wire.endTransmission();
    if (error == 0) {
      Serial.print("I2C device found at address 0x");
      if (address<16) Serial.print("0");
      Serial.println(address,HEX);
      nDevices++;
    }
  }
  if (nDevices == 0) {
    Serial.println("No I2C devices found!");
  } else {
    Serial.println("I2C scan complete");
  }
  
  mpu.initialize();
  delay(50);
  
  mpuConnected = mpu.testConnection();
  if (!mpuConnected) {
    Serial.println("MPU6050 connection failed - using simulated sensor data for testing");
    Serial.println("Check wiring: SDA=GPIO21, SCL=GPIO22, VCC=3.3V, GND=GND");
    Serial.println("MPU6050 should be at I2C address 0x68");
  } else {
    Serial.println("MPU6050 initialized successfully");
    Serial.println("MPU6050 found at I2C address 0x68");
  }
  
  // Configure sensor fusion with orientation
  sensorFusion.setOrientation(config.mpuOrientation);
  
  // Initialize sensor fusion with config
  sensorFusion.init(config.sampleRate);
  
  // Initialize LED pin for feedback
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  
  // Initialize addressable LED (NeoPixel)
  statusLED.begin();
  statusLED.setBrightness(50); // Set brightness (0-255)
  statusLED.clear();
  statusLED.show();
  updateStatusLEDColor(); // Load color from config
  Serial.println("Status LED initialized");
  
  // Calibrate to current position as level
  if (mpuConnected) {
    sensorFusion.calibrate(mpu, [](const String& msg) {
      Serial.println(msg);  // Output to Serial only
    });
  }
  
  // Initialize suspension simulator with config and servo calibration
  suspensionSimulator.init(config, servoConfig);
  
  // Initialize PWM outputs
  pwmOutputs.init();
  
  // Initialize Bluetooth Low Energy service
  bluetoothService = new BluetoothService(&storageManager);
  bluetoothService->setConfigWriteHandler(applyConfigUpdatePayload);
  bluetoothService->setServoWriteHandler(applyServoConfigPayload);
  bluetoothService->setLightsWriteHandler(applyLightsPayload);
  bluetoothService->setSystemWriteHandler(applySystemCommandPayload);
  const char* bleDeviceName = storageManager.getDeviceName();
  if (bleDeviceName == nullptr || bleDeviceName[0] == '\0') {
    bleDeviceName = DEFAULT_DEVICE_NAME;
  }
  Serial.printf("Starting BLE advertising as: %s\n", bleDeviceName);
  bluetoothService->begin(bleDeviceName);
  Serial.println("Bluetooth service started");
  
  Serial.println("Setup complete!");
}

// Main loop
void loop() {
  unsigned long loopStartTime = millis();
  unsigned long currentTime = loopStartTime;
  static unsigned long lastLoopTime = 0;
  static bool firstLoop = true;
  
  // Log loop execution time every 5 seconds for diagnostics
  if (!firstLoop && (currentTime - lastLoopTime) > 5000) {
    unsigned long loopDuration = currentTime - lastLoopTime;
    Serial.printf("[LOOP] Loop cycle time: %lums\n", loopDuration);
    if (loopDuration > 2000) {
      Serial.printf("⚠️  LONG LOOP DETECTED: %lums - possible blocking operation!\n", loopDuration);
    }
    lastLoopTime = currentTime;
  }
  if (firstLoop) {
    lastLoopTime = currentTime;
    firstLoop = false;
  }
  
  // Handle LED blink timeout
  if (ledBlinkEndTime > 0 && currentTime >= ledBlinkEndTime) {
    digitalWrite(LED_PIN, LOW);
    statusLED.clear(); // Turn off addressable LED
    statusLED.show();
    ledBlinkEndTime = 0;
  }
  
  // Update emergency light patterns (non-blocking)
  updateEmergencyLights();
  
  // Update dynamic light groups (patterns, animations, etc.)
  if (lightsEngine) {
    lightsEngine->update();
  }
  
  // Read MPU6050 sensor data at specified rate
  // Skip I2C read if sensor not connected to avoid 5s timeout blocking
  if (mpuConnected && currentTime - lastMPUReadTime >= (1000 / SUSPENSION_SAMPLE_RATE_HZ)) {
    unsigned long sensorBlockStart = millis();
    float accelX, accelY, accelZ, gyroX, gyroY, gyroZ;
    
    // Read sensor data from connected device
    int16_t ax, ay, az, gx, gy, gz;
    
    // CHECKPOINT: I2C Read Start
    unsigned long beforeI2C = millis();
    
    // Suppress I2C error messages temporarily to avoid flooding serial
    esp_log_level_set("Wire", ESP_LOG_NONE);
    mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
    esp_log_level_set("Wire", ESP_LOG_WARN);
    
    unsigned long i2cTime = millis() - beforeI2C;
    if (i2cTime > 100) {
      Serial.printf("⚠️  SLOW I2C READ: %lums\n", i2cTime);
    }
    
    // WATCHDOG FEED: Feed watchdog after I2C operation (can be slow)
    yield();
    
    // Check if we got valid data (not all zeros which indicates error)
    if (ax != 0 || ay != 0 || az != 0 || gx != 0 || gy != 0 || gz != 0) {
      // Convert raw values to g's and dps
      accelX = ax / 16384.0f;
      accelY = ay / 16384.0f;
      accelZ = az / 16384.0f;
      gyroX = gx / 131.0f;
      gyroY = gy / 131.0f;
      gyroZ = gz / 131.0f;
      
      // Update connection status - sensor is working!
      if (!mpuConnected) {
        mpuConnected = true;
        Serial.println("MPU6050 now responding - sensor online");
      }
    } else {
      // I2C error - use neutral values for safety
      accelX = 0.0f;
      accelY = 0.0f;
      accelZ = 1.0f;  // Gravity
      gyroX = 0.0f;
      gyroY = 0.0f;
      gyroZ = 0.0f;
      
      // Mark sensor as disconnected
      if (mpuConnected) {
        mpuConnected = false;
        Serial.println("MPU6050 stopped responding");
      }
    }
    
    // Update sensor fusion
    sensorFusion.update(accelX, accelY, accelZ, gyroX, gyroY, gyroZ);
    
    // Store acceleration values for BLE telemetry
    currentAccelX = accelX;
    currentAccelY = accelY;
    currentAccelZ = accelZ;
    
    lastMPUReadTime = currentTime;
    
    unsigned long afterSensorTime = millis();
    if (afterSensorTime - loopStartTime > 1000) {
      Serial.printf("⚠️  LONG SENSOR READ: %lums\n", afterSensorTime - loopStartTime);
    }
  }
  
  // Run suspension simulation
  if (currentTime - lastSimulationTime >= (1000 / SUSPENSION_SAMPLE_RATE_HZ)) {
    unsigned long simulationBlockStart = millis();
    
    // Get current orientation and acceleration from sensor fusion
    float roll = sensorFusion.getRoll();
    float pitch = sensorFusion.getPitch();
    float yaw = sensorFusion.getYaw();
    float verticalAccel = sensorFusion.getVerticalAcceleration();
    
    // CHECKPOINT: Suspension update
    unsigned long beforeSuspUpdate = millis();
    suspensionSimulator.update(roll, pitch, verticalAccel);
    unsigned long suspUpdateTime = millis() - beforeSuspUpdate;
    if (suspUpdateTime > 50) {
      Serial.printf("⚠️  SLOW SUSPENSION UPDATE: %lums\n", suspUpdateTime);
    }
    
    // Get suspension outputs (0-180 degrees for servos)
    float fl = suspensionSimulator.getFrontLeftOutput();
    float fr = suspensionSimulator.getFrontRightOutput();
    float rl = suspensionSimulator.getRearLeftOutput();
    float rr = suspensionSimulator.getRearRightOutput();
    
    // CHECKPOINT: Servo config load (SPIFFS read - can be slow)
    unsigned long beforeServoConfig = millis();
    ServoConfig servoConfig = storageManager.getServoConfig();
    unsigned long servoConfigTime = millis() - beforeServoConfig;
    if (servoConfigTime > 100) {
      Serial.printf("⚠️  SLOW SERVO CONFIG LOAD: %lums (SPIFFS read)\n", servoConfigTime);
    }
    
    // CHECKPOINT: PWM writes
    unsigned long beforePWM = millis();
    pwmOutputs.setChannel(0, fl, servoConfig.frontLeft);
    pwmOutputs.setChannel(1, fr, servoConfig.frontRight);
    pwmOutputs.setChannel(2, rl, servoConfig.rearLeft);
    pwmOutputs.setChannel(3, rr, servoConfig.rearRight);
    unsigned long pwmTime = millis() - beforePWM;
    if (pwmTime > 50) {
      Serial.printf("⚠️  SLOW PWM WRITES: %lums\n", pwmTime);
    }
    
    // Broadcast sensor data to web clients (interval based on telemetry rate config)
    static unsigned long lastBroadcast = 0;
    
    // CHECKPOINT: System config load (SPIFFS read - can be slow)
    unsigned long beforeSysConfig = millis();
    SuspensionConfig config = storageManager.getConfig();
    unsigned long sysConfigTime = millis() - beforeSysConfig;
    if (sysConfigTime > 100) {
      Serial.printf("⚠️  SLOW SYSTEM CONFIG LOAD: %lums (SPIFFS read)\n", sysConfigTime);
    }
    
    uint16_t telemetryIntervalMs = 1000 / config.telemetryRate;  // Convert Hz to milliseconds
    if (currentTime - lastBroadcast >= telemetryIntervalMs) {
      // Send telemetry via Bluetooth LE if connected
      if (bluetoothService && bluetoothService->isConnected() && mpuConnected) {
        bluetoothService->sendTelemetry(roll, pitch, currentAccelX, currentAccelY, currentAccelZ);
      }
      
      lastBroadcast = currentTime;
    }
    
    lastSimulationTime = currentTime;
  }
  
  // FINAL LOOP SUMMARY: Calculate total loop time and identify anomalies
  unsigned long loopEndTime = millis();
  unsigned long totalLoopTime = loopEndTime - loopStartTime;
  static unsigned long maxLoopTime = 0;
  static unsigned long crashDetectionWindow = 0;
  
  if (totalLoopTime > maxLoopTime) {
    maxLoopTime = totalLoopTime;
  }
  
  if (totalLoopTime > 1000) {
    Serial.printf("\n⛔ CRITICAL: Loop took %lums (max so far: %lums)\n", totalLoopTime, maxLoopTime);
    Serial.printf("   → If crash follows shortly, potential blocking operation identified\n\n");
    crashDetectionWindow = loopEndTime;
  }
  
  // FINAL WATCHDOG FEED before loop ends
  yield();
}