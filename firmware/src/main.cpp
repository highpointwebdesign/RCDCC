#include <Arduino.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <MPU6050.h>
#include <Adafruit_NeoPixel.h>
// #include <FastLED.h>
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
LightsEngine* lightsEngine = nullptr;
BluetoothService* bluetoothService = nullptr;  // Initialize in setup()

struct ManualServoOverride {
  bool active = false;
  uint32_t expiresAtMs = 0;
  uint16_t targetUs = 1500;
};

static ManualServoOverride gManualServoOverrides[4];

// LED feedback pin
#define LED_PIN 2
unsigned long ledBlinkEndTime = 0;
bool ledBleOn = false;  // true while BLE is connected (steady-on state)

// Continuous-servo BLE watchdog: stops all continuous servos if no BLE
// command is received within this window (phone disconnection safety net).
static uint32_t lastBleCommandMs = 0;
static constexpr uint32_t CONTINUOUS_WATCHDOG_MS = 500;
static constexpr bool LIGHTS_ENTRYPOINT_ENABLED = true;
static constexpr bool SUSPENSION_DEBUG_LOGS = true;
static constexpr uint32_t SUSPENSION_DEBUG_INTERVAL_MS = 500;
static constexpr bool I2C_BUS_SCAN_ENABLED = false;
static constexpr bool BLE_STARTUP_ENABLED = true;
static constexpr bool CALIBRATE_IMU_ON_BOOT = false;
static constexpr bool SUSPENSION_PWM_ENABLED = true;

enum StripColorOrder : uint8_t {
  STRIP_ORDER_GRB = 0,
  STRIP_ORDER_RGB = 1,
  STRIP_ORDER_RBG = 2,
  STRIP_ORDER_GBR = 3,
  STRIP_ORDER_BRG = 4,
  STRIP_ORDER_BGR = 5,
};

// Addressable LED (NeoPixel) - kept for backward compatibility
Adafruit_NeoPixel statusLED(STATUS_LED_COUNT, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);
uint32_t currentLEDColor = 0;
bool legacyStatusLedEnabled = true;
bool lightsMasterEnabled = false;
bool lightsBasicEnabled = false;
bool lightsDiagEnabled = false;
uint8_t lightsBasicR = 0;
uint8_t lightsBasicG = 0;
uint8_t lightsBasicB = 255;
uint8_t lightsBasicBri = 100;
uint16_t lightsDiagIntervalMs = 500;
unsigned long lightsDiagLastStepMs = 0;
uint8_t lightsDiagStep = 0;
StripColorOrder stripColorOrder = STRIP_ORDER_GRB;
static uint32_t lastSuspensionDebugMs = 0;

static constexpr uint8_t LIGHT_GROUP_SLOT_COUNT = 15;
struct LegacyLightGroupSlot {
  bool configured = false;
  bool enabled = false;
  uint8_t r = 0;
  uint8_t g = 0;
  uint8_t b = 0;
  uint8_t bri = 100;
  bool ledMask[STATUS_LED_COUNT] = { false };
};
LegacyLightGroupSlot legacyLightGroupSlots[LIGHT_GROUP_SLOT_COUNT];

// ==================== Phase 6: Dance Mode ====================
DanceMode gDanceMode = { false, 0.0f, 0.0f };
static bool gSuspensionPaused = false;

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

static void writeCenteredToAllSuspensionServos() {
  const RCDCCConfigState& state = storageManager.getCurrentState();

  const int32_t flMin = min(state.servoFL.minUs, state.servoFL.maxUs);
  const int32_t flMax = max(state.servoFL.minUs, state.servoFL.maxUs);
  const int32_t frMin = min(state.servoFR.minUs, state.servoFR.maxUs);
  const int32_t frMax = max(state.servoFR.minUs, state.servoFR.maxUs);
  const int32_t rlMin = min(state.servoRL.minUs, state.servoRL.maxUs);
  const int32_t rlMax = max(state.servoRL.minUs, state.servoRL.maxUs);
  const int32_t rrMin = min(state.servoRR.minUs, state.servoRR.maxUs);
  const int32_t rrMax = max(state.servoRR.minUs, state.servoRR.maxUs);

  const int32_t flCenter = clampI32Safe((flMin + flMax) / 2, flMin, flMax);
  const int32_t frCenter = clampI32Safe((frMin + frMax) / 2, frMin, frMax);
  const int32_t rlCenter = clampI32Safe((rlMin + rlMax) / 2, rlMin, rlMax);
  const int32_t rrCenter = clampI32Safe((rrMin + rrMax) / 2, rrMin, rrMax);

  pwmOutputs.setChannelMicroseconds(0, static_cast<uint16_t>(flCenter));
  pwmOutputs.setChannelMicroseconds(1, static_cast<uint16_t>(frCenter));
  pwmOutputs.setChannelMicroseconds(2, static_cast<uint16_t>(rlCenter));
  pwmOutputs.setChannelMicroseconds(3, static_cast<uint16_t>(rrCenter));
}

  static void clearManualServoOverrides() {
    for (auto& overrideState : gManualServoOverrides) {
      overrideState.active = false;
      overrideState.expiresAtMs = 0;
      overrideState.targetUs = 1500;
    }
  }

  static void setManualServoOverride(uint8_t channel, uint16_t microseconds, uint32_t durationMs = 2500) {
    if (channel >= 4) return;
    gManualServoOverrides[channel].active = true;
    gManualServoOverrides[channel].expiresAtMs = millis() + durationMs;
    gManualServoOverrides[channel].targetUs = constrain(microseconds, static_cast<uint16_t>(900), static_cast<uint16_t>(2100));
  }

  static bool manualServoOverrideActive(uint8_t channel, uint32_t nowMs) {
    if (channel >= 4) return false;
    ManualServoOverride& overrideState = gManualServoOverrides[channel];
    if (!overrideState.active) return false;
    if (static_cast<int32_t>(overrideState.expiresAtMs - nowMs) <= 0) {
      overrideState.active = false;
      return false;
    }
    return true;
  }

