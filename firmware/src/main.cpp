#include <Arduino.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <MPU6050.h>
#include <Adafruit_NeoPixel.h>
#include "Config.h"
#include "SensorFusion.h"
#include "SuspensionSimulator.h"
#include "StorageManager.h"
#include "PWMOutputs.h"
#include "BluetoothService.h"

// Global instances
MPU6050 mpu;
SensorFusion sensorFusion;
SuspensionSimulator suspensionSimulator;
StorageManager storageManager;
PWMOutputs pwmOutputs;
BluetoothService* bluetoothService = nullptr;  // Initialize in setup()

// LED feedback pin
#define LED_PIN 2
unsigned long ledBlinkEndTime = 0;
bool ledBleOn = false;  // true while BLE is connected (steady-on state)

// Continuous-servo BLE watchdog: stops all continuous servos if no BLE
// command is received within this window (phone disconnection safety net).
static uint32_t lastBleCommandMs = 0;
static constexpr uint32_t CONTINUOUS_WATCHDOG_MS = 500;
static constexpr bool LIGHTS_ENTRYPOINT_ENABLED = false;

// Addressable LED (NeoPixel) - kept for backward compatibility
Adafruit_NeoPixel statusLED(STATUS_LED_COUNT, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);
uint32_t currentLEDColor = 0;
bool legacyStatusLedEnabled = true;

// ==================== Phase 6: Dance Mode ====================
DanceMode gDanceMode = { false, 0.0f, 0.0f };

static float clampNorm(float value) {
  if (value < -1.0f) return -1.0f;
  if (value > 1.0f) return 1.0f;
  return value;
}

static int32_t clampI32Safe(int32_t value, int32_t minValue, int32_t maxValue) {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
}

static int32_t mapNormToServoUs(float norm, const RCDCCServoState& servo) {
  const int32_t servoMin = min(servo.minUs, servo.maxUs);
  const int32_t servoMax = max(servo.minUs, servo.maxUs);
  const int32_t safeMin = clampI32Safe(servoMin, 900, 2100);
  const int32_t safeMax = clampI32Safe(servoMax, safeMin + 1, 2100);
  const int32_t safeTrim = clampI32Safe(servo.trimUs, safeMin, safeMax);

  float mapped = static_cast<float>(safeTrim);
  if (norm >= 0.0f) {
    mapped = static_cast<float>(safeTrim) + (norm * static_cast<float>(safeMax - safeTrim));
  } else {
    mapped = static_cast<float>(safeTrim) + (norm * static_cast<float>(safeTrim - safeMin));
  }

  // Final firmware-side safety net: never command beyond configured limits.
  return clampI32Safe(static_cast<int32_t>(lroundf(mapped)), safeMin, safeMax);
}

static String buildBleAdvertisedName() {
  // Use the unique device-specific half of the base MAC as a stable 6-hex suffix.
  // ESP.getEfuseMac() exposes the MAC in an order where the lower 24 bits map to the
  // vendor/OUI bytes on this platform, which can collide across multiple devices.
  // Shift to the upper 24 bits so the advertised suffix matches the unique bytes that
  // differ per ESP32 unit (for example: xx:xx:xx:6A:92:46 -> 6A9246).
  const uint64_t chipMac = ESP.getEfuseMac();
  const uint32_t suffix = static_cast<uint32_t>((chipMac >> 24) & 0xFFFFFFULL);
  char nameBuf[24] = {0};
  snprintf(nameBuf, sizeof(nameBuf), "%s-%06X", DEFAULT_DEVICE_NAME, suffix);
  return String(nameBuf);
}

