#include <Arduino.h>
#include <WiFi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <SPIFFS.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <MPU6050.h>
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

// Timing variables
unsigned long lastMPUReadTime = 0;
unsigned long lastSimulationTime = 0;

// Development mode flag
bool mpuConnected = false;

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
  ledBlinkEndTime = millis() + 250; // Turn off after 250ms
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
    webServer.sendStatus("Development Mode: MPU6050 not connected (using simulated data)");
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
  
  // Set up recalibration callback for web interface
  webServer.setCalibrationCallback([&]() {
    if (mpuConnected) {
      sensorFusion.calibrate(mpu, [](const String& msg) {
        webServer.sendStatus(msg);
      });
    } else {
      webServer.sendStatus("Cannot calibrate - MPU6050 not connected");
    }
  });
  
  // Set up orientation callback for web interface
  webServer.setOrientationCallback([&](uint8_t orientation) {
    sensorFusion.setOrientation(orientation);
    webServer.sendStatus("MPU6050 orientation updated");
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
  
  // Calibrate to current position as level (sends status to web dashboard)
  if (mpuConnected) {
    sensorFusion.calibrate(mpu, [](const String& msg) {
      Serial.println(msg);  // Output to Serial
      webServer.sendStatus(msg);  // Output to Web
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
  
  // Send final ready status
  webServer.sendStatus("System ready");
  
  Serial.println("Setup complete!");
}

// Main loop
void loop() {
  unsigned long currentTime = millis();
  
  // Handle LED blink timeout
  if (ledBlinkEndTime > 0 && currentTime >= ledBlinkEndTime) {
    digitalWrite(LED_PIN, LOW);
    ledBlinkEndTime = 0;
  }
  
  // Read MPU6050 sensor data at specified rate
  if (currentTime - lastMPUReadTime >= (1000 / SUSPENSION_SAMPLE_RATE_HZ)) {
    float accelX, accelY, accelZ, gyroX, gyroY, gyroZ;
    
    // Always try to read sensor data (to detect reconnection)
    int16_t ax, ay, az, gx, gy, gz;
    
    // Suppress I2C error messages temporarily to avoid flooding serial
    esp_log_level_set("Wire", ESP_LOG_NONE);
    mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
    esp_log_level_set("Wire", ESP_LOG_WARN);
    
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
  }
  
  // Run suspension simulation
  if (currentTime - lastSimulationTime >= (1000 / SUSPENSION_SAMPLE_RATE_HZ)) {
    // Get current orientation and acceleration from sensor fusion
    float roll = sensorFusion.getRoll();
    float pitch = sensorFusion.getPitch();
    float yaw = sensorFusion.getYaw();
    float verticalAccel = sensorFusion.getVerticalAcceleration();
    
    // Update suspension state
    suspensionSimulator.update(roll, pitch, verticalAccel);
    
    // Get suspension outputs (0-180 degrees for servos)
    float fl = suspensionSimulator.getFrontLeftOutput();
    float fr = suspensionSimulator.getFrontRightOutput();
    float rl = suspensionSimulator.getRearLeftOutput();
    float rr = suspensionSimulator.getRearRightOutput();
    
    // Get servo calibration settings
    ServoConfig servoConfig = storageManager.getServoConfig();
    
    // Write PWM outputs with calibration applied
    pwmOutputs.setChannel(0, fl, servoConfig.frontLeft);
    pwmOutputs.setChannel(1, fr, servoConfig.frontRight);
    pwmOutputs.setChannel(2, rl, servoConfig.rearLeft);
    pwmOutputs.setChannel(3, rr, servoConfig.rearRight);
    
    // Broadcast sensor data to web clients (interval based on telemetry rate config)
    static unsigned long lastBroadcast = 0;
    SuspensionConfig config = storageManager.getConfig();
    uint16_t telemetryIntervalMs = 1000 / config.telemetryRate;  // Convert Hz to milliseconds
    if (currentTime - lastBroadcast >= telemetryIntervalMs) {
      if (mpuConnected) {
        webServer.sendSensorData(roll, pitch, yaw, verticalAccel);
        webServer.setSensorData(roll, pitch, yaw, verticalAccel); // Store for HTTP polling
      } else {
        // Send NaN values when sensor offline - dashboard will display '--'
        webServer.sendSensorData(NAN, NAN, NAN, NAN);
        webServer.setSensorData(NAN, NAN, NAN, NAN); // Store for HTTP polling
      }
      lastBroadcast = currentTime;
    }
    
    lastSimulationTime = currentTime;
  }
  
  // Read battery voltages periodically
  if (currentTime - lastBatteryReadTime >= BATTERY_READ_INTERVAL) {
    BatteriesConfig batteryConfig = storageManager.getBatteryConfig();
    
    // Read voltage for each configured battery
    batteryVoltages[0] = readBatteryVoltage(batteryConfig.battery1.plugAssignment);
    batteryVoltages[1] = readBatteryVoltage(batteryConfig.battery2.plugAssignment);
    batteryVoltages[2] = readBatteryVoltage(batteryConfig.battery3.plugAssignment);
    
    // Broadcast battery voltages to web clients
    webServer.sendBatteryData(batteryVoltages[0], batteryVoltages[1], batteryVoltages[2]);
    webServer.setBatteryData(batteryVoltages[0], batteryVoltages[1], batteryVoltages[2]); // Store for HTTP polling
    
    lastBatteryReadTime = currentTime;
  }
  
  yield();
}
