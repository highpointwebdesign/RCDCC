#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <SPIFFS.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <MPU6050.h>
#include <Adafruit_NeoPixel.h>
#include "Config.h"
#include "SensorFusion.h"
#include "SuspensionSimulator.h"
#include "WebServer.h"
#include "StorageManager.h"
#include "PWMOutputs.h"
#include "LightsEngine.h"

// Global instances
MPU6050 mpu;
SensorFusion sensorFusion;
SuspensionSimulator suspensionSimulator;
WebServerManager webServer;
StorageManager storageManager;
PWMOutputs pwmOutputs;
LightsEngine* lightsEngine = nullptr;  // Initialize as pointer in setup()

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

const char* DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1478218472709292145/9hSRUvb3wEMC-cTIs7OOILUkbqyO1MyEAOlS4zKmR5ztsuUaIxf_d7MNFmorPcISyGNp";

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

void notifyDiscordOnHomeWiFiJoin(const char* deviceName) {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  String connectedSSID = WiFi.SSID();
  if (connectedSSID != String(HOME_WIFI_SSID)) {
    Serial.printf("Discord webhook skipped: connected to '%s' (not home SSID)\n", connectedSSID.c_str());
    return;
  }

  WiFiClientSecure secureClient;
  secureClient.setInsecure();

  HTTPClient http;
  if (!http.begin(secureClient, DISCORD_WEBHOOK_URL)) {
    Serial.println("Discord webhook init failed");
    return;
  }

  http.addHeader("Content-Type", "application/json");

  String payload = "{\"content\":\"" +
                   String(deviceName) +
                   " joined " + connectedSSID +
                   " with IP " + WiFi.localIP().toString() +
                   "\"}";

  int responseCode = http.POST(payload);
  Serial.printf("Discord webhook POST response: %d\n", responseCode);
  http.end();
}

// Timing variables
unsigned long lastMPUReadTime = 0;
unsigned long lastSimulationTime = 0;

// Development mode flag
bool mpuConnected = false;

// Diagnostic flag to isolate WebSocket broadcast blocking
const bool disableWebSocketTelemetry = true;

// Sensor data for HTTP polling
float currentRoll = 0.0f;
float currentPitch = 0.0f;
float currentYaw = 0.0f;
float currentVerticalAccel = 0.0f;

// Function to start LED blink (250ms)
void startLedBlink() {
  digitalWrite(LED_PIN, HIGH);
  flashStatusLED(); // Flash addressable LED too
  ledBlinkEndTime = millis() + 250; // Turn off after 250ms
}

