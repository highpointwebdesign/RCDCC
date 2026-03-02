#include <Arduino.h>
#include <WiFi.h>
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

// Global instances
MPU6050 mpu;
SensorFusion sensorFusion;
SuspensionSimulator suspensionSimulator;
WebServerManager webServer;
StorageManager storageManager;
PWMOutputs pwmOutputs;

// LED feedback pin
#define LED_PIN 2
unsigned long ledBlinkEndTime = 0;

// Addressable LED (NeoPixel)
Adafruit_NeoPixel statusLED(STATUS_LED_COUNT, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);
uint32_t currentLEDColor = 0;

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

// Function to flash the addressable LED
void flashStatusLED() {
  statusLED.setPixelColor(0, currentLEDColor);
  statusLED.show();
}

// Timing variables
unsigned long lastMPUReadTime = 0;
unsigned long lastSimulationTime = 0;

// Development mode flag
bool mpuConnected = false;

// Diagnostic flag to isolate WebSocket broadcast blocking
const bool disableWebSocketTelemetry = true;

// Battery monitoring variables
float batteryVoltages[3] = {0.0f, 0.0f, 0.0f}; // Voltages for 3 batteries
unsigned long lastBatteryReadTime = 0;
const unsigned long BATTERY_READ_INTERVAL = 500; // Read batteries every 500ms

// Sensor data for HTTP polling
float currentRoll = 0.0f;
float currentPitch = 0.0f;
float currentYaw = 0.0f;
float currentVerticalAccel = 0.0f;

// Function to read battery voltage from ADC pin
float readBatteryVoltage(uint8_t plugAssignment) {
  if (plugAssignment == 0) return 0.0f; // No plug assigned
  
  int adcPin;
  if (plugAssignment == 1) adcPin = BATTERY_ADC_PIN_A; // GPIO 34
  else if (plugAssignment == 2) adcPin = BATTERY_ADC_PIN_B; // GPIO 35
  else if (plugAssignment == 3) adcPin = BATTERY_ADC_PIN_C; // GPIO 32
  else return 0.0f;
  
  // Read ADC value (12-bit: 0-4095)
  int adcValue = analogRead(adcPin);
  
  // Calculate voltage: (ADC / 4095) * 3.3V * voltage_divider_ratio
  float voltage = (adcValue / BATTERY_ADC_RESOLUTION) * BATTERY_VREF * BATTERY_VOLTAGE_DIVIDER_RATIO;
  
  return voltage;
}

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
  
  // Load configuration from storage
  storageManager.init();
  storageManager.loadConfig();
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
    webServer.init(storageManager);
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
    webServer.init(storageManager);
  }
  
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
  
  // Configure ADC pins for battery monitoring
  analogReadResolution(12); // 12-bit resolution (0-4095)
  analogSetAttenuation(ADC_11db); // Full range: 0-3.3V
  pinMode(BATTERY_ADC_PIN_A, INPUT); // GPIO 34
  pinMode(BATTERY_ADC_PIN_B, INPUT); // GPIO 35
  pinMode(BATTERY_ADC_PIN_C, INPUT); // GPIO 32
  Serial.println("Battery monitoring ADC pins configured");
  
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
  
  // CHECKPOINT: WiFi status check
  unsigned long beforeWiFiCheck = millis();
  int wifiStatus = WiFi.status();
  unsigned long wifiCheckTime = millis() - beforeWiFiCheck;
  if (wifiCheckTime > 50) {
    Serial.printf("⚠️  SLOW WIFI STATUS CHECK: %lums\n", wifiCheckTime);
  }
  
  // Handle LED blink timeout
  if (ledBlinkEndTime > 0 && currentTime >= ledBlinkEndTime) {
    digitalWrite(LED_PIN, LOW);
    statusLED.clear(); // Turn off addressable LED
    statusLED.show();
    ledBlinkEndTime = 0;
  }
  
  // Read MPU6050 sensor data at specified rate
  if (currentTime - lastMPUReadTime >= (1000 / SUSPENSION_SAMPLE_RATE_HZ)) {
    unsigned long sensorBlockStart = millis();
    float accelX, accelY, accelZ, gyroX, gyroY, gyroZ;
    
    // Always try to read sensor data (to detect reconnection)
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
  
  // Read battery voltages periodically
  // TODO: Battery monitoring disabled to improve stability - will re-enable in later release
  /*
  if (currentTime - lastBatteryReadTime >= BATTERY_READ_INTERVAL) {
    unsigned long beforeBatteryBlock = millis();
    
    BatteriesConfig batteryConfig = storageManager.getBatteryConfig();
    
    // Read voltage for each configured battery
    unsigned long beforeBatt1 = millis();
    batteryVoltages[0] = readBatteryVoltage(batteryConfig.battery1.plugAssignment);
    unsigned long batt1Time = millis() - beforeBatt1;
    if (batt1Time > 20) Serial.printf("⚠️  SLOW BATT1 READ: %lums\n", batt1Time);
    
    yield(); // Feed watchdog between ADC reads
    
    unsigned long beforeBatt2 = millis();
    batteryVoltages[1] = readBatteryVoltage(batteryConfig.battery2.plugAssignment);
    unsigned long batt2Time = millis() - beforeBatt2;
    if (batt2Time > 20) Serial.printf("⚠️  SLOW BATT2 READ: %lums\n", batt2Time);
    
    yield(); // Feed watchdog between ADC reads
    
    unsigned long beforeBatt3 = millis();
    batteryVoltages[2] = readBatteryVoltage(batteryConfig.battery3.plugAssignment);
    unsigned long batt3Time = millis() - beforeBatt3;
    if (batt3Time > 20) Serial.printf("⚠️  SLOW BATT3 READ: %lums\n", batt3Time);
    
    yield(); // Feed watchdog after all reads
    
    // Broadcast battery voltages to web clients
    unsigned long beforeBattBcast = millis();
    webServer.sendBatteryData(batteryVoltages[0], batteryVoltages[1], batteryVoltages[2]);
    webServer.setBatteryData(batteryVoltages[0], batteryVoltages[1], batteryVoltages[2]); // Store for HTTP polling
    unsigned long battBcastTime = millis() - beforeBattBcast;
    if (battBcastTime > 50) Serial.printf("⚠️  SLOW BATT BROADCAST: %lums\n", battBcastTime);
    
    unsigned long totalBatteryTime = millis() - beforeBatteryBlock;
    if (totalBatteryTime > 100) {
      Serial.printf("⚠️  SLOW TOTAL BATTERY BLOCK: %lums\n", totalBatteryTime);
    }
    
    lastBatteryReadTime = currentTime;
  }
  */
  
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
    Serial.printf("   [WiFi check: recently checked at %lu ms]\n", beforeWiFiCheck);
    Serial.printf("   → If crash follows shortly, potential blocking operation identified\n\n");
    crashDetectionWindow = loopEndTime;
  }
  
  // FINAL WATCHDOG FEED before loop ends
  yield();
}