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
#include "BluetoothService.h"

// Global instances
MPU6050 mpu;
SensorFusion sensorFusion;
SuspensionSimulator suspensionSimulator;
StorageManager storageManager;
PWMOutputs pwmOutputs;
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
static constexpr bool SUSPENSION_DEBUG_LOGS = false;
static constexpr uint32_t SUSPENSION_DEBUG_INTERVAL_MS = 500;
static constexpr bool I2C_BUS_SCAN_ENABLED = false;
static constexpr bool BLE_STARTUP_ENABLED = true;
static constexpr bool CALIBRATE_IMU_ON_BOOT = false;
static constexpr bool SUSPENSION_PWM_ENABLED = true;
static constexpr uint16_t SAMPLE_PROFILE_CONTROL_RATE_HZ = 100;
static constexpr uint16_t LEGACY_PROFILE_MIN_RATE_HZ = 5;
static constexpr uint16_t LEGACY_PROFILE_MAX_RATE_HZ = 200;

// Addressable LED (NeoPixel) - kept for backward compatibility
Adafruit_NeoPixel statusLED(STATUS_LED_COUNT, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);
uint32_t currentLEDColor = 0;
bool legacyStatusLedEnabled = true;
static uint32_t lastSuspensionDebugMs = 0;

enum class ControlProfileMode : uint8_t {
  Sample = 0,
  Legacy = 1
};

static volatile ControlProfileMode gControlProfileMode = ControlProfileMode::Sample;

struct SharedSensorState {
  float roll = 0.0f;
  float pitch = 0.0f;
  float yaw = 0.0f;
  float verticalAccel = 0.0f;
  float accelX = 0.0f;
  float accelY = 0.0f;
  float accelZ = 0.0f;
  bool mpuConnected = false;
};

static SharedSensorState gSensorState;
static SemaphoreHandle_t gSensorStateMutex = nullptr;
static TaskHandle_t gImuTaskHandle = nullptr;
static TaskHandle_t gControlTaskHandle = nullptr;

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

static int32_t mapRideHeightToServoUs(const RCDCCServoState& servo) {
  // rideHeight 0..100 -> normalized -1..1
  float norm = (static_cast<float>(clampI32Safe(servo.rideHeight, 0, 100)) - 50.0f) / 50.0f;
  norm = clampNorm(norm);
  if (servo.reverse != 0) {
    norm = -norm;
  }
  return mapNormToServoUs(norm, servo);
}