static void refreshSuspensionRuntimeFromStorage() {
  const SuspensionConfig cfg = storageManager.getConfig();
  const ServoConfig servoCfg = storageManager.getServoConfig();
  suspensionSimulator.init(cfg, servoCfg);
}

static bool runServoTestCommand(uint8_t index, int dir) {
  if (index >= 4) return false;

  const RCDCCConfigState& state = storageManager.getCurrentState();
  const RCDCCServoState* servo = nullptr;
  switch (index) {
    case 0: servo = &state.servoFL; break;
    case 1: servo = &state.servoFR; break;
    case 2: servo = &state.servoRL; break;
    case 3: servo = &state.servoRR; break;
    default: return false;
  }

  const int32_t servoMin = min(servo->minUs, servo->maxUs);
  const int32_t servoMax = max(servo->minUs, servo->maxUs);
  const int32_t safeMin = clampI32Safe(servoMin, 900, 2100);
  const int32_t safeMax = clampI32Safe(servoMax, safeMin + 1, 2100);
  const int32_t safeTrim = clampI32Safe(servo->trimUs, safeMin, safeMax);

  int32_t targetUs = safeTrim;
  if (dir > 0) {
    targetUs = safeMax;
  } else if (dir < 0) {
    targetUs = safeMin;
  }

  setManualServoOverride(index, static_cast<uint16_t>(targetUs));
  pwmOutputs.setChannelMicroseconds(index, static_cast<uint16_t>(targetUs));
  Serial.printf("[SERVO-TEST] idx=%u dir=%d targetUs=%ld\n", index, dir, static_cast<long>(targetUs));
  return true;
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

void remapColorForOrder(uint8_t inR, uint8_t inG, uint8_t inB, uint8_t& outR, uint8_t& outG, uint8_t& outB) {
  switch (stripColorOrder) {
    case STRIP_ORDER_RGB: outR = inR; outG = inG; outB = inB; break;
    case STRIP_ORDER_RBG: outR = inR; outG = inB; outB = inG; break;
    case STRIP_ORDER_GBR: outR = inG; outG = inB; outB = inR; break;
    case STRIP_ORDER_BRG: outR = inB; outG = inR; outB = inG; break;
    case STRIP_ORDER_BGR: outR = inB; outG = inG; outB = inR; break;
    case STRIP_ORDER_GRB:
    default: outR = inG; outG = inR; outB = inB; break;
  }
}

void clearStrip() {
  if (!legacyStatusLedEnabled) return;
  statusLED.clear();
  statusLED.show();
}

void clearLegacyGroupSlot(uint8_t groupIndex) {
  if (groupIndex >= LIGHT_GROUP_SLOT_COUNT) return;
  LegacyLightGroupSlot& slot = legacyLightGroupSlots[groupIndex];
  slot.configured = false;
  slot.enabled = false;
  slot.r = 0;
  slot.g = 0;
  slot.b = 0;
  slot.bri = 100;
  for (uint16_t i = 0; i < STATUS_LED_COUNT; i++) {
    slot.ledMask[i] = false;
  }
}

void clearAllLegacyGroupSlots() {
  for (uint8_t i = 0; i < LIGHT_GROUP_SLOT_COUNT; i++) {
    clearLegacyGroupSlot(i);
  }
}

bool slotHasAnyLed(const LegacyLightGroupSlot& slot) {
  for (uint16_t i = 0; i < STATUS_LED_COUNT; i++) {
    if (slot.ledMask[i]) return true;
  }
  return false;
}

bool hasAnyEnabledLegacyGroups() {
  for (uint8_t i = 0; i < LIGHT_GROUP_SLOT_COUNT; i++) {
    const LegacyLightGroupSlot& slot = legacyLightGroupSlots[i];
    if (slot.configured && slot.enabled && slotHasAnyLed(slot)) {
      return true;
    }
  }
  return false;
}

void applyLegacyGroupCompositeOutput() {
  if (!legacyStatusLedEnabled) return;
  if (!lightsMasterEnabled) {
    clearStrip();
    return;
  }

  uint8_t outR[STATUS_LED_COUNT] = { 0 };
  uint8_t outG[STATUS_LED_COUNT] = { 0 };
  uint8_t outB[STATUS_LED_COUNT] = { 0 };
  bool hasOutput = false;

  // Deterministic overlay order: higher slot index can override earlier slots.
  for (uint8_t group = 0; group < LIGHT_GROUP_SLOT_COUNT; group++) {
    const LegacyLightGroupSlot& slot = legacyLightGroupSlots[group];
    if (!slot.configured || !slot.enabled) continue;

    const uint16_t safeBri = constrain(static_cast<int>(slot.bri), 0, 100);
    const uint16_t scaledR = (static_cast<uint16_t>(slot.r) * safeBri) / 100;
    const uint16_t scaledG = (static_cast<uint16_t>(slot.g) * safeBri) / 100;
    const uint16_t scaledB = (static_cast<uint16_t>(slot.b) * safeBri) / 100;

    uint8_t mappedR = 0;
    uint8_t mappedG = 0;
    uint8_t mappedB = 0;
    remapColorForOrder(static_cast<uint8_t>(scaledR), static_cast<uint8_t>(scaledG), static_cast<uint8_t>(scaledB), mappedR, mappedG, mappedB);

    // DEBUG: Log which group is contributing to output
    bool groupHasLeds = false;
    for (uint16_t i = 0; i < STATUS_LED_COUNT; i++) {
      if (slot.ledMask[i]) {
        groupHasLeds = true;
        break;
      }
    }
    if (groupHasLeds) {
      Serial.printf("[Composite] Group %d active: rgb=(%d,%d,%d) mapped=(%d,%d,%d)\n", 
        group, slot.r, slot.g, slot.b, mappedR, mappedG, mappedB);
    }

    for (uint16_t i = 0; i < STATUS_LED_COUNT; i++) {
      if (!slot.ledMask[i]) continue;
      outR[i] = mappedR;
      outG[i] = mappedG;
      outB[i] = mappedB;
      hasOutput = true;
    }
  }

  if (!hasOutput) {
    clearStrip();
    return;
  }

  for (uint16_t i = 0; i < STATUS_LED_COUNT; i++) {
    statusLED.setPixelColor(i, outR[i], outG[i], outB[i]);
  }
  statusLED.show();
}

void updateLegacyGroupSlotLeds(uint8_t groupIndex, const JsonArray& leds) {
  if (groupIndex >= LIGHT_GROUP_SLOT_COUNT) return;
  LegacyLightGroupSlot& slot = legacyLightGroupSlots[groupIndex];
  for (uint16_t i = 0; i < STATUS_LED_COUNT; i++) {
    slot.ledMask[i] = false;
  }

  for (JsonVariant v : leds) {
    if (!v.is<int>()) continue;
    const int idx = v.as<int>();
    if (idx < 0 || idx >= STATUS_LED_COUNT) continue;
    slot.ledMask[static_cast<uint16_t>(idx)] = true;
  }
}

void setAllStripLeds(uint8_t r, uint8_t g, uint8_t b, uint8_t briPercent) {
  if (!legacyStatusLedEnabled) return;

  const uint16_t safeBri = constrain(static_cast<int>(briPercent), 0, 100);
  const uint16_t scaledR = (static_cast<uint16_t>(r) * safeBri) / 100;
  const uint16_t scaledG = (static_cast<uint16_t>(g) * safeBri) / 100;
  const uint16_t scaledB = (static_cast<uint16_t>(b) * safeBri) / 100;

  uint8_t mappedR = 0;
  uint8_t mappedG = 0;
  uint8_t mappedB = 0;
  remapColorForOrder(static_cast<uint8_t>(scaledR), static_cast<uint8_t>(scaledG), static_cast<uint8_t>(scaledB), mappedR, mappedG, mappedB);

  for (uint16_t i = 0; i < STATUS_LED_COUNT; i++) {
    statusLED.setPixelColor(i, mappedR, mappedG, mappedB);
  }
  statusLED.show();
}

void setIndexedStripLeds(const JsonArray& leds, uint8_t r, uint8_t g, uint8_t b, uint8_t briPercent) {
  if (!legacyStatusLedEnabled) return;

  statusLED.clear();
  const uint16_t safeBri = constrain(static_cast<int>(briPercent), 0, 100);
  const uint16_t scaledR = (static_cast<uint16_t>(r) * safeBri) / 100;
  const uint16_t scaledG = (static_cast<uint16_t>(g) * safeBri) / 100;
  const uint16_t scaledB = (static_cast<uint16_t>(b) * safeBri) / 100;

  uint8_t mappedR = 0;
  uint8_t mappedG = 0;
  uint8_t mappedB = 0;
  remapColorForOrder(static_cast<uint8_t>(scaledR), static_cast<uint8_t>(scaledG), static_cast<uint8_t>(scaledB), mappedR, mappedG, mappedB);

  for (JsonVariant v : leds) {
    if (!v.is<int>()) continue;
    const int idx = v.as<int>();
    if (idx < 0 || idx >= STATUS_LED_COUNT) continue;
    statusLED.setPixelColor(static_cast<uint16_t>(idx), mappedR, mappedG, mappedB);
  }
  statusLED.show();
}

void applyBasicLightsOutput() {
  if (!legacyStatusLedEnabled) return;
  if (!lightsMasterEnabled || !lightsBasicEnabled) {
    clearStrip();
    return;
  }
  setAllStripLeds(lightsBasicR, lightsBasicG, lightsBasicB, lightsBasicBri);
}

void applyDiagStep() {
  if (!legacyStatusLedEnabled) return;

  switch (lightsDiagStep % 5) {
    case 0: setAllStripLeds(255, 0, 0, 100); break;
    case 1: setAllStripLeds(0, 255, 0, 100); break;
    case 2: setAllStripLeds(0, 0, 255, 100); break;
    case 3: setAllStripLeds(255, 255, 255, 100); break;
    case 4:
    default: clearStrip(); break;
  }
  lightsDiagStep = (lightsDiagStep + 1) % 5;
}

StripColorOrder parseStripColorOrder(const String& input) {
  String order = input;
  order.toLowerCase();
  if (order == "rgb") return STRIP_ORDER_RGB;
  if (order == "rbg") return STRIP_ORDER_RBG;
  if (order == "gbr") return STRIP_ORDER_GBR;
  if (order == "brg") return STRIP_ORDER_BRG;
  if (order == "bgr") return STRIP_ORDER_BGR;
  return STRIP_ORDER_GRB;
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
  if (doc.containsKey("omegaN"))        storageManager.updateParameter("omegaN",        doc["omegaN"]);
  if (doc.containsKey("zeta"))          storageManager.updateParameter("zeta",          doc["zeta"]);
  if (doc.containsKey("range"))         storageManager.updateParameter("range",         doc["range"]);
  if (doc.containsKey("inputDeadband")) storageManager.updateParameter("inputDeadband", doc["inputDeadband"]);
  if (doc.containsKey("inputHyst"))     storageManager.updateParameter("inputHyst",     doc["inputHyst"]);
  if (doc.containsKey("frontRearBalance")) storageManager.updateParameter("frontRearBalance", doc["frontRearBalance"]);
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
      if (servo.containsKey("rideHeight")) {
        String ns = (strcmp(servoName, "frontLeft") == 0) ? "srv_fl"
                  : (strcmp(servoName, "frontRight") == 0) ? "srv_fr"
                  : (strcmp(servoName, "rearLeft") == 0) ? "srv_rl"
                  : "srv_rr";
        DynamicJsonDocument rideDoc(32);
        rideDoc["v"] = servo["rideHeight"].as<int32_t>();
        storageManager.setValue(ns + ".ride_ht", rideDoc["v"].as<JsonVariantConst>());
      }
      if (servo.containsKey("ride_ht")) {
        String ns = (strcmp(servoName, "frontLeft") == 0) ? "srv_fl"
                  : (strcmp(servoName, "frontRight") == 0) ? "srv_fr"
                  : (strcmp(servoName, "rearLeft") == 0) ? "srv_rl"
                  : "srv_rr";
        DynamicJsonDocument rideDoc(32);
        rideDoc["v"] = servo["ride_ht"].as<int32_t>();
        storageManager.setValue(ns + ".ride_ht", rideDoc["v"].as<JsonVariantConst>());
      }
    }
  }

  refreshSuspensionRuntimeFromStorage();

  startLedBlink();
  return true;
}