static void writeTrimToAllSuspensionServos() {
  const RCDCCConfigState& state = storageManager.getCurrentState();

  const int32_t flTrim = clampI32Safe(state.servoFL.trimUs, min(state.servoFL.minUs, state.servoFL.maxUs), max(state.servoFL.minUs, state.servoFL.maxUs));
  const int32_t frTrim = clampI32Safe(state.servoFR.trimUs, min(state.servoFR.minUs, state.servoFR.maxUs), max(state.servoFR.minUs, state.servoFR.maxUs));
  const int32_t rlTrim = clampI32Safe(state.servoRL.trimUs, min(state.servoRL.minUs, state.servoRL.maxUs), max(state.servoRL.minUs, state.servoRL.maxUs));
  const int32_t rrTrim = clampI32Safe(state.servoRR.trimUs, min(state.servoRR.minUs, state.servoRR.maxUs), max(state.servoRR.minUs, state.servoRR.maxUs));

  pwmOutputs.setChannelMicroseconds(0, static_cast<uint16_t>(flTrim));
  pwmOutputs.setChannelMicroseconds(1, static_cast<uint16_t>(frTrim));
  pwmOutputs.setChannelMicroseconds(2, static_cast<uint16_t>(rlTrim));
  pwmOutputs.setChannelMicroseconds(3, static_cast<uint16_t>(rrTrim));
}

static void applyDanceModeTilt(float rollNorm, float pitchNorm) {
  const RCDCCConfigState& state = storageManager.getCurrentState();

  float flNorm = clampNorm(rollNorm + pitchNorm);
  float frNorm = clampNorm(-rollNorm + pitchNorm);
  float rlNorm = clampNorm(rollNorm - pitchNorm);
  float rrNorm = clampNorm(-rollNorm - pitchNorm);

  if (state.servoFL.reverse != 0) flNorm = -flNorm;
  if (state.servoFR.reverse != 0) frNorm = -frNorm;
  if (state.servoRL.reverse != 0) rlNorm = -rlNorm;
  if (state.servoRR.reverse != 0) rrNorm = -rrNorm;

  const int32_t flUs = mapNormToServoUs(flNorm, state.servoFL);
  const int32_t frUs = mapNormToServoUs(frNorm, state.servoFR);
  const int32_t rlUs = mapNormToServoUs(rlNorm, state.servoRL);
  const int32_t rrUs = mapNormToServoUs(rrNorm, state.servoRR);

  pwmOutputs.setChannelMicroseconds(0, static_cast<uint16_t>(flUs));
  pwmOutputs.setChannelMicroseconds(1, static_cast<uint16_t>(frUs));
  pwmOutputs.setChannelMicroseconds(2, static_cast<uint16_t>(rlUs));
  pwmOutputs.setChannelMicroseconds(3, static_cast<uint16_t>(rrUs));

  gDanceMode.last_roll = rollNorm;
  gDanceMode.last_pitch = pitchNorm;
}

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
  // Status flashes should use the ESP32 onboard LED (GPIO2), not strip pixels.
  digitalWrite(LED_PIN, ledBleOn ? LOW : HIGH);
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