static void writeRideHeightToAllSuspensionServos() {
  const RCDCCConfigState& state = storageManager.getCurrentState();

  const int32_t flUs = mapRideHeightToServoUs(state.servoFL);
  const int32_t frUs = mapRideHeightToServoUs(state.servoFR);
  const int32_t rlUs = mapRideHeightToServoUs(state.servoRL);
  const int32_t rrUs = mapRideHeightToServoUs(state.servoRR);

  pwmOutputs.setChannelMicroseconds(0, static_cast<uint16_t>(flUs));
  pwmOutputs.setChannelMicroseconds(1, static_cast<uint16_t>(frUs));
  pwmOutputs.setChannelMicroseconds(2, static_cast<uint16_t>(rlUs));
  pwmOutputs.setChannelMicroseconds(3, static_cast<uint16_t>(rrUs));
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

static uint16_t getSuspensionLoopRateHz() {
  const uint16_t configuredRate = storageManager.getConfig().sampleRate;
  return static_cast<uint16_t>(constrain(configuredRate, static_cast<uint16_t>(5), static_cast<uint16_t>(200)));
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

static void writeSharedSensorState(const SharedSensorState& nextState) {
  if (!gSensorStateMutex) return;
  if (xSemaphoreTake(gSensorStateMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
    gSensorState = nextState;
    xSemaphoreGive(gSensorStateMutex);
  }
}

static SharedSensorState readSharedSensorState() {
  SharedSensorState snapshot;
  if (!gSensorStateMutex) {
    return snapshot;
  }
  if (xSemaphoreTake(gSensorStateMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
    snapshot = gSensorState;
    xSemaphoreGive(gSensorStateMutex);
  }
  return snapshot;
}

static bool isSampleControlProfileActive() {
  return gControlProfileMode == ControlProfileMode::Sample;
}

static uint16_t getControlLoopRateHz() {
  if (isSampleControlProfileActive()) {
    return SAMPLE_PROFILE_CONTROL_RATE_HZ;
  }
  const uint16_t configuredRate = storageManager.getConfig().sampleRate;
  return static_cast<uint16_t>(constrain(configuredRate, LEGACY_PROFILE_MIN_RATE_HZ, LEGACY_PROFILE_MAX_RATE_HZ));
}

static void processAuxServoOutputs() {
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

static void runSuspensionControlCycle(const SharedSensorState& sensors, uint32_t nowMs) {
  if (gDanceMode.enabled || gSuspensionPaused) {
    clearManualServoOverrides();
    processAuxServoOutputs();
    return;
  }

  suspensionSimulator.update(sensors.roll, sensors.pitch, sensors.verticalAccel);

  float fl = suspensionSimulator.getFrontLeftOutput();
  float fr = suspensionSimulator.getFrontRightOutput();
  float rl = suspensionSimulator.getRearLeftOutput();
  float rr = suspensionSimulator.getRearRightOutput();

  const RCDCCConfigState& state = storageManager.getCurrentState();
  const float halfTravel = SUSP_SIM_TRAVEL_DEG * 0.5f;
  const float invHalfTravel = (halfTravel > 0.0001f) ? (1.0f / halfTravel) : 0.0f;

  float flNorm = clampNorm((fl - SUSP_SIM_DEG_MID) * invHalfTravel);
  float frNorm = clampNorm((fr - SUSP_SIM_DEG_MID) * invHalfTravel);
  float rlNorm = clampNorm((rl - SUSP_SIM_DEG_MID) * invHalfTravel);
  float rrNorm = clampNorm((rr - SUSP_SIM_DEG_MID) * invHalfTravel);

  if (state.servoFL.reverse != 0) flNorm = -flNorm;
  if (state.servoFR.reverse != 0) frNorm = -frNorm;
  if (state.servoRL.reverse != 0) rlNorm = -rlNorm;
  if (state.servoRR.reverse != 0) rrNorm = -rrNorm;

  const int32_t flUs = mapNormToServoUs(flNorm, state.servoFL);
  const int32_t frUs = mapNormToServoUs(frNorm, state.servoFR);
  const int32_t rlUs = mapNormToServoUs(rlNorm, state.servoRL);
  const int32_t rrUs = mapNormToServoUs(rrNorm, state.servoRR);

  if (SUSPENSION_DEBUG_LOGS && (nowMs - lastSuspensionDebugMs >= SUSPENSION_DEBUG_INTERVAL_MS)) {
    Serial.printf(
      "[SUSP-DBG] mode=%s imu roll=%.2f pitch=%.2f vacc=%.2f | outDeg fl=%.1f fr=%.1f rl=%.1f rr=%.1f\n",
      isSampleControlProfileActive() ? "sample" : "legacy",
      sensors.roll,
      sensors.pitch,
      sensors.verticalAccel,
      fl,
      fr,
      rl,
      rr
    );
    lastSuspensionDebugMs = nowMs;
  }

  if (manualServoOverrideActive(0, nowMs)) pwmOutputs.setChannelMicroseconds(0, gManualServoOverrides[0].targetUs);
  else pwmOutputs.setChannelMicroseconds(0, static_cast<uint16_t>(flUs));

  if (manualServoOverrideActive(1, nowMs)) pwmOutputs.setChannelMicroseconds(1, gManualServoOverrides[1].targetUs);
  else pwmOutputs.setChannelMicroseconds(1, static_cast<uint16_t>(frUs));

  if (manualServoOverrideActive(2, nowMs)) pwmOutputs.setChannelMicroseconds(2, gManualServoOverrides[2].targetUs);
  else pwmOutputs.setChannelMicroseconds(2, static_cast<uint16_t>(rlUs));

  if (manualServoOverrideActive(3, nowMs)) pwmOutputs.setChannelMicroseconds(3, gManualServoOverrides[3].targetUs);
  else pwmOutputs.setChannelMicroseconds(3, static_cast<uint16_t>(rrUs));

  clearManualServoOverrides();
  processAuxServoOutputs();
}

static void imuTask(void* /*pv*/) {
  TickType_t lastWake = xTaskGetTickCount();

  for (;;) {
    const uint16_t sampleHz = getSuspensionLoopRateHz();
    const uint32_t sampleIntervalMs = max<uint32_t>(1UL, 1000UL / static_cast<uint32_t>(sampleHz));
    const TickType_t sampleTicks = pdMS_TO_TICKS(sampleIntervalMs);

    SharedSensorState nextState = readSharedSensorState();

    if (mpuConnected) {
      int16_t ax, ay, az, gx, gy, gz;

      esp_log_level_set("Wire", ESP_LOG_NONE);
      mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
      esp_log_level_set("Wire", ESP_LOG_WARN);

      if (ax != 0 || ay != 0 || az != 0 || gx != 0 || gy != 0 || gz != 0) {
        const float accelX = ax / 16384.0f;
        const float accelY = ay / 16384.0f;
        const float accelZ = az / 16384.0f;
        const float gyroX = gx / 131.0f;
        const float gyroY = gy / 131.0f;
        const float gyroZ = gz / 131.0f;

        sensorFusion.update(accelX, accelY, accelZ, gyroX, gyroY, gyroZ);

        nextState.roll = sensorFusion.getRoll();
        nextState.pitch = sensorFusion.getPitch();
        nextState.yaw = sensorFusion.getYaw();
        nextState.verticalAccel = sensorFusion.getVerticalAcceleration();
        nextState.accelX = accelX;
        nextState.accelY = accelY;
        nextState.accelZ = accelZ;
        nextState.mpuConnected = true;
        mpuConnected = true;
      } else {
        nextState.mpuConnected = false;
        mpuConnected = false;
      }
    } else {
      nextState.mpuConnected = false;
    }

    writeSharedSensorState(nextState);

    // Keep legacy globals in sync for existing code paths and telemetry serialization.
    currentRoll = nextState.roll;
    currentPitch = nextState.pitch;
    currentYaw = nextState.yaw;
    currentVerticalAccel = nextState.verticalAccel;
    currentAccelX = nextState.accelX;
    currentAccelY = nextState.accelY;
    currentAccelZ = nextState.accelZ;

    vTaskDelayUntil(&lastWake, sampleTicks);
  }
}

static void controlTask(void* /*pv*/) {
  TickType_t lastWake = xTaskGetTickCount();

  for (;;) {
    const uint16_t controlRateHz = getControlLoopRateHz();
    const uint32_t controlIntervalMs = max<uint32_t>(1UL, 1000UL / static_cast<uint32_t>(controlRateHz));
    const TickType_t controlTicks = pdMS_TO_TICKS(controlIntervalMs);

    const SharedSensorState sensors = readSharedSensorState();
    runSuspensionControlCycle(sensors, millis());
    vTaskDelayUntil(&lastWake, controlTicks);
  }
}

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

void clearStrip() {
  if (!legacyStatusLedEnabled) return;
  statusLED.clear();
  statusLED.show();
}

bool applyConfigUpdatePayload(const String& payload) {
  if (payload.length() == 0) {
    return true;
  }

  bool hasRideHeightUpdate = false;

  DynamicJsonDocument doc(2048);
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("BLE config JSON parse error: %s\n", error.c_str());
    return false;
  }

  if (doc.containsKey("reactionSpeed")) storageManager.updateParameter("reactionSpeed", doc["reactionSpeed"]);
  if (doc.containsKey("suspensionMode")) storageManager.updateParameter("suspensionMode", doc["suspensionMode"]);
  if (doc.containsKey("rideHeightOffset")) {
    storageManager.updateParameter("rideHeightOffset", doc["rideHeightOffset"]);
    hasRideHeightUpdate = true;
  }
  if (doc.containsKey("travelDeg")) storageManager.updateParameter("travelDeg", doc["travelDeg"]);
  else if (doc.containsKey("rangeLimit")) storageManager.updateParameter("rangeLimit", doc["rangeLimit"]);
  if (doc.containsKey("cornerAssist")) storageManager.updateParameter("cornerAssist", doc["cornerAssist"].as<bool>() ? 1.0f : 0.0f);
  if (doc.containsKey("cornerGain")) storageManager.updateParameter("cornerGain", doc["cornerGain"]);
  if (doc.containsKey("cornerResponse")) storageManager.updateParameter("cornerResponse", doc["cornerResponse"]);
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
        hasRideHeightUpdate = true;
      }
      if (servo.containsKey("ride_ht")) {
        String ns = (strcmp(servoName, "frontLeft") == 0) ? "srv_fl"
                  : (strcmp(servoName, "frontRight") == 0) ? "srv_fr"
                  : (strcmp(servoName, "rearLeft") == 0) ? "srv_rl"
                  : "srv_rr";
        DynamicJsonDocument rideDoc(32);
        rideDoc["v"] = servo["ride_ht"].as<int32_t>();
        storageManager.setValue(ns + ".ride_ht", rideDoc["v"].as<JsonVariantConst>());
        hasRideHeightUpdate = true;
      }
    }
  }

  refreshSuspensionRuntimeFromStorage();

  // In pause mode, allow static ride-height adjustments without re-enabling
  // the suspension loop. Dance Mode retains servo ownership when active.
  if (gSuspensionPaused && hasRideHeightUpdate && !gDanceMode.enabled) {
    writeRideHeightToAllSuspensionServos();
  }

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

  // In paused setup mode, apply servo setup edits live.
  if (gSuspensionPaused) {
    if (key.startsWith("srv_") &&
        (key.endsWith(".trim") || key.endsWith(".min") || key.endsWith(".max") ||
         key.endsWith(".ride_ht") || key.endsWith(".reverse"))) {
      writeRideHeightToAllSuspensionServos();
    }
  }

  if (key.startsWith("suspension.") || key.startsWith("srv_") || key == "imu.orient") {
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

  if (command == "control_profile") {
    String mode = doc["mode"] | String("");
    mode.toLowerCase();
    const bool sampleProfile = doc.containsKey("sample") ? doc["sample"].as<bool>() : (mode != "legacy");
    gControlProfileMode = sampleProfile ? ControlProfileMode::Sample : ControlProfileMode::Legacy;
    refreshSuspensionRuntimeFromStorage();
    Serial.printf("{\"status\":\"control_profile\",\"mode\":\"%s\",\"hz\":%u}\n",
                  sampleProfile ? "sample" : "legacy",
                  static_cast<unsigned>(getControlLoopRateHz()));
    return true;
  }

  // ==================== Phase 6: Dance Mode ====================

  if (command == "suspend_suspension") {
    gSuspensionPaused = doc["paused"] | false;
    if (gSuspensionPaused) {
      writeTrimToAllSuspensionServos();
    } else {
      // Reset simulator state and clear stale overrides so resume starts level
      // with the latest per-servo calibration (trim/min/max/reverse/ride height).
      refreshSuspensionRuntimeFromStorage();
      clearManualServoOverrides();
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
    Serial.printf("BLE system command ignored (profile command removed): %s\n", command.c_str());
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

  legacyStatusLedEnabled = true;

  storageManager.loadConfig();
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

  gSensorStateMutex = xSemaphoreCreateMutex();
  SharedSensorState bootState;
  bootState.mpuConnected = mpuConnected;
  writeSharedSensorState(bootState);
  
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
  } else {
    Serial.println("BLE startup disabled");
  }

  if (SUSPENSION_PWM_ENABLED) {
    xTaskCreatePinnedToCore(imuTask, "imuTask", 4096, nullptr, 2, &gImuTaskHandle, 0);
    xTaskCreatePinnedToCore(controlTask, "controlTask", 6144, nullptr, 2, &gControlTaskHandle, 1);
    Serial.printf("Control runtime started (profile=%s, controlHz=%u)\n",
                  isSampleControlProfileActive() ? "sample" : "legacy",
                  static_cast<unsigned>(getControlLoopRateHz()));
  }
  
  Serial.println("Setup complete!");
}

// Main loop
void loop() {
  const unsigned long currentTime = millis();

  // BLE message processing remains on the Arduino loop task.
  if (bluetoothService) {
    bluetoothService->update();
  }

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

  // Send BLE telemetry at configured rate (loop task remains comms owner).
  static unsigned long lastBroadcast = 0;
  const SuspensionConfig config = storageManager.getConfig();
  const uint8_t telemetryHz = max<uint8_t>(1, config.telemetryRate);
  const uint16_t telemetryIntervalMs = 1000 / telemetryHz;
  if (currentTime - lastBroadcast >= telemetryIntervalMs) {
    const SharedSensorState sensors = readSharedSensorState();
    if (bluetoothService && bluetoothService->isConnected() && sensors.mpuConnected) {
      bluetoothService->sendTelemetry(sensors.roll, sensors.pitch, sensors.accelX, sensors.accelY, sensors.accelZ);
    }
    lastBroadcast = currentTime;
  }

  yield();
}