bool applyKVWritePayload(const String& payload) {
  lastBleCommandMs = millis();  // Reset continuous-servo watchdog
  Serial.printf("[BLE-KV] payload=%s\n", payload.c_str());
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
  Serial.printf("[BLE-KV] key=%s value=%s\n", key.c_str(), value.as<String>().c_str());

  if (!storageManager.setValue(key, value)) {
    Serial.printf("BLE KV ignored unknown key: %s\n", key.c_str());
    return true;
  }

  if (key == "imu.orient") {
    sensorFusion.setOrientation(storageManager.getConfig().mpuOrientation);
  }

  if (key == "srv_fl.trim") {
    setManualServoOverride(0, value.as<int32_t>());
    Serial.printf("[SERVO-OVR] ch=0 us=%ld\n", static_cast<long>(value.as<int32_t>()));
  } else if (key == "srv_fr.trim") {
    setManualServoOverride(1, value.as<int32_t>());
    Serial.printf("[SERVO-OVR] ch=1 us=%ld\n", static_cast<long>(value.as<int32_t>()));
  } else if (key == "srv_rl.trim") {
    setManualServoOverride(2, value.as<int32_t>());
    Serial.printf("[SERVO-OVR] ch=2 us=%ld\n", static_cast<long>(value.as<int32_t>()));
  } else if (key == "srv_rr.trim") {
    setManualServoOverride(3, value.as<int32_t>());
    Serial.printf("[SERVO-OVR] ch=3 us=%ld\n", static_cast<long>(value.as<int32_t>()));
  }

  if (key.startsWith("suspension.") || key.startsWith("srv_f") || key == "imu.orient") {
    refreshSuspensionRuntimeFromStorage();
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

  const String servoName = doc["servo"].as<String>();
  const String paramName = doc["param"].as<String>();
  const int paramValue = doc["value"].as<int>();

  storageManager.updateServoParameter(servoName, paramName, paramValue);

  if (paramName == "trim") {
    if (servoName == "frontLeft") setManualServoOverride(0, paramValue);
    else if (servoName == "frontRight") setManualServoOverride(1, paramValue);
    else if (servoName == "rearLeft") setManualServoOverride(2, paramValue);
    else if (servoName == "rearRight") setManualServoOverride(3, paramValue);
  }

  refreshSuspensionRuntimeFromStorage();

  startLedBlink();
  return true;
}

bool applyLightsPayload(const String& payload) {
  Serial.printf("[BLE-LIGHTS] payload=%s\n", payload.c_str());

  if (!LIGHTS_ENTRYPOINT_ENABLED) {
    Serial.println("BLE lights payload ignored: lights entrypoint disabled");
    return true;
  }

  if (!lightsEngine) {
    Serial.println("BLE lights payload ignored: lights runtime not initialized");
    return false;
  }

  // Use LightsEngine runtime directly so effect/speed/intensity animate correctly.
  const bool applied = lightsEngine->updateGroupFromJson(payload);
  if (!applied) {
    Serial.println("BLE lights payload rejected by runtime parser");
    return false;
  }

  lightsDiagEnabled = false;
  lightsBasicEnabled = false;
  return true;

  DynamicJsonDocument doc(3072);
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("BLE lights JSON parse error: %s\n", error.c_str());
    return false;
  }

  const bool enabled = doc["enabled"] | true;
  const uint8_t brightness = static_cast<uint8_t>(constrain(static_cast<int>(doc["brightness"] | 100), 0, 100));

  uint32_t color = 0x0000FF;
  if (doc["color"].is<const char*>()) {
    color = parseHexColor(String(doc["color"].as<const char*>()));
  } else if (doc["color"].is<uint32_t>()) {
    color = doc["color"].as<uint32_t>() & 0xFFFFFF;
  }

  const uint8_t r = static_cast<uint8_t>((color >> 16) & 0xFF);
  const uint8_t g = static_cast<uint8_t>((color >> 8) & 0xFF);
  const uint8_t b = static_cast<uint8_t>(color & 0xFF);

  const bool hasGroup = doc.containsKey("group") && doc["group"].is<int>();
  const int groupIndex = hasGroup ? doc["group"].as<int>() : -1;

  lightsDiagEnabled = false;

  if (hasGroup && groupIndex >= 0 && groupIndex < LIGHT_GROUP_SLOT_COUNT) {
    LegacyLightGroupSlot& slot = legacyLightGroupSlots[static_cast<uint8_t>(groupIndex)];
    slot.configured = true;
    slot.enabled = enabled;
    slot.r = r;
    slot.g = g;
    slot.b = b;
    slot.bri = brightness;

    if (doc.containsKey("leds") && doc["leds"].is<JsonArray>()) {
      updateLegacyGroupSlotLeds(static_cast<uint8_t>(groupIndex), doc["leds"].as<JsonArray>());
    } else {
      for (uint16_t i = 0; i < STATUS_LED_COUNT; i++) {
        slot.ledMask[i] = false;
      }
    }

    // DEBUG: Log all group payloads
    Serial.printf("[LightGroup %d] enabled=%d rgb=(%d,%d,%d) bri=%d  leds=[", 
      groupIndex, enabled, r, g, b, brightness);
    for (uint16_t i = 0; i < STATUS_LED_COUNT && i < 100; i++) {
      if (slot.ledMask[i]) {
        Serial.printf("%d,", i);
      }
    }
    Serial.println("]");

    lightsBasicEnabled = false;
    if (!lightsMasterEnabled) {
      clearStrip();
      return true;
    }

    applyLegacyGroupCompositeOutput();
    return true;
  }

  lightsBasicEnabled = enabled;
  lightsBasicR = r;
  lightsBasicG = g;
  lightsBasicB = b;
  lightsBasicBri = brightness;

  if (!lightsMasterEnabled || !enabled) {
    clearStrip();
    return true;
  }

  if (doc.containsKey("leds") && doc["leds"].is<JsonArray>()) {
    JsonArray leds = doc["leds"].as<JsonArray>();
    if (leds.size() > 0) {
      setIndexedStripLeds(leds, r, g, b, brightness);
      return true;
    }
  }

  setAllStripLeds(r, g, b, brightness);
  return true;
}