// Function to start LED blink (250ms); stays on after if BLE connected
void startLedBlink() {
  // Pulse opposite the steady BLE state so the 250ms flash is visible.
  flashStatusLED();
  ledBlinkEndTime = millis() + 250;
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
  if (payload.length() == 0) {
    return true;
  }

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

bool applyKVWritePayload(const String& payload) {
  lastBleCommandMs = millis();  // Reset continuous-servo watchdog
  DynamicJsonDocument doc(512);
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("BLE KV JSON parse error: %s\n", error.c_str());
    return false;
  }

  if (!(doc.containsKey("key") && doc.containsKey("value"))) {
    Serial.println("BLE KV payload missing key/value");
    return false;
  }

  const String key = doc["key"].as<String>();
  const JsonVariantConst value = doc["value"].as<JsonVariantConst>();

  if (!storageManager.setValue(key, value)) {
    Serial.printf("BLE KV ignored unknown key: %s\n", key.c_str());
    return true;
  }

  if (key == "imu.orient") {
    sensorFusion.setOrientation(storageManager.getConfig().mpuOrientation);
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
  (void)payload;
  Serial.println("BLE lights payload ignored: lights engine removed from firmware");
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

  if (!LIGHTS_ENTRYPOINT_ENABLED && command.startsWith("lights_")) {
    Serial.printf("BLE system command ignored (lights disabled): %s\n", command.c_str());
    return true;
  }

  if (command == "cfg_read_prepare") {
    String scope = doc["scope"] | String("bootstrap");
    scope.toLowerCase();
    if (bluetoothService) {
      bluetoothService->requestConfigScope(scope);
    }
    return true;
  }

  if (command == "cfg_read_chunk") {
    int32_t chunkIndex = doc["index"] | 0;
    if (bluetoothService) {
      bluetoothService->requestConfigChunk(chunkIndex);
    }
    return true;
  }

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

  if (command == "save") {
    storageManager.saveAll();
    Serial.println("{\"status\":\"saved\"}");
    return true;
  }

  if (command == "flash") {
    startLedBlink();
    return true;
  }

  // ==================== Phase 6: Dance Mode ====================

  if (command == "dance_mode") {
    const bool enabled = doc["enabled"] | false;
    gDanceMode.enabled = enabled;

    if (!enabled) {
      gDanceMode.last_roll = 0.0f;
      gDanceMode.last_pitch = 0.0f;
      writeTrimToAllSuspensionServos();
    }

    Serial.printf("{\"status\":\"dance_mode\",\"enabled\":%s}\n", enabled ? "true" : "false");
    return true;
  }

  if (command == "servo_tilt") {
    if (!gDanceMode.enabled) {
      // High-rate command: intentionally ignored when Dance Mode is off.
      return true;
    }

    float rollNorm = doc["roll"] | 0.0f;
    float pitchNorm = doc["pitch"] | 0.0f;
    rollNorm = clampNorm(rollNorm);
    pitchNorm = clampNorm(pitchNorm);

    // Immediate direct control (no easing/reaction-speed in Dance Mode).
    applyDanceModeTilt(rollNorm, pitchNorm);
    return true;
  }

  // ==================== Driving Profile Commands (Phase 3) ====================

  if (command == "load_drv_profile") {
    Serial.println("{\"status\":\"deprecated\",\"command\":\"load_drv_profile\",\"owner\":\"app\"}");
    return true;
  }

  if (command == "save_drv_profile") {
    Serial.println("{\"status\":\"deprecated\",\"command\":\"save_drv_profile\",\"owner\":\"app\"}");
    return true;
  }

  if (command == "delete_drv_profile") {
    Serial.println("{\"status\":\"deprecated\",\"command\":\"delete_drv_profile\",\"owner\":\"app\"}");
    return true;
  }

  // ==================== Servo Registry Commands (Phase 4) ====================

  if (command == "add_aux_servo") {
    String type  = doc["type"]  | String(AUX_TYPE_POSITIONAL);
    String label = doc["label"] | String("");
    type.toLowerCase();
    // Validate type
    if (type != AUX_TYPE_POSITIONAL && type != AUX_TYPE_CONTINUOUS &&
        type != AUX_TYPE_PAN        && type != AUX_TYPE_RELAY) {
      type = AUX_TYPE_POSITIONAL;
    }
    String outNs;
    if (!storageManager.addAuxServo(type, label, outNs)) {
      Serial.println("{\"status\":\"error\",\"reason\":\"max_reached\"}");
      return false;
    }
    lastBleCommandMs = millis();
    startLedBlink();
    Serial.printf("{\"status\":\"added\",\"namespace\":\"%s\"}\n", outNs.c_str());
    return true;
  }

  if (command == "remove_aux_servo") {
    String ns = doc["namespace"] | String("");
    if (ns.length() == 0 || !storageManager.removeAuxServo(ns)) {
      Serial.println("{\"status\":\"error\",\"reason\":\"not_found\"}");
      return false;
    }
    lastBleCommandMs = millis();
    startLedBlink();
    Serial.printf("{\"status\":\"removed\",\"namespace\":\"%s\"}\n", ns.c_str());
    return true;
  }

  // aux_run: set a continuous servo speed (-100..100, 0=stop)
  if (command == "aux_run") {
    String  ns    = doc["namespace"] | String("");
    int32_t speed = doc["speed"]     | 0;
    speed = constrain(speed, -100, 100);
    storageManager.setAuxServoSpeed(ns, speed);
    lastBleCommandMs = millis();
    return true;
  }

  // aux_relay: set a relay servo state (0=off, 1=on)
  if (command == "aux_relay") {
    String  ns  = doc["namespace"] | String("");
    int32_t val = (doc["state"] | 0) ? 1 : 0;
    DynamicJsonDocument vDoc(32);
    vDoc["v"] = val;
    storageManager.setValue(ns + ".state", vDoc["v"].as<JsonVariantConst>());
    lastBleCommandMs = millis();
    return true;
  }

  if (command == "load_lt_profile" || command == "save_lt_profile" || command == "delete_lt_profile") {
    Serial.printf("BLE system command ignored (lights profiles removed): %s\n", command.c_str());
    return true;
  }

  return false;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  
  Serial.println("\n\nR/C Dynamic Chassis Control - Starting...");
  
  // Load configuration from storage
  storageManager.init();

  // LightsEngine removed; legacy status LED path remains active.
  legacyStatusLedEnabled = true;

  storageManager.loadConfig();
  storageManager.loadLights();
  // Note: Phase 5 loads lighting profiles from LittleFS, not from legacy lights config
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
  if (legacyStatusLedEnabled) {
    statusLED.begin();
    statusLED.setBrightness(50); // Set brightness (0-255)
    statusLED.clear();
    statusLED.show();
    updateStatusLEDColor(); // Load color from config
    Serial.println("Status LED initialized");
  }
  
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
  pwmOutputs.initAux();

  // Initialize Bluetooth Low Energy service
  bluetoothService = new BluetoothService(&storageManager);
  bluetoothService->setConfigWriteHandler(applyConfigUpdatePayload);
  bluetoothService->setKVWriteHandler(applyKVWritePayload);
  bluetoothService->setServoWriteHandler(applyServoConfigPayload);
  bluetoothService->setSystemWriteHandler(applySystemCommandPayload);
  bluetoothService->setConnectionStateHandler([](bool connected) {
    ledBleOn = connected;
    if (!connected) {
      ledBlinkEndTime = 0;
    }
    digitalWrite(LED_PIN, connected ? HIGH : LOW);
  });
  const String bleDeviceName = buildBleAdvertisedName();
  Serial.printf("Starting BLE advertising as: %s\n", bleDeviceName.c_str());
  bluetoothService->begin(bleDeviceName.c_str());
  Serial.println("Bluetooth service started");
  
  Serial.println("Setup complete!");
}

// Main loop
void loop() {
  unsigned long loopStartTime = millis();
  unsigned long currentTime = loopStartTime;
  static unsigned long lastLoopTime = 0;
  static bool firstLoop = true;

  // Run BLE service work on the main loop task, not BTC_TASK callbacks.
  if (bluetoothService) {
    bluetoothService->update();
  }

  // Detect genuinely slow single loop iterations (>100ms each).
  // lastLoopTime tracks the START of the previous iteration for per-iteration timing.
  if (firstLoop) {
    lastLoopTime = loopStartTime;
    firstLoop = false;
  } else {
    unsigned long iterationTime = loopStartTime - lastLoopTime;
    if (iterationTime > 100) {
      Serial.printf("⚠️  LONG LOOP DETECTED: %lums - possible blocking operation!\n", iterationTime);
    }
  }
  lastLoopTime = loopStartTime;
  
  // Handle LED blink timeout
  if (ledBlinkEndTime > 0 && currentTime >= ledBlinkEndTime) {
    // After a blink: keep LED on if BLE is still connected, otherwise off.
    digitalWrite(LED_PIN, ledBleOn ? HIGH : LOW);
    if (legacyStatusLedEnabled) {
      statusLED.clear();
      statusLED.show();
    }
    ledBlinkEndTime = 0;
  }

  // Auto-disable Dance Mode on BLE disconnect and force all suspension servos to trim.
  static bool previousBleConnected = false;
  const bool bleConnected = (bluetoothService && bluetoothService->isConnected());

  // Steady LED: on while connected, off while disconnected.
  if (bleConnected != ledBleOn) {
    ledBleOn = bleConnected;
    if (ledBlinkEndTime == 0) {  // Don't interrupt an active blink
      digitalWrite(LED_PIN, ledBleOn ? HIGH : LOW);
    }
  }

  if (previousBleConnected && !bleConnected && gDanceMode.enabled) {
    gDanceMode.enabled = false;
    gDanceMode.last_roll = 0.0f;
    gDanceMode.last_pitch = 0.0f;
    writeTrimToAllSuspensionServos();
    Serial.println("[DanceMode] Auto-disabled due to BLE disconnect");
  }
  previousBleConnected = bleConnected;

  // Continuous-servo BLE watchdog: stop all continuous servos if BLE goes silent
  if (lastBleCommandMs > 0 &&
      (uint32_t)(currentTime - lastBleCommandMs) > CONTINUOUS_WATCHDOG_MS) {
    const ServoRegistry& reg = storageManager.getServoRegistry();
    bool anyRunning = false;
    for (int i = 0; i < reg.auxCount; i++) {
      if (strcmp(reg.auxServos[i].type, AUX_TYPE_CONTINUOUS) == 0 &&
          reg.auxServos[i].currentSpeed != 0) {
        anyRunning = true;
        break;
      }
    }
    if (anyRunning) {
      storageManager.stopAllContinuousServos();
      // Update PWM outputs to stop
      for (int i = 0; i < reg.auxCount; i++) {
        if (strcmp(reg.auxServos[i].type, AUX_TYPE_CONTINUOUS) == 0) {
          pwmOutputs.setAuxContinuous(i, 0);
        }
      }
      lastBleCommandMs = 0;  // Arm only again when next command arrives
      Serial.println("[Watchdog] Stopped continuous servos (BLE silent)");
    }
  }
  
  // Lights are app-driven; firmware should not own hardcoded legacy groups.
  
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

    // CHECKPOINT: PWM writes
    unsigned long beforePWM = millis();

    if (!gDanceMode.enabled) {
      // Normal suspension loop runs only while Dance Mode is off.
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

      pwmOutputs.setChannel(0, fl, servoConfig.frontLeft);
      pwmOutputs.setChannel(1, fr, servoConfig.frontRight);
      pwmOutputs.setChannel(2, rl, servoConfig.rearLeft);
      pwmOutputs.setChannel(3, rr, servoConfig.rearRight);
    }

    // Update aux servo PWM outputs
    {
      const ServoRegistry& reg = storageManager.getServoRegistry();
      for (int i = 0; i < reg.auxCount; i++) {
        const AuxServoConfig& aux = reg.auxServos[i];
        if (!aux.enabled) continue;
        const char* t = aux.type;
        if (strcmp(t, AUX_TYPE_POSITIONAL) == 0 || strcmp(t, AUX_TYPE_PAN) == 0) {
          pwmOutputs.setAuxPositional(i, aux.trimUs);
        } else if (strcmp(t, AUX_TYPE_CONTINUOUS) == 0) {
          pwmOutputs.setAuxContinuous(i, aux.currentSpeed);
        } else if (strcmp(t, AUX_TYPE_RELAY) == 0) {
          pwmOutputs.setAuxRelay(i, aux.state != 0);
        }
      }
    }
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