void setup() {
  Serial.begin(115200);
  delay(500);
  
  Serial.println("\n\nESP32 Active Suspension Simulator - Starting...");
  if (disableWebSocketTelemetry) {
    Serial.println("WebSocket telemetry broadcast DISABLED for diagnostics");
  }
  
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
    webServer.init(storageManager, lightsEngine);
  } else {
    Serial.println("MPU6050 initialized successfully");
    Serial.println("MPU6050 found at I2C address 0x68");
  }
  
  // Configure sensor fusion with orientation
  sensorFusion.setOrientation(config.mpuOrientation);
  
  // Initialize sensor fusion with config
  sensorFusion.init(config.sampleRate);
  
  // Initialize and start WiFi + Web Server (if not already started)
  if (mpuConnected) {
    webServer.init(storageManager, lightsEngine);
  }

  notifyDiscordOnHomeWiFiJoin(storageManager.getDeviceName());
  
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
  
  // Set up recalibration callback for web interface
  webServer.setCalibrationCallback([&]() {
    if (mpuConnected) {
      sensorFusion.calibrate(mpu, [](const String& msg) {
        Serial.println(msg);
      });
    }
  });
  
  // Set up orientation callback for web interface
  webServer.setOrientationCallback([&](uint8_t orientation) {
    sensorFusion.setOrientation(orientation);
  });
  
  // Set up MPU status callback for web interface
  webServer.setMPUStatusCallback([&]() {
    // Test if sensor is currently responding
    if (!mpuConnected) return false;
    
    // Quick test: try to read WHO_AM_I register
    Wire.beginTransmission(0x68);
    byte error = Wire.endTransmission();
    return (error == 0);
  });
  
  // Set up LED blink callback for config saves
  webServer.setLedBlinkCallback(startLedBlink);
  
  // Set up LED update callback for color changes
  webServer.setLedUpdateCallback(updateStatusLEDColor);
  
  // Set up emergency light callbacks
  webServer.setEmergencyLightSetCallback([&](String patternJson) {
    // Parse JSON pattern and load it
    // Format: {enabled: bool, pattern: {steps: [{led0, led1, duration}, ...], isLooping: bool}}
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, patternJson);
    
    if (error) {
      Serial.printf("Failed to parse pattern JSON: %s\n", error.c_str());
      return;
    }
    
    bool enabled = doc["enabled"] | false;
    emergencyLightsEnabled = enabled;
    
    if (!enabled) {
      Serial.println("Emergency lights: OFF");
      return;
    }
    
    // Parse pattern structure
    JsonObject patternObj = doc["pattern"];
    if (!patternObj) {
      Serial.println("No pattern data in request");
      return;
    }
    
    JsonArray stepsArray = patternObj["steps"];
    currentPattern.stepCount = stepsArray.size();
    currentPattern.isLooping = patternObj["isLooping"] | true;
    
    if (currentPattern.stepCount > MAX_PATTERN_STEPS) {
      currentPattern.stepCount = MAX_PATTERN_STEPS;
    }
    
    // Load steps
    for (uint8_t i = 0; i < currentPattern.stepCount; i++) {
      JsonObject step = stepsArray[i];
      currentPattern.steps[i].led0Color = strtol(step["led0"] | "000000", nullptr, 16);
      currentPattern.steps[i].led1Color = strtol(step["led1"] | "000000", nullptr, 16);
      currentPattern.steps[i].duration = step["duration"] | 250;
    }
    
    currentPatternStep = 0;
    patternStepStartTime = millis();
    
    Serial.printf("Emergency lights: Pattern loaded with %d steps\n", currentPattern.stepCount);
  });
  
  webServer.setEmergencyLightGetCallback([&](String& patternJson) {
    // Return current pattern state as JSON
    JsonDocument doc;
    doc["enabled"] = emergencyLightsEnabled;
    
    if (emergencyLightsEnabled && currentPattern.stepCount > 0) {
      JsonObject pattern = doc["pattern"].to<JsonObject>();
      pattern["stepCount"] = currentPattern.stepCount;
      pattern["currentStep"] = currentPatternStep;
      pattern["isLooping"] = currentPattern.isLooping;
      
      JsonArray steps = pattern["steps"].to<JsonArray>();
      for (uint8_t i = 0; i < currentPattern.stepCount; i++) {
        JsonObject step = steps.add<JsonObject>();
        char led0Hex[7], led1Hex[7];
        snprintf(led0Hex, sizeof(led0Hex), "%06lX", currentPattern.steps[i].led0Color);
        snprintf(led1Hex, sizeof(led1Hex), "%06lX", currentPattern.steps[i].led1Color);
        step["led0"] = led0Hex;
        step["led1"] = led1Hex;
        step["duration"] = currentPattern.steps[i].duration;
      }
    }
    
    serializeJson(doc, patternJson);
  });
  
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
      unsigned long beforeBroadcast = millis();
      
      if (!disableWebSocketTelemetry) {
        // Store sensor data for HTTP polling
        if (mpuConnected) {
          webServer.setSensorData(roll, pitch, yaw, verticalAccel);
        } else {
          // Store NaN values when sensor offline - dashboard will display '--'
          webServer.setSensorData(NAN, NAN, NAN, NAN);
        }
        
        unsigned long afterBroadcast = millis();
        unsigned long broadcastTime = afterBroadcast - beforeBroadcast;
        if (broadcastTime > 100) {
          Serial.printf("⚠️  SLOW TELEMETRY BROADCAST: %lums\n", broadcastTime);
        }
        Serial.printf("✓ [TELEMETRY] Broadcast complete at %lu ms (took %lu ms)\n", afterBroadcast, broadcastTime);
      } else {
        // Diagnostic mode: skip WebSocket sends, keep HTTP polling updated
        if (mpuConnected) {
          webServer.setSensorData(roll, pitch, yaw, verticalAccel);
        } else {
          webServer.setSensorData(NAN, NAN, NAN, NAN);
        }
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