bool applySystemCommandPayload(const String& payload) {

  Serial.printf("[BLE-SYS] payload=%s\n", payload.c_str());

  DynamicJsonDocument doc(512);
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("BLE system JSON parse error: %s\n", error.c_str());
    return false;
  }

  String command = doc["command"] | "";
  command.toLowerCase();
  Serial.printf("[BLE-SYS] command=%s\n", command.c_str());

  // Simple 5-LED blue on/off test
  if (command == "leds_simple_onoff") {
    bool on = doc["on"] | false;
    if (on) {
      if (legacyStatusLedEnabled) {
        for (uint16_t i = 0; i < 5 && i < STATUS_LED_COUNT; i++) {
          statusLED.setPixelColor(i, 0, 0, 255); // Blue
        }
        for (uint16_t i = 5; i < STATUS_LED_COUNT; i++) {
          statusLED.setPixelColor(i, 0, 0, 0); // Off
        }
        statusLED.show();
      }
    } else {
      if (legacyStatusLedEnabled) {
        for (uint16_t i = 0; i < 5 && i < STATUS_LED_COUNT; i++) {
          statusLED.setPixelColor(i, 0, 0, 0); // Off
        }
        statusLED.show();
      }
    }
    Serial.printf("{\"status\":\"leds_simple_onoff\",\"on\":%s}\n", on ? "true" : "false");
    return true;
  }

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

  if (command == "testservo" || command == "test_servo") {
    const uint8_t idx = doc["idx"] | 0;
    const int dir = doc["dir"] | 0;
    return runServoTestCommand(idx, dir);
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

  if (command == "lights_master") {
    lightsMasterEnabled = doc["enabled"] | false;
    if (lightsEngine) {
      lightsEngine->setMaster(lightsMasterEnabled);
      if (!lightsMasterEnabled) {
        lightsEngine->setBasicMode(false);
      }
    }

    lightsDiagEnabled = false;
    if (!lightsMasterEnabled) {
      lightsBasicEnabled = false;
    }

    Serial.printf("{\"status\":\"lights_master\",\"enabled\":%s}\n", lightsMasterEnabled ? "true" : "false");
    return true;

    if (!lightsMasterEnabled) {
      lightsDiagEnabled = false;
      lightsBasicEnabled = false;
      clearStrip();
    } else {
      if (hasAnyEnabledLegacyGroups()) {
        applyLegacyGroupCompositeOutput();
      } else {
        applyBasicLightsOutput();
      }
    }
    Serial.printf("{\"status\":\"lights_master\",\"enabled\":%s}\n", lightsMasterEnabled ? "true" : "false");
    return true;
  }

  if (command == "lights_clear_all") {
    lightsDiagEnabled = false;
    lightsBasicEnabled = false;
    if (lightsEngine) {
      lightsEngine->setBasicMode(false);
      lightsEngine->clearAllGroups(true);
    }
    clearAllLegacyGroupSlots();
    Serial.println("{\"status\":\"lights_cleared\"}");
    return true;
  }

  if (command == "lights_color_order") {
    const String order = doc["order"] | "grb";
    stripColorOrder = parseStripColorOrder(order);
    if (lightsEngine) {
      lightsEngine->setColorOrderByName(order.c_str());
    }

    Serial.printf("{\"status\":\"lights_color_order\",\"order\":\"%s\"}\n", order.c_str());
    return true;

    if (lightsDiagEnabled) {
      applyDiagStep();
    } else if (hasAnyEnabledLegacyGroups()) {
      applyLegacyGroupCompositeOutput();
    } else {
      applyBasicLightsOutput();
    }
    Serial.printf("{\"status\":\"lights_color_order\",\"order\":\"%s\"}\n", order.c_str());
    return true;
  }

  if (command == "lights_basic") {
    lightsMasterEnabled = true;
    lightsDiagEnabled = false;
    lightsBasicEnabled = doc["on"] | false;
    lightsBasicR = static_cast<uint8_t>(constrain(static_cast<int>(doc["r"] | 0), 0, 255));
    lightsBasicG = static_cast<uint8_t>(constrain(static_cast<int>(doc["g"] | 0), 0, 255));
    lightsBasicB = static_cast<uint8_t>(constrain(static_cast<int>(doc["b"] | 0), 0, 255));
    lightsBasicBri = static_cast<uint8_t>(constrain(static_cast<int>(doc["bri"] | 100), 0, 100));

    if (lightsEngine) {
      lightsEngine->setMaster(true);
      lightsEngine->setBasicMode(lightsBasicEnabled, lightsBasicR, lightsBasicG, lightsBasicB, STATUS_LED_COUNT);
    }

    Serial.println("{\"status\":\"lights_basic\"}");
    return true;
  }

  if (command == "lights_diag") {
    const bool diagOn = doc["on"] | false;
    lightsMasterEnabled = true;
    lightsDiagEnabled = diagOn;
    lightsBasicEnabled = false;
    lightsDiagIntervalMs = static_cast<uint16_t>(constrain(static_cast<int>(doc["intervalMs"] | 500), 100, 5000));
    lightsDiagLastStepMs = 0;
    lightsDiagStep = 0;
    if (!diagOn) {
      clearStrip();
    } else {
      applyDiagStep();
      lightsDiagLastStepMs = millis();
    }
    Serial.printf("{\"status\":\"lights_diag\",\"on\":%s}\n", diagOn ? "true" : "false");
    return true;
  }

  // ==================== Phase 6: Dance Mode ====================

  if (command == "suspend_suspension") {
    gSuspensionPaused = doc["paused"] | false;
    if (gSuspensionPaused) {
      writeCenteredToAllSuspensionServos();
    }
    Serial.printf("{\"status\":\"suspend_suspension\",\"paused\":%s}\n", gSuspensionPaused ? "true" : "false");
    return true;
  }

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

// Removed FastLED helper functions - using Adafruit NeoPixel API instead
// CRGB hexToCRGB(const String& hex) { ... } — not needed
// void applyColors() { ... } — not needed

void setup() {
  Serial.begin(115200);
  delay(500);

  // Adafruit NeoPixel LED initialization - TEST 1.1
  statusLED.begin();
  statusLED.show();  // Initialize all pixels to off
  
  Serial.println("\n\nR/C Dynamic Chassis Control - Starting...");
  
  // Load configuration from storage
  storageManager.init();

  // Lights runtime disabled for debugging
  // if (LIGHTS_ENTRYPOINT_ENABLED) {
  //   lightsEngine = new LightsEngine(STATUS_LED_PIN, STATUS_LED_COUNT);
  //   lightsEngine->begin();
  //   lightsEngine->setMaster(false);
  //   lightsEngine->setColorOrderByName("grb");
  //   legacyStatusLedEnabled = false;
  // } else {
  //   lightsEngine = nullptr;
  //   legacyStatusLedEnabled = true;
  //   Serial.println("Lights runtime disabled");
  // }
  lightsEngine = nullptr;
  legacyStatusLedEnabled = true;  // TEST 1.3: Re-enable LightsEngine allocation
  
  // TEST 1.3: Re-enable LightsEngine allocation
  if (LIGHTS_ENTRYPOINT_ENABLED) {
    lightsEngine = new LightsEngine(STATUS_LED_PIN, STATUS_LED_COUNT);
    lightsEngine->begin();
    lightsEngine->setMaster(false);
    lightsEngine->setColorOrderByName("grb");
    legacyStatusLedEnabled = false;
  } else {
    lightsEngine = nullptr;
    legacyStatusLedEnabled = true;
  }

  storageManager.loadConfig();
  // Lights loading disabled for debugging
  if (LIGHTS_ENTRYPOINT_ENABLED) {
    storageManager.loadLights();
  }
  // Note: Phase 5 loads lighting profiles from LittleFS, not from legacy lights config
  SuspensionConfig config = storageManager.getConfig();
  ServoConfig servoConfig = storageManager.getServoConfig();
  
  // Initialize I2C and MPU6050
  Wire.begin(21, 22); // SDA=21, SCL=22 for most ESP32 boards
  delay(100);
  
  Serial.println("Testing MPU6050 connection...");
  if (I2C_BUS_SCAN_ENABLED) {
    Serial.println("Scanning I2C bus...");

    // Optional bus scan for diagnostics. Disabled by default to avoid
    // driver panics observed on some boards during startup.
    byte error;
    int nDevices = 0;
    for (uint8_t address = 1; address < 127; address++) {
      Wire.beginTransmission(address);
      error = Wire.endTransmission();
      if (error == 0) {
        Serial.print("I2C device found at address 0x");
        if (address < 16) Serial.print("0");
        Serial.println(address, HEX);
        nDevices++;
      }
    }
    if (nDevices == 0) {
      Serial.println("No I2C devices found!");
    } else {
      Serial.println("I2C scan complete");
    }
  } else {
    Serial.println("I2C bus scan disabled");
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
  
  // Initialize addressable LED (NeoPixel) - TEST 1.2
  if (legacyStatusLedEnabled) {
    statusLED.begin();
    statusLED.setBrightness(50); // Set brightness (0-255)
    statusLED.clear();
    statusLED.show();
    updateStatusLEDColor(); // Load color from config
    Serial.println("Status LED initialized");
  }
  
  // Calibrate to current position as level
  if (mpuConnected && CALIBRATE_IMU_ON_BOOT) {
    sensorFusion.calibrate(mpu, [](const String& msg) {
      Serial.println(msg);  // Output to Serial only
    });
  } else if (mpuConnected) {
    Serial.println("Skipping IMU calibration on boot");
  }
  
  // Initialize suspension simulator with config and servo calibration
  suspensionSimulator.init(config, servoConfig);
  
  // Initialize PWM outputs
  if (SUSPENSION_PWM_ENABLED) {
    pwmOutputs.init();
    // pwmOutputs.initAux();  // Disabled: AUX_SERVO_PINS overlap with suspension servo pins (25,26,32,33) and NeoPixel (27)
  } else {
    Serial.println("Suspension PWM disabled");
  }

  if (BLE_STARTUP_ENABLED) {
    // Initialize Bluetooth Low Energy service
    bluetoothService = new BluetoothService(&storageManager);
    bluetoothService->setConfigWriteHandler(applyConfigUpdatePayload);
    bluetoothService->setKVWriteHandler(applyKVWritePayload);
    bluetoothService->setServoWriteHandler(applyServoConfigPayload);
    bluetoothService->setSystemWriteHandler(applySystemCommandPayload);
    if (LIGHTS_ENTRYPOINT_ENABLED) {
      bluetoothService->setLightsWriteHandler(applyLightsPayload);
    }
    bluetoothService->setConnectionStateHandler([](bool connected) {
      ledBleOn = connected;
      if (!connected) {
        ledBlinkEndTime = 0;
        lightsDiagEnabled = false;
        // lightsBasicEnabled and lightsMasterEnabled are intentionally preserved so
        // the LED groups keep running after the phone disconnects.
      }
      digitalWrite(LED_PIN, connected ? HIGH : LOW);
    });
    const String bleDeviceName = buildBleAdvertisedName();
    Serial.printf("Starting BLE advertising as: %s\n", bleDeviceName.c_str());
    bluetoothService->begin(bleDeviceName.c_str());
    Serial.println("Bluetooth service started");
  } else {
    Serial.println("BLE startup disabled");
  }
  
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
    if (legacyStatusLedEnabled && !lightsMasterEnabled && !lightsDiagEnabled && !lightsBasicEnabled) {
      statusLED.clear();
      statusLED.show();
    }
    ledBlinkEndTime = 0;
  }

  if (lightsDiagEnabled && legacyStatusLedEnabled && (currentTime - lightsDiagLastStepMs >= lightsDiagIntervalMs)) {
    applyDiagStep();
    lightsDiagLastStepMs = currentTime;
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

    if (!gDanceMode.enabled && !gSuspensionPaused) {
      // Normal suspension loop runs only while Dance Mode is off and suspension is not paused.
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

      if (SUSPENSION_DEBUG_LOGS && (currentTime - lastSuspensionDebugMs >= SUSPENSION_DEBUG_INTERVAL_MS)) {
        const RCDCCConfigState& dbgState = storageManager.getCurrentState();
        Serial.printf(
          "[SUSP-DBG] imu roll=%.2f pitch=%.2f vacc=%.2f | outDeg fl=%.1f fr=%.1f rl=%.1f rr=%.1f\n",
          roll,
          pitch,
          verticalAccel,
          fl,
          fr,
          rl,
          rr
        );
        Serial.printf(
          "[SUSP-DBG] state us fl(t=%ld min=%ld max=%ld rh=%ld rev=%u) fr(t=%ld min=%ld max=%ld rh=%ld rev=%u)\n",
          static_cast<long>(dbgState.servoFL.trimUs),
          static_cast<long>(dbgState.servoFL.minUs),
          static_cast<long>(dbgState.servoFL.maxUs),
          static_cast<long>(dbgState.servoFL.rideHeight),
          static_cast<unsigned>(dbgState.servoFL.reverse),
          static_cast<long>(dbgState.servoFR.trimUs),
          static_cast<long>(dbgState.servoFR.minUs),
          static_cast<long>(dbgState.servoFR.maxUs),
          static_cast<long>(dbgState.servoFR.rideHeight),
          static_cast<unsigned>(dbgState.servoFR.reverse)
        );
        Serial.printf(
          "[SUSP-DBG] state us rl(t=%ld min=%ld max=%ld rh=%ld rev=%u) rr(t=%ld min=%ld max=%ld rh=%ld rev=%u)\n",
          static_cast<long>(dbgState.servoRL.trimUs),
          static_cast<long>(dbgState.servoRL.minUs),
          static_cast<long>(dbgState.servoRL.maxUs),
          static_cast<long>(dbgState.servoRL.rideHeight),
          static_cast<unsigned>(dbgState.servoRL.reverse),
          static_cast<long>(dbgState.servoRR.trimUs),
          static_cast<long>(dbgState.servoRR.minUs),
          static_cast<long>(dbgState.servoRR.maxUs),
          static_cast<long>(dbgState.servoRR.rideHeight),
          static_cast<unsigned>(dbgState.servoRR.reverse)
        );
        Serial.printf(
          "[SUSP-DBG] pins fl=%d fr=%d rl=%d rr=%d\n",
          PWM_FL_PIN,
          PWM_FR_PIN,
          PWM_RL_PIN,
          PWM_RR_PIN
        );
        lastSuspensionDebugMs = currentTime;
      }

      if (manualServoOverrideActive(0, currentTime)) pwmOutputs.setChannelMicroseconds(0, gManualServoOverrides[0].targetUs);
      else pwmOutputs.setChannel(0, fl, servoConfig.frontLeft);

      if (manualServoOverrideActive(1, currentTime)) pwmOutputs.setChannelMicroseconds(1, gManualServoOverrides[1].targetUs);
      else pwmOutputs.setChannel(1, fr, servoConfig.frontRight);

      if (manualServoOverrideActive(2, currentTime)) pwmOutputs.setChannelMicroseconds(2, gManualServoOverrides[2].targetUs);
      else pwmOutputs.setChannel(2, rl, servoConfig.rearLeft);

      if (manualServoOverrideActive(3, currentTime)) pwmOutputs.setChannelMicroseconds(3, gManualServoOverrides[3].targetUs);
      else pwmOutputs.setChannel(3, rr, servoConfig.rearRight);
    }


    clearManualServoOverrides();
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