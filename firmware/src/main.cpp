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
bool ledBleOn = false;  // true while BLE is connected (steady-on state)

// Continuous-servo BLE watchdog: stops all continuous servos if no BLE
// command is received within this window (phone disconnection safety net).
static uint32_t lastBleCommandMs = 0;
static constexpr uint32_t CONTINUOUS_WATCHDOG_MS = 500;

// Addressable LED (NeoPixel) - kept for backward compatibility
Adafruit_NeoPixel statusLED(STATUS_LED_COUNT, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);
uint32_t currentLEDColor = 0;
bool legacyStatusLedEnabled = false;

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

// ==================== Phase 6: Dance Mode ====================
DanceMode gDanceMode = { false, 0.0f, 0.0f };
volatile bool gFlashCancelRequested = false;
static int32_t gLightsReadCursor = 0;

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
  if (!legacyStatusLedEnabled) return;
  statusLED.setPixelColor(2, currentLEDColor);
  statusLED.show();
}

// Function to update emergency lights with generic pattern sequencer
void updateEmergencyLights() {
  if (!legacyStatusLedEnabled) return;
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

// Function to start LED blink (250ms); stays on after if BLE connected
void startLedBlink() {
  digitalWrite(LED_PIN, HIGH);
  flashStatusLED(); // Flash addressable LED too
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
  DynamicJsonDocument doc(4096);
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("BLE lights JSON parse error: %s\n", error.c_str());
    return false;
  }

  // New path: single-group updates for low-latency effect edits.
  if (doc.containsKey("group")) {
    if (lightsEngine) {
      const bool ok = lightsEngine->updateGroupFromJson(payload);
      if (!ok) {
        Serial.println("BLE lights single-group update rejected");
        return false;
      }
    }
    startLedBlink();
    return true;
  }

  NewLightsConfig config;
  memset(&config, 0, sizeof(NewLightsConfig));

  if (doc.containsKey("lightGroupsArray")) {
    JsonArray groupsArray = doc["lightGroupsArray"];
    config.useLegacyMode = false;
    config.groupCount = 0;

    for (JsonObject groupObj : groupsArray) {
      if (config.groupCount >= MAX_DYNAMIC_LIGHT_GROUPS) break;

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
          if (group.ledCount >= MAX_DYNAMIC_GROUP_LEDS) break;
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

  if (command == "lights_group_index") {
    if (!bluetoothService) return false;

    String payloadOut;
    const bool ok = storageManager.getActiveLightingGroupIndexJSON(payloadOut);
    bluetoothService->setDirectConfigReadResponse(payloadOut);
    gLightsReadCursor = 0;
    if (!ok) {
      Serial.println("BLE: lights_group_index active profile missing");
    }
    return true;
  }

  if (command == "lights_group_detail") {
    if (!bluetoothService) return false;

    int32_t requestedCursor = -1;
    if (doc.containsKey("cursor")) {
      requestedCursor = doc["cursor"] | -1;
    } else if (doc.containsKey("index")) {
      requestedCursor = doc["index"] | -1;
    }

    if (requestedCursor < 0) {
      requestedCursor = gLightsReadCursor;
    }

    String payloadOut;
    int nextCursor = 0;
    bool done = true;
    const bool ok = storageManager.getActiveLightingGroupDetailJSON(
      static_cast<int>(requestedCursor),
      payloadOut,
      nextCursor,
      done
    );

    bluetoothService->setDirectConfigReadResponse(payloadOut);
    gLightsReadCursor = nextCursor;

    if (!ok) {
      Serial.printf("BLE: lights_group_detail failed at cursor=%d\n", static_cast<int>(requestedCursor));
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

  if (command == "lights_master") {
    const bool on = doc["enabled"] | true;
    if (lightsEngine) {
      lightsEngine->setMaster(on);
    }
    return true;
  }

  if (command == "lights_color_order") {
    String order = doc["order"] | String("grb");
    order.toLowerCase();
    if (lightsEngine) {
      lightsEngine->setColorOrderByName(order.c_str());
    }
    return true;
  }

  if (command == "lights_clear_all") {
    if (lightsEngine) {
      lightsEngine->clearAllGroups(true);
    }
    return true;
  }

  if (command == "flash") {
    String color = doc["color"] | String("white");
    color.toLowerCase();
    int count = doc["count"] | 1;
    int onMs = doc["onMs"] | 200;
    int offMs = doc["offMs"] | 200;
    count = constrain(count, 1, 10);
    onMs = constrain(onMs, 0, 5000);
    offMs = constrain(offMs, 0, 5000);

    uint32_t rgb = 0xFFFFFF;
    if (color == "red") rgb = 0xFF0000;
    else if (color == "green") rgb = 0x00FF00;
    else if (color == "blue") rgb = 0x0000FF;
    else if (color == "yellow") rgb = 0xFFFF00;
    else if (color == "cyan") rgb = 0x00FFFF;
    else if (color == "magenta") rgb = 0xFF00FF;

    if (lightsEngine) {
      // Defaults remain 200ms on / 200ms off unless overridden by command payload.
      gFlashCancelRequested = false;
      lightsEngine->flashAllBlocking(rgb, static_cast<uint8_t>(count), static_cast<uint16_t>(onMs), static_cast<uint16_t>(offMs), &gFlashCancelRequested);
      gFlashCancelRequested = false;
    }
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
    int32_t idx = doc["index"] | -1;
    if (idx < 0 || idx >= MAX_DRIVING_PROFILES) {
      Serial.println("{\"status\":\"error\",\"reason\":\"invalid_index\"}");
      return false;
    }
    if (!storageManager.loadDrivingProfile(static_cast<int>(idx))) {
      Serial.println("{\"status\":\"error\",\"reason\":\"not_found\"}");
      return false;
    }
    SuspensionConfig newCfg = storageManager.getConfig();
    ServoConfig newSrvCfg = storageManager.getServoConfig();
    suspensionSimulator.init(newCfg, newSrvCfg);
    sensorFusion.setOrientation(newCfg.mpuOrientation);
    startLedBlink();
    Serial.printf("{\"status\":\"ok\",\"profile\":%d}\n", static_cast<int>(idx));
    return true;
  }

  if (command == "save_drv_profile") {
    int32_t idx = doc["index"] | -1;
    String name = doc["name"] | "";
    if (idx < 0 || idx >= MAX_DRIVING_PROFILES) {
      Serial.println("{\"status\":\"error\",\"reason\":\"invalid_index\"}");
      return false;
    }
    if (name.length() == 0) { name = String("Profile ") + String(static_cast<int>(idx)); }
    if (name.length() > 20) { name = name.substring(0, 20); }
    storageManager.saveDrivingProfile(static_cast<int>(idx), name);
    startLedBlink();
    Serial.printf("{\"status\":\"saved\",\"profile\":%d}\n", static_cast<int>(idx));
    return true;
  }

  if (command == "delete_drv_profile") {
    int32_t idx = doc["index"] | -1;
    if (idx < 0 || idx >= MAX_DRIVING_PROFILES) {
      Serial.println("{\"status\":\"error\",\"reason\":\"invalid_index\"}");
      return false;
    }
    int newActive = -1;
    if (!storageManager.deleteDrivingProfile(static_cast<int>(idx), newActive)) {
      Serial.println("{\"status\":\"error\",\"reason\":\"last_profile\"}");
      return false;
    }
    startLedBlink();
    Serial.printf("{\"status\":\"deleted\",\"profile\":%d,\"new_active\":%d}\n",
                  static_cast<int>(idx), newActive);
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

  // ==================== Phase 5: Lighting Profile Commands ====================
  
  // load_lt_profile: Load a lighting profile from LittleFS
  if (command == "load_lt_profile") {
    int index = doc["index"] | 0;
    if (index < 0 || index >= MAX_LIGHTING_PROFILES) {
      DynamicJsonDocument resp(128);
      resp["status"] = "error";
      resp["reason"] = "invalid_index";
      String out;
      serializeJson(resp, out);
      Serial.println(out);
      Serial.printf("[BLE] Lighting profile load error: invalid index %d\n", index);
      return true;
    }

    LightingProfile profile = {};
    if (!storageManager.loadLightingProfile(index, profile)) {
      DynamicJsonDocument resp(128);
      resp["status"] = "error";
      resp["reason"] = "not_found";
      String out;
      serializeJson(resp, out);
      Serial.println(out);
      Serial.printf("[BLE] Lighting profile %d not found\n", index);
      return true;
    }

    // Update active profile index in NVS
    Preferences pref;
    if (pref.begin("system", false)) {
      pref.putInt("act_lt_prof", index);
      pref.end();
    }

    // Load profile into LightsEngine
    if (lightsEngine) {
      lightsEngine->loadProfile(profile);
    }

    DynamicJsonDocument resp(128);
    resp["status"] = "ok";
    resp["profile"] = index;
    String out;
    serializeJson(resp, out);
    Serial.println(out);
    Serial.printf("[BLE] Loaded lighting profile %d: %s\n", index, profile.name);
    return true;
  }

  // save_lt_profile: Save current lighting state to a profile
  if (command == "save_lt_profile") {
    int index = doc["index"] | 0;
    String name = doc["name"] | String("Unnamed Profile");
    
    if (index < 0 || index >= MAX_LIGHTING_PROFILES) {
      DynamicJsonDocument resp(128);
      resp["status"] = "error";
      resp["reason"] = "invalid_index";
      String out;
      serializeJson(resp, out);
      Serial.println(out);
      return true;
    }

    // Get current profile from LightsEngine and save to LittleFS
    if (lightsEngine) {
      LightingProfile* current = lightsEngine->getProfile();
      if (current) {
        strncpy(current->name, name.c_str(), sizeof(current->name) - 1);
        if (storageManager.saveLightingProfile(index, *current)) {
          // Update active profile index in NVS
          Preferences pref;
          if (pref.begin("system", false)) {
            pref.putInt("act_lt_prof", index);
            pref.end();
          }
          
          DynamicJsonDocument resp(128);
          resp["status"] = "saved";
          resp["profile"] = index;
          String out;
          serializeJson(resp, out);
          Serial.println(out);
          Serial.printf("[BLE] Saved lighting profile %d: %s\n", index, name.c_str());
          return true;
        }
      }
    }

    DynamicJsonDocument resp(128);
    resp["status"] = "error";
    resp["reason"] = "save_failed";
    String out;
    serializeJson(resp, out);
    Serial.println(out);
    return true;
  }

  // delete_lt_profile: Delete a lighting profile
  if (command == "delete_lt_profile") {
    int index = doc["index"] | 0;
    
    if (index < 0 || index >= MAX_LIGHTING_PROFILES) {
      DynamicJsonDocument resp(128);
      resp["status"] = "error";
      resp["reason"] = "invalid_index";
      String out;
      serializeJson(resp, out);
      Serial.println(out);
      return true;
    }

    // Check if this is the last remaining profile
    int profileCount = storageManager.getLightingProfileCount();
    if (profileCount <= 1) {
      DynamicJsonDocument resp(128);
      resp["status"] = "error";
      resp["reason"] = "last_profile";
      String out;
      serializeJson(resp, out);
      Serial.println(out);
      Serial.println("[BLE] Cannot delete last remaining lighting profile");
      return true;
    }

    // Delete the profile
    if (storageManager.deleteLightingProfile(index)) {
      // If the deleted profile was active, switch to profile 0
      Preferences pref;
      if (pref.begin("system", false)) {
        int active = pref.getInt("act_lt_prof", 0);
        if (active == index) {
          // Find the lowest available profile
          for (int i = 0; i < MAX_LIGHTING_PROFILES; i++) {
            if (i != index && LittleFS.exists(String("/lt_p") + i + ".json")) {
              pref.putInt("act_lt_prof", i);
              Serial.printf("[BLE] Switched active profile from %d to %d\n", index, i);
              break;
            }
          }
        }
        pref.end();
      }
      
      DynamicJsonDocument resp(128);
      resp["status"] = "deleted";
      resp["profile"] = index;
      String out;
      serializeJson(resp, out);
      Serial.println(out);
      Serial.printf("[BLE] Deleted lighting profile %d\n", index);
      return true;
    }

    DynamicJsonDocument resp(128);
    resp["status"] = "error";
    resp["reason"] = "delete_failed";
    String out;
    serializeJson(resp, out);
    Serial.println(out);
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

  // Initialize LightsEngine after storage init. begin() starts the Core 0 task.
  lightsEngine = new LightsEngine(STATUS_LED_PIN, STATUS_LED_COUNT);
  if (lightsEngine) {
    lightsEngine->begin();
    Serial.printf("LightsEngine initialized: %d LED capacity\n", STATUS_LED_COUNT);
  } else {
    Serial.println("LightsEngine allocation failed; falling back to legacy status LED control");
  }
  // Never drive the same WS2812 strip from both statusLED and LightsEngine.
  legacyStatusLedEnabled = (lightsEngine == nullptr);

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
  } else {
    Serial.println("Status LED disabled while LightsEngine owns LED strip");
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

  // ==================== Phase 5: Lighting Profiles ====================
  
  // Create default lighting profiles on first boot
  storageManager.createDefaultLightingProfiles();
  
  // Load active lighting profile
  {
    Preferences pref;
    int activeLtProf = 0;
    if (pref.begin("system", false)) {
      activeLtProf = pref.getInt("act_lt_prof", 0);
      pref.end();
    }

    static LightingProfile profile = {};
    if (storageManager.loadLightingProfile(activeLtProf, profile)) {
      if (lightsEngine) {
        lightsEngine->loadProfile(profile);
        Serial.printf("Loaded active lighting profile %d: %s\n", activeLtProf, profile.name);
      }
    } else {
      Serial.printf("Warning: Could not load lighting profile %d\n", activeLtProf);
    }
  }

  Serial.println("LED effects task started by LightsEngine::begin() on Core 0");
  
  // Initialize Bluetooth Low Energy service
  bluetoothService = new BluetoothService(&storageManager);
  bluetoothService->setConfigWriteHandler(applyConfigUpdatePayload);
  bluetoothService->setKVWriteHandler(applyKVWritePayload);
  bluetoothService->setServoWriteHandler(applyServoConfigPayload);
  bluetoothService->setLightsWriteHandler(applyLightsPayload);
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
  if (previousBleConnected && !bleConnected) {
    gFlashCancelRequested = true;
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
  
  // Update emergency light patterns (non-blocking)
  updateEmergencyLights();
  
  // Dynamic light groups are updated in the dedicated LEDEffects task.
  
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