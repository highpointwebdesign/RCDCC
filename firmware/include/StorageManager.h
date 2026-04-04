#ifndef STORAGE_MANAGER_H
#define STORAGE_MANAGER_H

#include "Config.h"
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <esp_mac.h>
#include <cstring>

class StorageManager {
private:
  RCDCCConfigState state = {};
  SuspensionConfig legacyConfig = {};
  ServoConfig legacyServoConfig = {};

  LEDConfig ledConfig;
  LightsConfig lightsConfig;
  NewLightsConfig newLightsConfig = {};
  bool littleFsReady = false;
  bool servoTrimResetWarning = false;

  // Driving profiles (Phase 3)
  DrivingProfile drivingProfiles[MAX_DRIVING_PROFILES] = {};

  // Servo registry (Phase 4)
  ServoRegistry servoRegistry = {};

  static constexpr const char* NS_SERVO_REGISTRY = "srv_registry";

  static constexpr const char* NS_SERVO_FL = "srv_fl";
  static constexpr const char* NS_SERVO_FR = "srv_fr";
  static constexpr const char* NS_SERVO_RL = "srv_rl";
  static constexpr const char* NS_SERVO_RR = "srv_rr";
  static constexpr const char* NS_SUSP = "suspension";
  static constexpr const char* NS_IMU = "imu";
  static constexpr const char* NS_SYSTEM = "system";

  static constexpr float FLOAT_SCALE = 1000.0f;

  static String formatMacAddress(const uint8_t* macBytes) {
    char buffer[18] = {0};
    snprintf(buffer,
             sizeof(buffer),
             "%02X:%02X:%02X:%02X:%02X:%02X",
             macBytes[0], macBytes[1], macBytes[2], macBytes[3], macBytes[4], macBytes[5]);
    return String(buffer);
  }

  static String readInterfaceMac(esp_mac_type_t macType) {
    uint8_t macBytes[6] = {0};
    if (esp_read_mac(macBytes, macType) != ESP_OK) {
      return String("");
    }
    return formatMacAddress(macBytes);
  }

  static int32_t clampI32(int32_t value, int32_t minValue, int32_t maxValue) {
    if (value < minValue) return minValue;
    if (value > maxValue) return maxValue;
    return value;
  }

  static int32_t floatToScaledI32(float value) {
    return static_cast<int32_t>(roundf(value * FLOAT_SCALE));
  }

  static float scaledI32ToFloat(int32_t value) {
    return static_cast<float>(value) / FLOAT_SCALE;
  }

  void initDefaultServo(RCDCCServoState& servo, const char* label) {
    strncpy(servo.label, label, sizeof(servo.label) - 1);
    servo.label[sizeof(servo.label) - 1] = '\0';

    strncpy(servo.type, DEFAULT_SERVO_TYPE, sizeof(servo.type) - 1);
    servo.type[sizeof(servo.type) - 1] = '\0';

    servo.enabled = DEFAULT_SERVO_ENABLED;
    servo.trimUs = DEFAULT_SERVO_TRIM_US;
    servo.minUs = DEFAULT_SERVO_MIN_US;
    servo.maxUs = DEFAULT_SERVO_MAX_US;
    servo.reverse = DEFAULT_SERVO_REVERSE;
    servo.rideHeight = DEFAULT_SERVO_RIDE_HT;
  }

  void loadStateDefaults() {
    initDefaultServo(state.servoFL, DEFAULT_SERVO_LABEL_FL);
    initDefaultServo(state.servoFR, DEFAULT_SERVO_LABEL_FR);
    initDefaultServo(state.servoRL, DEFAULT_SERVO_LABEL_RL);
    initDefaultServo(state.servoRR, DEFAULT_SERVO_LABEL_RR);

    state.suspension.damping = DEFAULT_SUSP_DAMPING;
    state.suspension.stiffness = DEFAULT_SUSP_STIFFNESS;
    state.suspension.reactSpeed = DEFAULT_SUSP_REACT_SPD;
    state.suspension.frontRearBalance = DEFAULT_SUSP_FR_BALANCE;

    state.imu.orient = DEFAULT_IMU_ORIENT;
    state.imu.rollTrim = DEFAULT_IMU_ROLL_TRIM;
    state.imu.pitchTrim = DEFAULT_IMU_PITCH_TRIM;

    strncpy(state.system.deviceName, DEFAULT_DEVICE_NAME, sizeof(state.system.deviceName) - 1);
    state.system.deviceName[sizeof(state.system.deviceName) - 1] = '\0';
    strncpy(state.system.firmwareVersion, FIRMWARE_VERSION, sizeof(state.system.firmwareVersion) - 1);
    state.system.firmwareVersion[sizeof(state.system.firmwareVersion) - 1] = '\0';
    state.system.activeDrivingProfile = DEFAULT_ACTIVE_DRIVING_PROFILE;
    state.system.activeLightingProfile = DEFAULT_ACTIVE_LIGHTING_PROFILE;

    syncLegacyFromState();
  }

  void syncLegacyFromState() {
    legacyConfig.reactionSpeed = static_cast<float>(clampI32(state.suspension.reactSpeed, 0, 100)) / 50.0f;
    if (legacyConfig.reactionSpeed < 0.1f) legacyConfig.reactionSpeed = 0.1f;

    legacyConfig.rideHeightOffset = static_cast<float>(
      (state.servoFL.rideHeight + state.servoFR.rideHeight + state.servoRL.rideHeight + state.servoRR.rideHeight) / 4
    );
    legacyConfig.rangeLimit = DEFAULT_RANGE_LIMIT;
    legacyConfig.damping = static_cast<float>(clampI32(state.suspension.damping, 0, 100)) / 100.0f;
    legacyConfig.frontRearBalance = static_cast<float>(clampI32(state.suspension.frontRearBalance, -100, 100) + 100) / 200.0f;
    legacyConfig.stiffness = static_cast<float>(clampI32(state.suspension.stiffness, 0, 100)) / 50.0f;
    if (legacyConfig.stiffness < 0.1f) legacyConfig.stiffness = 0.1f;
    legacyConfig.sampleRate = SUSPENSION_SAMPLE_RATE_HZ;
    legacyConfig.telemetryRate = DEFAULT_TELEMETRY_RATE_HZ;
    legacyConfig.mpuOrientation = static_cast<uint8_t>(clampI32(state.imu.orient, 0, 3));
    legacyConfig.fpvAutoMode = DEFAULT_FPV_AUTO_MODE;

    strncpy(legacyConfig.deviceName, state.system.deviceName, sizeof(legacyConfig.deviceName) - 1);
    legacyConfig.deviceName[sizeof(legacyConfig.deviceName) - 1] = '\0';

    auto mapUsToDegrees = [](int32_t us, int32_t minUs, int32_t maxUs) -> uint8_t {
      const int32_t safeMin = clampI32(minUs, 900, 2100);
      const int32_t safeMax = clampI32(maxUs, safeMin + 1, 2100);
      const float ratio = static_cast<float>(clampI32(us, safeMin, safeMax) - safeMin) / static_cast<float>(safeMax - safeMin);
      const int32_t deg = static_cast<int32_t>(roundf(ratio * 180.0f));
      return static_cast<uint8_t>(clampI32(deg, 0, 180));
    };

    auto fillLegacyServo = [&](const RCDCCServoState& source, ServoCalibration& target) {
      target.minLimit = mapUsToDegrees(source.minUs, source.minUs, source.maxUs);
      target.maxLimit = mapUsToDegrees(source.maxUs, source.minUs, source.maxUs);
      const int32_t trimDeltaUs = source.trimUs - DEFAULT_SERVO_TRIM_US;
      const int32_t trimDeg = static_cast<int32_t>(roundf(static_cast<float>(trimDeltaUs) * 180.0f / 1000.0f));
      target.trim = static_cast<int8_t>(clampI32(trimDeg, -45, 45));
      target.reversed = source.reverse != 0;
    };

    fillLegacyServo(state.servoFL, legacyServoConfig.frontLeft);
    fillLegacyServo(state.servoFR, legacyServoConfig.frontRight);
    fillLegacyServo(state.servoRL, legacyServoConfig.rearLeft);
    fillLegacyServo(state.servoRR, legacyServoConfig.rearRight);
  }

  bool hasSystemFirmwareVersion() {
    Preferences pref;
    if (!pref.begin(NS_SYSTEM, true)) {
      Serial.println("NVS open failed for first-boot check");
      return false;
    }

    const bool hasKey = pref.isKey("fw_version");
    pref.end();
    return hasKey;
  }

  void writeServoNamespace(const char* ns, const RCDCCServoState& servo) {
    Preferences pref;
    if (!pref.begin(ns, false)) {
      Serial.printf("NVS open failed for namespace: %s\n", ns);
      return;
    }

    pref.putString("label", servo.label);
    pref.putString("type", servo.type);
    pref.putUChar("enabled", servo.enabled);
    pref.putInt("trim", servo.trimUs);
    pref.putInt("min", servo.minUs);
    pref.putInt("max", servo.maxUs);
    pref.putUChar("reverse", servo.reverse);
    pref.putInt("ride_ht", servo.rideHeight);
    pref.end();
  }

  void writeSuspensionNamespace() {
    Preferences pref;
    if (!pref.begin(NS_SUSP, false)) {
      Serial.println("NVS open failed for suspension namespace");
      return;
    }

    pref.putInt("damping", state.suspension.damping);
    pref.putInt("stiffness", state.suspension.stiffness);
    pref.putInt("react_spd", state.suspension.reactSpeed);
    pref.putInt("fr_balance", state.suspension.frontRearBalance);
    pref.end();
  }

  void writeImuNamespace() {
    Preferences pref;
    if (!pref.begin(NS_IMU, false)) {
      Serial.println("NVS open failed for imu namespace");
      return;
    }

    pref.putInt("orient", state.imu.orient);
    pref.putInt("roll_trim", floatToScaledI32(state.imu.rollTrim));
    pref.putInt("pitch_trim", floatToScaledI32(state.imu.pitchTrim));
    pref.end();
  }

  void writeSystemNamespace() {
    Preferences pref;
    if (!pref.begin(NS_SYSTEM, false)) {
      Serial.println("NVS open failed for system namespace");
      return;
    }

    pref.putString("device_nm", state.system.deviceName);
    pref.putString("fw_version", state.system.firmwareVersion);
    pref.putInt("act_drv_prof", state.system.activeDrivingProfile);
    pref.putInt("act_lt_prof", state.system.activeLightingProfile);
    pref.end();
  }

  void readServoNamespace(const char* ns, RCDCCServoState& servo, const char* defaultLabel) {
    initDefaultServo(servo, defaultLabel);

    Preferences pref;
    if (!pref.begin(ns, true)) {
      Serial.printf("NVS read open failed for namespace: %s\n", ns);
      return;
    }

    String label = pref.getString("label", servo.label);
    String type = pref.getString("type", servo.type);

    strncpy(servo.label, label.c_str(), sizeof(servo.label) - 1);
    servo.label[sizeof(servo.label) - 1] = '\0';

    strncpy(servo.type, type.c_str(), sizeof(servo.type) - 1);
    servo.type[sizeof(servo.type) - 1] = '\0';

    servo.enabled = pref.getUChar("enabled", DEFAULT_SERVO_ENABLED);
    servo.trimUs = pref.getInt("trim", DEFAULT_SERVO_TRIM_US);
    servo.minUs = pref.getInt("min", DEFAULT_SERVO_MIN_US);
    servo.maxUs = pref.getInt("max", DEFAULT_SERVO_MAX_US);
    servo.reverse = pref.getUChar("reverse", DEFAULT_SERVO_REVERSE);
    servo.rideHeight = pref.getInt("ride_ht", DEFAULT_SERVO_RIDE_HT);
    pref.end();

    servo.enabled = servo.enabled ? 1 : 0;
    servo.minUs = clampI32(servo.minUs, 900, 2100);
    servo.maxUs = clampI32(servo.maxUs, servo.minUs + 1, 2100);
    servo.trimUs = clampI32(servo.trimUs, 900, 2100);
    servo.reverse = servo.reverse ? 1 : 0;
    servo.rideHeight = clampI32(servo.rideHeight, 0, 100);

    if (servo.label[0] == '\0') {
      strncpy(servo.label, defaultLabel, sizeof(servo.label) - 1);
      servo.label[sizeof(servo.label) - 1] = '\0';
    }

    if (servo.type[0] == '\0') {
      strncpy(servo.type, DEFAULT_SERVO_TYPE, sizeof(servo.type) - 1);
      servo.type[sizeof(servo.type) - 1] = '\0';
    }
  }

  void readSuspensionNamespace() {
    state.suspension = { DEFAULT_SUSP_DAMPING, DEFAULT_SUSP_STIFFNESS, DEFAULT_SUSP_REACT_SPD, DEFAULT_SUSP_FR_BALANCE };

    Preferences pref;
    if (!pref.begin(NS_SUSP, true)) {
      Serial.println("NVS read open failed for suspension namespace");
      return;
    }

    state.suspension.damping = pref.getInt("damping", DEFAULT_SUSP_DAMPING);
    state.suspension.stiffness = pref.getInt("stiffness", DEFAULT_SUSP_STIFFNESS);
    state.suspension.reactSpeed = pref.getInt("react_spd", DEFAULT_SUSP_REACT_SPD);
    state.suspension.frontRearBalance = pref.getInt("fr_balance", DEFAULT_SUSP_FR_BALANCE);
    pref.end();

    state.suspension.damping = clampI32(state.suspension.damping, 0, 100);
    state.suspension.stiffness = clampI32(state.suspension.stiffness, 0, 100);
    state.suspension.reactSpeed = clampI32(state.suspension.reactSpeed, 0, 100);
    state.suspension.frontRearBalance = clampI32(state.suspension.frontRearBalance, -100, 100);
  }

  void readImuNamespace() {
    state.imu = { DEFAULT_IMU_ORIENT, DEFAULT_IMU_ROLL_TRIM, DEFAULT_IMU_PITCH_TRIM };

    Preferences pref;
    if (!pref.begin(NS_IMU, true)) {
      Serial.println("NVS read open failed for imu namespace");
      return;
    }

    state.imu.orient = pref.getInt("orient", DEFAULT_IMU_ORIENT);
    state.imu.rollTrim = scaledI32ToFloat(pref.getInt("roll_trim", floatToScaledI32(DEFAULT_IMU_ROLL_TRIM)));
    state.imu.pitchTrim = scaledI32ToFloat(pref.getInt("pitch_trim", floatToScaledI32(DEFAULT_IMU_PITCH_TRIM)));
    pref.end();

    state.imu.orient = clampI32(state.imu.orient, 0, 3);
  }

  void readSystemNamespace() {
    strncpy(state.system.deviceName, DEFAULT_DEVICE_NAME, sizeof(state.system.deviceName) - 1);
    state.system.deviceName[sizeof(state.system.deviceName) - 1] = '\0';
    strncpy(state.system.firmwareVersion, FIRMWARE_VERSION, sizeof(state.system.firmwareVersion) - 1);
    state.system.firmwareVersion[sizeof(state.system.firmwareVersion) - 1] = '\0';
    state.system.activeDrivingProfile = DEFAULT_ACTIVE_DRIVING_PROFILE;
    state.system.activeLightingProfile = DEFAULT_ACTIVE_LIGHTING_PROFILE;

    Preferences pref;
    if (!pref.begin(NS_SYSTEM, true)) {
      Serial.println("NVS read open failed for system namespace");
      return;
    }

    String deviceName = pref.getString("device_nm", state.system.deviceName);
    String fwVersion = pref.getString("fw_version", FIRMWARE_VERSION);

    strncpy(state.system.deviceName, deviceName.c_str(), sizeof(state.system.deviceName) - 1);
    state.system.deviceName[sizeof(state.system.deviceName) - 1] = '\0';

    strncpy(state.system.firmwareVersion, fwVersion.c_str(), sizeof(state.system.firmwareVersion) - 1);
    state.system.firmwareVersion[sizeof(state.system.firmwareVersion) - 1] = '\0';

    state.system.activeDrivingProfile = pref.getInt("act_drv_prof", DEFAULT_ACTIVE_DRIVING_PROFILE);
    state.system.activeLightingProfile = pref.getInt("act_lt_prof", DEFAULT_ACTIVE_LIGHTING_PROFILE);
    pref.end();
  }

  RCDCCServoState* resolveServoNamespace(const String& ns) {
    if (ns == NS_SERVO_FL) return &state.servoFL;
    if (ns == NS_SERVO_FR) return &state.servoFR;
    if (ns == NS_SERVO_RL) return &state.servoRL;
    if (ns == NS_SERVO_RR) return &state.servoRR;
    return nullptr;
  }

  // ==================== Aux Servo NVS Helpers (Phase 4) ====================

  static String getAuxNs(int slot) {
    String ns = "srv_aux_";
    if (slot < 10) ns += "0";
    ns += String(slot);
    return ns;
  }

  // Write type-specific default keys for a brand-new (or re-typed) aux servo.
  void writeAuxTypeDefaults(const String& ns, const String& type) {
    Preferences pref;
    if (!pref.begin(ns.c_str(), false)) return;
    if (type == AUX_TYPE_POSITIONAL) {
      pref.putInt("trim",   DEFAULT_AUX_TRIM_US);
      pref.putInt("min",    DEFAULT_AUX_MIN_US);
      pref.putInt("max",    DEFAULT_AUX_MAX_US);
      pref.putUChar("reverse",  DEFAULT_AUX_REVERSE);
      pref.putInt("ride_ht",    DEFAULT_AUX_RIDE_HT);
    } else if (type == AUX_TYPE_CONTINUOUS) {
      pref.putInt("spd_fwd", DEFAULT_AUX_SPD_FWD);
      pref.putInt("spd_rev", DEFAULT_AUX_SPD_REV);
      pref.putUChar("reverse",  DEFAULT_AUX_REVERSE);
    } else if (type == AUX_TYPE_PAN) {
      pref.putInt("trim",   DEFAULT_AUX_TRIM_US);
      pref.putInt("min",    DEFAULT_AUX_MIN_US);
      pref.putInt("max",    DEFAULT_AUX_MAX_US);
      pref.putUChar("reverse",  DEFAULT_AUX_REVERSE);
      pref.putInt("spd",    DEFAULT_AUX_SPD);
    } else if (type == AUX_TYPE_RELAY) {
      pref.putUChar("state",    DEFAULT_AUX_STATE);
      pref.putUChar("momentary", DEFAULT_AUX_MOMENTARY);
    }
    pref.end();
  }

  // Remove NVS keys belonging to oldType that do NOT exist in newType.
  void clearAuxTypeSpecificKeys(const String& ns, const char* oldType, const char* newType) {
    Preferences pref;
    if (!pref.begin(ns.c_str(), false)) return;

    bool wasPos  = strcmp(oldType, AUX_TYPE_POSITIONAL) == 0;
    bool isPos   = strcmp(newType, AUX_TYPE_POSITIONAL) == 0;
    bool wasCont = strcmp(oldType, AUX_TYPE_CONTINUOUS) == 0;
    bool isCont  = strcmp(newType, AUX_TYPE_CONTINUOUS) == 0;
    bool wasPan  = strcmp(oldType, AUX_TYPE_PAN) == 0;
    bool isPan   = strcmp(newType, AUX_TYPE_PAN) == 0;
    bool wasRel  = strcmp(oldType, AUX_TYPE_RELAY) == 0;
    bool isRel   = strcmp(newType, AUX_TYPE_RELAY) == 0;

    // trim/min/max present in positional + pan only
    bool hadTrimMinMax = wasPos || wasPan;
    bool hasTrimMinMax = isPos  || isPan;
    if (hadTrimMinMax && !hasTrimMinMax) {
      pref.remove("trim"); pref.remove("min"); pref.remove("max");
    }
    if (wasPos && !isPos)  pref.remove("ride_ht");
    if (wasCont && !isCont) { pref.remove("spd_fwd"); pref.remove("spd_rev"); }
    if (wasPan  && !isPan)  pref.remove("spd");
    // reverse key appears in pos/pan/continuous but not relay
    bool hadReverse = wasPos || wasPan || wasCont;
    bool hasReverse = isPos  || isPan  || isCont;
    if (hadReverse && !hasReverse) pref.remove("reverse");
    if (wasRel && !isRel) { pref.remove("state"); pref.remove("momentary"); }
    pref.end();
  }

  void writeAuxServoToNVS(const AuxServoConfig& aux) {
    Preferences pref;
    if (!pref.begin(aux.ns, false)) return;
    pref.putString("label",  aux.label);
    pref.putString("type",   aux.type);
    pref.putUChar("enabled", aux.enabled);
    String t = aux.type;
    if (t == AUX_TYPE_POSITIONAL || t == AUX_TYPE_PAN) {
      pref.putInt("trim",  aux.trimUs);
      pref.putInt("min",   aux.minUs);
      pref.putInt("max",   aux.maxUs);
      pref.putUChar("reverse", aux.reverse);
    }
    if (t == AUX_TYPE_POSITIONAL) pref.putInt("ride_ht", aux.rideHeight);
    if (t == AUX_TYPE_CONTINUOUS) {
      pref.putInt("spd_fwd", aux.spdFwd);
      pref.putInt("spd_rev", aux.spdRev);
      pref.putUChar("reverse", aux.reverse);
    }
    if (t == AUX_TYPE_PAN)   pref.putInt("spd",  aux.spd);
    if (t == AUX_TYPE_RELAY) {
      pref.putUChar("state",    aux.state);
      pref.putUChar("momentary", aux.momentary);
    }
    pref.end();
  }

  bool readAuxServoFromNVS(const String& ns, AuxServoConfig& aux) {
    aux = {};
    Preferences pref;
    if (!pref.begin(ns.c_str(), true)) return false;
    if (!pref.isKey("label")) { pref.end(); return false; }

    strncpy(aux.ns, ns.c_str(), sizeof(aux.ns) - 1);
    aux.ns[sizeof(aux.ns) - 1] = '\0';

    String lbl  = pref.getString("label", "Aux");
    String type = pref.getString("type",  AUX_TYPE_POSITIONAL);
    strncpy(aux.label, lbl.c_str(),  sizeof(aux.label) - 1);
    aux.label[sizeof(aux.label) - 1] = '\0';
    strncpy(aux.type,  type.c_str(), sizeof(aux.type)  - 1);
    aux.type[sizeof(aux.type)  - 1] = '\0';
    aux.enabled = pref.getUChar("enabled", DEFAULT_AUX_ENABLED);

    if (type == AUX_TYPE_POSITIONAL || type == AUX_TYPE_PAN) {
      aux.trimUs  = pref.getInt("trim",    DEFAULT_AUX_TRIM_US);
      aux.minUs   = pref.getInt("min",     DEFAULT_AUX_MIN_US);
      aux.maxUs   = pref.getInt("max",     DEFAULT_AUX_MAX_US);
      aux.reverse = pref.getUChar("reverse", DEFAULT_AUX_REVERSE);
    }
    if (type == AUX_TYPE_POSITIONAL) aux.rideHeight = pref.getInt("ride_ht", DEFAULT_AUX_RIDE_HT);
    if (type == AUX_TYPE_CONTINUOUS) {
      aux.spdFwd  = pref.getInt("spd_fwd", DEFAULT_AUX_SPD_FWD);
      aux.spdRev  = pref.getInt("spd_rev", DEFAULT_AUX_SPD_REV);
      aux.reverse = pref.getUChar("reverse", DEFAULT_AUX_REVERSE);
    }
    if (type == AUX_TYPE_PAN)   aux.spd      = pref.getInt("spd", DEFAULT_AUX_SPD);
    if (type == AUX_TYPE_RELAY) {
      aux.state    = pref.getUChar("state",    DEFAULT_AUX_STATE);
      aux.momentary = pref.getUChar("momentary", DEFAULT_AUX_MOMENTARY);
    }
    pref.end();
    aux.populated = true;
    return true;
  }

  void writeRegistryToNVS() {
    Preferences pref;
    if (!pref.begin(NS_SERVO_REGISTRY, false)) return;
    pref.putInt("count",     4 + servoRegistry.auxCount);
    pref.putInt("aux_count", servoRegistry.auxCount);
    for (int i = 0; i < servoRegistry.auxCount; i++) {
      String key = "aux_";
      if (i < 10) key += "0";
      key += String(i);
      pref.putString(key.c_str(), servoRegistry.auxServos[i].ns);
    }
    pref.end();
  }

  void readRegistryFromNVS() {
    Preferences pref;
    if (!pref.begin(NS_SERVO_REGISTRY, true)) return;
    if (!pref.isKey("aux_count")) { pref.end(); return; }
    int cnt = clampI32(pref.getInt("aux_count", 0), 0, MAX_AUX_SERVOS);
    for (int i = 0; i < cnt; i++) {
      String key = "aux_";
      if (i < 10) key += "0";
      key += String(i);
      String ns = pref.getString(key.c_str(), "");
      if (ns.length() > 0) {
        readAuxServoFromNVS(ns, servoRegistry.auxServos[servoRegistry.auxCount]);
        servoRegistry.auxCount++;
      }
    }
    pref.end();
  }

  // ==================== Driving Profile NVS Helpers ====================

  static String getDrivingProfileNs(int idx) {
    return String("drv_p") + String(idx);
  }

  void writeDrivingProfileToNVS(int idx, const DrivingProfile& p) {
    String ns = getDrivingProfileNs(idx);
    Preferences pref;
    if (!pref.begin(ns.c_str(), false)) {
      Serial.printf("NVS open failed for profile namespace: %s\n", ns.c_str());
      return;
    }
    pref.putString("name", p.name);
    pref.putInt("srv_fl_trim", p.srvFlTrim);  pref.putInt("srv_fl_min", p.srvFlMin);
    pref.putInt("srv_fl_max",  p.srvFlMax);   pref.putInt("srv_fl_rht", p.srvFlRht);
    pref.putUChar("srv_fl_rev", p.srvFlRev);
    pref.putInt("srv_fr_trim", p.srvFrTrim);  pref.putInt("srv_fr_min", p.srvFrMin);
    pref.putInt("srv_fr_max",  p.srvFrMax);   pref.putInt("srv_fr_rht", p.srvFrRht);
    pref.putUChar("srv_fr_rev", p.srvFrRev);
    pref.putInt("srv_rl_trim", p.srvRlTrim);  pref.putInt("srv_rl_min", p.srvRlMin);
    pref.putInt("srv_rl_max",  p.srvRlMax);   pref.putInt("srv_rl_rht", p.srvRlRht);
    pref.putUChar("srv_rl_rev", p.srvRlRev);
    pref.putInt("srv_rr_trim", p.srvRrTrim);  pref.putInt("srv_rr_min", p.srvRrMin);
    pref.putInt("srv_rr_max",  p.srvRrMax);   pref.putInt("srv_rr_rht", p.srvRrRht);
    pref.putUChar("srv_rr_rev", p.srvRrRev);
    pref.putInt("damping",    p.damping);
    pref.putInt("stiffness",  p.stiffness);
    pref.putInt("react_spd",  p.reactSpd);
    pref.putInt("fr_balance", p.frBalance);
    pref.putInt("imu_orient", p.imuOrient);
    pref.end();
  }

  bool readDrivingProfileFromNVS(int idx, DrivingProfile& p) {
    p = {};
    String ns = getDrivingProfileNs(idx);
    Preferences pref;
    if (!pref.begin(ns.c_str(), true)) return false;
    if (!pref.isKey("name")) { pref.end(); return false; }

    String name = pref.getString("name", "");
    strncpy(p.name, name.c_str(), sizeof(p.name) - 1);
    p.name[sizeof(p.name) - 1] = '\0';

    p.srvFlTrim = pref.getInt("srv_fl_trim", DEFAULT_SERVO_TRIM_US);
    p.srvFlMin  = pref.getInt("srv_fl_min",  DEFAULT_SERVO_MIN_US);
    p.srvFlMax  = pref.getInt("srv_fl_max",  DEFAULT_SERVO_MAX_US);
    p.srvFlRht  = pref.getInt("srv_fl_rht",  DEFAULT_SERVO_RIDE_HT);
    p.srvFlRev  = pref.getUChar("srv_fl_rev", DEFAULT_SERVO_REVERSE);
    p.srvFrTrim = pref.getInt("srv_fr_trim", DEFAULT_SERVO_TRIM_US);
    p.srvFrMin  = pref.getInt("srv_fr_min",  DEFAULT_SERVO_MIN_US);
    p.srvFrMax  = pref.getInt("srv_fr_max",  DEFAULT_SERVO_MAX_US);
    p.srvFrRht  = pref.getInt("srv_fr_rht",  DEFAULT_SERVO_RIDE_HT);
    p.srvFrRev  = pref.getUChar("srv_fr_rev", DEFAULT_SERVO_REVERSE);
    p.srvRlTrim = pref.getInt("srv_rl_trim", DEFAULT_SERVO_TRIM_US);
    p.srvRlMin  = pref.getInt("srv_rl_min",  DEFAULT_SERVO_MIN_US);
    p.srvRlMax  = pref.getInt("srv_rl_max",  DEFAULT_SERVO_MAX_US);
    p.srvRlRht  = pref.getInt("srv_rl_rht",  DEFAULT_SERVO_RIDE_HT);
    p.srvRlRev  = pref.getUChar("srv_rl_rev", DEFAULT_SERVO_REVERSE);
    p.srvRrTrim = pref.getInt("srv_rr_trim", DEFAULT_SERVO_TRIM_US);
    p.srvRrMin  = pref.getInt("srv_rr_min",  DEFAULT_SERVO_MIN_US);
    p.srvRrMax  = pref.getInt("srv_rr_max",  DEFAULT_SERVO_MAX_US);
    p.srvRrRht  = pref.getInt("srv_rr_rht",  DEFAULT_SERVO_RIDE_HT);
    p.srvRrRev  = pref.getUChar("srv_rr_rev", DEFAULT_SERVO_REVERSE);
    p.damping   = pref.getInt("damping",    DEFAULT_SUSP_DAMPING);
    p.stiffness = pref.getInt("stiffness",  DEFAULT_SUSP_STIFFNESS);
    p.reactSpd  = pref.getInt("react_spd",  DEFAULT_SUSP_REACT_SPD);
    p.frBalance = pref.getInt("fr_balance", DEFAULT_SUSP_FR_BALANCE);
    p.imuOrient = pref.getInt("imu_orient", DEFAULT_IMU_ORIENT);
    pref.end();
    p.populated = true;
    return true;
  }

  void loadAllDrivingProfiles() {
    for (int i = 0; i < MAX_DRIVING_PROFILES; i++) {
      readDrivingProfileFromNVS(i, drivingProfiles[i]);
    }
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

public:
  void init() {
    ledConfig.color = DEFAULT_LED_COLOR;
    initLightsDefaults();
    loadStateDefaults();

    // Partition table uses label "littlefs". Mount that explicitly first.
    littleFsReady = LittleFS.begin(true, "/littlefs", 10, "littlefs");
    if (!littleFsReady) {
      // Backward-compatible fallback for legacy/default partition label.
      littleFsReady = LittleFS.begin(true);
    }
    Serial.println(littleFsReady ? "LittleFS initialized" : "LittleFS mount failed");

    if (!hasSystemFirmwareVersion()) {
      Serial.println("First boot detected. Writing default config to NVS...");
      saveAll();
      // Create default driving profile in slot 0
      saveDrivingProfile(0, DEFAULT_DRIVING_PROFILE_NAME);
    }

    loadAll();
    loadAllDrivingProfiles();
    loadServoRegistry();
  }

  void loadConfig() {
    loadAll();
  }

  void loadAll() {
    readServoNamespace(NS_SERVO_FL, state.servoFL, DEFAULT_SERVO_LABEL_FL);
    readServoNamespace(NS_SERVO_FR, state.servoFR, DEFAULT_SERVO_LABEL_FR);
    readServoNamespace(NS_SERVO_RL, state.servoRL, DEFAULT_SERVO_LABEL_RL);
    readServoNamespace(NS_SERVO_RR, state.servoRR, DEFAULT_SERVO_LABEL_RR);
    readSuspensionNamespace();
    readImuNamespace();
    readSystemNamespace();

    syncLegacyFromState();
  }

  void saveAll() {
    writeServoNamespace(NS_SERVO_FL, state.servoFL);
    writeServoNamespace(NS_SERVO_FR, state.servoFR);
    writeServoNamespace(NS_SERVO_RL, state.servoRL);
    writeServoNamespace(NS_SERVO_RR, state.servoRR);
    writeSuspensionNamespace();
    writeImuNamespace();
    writeSystemNamespace();

    Serial.println("NVS save complete");
  }

  bool setValue(const String& dottedKey, JsonVariantConst value) {
    int dotIndex = dottedKey.indexOf('.');
    if (dotIndex <= 0 || dotIndex >= static_cast<int>(dottedKey.length()) - 1) {
      return false;
    }

    const String ns = dottedKey.substring(0, dotIndex);
    const String key = dottedKey.substring(dotIndex + 1);

    RCDCCServoState* servo = resolveServoNamespace(ns);
    if (servo) {
      if (key == "label") {
        String s = value.as<String>();
        if (s.length() > 20) s = s.substring(0, 20);
        strncpy(servo->label, s.c_str(), sizeof(servo->label) - 1);
        servo->label[sizeof(servo->label) - 1] = '\0';
      } else if (key == "type") {
        String s = value.as<String>();
        if (s.length() > 15) s = s.substring(0, 15);
        strncpy(servo->type, s.c_str(), sizeof(servo->type) - 1);
        servo->type[sizeof(servo->type) - 1] = '\0';
      } else if (key == "enabled") {
        servo->enabled = value.as<int>() ? 1 : 0;
      } else if (key == "trim") {
        servo->trimUs = clampI32(value.as<int32_t>(), 900, 2100);
      } else if (key == "min") {
        servo->minUs = clampI32(value.as<int32_t>(), 900, 2100);
        if (servo->maxUs <= servo->minUs) servo->maxUs = servo->minUs + 1;
      } else if (key == "max") {
        servo->maxUs = clampI32(value.as<int32_t>(), 901, 2100);
        if (servo->maxUs <= servo->minUs) servo->minUs = servo->maxUs - 1;
      } else if (key == "reverse") {
        servo->reverse = value.as<int>() ? 1 : 0;
      } else if (key == "ride_ht") {
        servo->rideHeight = clampI32(value.as<int32_t>(), 0, 100);
      } else {
        return false;
      }

      syncLegacyFromState();
      return true;
    }

    if (ns == NS_SUSP) {
      if (key == "damping") state.suspension.damping = clampI32(value.as<int32_t>(), 0, 100);
      else if (key == "stiffness") state.suspension.stiffness = clampI32(value.as<int32_t>(), 0, 100);
      else if (key == "react_spd") state.suspension.reactSpeed = clampI32(value.as<int32_t>(), 0, 100);
      else if (key == "fr_balance") state.suspension.frontRearBalance = clampI32(value.as<int32_t>(), -100, 100);
      else return false;

      syncLegacyFromState();
      return true;
    }

    if (ns == NS_IMU) {
      if (key == "orient") state.imu.orient = clampI32(value.as<int32_t>(), 0, 3);
      else if (key == "roll_trim") state.imu.rollTrim = value.as<float>();
      else if (key == "pitch_trim") state.imu.pitchTrim = value.as<float>();
      else return false;

      syncLegacyFromState();
      return true;
    }

    if (ns == NS_SYSTEM) {
      if (key == "device_nm") {
        String s = value.as<String>();
        if (s.length() > 63) s = s.substring(0, 63);
        strncpy(state.system.deviceName, s.c_str(), sizeof(state.system.deviceName) - 1);
        state.system.deviceName[sizeof(state.system.deviceName) - 1] = '\0';
      } else if (key == "act_drv_prof") {
        state.system.activeDrivingProfile = value.as<int32_t>();
      } else if (key == "act_lt_prof") {
        state.system.activeLightingProfile = value.as<int32_t>();
      } else if (key == "fw_version") {
        String s = value.as<String>();
        if (s.length() > 15) s = s.substring(0, 15);
        strncpy(state.system.firmwareVersion, s.c_str(), sizeof(state.system.firmwareVersion) - 1);
        state.system.firmwareVersion[sizeof(state.system.firmwareVersion) - 1] = '\0';
      } else {
        return false;
      }

      syncLegacyFromState();
      return true;
    }

    // ==================== Aux Servo KV Handler (Phase 4) ====================
    if (ns.startsWith("srv_aux_")) {
      AuxServoConfig* aux = findAuxServo(ns);
      if (!aux) return false;

      if (key == "label") {
        String s = value.as<String>();
        if (s.length() > 20) s = s.substring(0, 20);
        strncpy(aux->label, s.c_str(), sizeof(aux->label) - 1);
        aux->label[sizeof(aux->label) - 1] = '\0';
      } else if (key == "type") {
        String newType = value.as<String>();
        if (newType.length() > 15) newType = newType.substring(0, 15);
        if (String(aux->type) != newType) {
          Serial.printf("[AuxServo] Type change: %s -> %s on %s\n",
                        aux->type, newType.c_str(), ns.c_str());
          clearAuxTypeSpecificKeys(ns, aux->type, newType.c_str());
          strncpy(aux->type, newType.c_str(), sizeof(aux->type) - 1);
          aux->type[sizeof(aux->type) - 1] = '\0';
          writeAuxTypeDefaults(ns, newType);
          // Re-sync RAM struct with the fresh NVS defaults
          readAuxServoFromNVS(ns, *aux);
          // Write the updated type key (readAuxServoFromNVS already synced type)
          Preferences pref2;
          if (pref2.begin(ns.c_str(), false)) {
            pref2.putString("type", aux->type);
            pref2.end();
          }
        }
        return true;
      } else if (key == "enabled") {
        aux->enabled = value.as<int>() ? 1 : 0;
      } else if (key == "trim") {
        aux->trimUs = clampI32(value.as<int32_t>(), 900, 2100);
      } else if (key == "min") {
        aux->minUs  = clampI32(value.as<int32_t>(), 900, 2100);
      } else if (key == "max") {
        aux->maxUs  = clampI32(value.as<int32_t>(), 901, 2100);
      } else if (key == "reverse") {
        aux->reverse = value.as<int>() ? 1 : 0;
      } else if (key == "ride_ht") {
        aux->rideHeight = clampI32(value.as<int32_t>(), 0, 100);
      } else if (key == "spd_fwd") {
        aux->spdFwd = clampI32(value.as<int32_t>(), 0, 100);
      } else if (key == "spd_rev") {
        aux->spdRev = clampI32(value.as<int32_t>(), 0, 100);
      } else if (key == "spd") {
        aux->spd = clampI32(value.as<int32_t>(), 0, 100);
      } else if (key == "state") {
        aux->state = value.as<int>() ? 1 : 0;
      } else if (key == "momentary") {
        aux->momentary = value.as<int>() ? 1 : 0;
      } else {
        return false;
      }

      // Persist the single updated key to NVS
      Preferences pref;
      if (pref.begin(ns.c_str(), false)) {
        if      (key == "label")    pref.putString("label",    aux->label);
        else if (key == "enabled")  pref.putUChar("enabled",   aux->enabled);
        else if (key == "trim")     pref.putInt("trim",        aux->trimUs);
        else if (key == "min")      pref.putInt("min",         aux->minUs);
        else if (key == "max")      pref.putInt("max",         aux->maxUs);
        else if (key == "reverse")  pref.putUChar("reverse",   aux->reverse);
        else if (key == "ride_ht")  pref.putInt("ride_ht",     aux->rideHeight);
        else if (key == "spd_fwd")  pref.putInt("spd_fwd",     aux->spdFwd);
        else if (key == "spd_rev")  pref.putInt("spd_rev",     aux->spdRev);
        else if (key == "spd")      pref.putInt("spd",         aux->spd);
        else if (key == "state")    pref.putUChar("state",     aux->state);
        else if (key == "momentary") pref.putUChar("momentary", aux->momentary);
        pref.end();
      }
      return true;
    }

    return false;
  }

  const RCDCCConfigState& getCurrentState() const {
    return state;
  }

  SuspensionConfig getConfig() const {
    return legacyConfig;
  }

  ServoConfig getServoConfig() const {
    return legacyServoConfig;
  }

  const char* getDeviceName() const {
    if (state.system.deviceName[0] == '\0') {
      return DEFAULT_DEVICE_NAME;
    }
    return state.system.deviceName;
  }

  void updateDeviceName(const String& newName) {
    DynamicJsonDocument doc(96);
    doc["v"] = newName;
    setValue("system.device_nm", doc["v"].as<JsonVariantConst>());
  }

  void updateParameter(const String& key, float value) {
    DynamicJsonDocument doc(64);
    if (key == "reactionSpeed") {
      doc["v"] = static_cast<int32_t>(roundf(value * 50.0f));
      setValue("suspension.react_spd", doc["v"].as<JsonVariantConst>());
    } else if (key == "rideHeightOffset") {
      const int32_t rideHeight = clampI32(static_cast<int32_t>(roundf(value)), 0, 100);
      doc["v"] = rideHeight;
      setValue("srv_fl.ride_ht", doc["v"].as<JsonVariantConst>());
      setValue("srv_fr.ride_ht", doc["v"].as<JsonVariantConst>());
      setValue("srv_rl.ride_ht", doc["v"].as<JsonVariantConst>());
      setValue("srv_rr.ride_ht", doc["v"].as<JsonVariantConst>());
    } else if (key == "rangeLimit") {
      legacyConfig.rangeLimit = constrain(value, 0.0f, 180.0f);
    } else if (key == "damping") {
      doc["v"] = static_cast<int32_t>(roundf(value * 100.0f));
      setValue("suspension.damping", doc["v"].as<JsonVariantConst>());
    } else if (key == "stiffness") {
      doc["v"] = static_cast<int32_t>(roundf(value * 50.0f));
      setValue("suspension.stiffness", doc["v"].as<JsonVariantConst>());
    } else if (key == "frontRearBalance") {
      doc["v"] = static_cast<int32_t>(roundf((value * 200.0f) - 100.0f));
      setValue("suspension.fr_balance", doc["v"].as<JsonVariantConst>());
    } else if (key == "sampleRate") {
      legacyConfig.sampleRate = static_cast<uint16_t>(clampI32(static_cast<int32_t>(roundf(value)), 1, 200));
    } else if (key == "telemetryRate") {
      legacyConfig.telemetryRate = static_cast<uint8_t>(clampI32(static_cast<int32_t>(roundf(value)), 1, 10));
    } else if (key == "fpvAutoMode") {
      legacyConfig.fpvAutoMode = value > 0.5f;
    } else if (key == "mpuOrientation") {
      doc["v"] = static_cast<int32_t>(value);
      setValue("imu.orient", doc["v"].as<JsonVariantConst>());
    }
  }

  void updateServoParameter(const String& servo, const String& param, int value) {
    String ns;
    if (servo == "frontLeft") ns = "srv_fl";
    else if (servo == "frontRight") ns = "srv_fr";
    else if (servo == "rearLeft") ns = "srv_rl";
    else if (servo == "rearRight") ns = "srv_rr";
    else return;

    String key;
    if (param == "trim") key = "trim";
    else if (param == "min") key = "min";
    else if (param == "max") key = "max";
    else if (param == "reversed") key = "reverse";
    else return;

    DynamicJsonDocument doc(64);
    doc["v"] = value;
    setValue(ns + "." + key, doc["v"].as<JsonVariantConst>());
  }

  void resetToDefaults() {
    loadStateDefaults();
    saveAll();
    Serial.println("Config reset to defaults");
  }

  String getConfigJSON(bool includeActiveLightingProfile = true) {
    DynamicJsonDocument doc(includeActiveLightingProfile ? 10240 : 3072);

    auto writeServo = [&](const char* name, const RCDCCServoState& servo) {
      JsonObject s = doc.createNestedObject(name);
      if (includeActiveLightingProfile) {
        s["label"] = servo.label;
        s["type"] = servo.type;
        s["enabled"] = servo.enabled;
      }
      s["trim"] = servo.trimUs;
      s["min"] = servo.minUs;
      s["max"] = servo.maxUs;
      s["reverse"] = servo.reverse;
      s["ride_ht"] = servo.rideHeight;
    };

    writeServo("srv_fl", state.servoFL);
    writeServo("srv_fr", state.servoFR);
    writeServo("srv_rl", state.servoRL);
    writeServo("srv_rr", state.servoRR);

    JsonObject susp = doc.createNestedObject("suspension");
    susp["damping"] = state.suspension.damping;
    susp["stiffness"] = state.suspension.stiffness;
    susp["react_spd"] = state.suspension.reactSpeed;
    susp["fr_balance"] = state.suspension.frontRearBalance;

    JsonObject imu = doc.createNestedObject("imu");
    imu["orient"] = state.imu.orient;
    imu["roll_trim"] = state.imu.rollTrim;
    imu["pitch_trim"] = state.imu.pitchTrim;

    JsonObject system = doc.createNestedObject("system");
    system["device_nm"] = state.system.deviceName;
    system["fw_version"] = state.system.firmwareVersion;
    system["act_drv_prof"] = state.system.activeDrivingProfile;
    system["act_lt_prof"] = state.system.activeLightingProfile;

    doc["fw_version"] = state.system.firmwareVersion;

    // BLE config reads use this compact shape to stay within characteristic size limits.
    if (!includeActiveLightingProfile) {
      String compactOutput;
      serializeJson(doc, compactOutput);
      return compactOutput;
    }

    doc["reactionSpeed"] = legacyConfig.reactionSpeed;
    doc["rideHeightOffset"] = legacyConfig.rideHeightOffset;
    doc["rangeLimit"] = legacyConfig.rangeLimit;
    doc["damping"] = legacyConfig.damping;
    doc["frontRearBalance"] = legacyConfig.frontRearBalance;
    doc["stiffness"] = legacyConfig.stiffness;
    doc["sampleRate"] = legacyConfig.sampleRate;
    doc["telemetryRate"] = legacyConfig.telemetryRate;
    doc["mpuOrientation"] = legacyConfig.mpuOrientation;
    doc["deviceName"] = legacyConfig.deviceName;

    JsonObject servos = doc.createNestedObject("servos");
    auto writeLegacyServo = [&](const char* key, const ServoCalibration& cal) {
      JsonObject node = servos.createNestedObject(key);
      node["trim"] = cal.trim;
      node["min"] = cal.minLimit;
      node["max"] = cal.maxLimit;
      node["reversed"] = cal.reversed;
    };

    writeLegacyServo("frontLeft", legacyServoConfig.frontLeft);
    writeLegacyServo("frontRight", legacyServoConfig.frontRight);
    writeLegacyServo("rearLeft", legacyServoConfig.rearLeft);
    writeLegacyServo("rearRight", legacyServoConfig.rearRight);

    // Driving profiles (Phase 3)
    int profileCount = 0;
    JsonArray profilesArr = doc.createNestedArray("drv_profiles");
    for (int i = 0; i < MAX_DRIVING_PROFILES; i++) {
      if (drivingProfiles[i].populated) {
        JsonObject pe = profilesArr.createNestedObject();
        pe["index"] = i;
        pe["name"]  = drivingProfiles[i].name;
        profileCount++;
      }
    }
    doc["drv_profile_count"] = profileCount;
    doc["act_drv_prof"] = state.system.activeDrivingProfile;

    // Servo registry (Phase 4)
    {
      JsonObject srReg = doc.createNestedObject("servo_registry");
      srReg["count"]     = 4 + servoRegistry.auxCount;
      srReg["aux_count"] = servoRegistry.auxCount;
      JsonArray auxArr = srReg.createNestedArray("aux_servos");
      for (int i = 0; i < servoRegistry.auxCount; i++) {
        const AuxServoConfig& aux = servoRegistry.auxServos[i];
        if (!aux.populated) continue;
        JsonObject entry = auxArr.createNestedObject();
        entry["ns"]      = aux.ns;
        entry["label"]   = aux.label;
        entry["type"]    = aux.type;
        entry["enabled"] = aux.enabled;
        String t = aux.type;
        if (t == AUX_TYPE_POSITIONAL || t == AUX_TYPE_PAN) {
          entry["trim"]    = aux.trimUs;
          entry["min"]     = aux.minUs;
          entry["max"]     = aux.maxUs;
          entry["reverse"] = aux.reverse;
        }
        if (t == AUX_TYPE_POSITIONAL) entry["ride_ht"]  = aux.rideHeight;
        if (t == AUX_TYPE_CONTINUOUS) {
          entry["spd_fwd"] = aux.spdFwd;
          entry["spd_rev"] = aux.spdRev;
          entry["reverse"] = aux.reverse;
        }
        if (t == AUX_TYPE_PAN)   entry["spd"]      = aux.spd;
        if (t == AUX_TYPE_RELAY) {
          entry["state"]    = aux.state;
          entry["momentary"] = aux.momentary;
        }
      }
    }

    // Phase 5: Lighting profiles
    {
      JsonArray ltProfArr = doc.createNestedArray("lt_profiles");
      getLightingProfileNames(ltProfArr);
      doc["lt_profile_count"] = ltProfArr.size();

      int activeLtProf = 0;
      Preferences pref;
      if (pref.begin("system", false)) {
        activeLtProf = pref.getInt("act_lt_prof", 0);
        doc["act_lt_prof"] = activeLtProf;
        pref.end();
      } else {
        doc["act_lt_prof"] = 0;
      }

      // Include full active profile JSON only when requested.
      // Keeping this out of BLE characteristic reads avoids large callback payloads.
      if (includeActiveLightingProfile) {
        LightingProfile activeProfile = {};
        if (loadLightingProfile(activeLtProf, activeProfile)) {
          JsonObject ap = doc.createNestedObject("active_lt_profile");
          ap["index"] = activeLtProf;
          ap["name"] = activeProfile.name;
          ap["master"] = activeProfile.master;
          ap["total_leds"] = activeProfile.totalLeds;
          JsonArray groups = ap.createNestedArray("groups");
          for (uint8_t i = 0; i < activeProfile.groupCount; i++) {
            const LightingGroup& g = activeProfile.groups[i];
            JsonObject go = groups.createNestedObject();
            go["id"] = g.id;
            go["name"] = g.name;
            go["enabled"] = g.enabled;
            go["effect"] = g.effect;
            go["color_primary"] = g.colorPrimary;
            go["color_secondary"] = g.colorSecondary;
            go["brightness"] = g.brightness;
            go["effect_speed"] = g.effectSpeed;
            go["effect_intensity"] = g.effectIntensity;
            JsonArray leds = go.createNestedArray("leds");
            for (uint16_t j = 0; j < g.ledCount; j++) leds.add(g.leds[j]);
          }
        }
      }
    }

    String output;
    serializeJson(doc, output);
    return output;
  }

  String getScopedConfigJSON(const String& rawScope) {
    String scope = rawScope;
    scope.toLowerCase();

    if (scope == "bootstrap") {
      DynamicJsonDocument doc(768);
      doc["fw_version"] = state.system.firmwareVersion;
      doc["device_nm"] = state.system.deviceName;
      doc["config_owner"] = "app";
      doc["executor_mode"] = "kv_only";
      doc["mac_wifi_sta"] = readInterfaceMac(ESP_MAC_WIFI_STA);
      doc["mac_softap"] = readInterfaceMac(ESP_MAC_WIFI_SOFTAP);
      doc["mac_ble"] = readInterfaceMac(ESP_MAC_BT);
      String out;
      serializeJson(doc, out);
      return out;
    }

    if (scope == "tuning") {
      DynamicJsonDocument doc(512);
      doc["scope"] = "tuning";
      doc["fw_version"] = state.system.firmwareVersion;
      doc["config_owner"] = "app";
      doc["executor_mode"] = "kv_only";
      doc["servo_count"] = 4 + servoRegistry.auxCount;

      String out;
      serializeJson(doc, out);
      return out;
    }

    // Lights scope: return minimal empty config (no filesystem ops)
    if (scope == "lights") {
      DynamicJsonDocument doc(512);
      doc["lt_profile_count"] = 0;
      doc["act_lt_prof"] = 0;
      JsonArray ltProfArr = doc.createNestedArray("lt_profiles");
      // Empty profiles array - no file I/O
      
      String out;
      serializeJson(doc, out);
      return out;
    }

    if (scope == "settings") {
      DynamicJsonDocument doc(4096);
      doc["fw_version"] = state.system.firmwareVersion;
      doc["deviceName"] = legacyConfig.deviceName;

      JsonObject system = doc.createNestedObject("system");
      system["device_nm"] = state.system.deviceName;
      system["fw_version"] = state.system.firmwareVersion;
      system["config_owner"] = "app";
      system["executor_mode"] = "kv_only";

      JsonObject srReg = doc.createNestedObject("servo_registry");
      srReg["count"] = 4 + servoRegistry.auxCount;
      srReg["aux_count"] = servoRegistry.auxCount;
      JsonArray auxArr = srReg.createNestedArray("aux_servos");
      for (int i = 0; i < servoRegistry.auxCount; i++) {
        const AuxServoConfig& aux = servoRegistry.auxServos[i];
        if (!aux.populated) continue;
        JsonObject entry = auxArr.createNestedObject();
        entry["ns"] = aux.ns;
        entry["label"] = aux.label;
        entry["type"] = aux.type;
        entry["enabled"] = aux.enabled;
      }

      String out;
      serializeJson(doc, out);
      return out;
    }

    return getScopedConfigJSON(String("bootstrap"));
  }

  void saveConfigFromJSON(const String& jsonStr) {
    DynamicJsonDocument doc(2048);
    DeserializationError error = deserializeJson(doc, jsonStr);
    if (error) {
      Serial.print("Failed to parse config JSON: ");
      Serial.println(error.c_str());
      return;
    }

    if (doc.containsKey("deviceName")) {
      DynamicJsonDocument valueDoc(96);
      valueDoc["v"] = doc["deviceName"].as<String>();
      setValue("system.device_nm", valueDoc["v"].as<JsonVariantConst>());
    }

    if (doc.containsKey("reactionSpeed")) {
      DynamicJsonDocument valueDoc(32);
      valueDoc["v"] = static_cast<int32_t>(roundf(doc["reactionSpeed"].as<float>() * 50.0f));
      setValue("suspension.react_spd", valueDoc["v"].as<JsonVariantConst>());
    }

    if (doc.containsKey("damping")) {
      DynamicJsonDocument valueDoc(32);
      valueDoc["v"] = static_cast<int32_t>(roundf(doc["damping"].as<float>() * 100.0f));
      setValue("suspension.damping", valueDoc["v"].as<JsonVariantConst>());
    }

    if (doc.containsKey("stiffness")) {
      DynamicJsonDocument valueDoc(32);
      valueDoc["v"] = static_cast<int32_t>(roundf(doc["stiffness"].as<float>() * 50.0f));
      setValue("suspension.stiffness", valueDoc["v"].as<JsonVariantConst>());
    }

    if (doc.containsKey("frontRearBalance")) {
      DynamicJsonDocument valueDoc(32);
      valueDoc["v"] = static_cast<int32_t>(roundf((doc["frontRearBalance"].as<float>() * 200.0f) - 100.0f));
      setValue("suspension.fr_balance", valueDoc["v"].as<JsonVariantConst>());
    }

    if (doc.containsKey("mpuOrientation")) {
      DynamicJsonDocument valueDoc(32);
      valueDoc["v"] = doc["mpuOrientation"].as<int32_t>();
      setValue("imu.orient", valueDoc["v"].as<JsonVariantConst>());
    }

    if (doc.containsKey("servos")) {
      JsonObject servos = doc["servos"];
      struct ServoMap {
        const char* legacyName;
        const char* ns;
      } maps[4] = {
        {"frontLeft", "srv_fl"},
        {"frontRight", "srv_fr"},
        {"rearLeft", "srv_rl"},
        {"rearRight", "srv_rr"}
      };

      for (const auto& map : maps) {
        if (!servos.containsKey(map.legacyName)) continue;
        JsonObject node = servos[map.legacyName];

        if (node.containsKey("trim")) {
          DynamicJsonDocument valueDoc(32);
          const int32_t trimDegrees = node["trim"].as<int32_t>();
          valueDoc["v"] = DEFAULT_SERVO_TRIM_US + static_cast<int32_t>(roundf(trimDegrees * (1000.0f / 180.0f)));
          setValue(String(map.ns) + ".trim", valueDoc["v"].as<JsonVariantConst>());
        }

        if (node.containsKey("min")) {
          DynamicJsonDocument valueDoc(32);
          const int32_t minDeg = clampI32(node["min"].as<int32_t>(), 0, 180);
          valueDoc["v"] = DEFAULT_SERVO_MIN_US + static_cast<int32_t>(roundf(minDeg * (1000.0f / 180.0f)));
          setValue(String(map.ns) + ".min", valueDoc["v"].as<JsonVariantConst>());
        }

        if (node.containsKey("max")) {
          DynamicJsonDocument valueDoc(32);
          const int32_t maxDeg = clampI32(node["max"].as<int32_t>(), 0, 180);
          valueDoc["v"] = DEFAULT_SERVO_MIN_US + static_cast<int32_t>(roundf(maxDeg * (1000.0f / 180.0f)));
          setValue(String(map.ns) + ".max", valueDoc["v"].as<JsonVariantConst>());
        }

        if (node.containsKey("reversed")) {
          DynamicJsonDocument valueDoc(16);
          valueDoc["v"] = node["reversed"].as<int32_t>();
          setValue(String(map.ns) + ".reverse", valueDoc["v"].as<JsonVariantConst>());
        }
      }
    }
  }

  bool consumeServoTrimResetWarning() {
    bool warning = servoTrimResetWarning;
    servoTrimResetWarning = false;
    return warning;
  }

  // ==================== Driving Profile Public API (Phase 3) ====================

  int getDrivingProfileCount() const {
    int count = 0;
    for (int i = 0; i < MAX_DRIVING_PROFILES; i++) {
      if (drivingProfiles[i].populated) count++;
    }
    return count;
  }

  const DrivingProfile* getDrivingProfiles() const { return drivingProfiles; }

  // Load a profile from NVS into RAM state and apply immediately.
  bool loadDrivingProfile(int idx) {
    if (idx < 0 || idx >= MAX_DRIVING_PROFILES) return false;
    if (!drivingProfiles[idx].populated) return false;

    const DrivingProfile& p = drivingProfiles[idx];

    state.servoFL.trimUs    = clampI32(p.srvFlTrim, 900, 2100);
    state.servoFL.minUs     = clampI32(p.srvFlMin,  900, 2100);
    state.servoFL.maxUs     = clampI32(p.srvFlMax,  900, 2100);
    state.servoFL.rideHeight = clampI32(p.srvFlRht, 0, 100);
    state.servoFL.reverse   = p.srvFlRev ? 1 : 0;

    state.servoFR.trimUs    = clampI32(p.srvFrTrim, 900, 2100);
    state.servoFR.minUs     = clampI32(p.srvFrMin,  900, 2100);
    state.servoFR.maxUs     = clampI32(p.srvFrMax,  900, 2100);
    state.servoFR.rideHeight = clampI32(p.srvFrRht, 0, 100);
    state.servoFR.reverse   = p.srvFrRev ? 1 : 0;

    state.servoRL.trimUs    = clampI32(p.srvRlTrim, 900, 2100);
    state.servoRL.minUs     = clampI32(p.srvRlMin,  900, 2100);
    state.servoRL.maxUs     = clampI32(p.srvRlMax,  900, 2100);
    state.servoRL.rideHeight = clampI32(p.srvRlRht, 0, 100);
    state.servoRL.reverse   = p.srvRlRev ? 1 : 0;

    state.servoRR.trimUs    = clampI32(p.srvRrTrim, 900, 2100);
    state.servoRR.minUs     = clampI32(p.srvRrMin,  900, 2100);
    state.servoRR.maxUs     = clampI32(p.srvRrMax,  900, 2100);
    state.servoRR.rideHeight = clampI32(p.srvRrRht, 0, 100);
    state.servoRR.reverse   = p.srvRrRev ? 1 : 0;

    state.suspension.damping   = clampI32(p.damping,   0, 100);
    state.suspension.stiffness = clampI32(p.stiffness, 0, 100);
    state.suspension.reactSpeed = clampI32(p.reactSpd, 0, 100);
    state.suspension.frontRearBalance = clampI32(p.frBalance, -100, 100);

    state.imu.orient = clampI32(p.imuOrient, 0, 5);
    state.system.activeDrivingProfile = idx;

    syncLegacyFromState();
    return true;
  }

  // Snapshot current RAM state and write it to a named profile slot in NVS.
  void saveDrivingProfile(int idx, const String& name) {
    if (idx < 0 || idx >= MAX_DRIVING_PROFILES) return;

    DrivingProfile& p = drivingProfiles[idx];
    p.populated = true;
    strncpy(p.name, name.c_str(), sizeof(p.name) - 1);
    p.name[sizeof(p.name) - 1] = '\0';

    p.srvFlTrim = state.servoFL.trimUs;   p.srvFlMin = state.servoFL.minUs;
    p.srvFlMax  = state.servoFL.maxUs;    p.srvFlRht = state.servoFL.rideHeight;
    p.srvFlRev  = state.servoFL.reverse;
    p.srvFrTrim = state.servoFR.trimUs;   p.srvFrMin = state.servoFR.minUs;
    p.srvFrMax  = state.servoFR.maxUs;    p.srvFrRht = state.servoFR.rideHeight;
    p.srvFrRev  = state.servoFR.reverse;
    p.srvRlTrim = state.servoRL.trimUs;   p.srvRlMin = state.servoRL.minUs;
    p.srvRlMax  = state.servoRL.maxUs;    p.srvRlRht = state.servoRL.rideHeight;
    p.srvRlRev  = state.servoRL.reverse;
    p.srvRrTrim = state.servoRR.trimUs;   p.srvRrMin = state.servoRR.minUs;
    p.srvRrMax  = state.servoRR.maxUs;    p.srvRrRht = state.servoRR.rideHeight;
    p.srvRrRev  = state.servoRR.reverse;
    p.damping   = state.suspension.damping;
    p.stiffness = state.suspension.stiffness;
    p.reactSpd  = state.suspension.reactSpeed;
    p.frBalance = state.suspension.frontRearBalance;
    p.imuOrient = state.imu.orient;

    writeDrivingProfileToNVS(idx, p);

    state.system.activeDrivingProfile = idx;
    writeSystemNamespace();
  }

  // Delete a profile slot. Returns false if it's the last populated slot.
  // outNewActive is set to the new active profile index (unchanged if del was not active).
  bool deleteDrivingProfile(int idx, int& outNewActive) {
    if (idx < 0 || idx >= MAX_DRIVING_PROFILES) return false;
    if (!drivingProfiles[idx].populated) return false;
    if (getDrivingProfileCount() <= 1) return false;

    // Erase from NVS
    {
      String ns = getDrivingProfileNs(idx);
      Preferences pref;
      if (pref.begin(ns.c_str(), false)) {
        pref.clear();
        pref.end();
      }
    }
    drivingProfiles[idx] = {};  // clear in-memory slot

    // If active profile was deleted, switch to lowest available slot
    if (state.system.activeDrivingProfile == idx) {
      for (int i = 0; i < MAX_DRIVING_PROFILES; i++) {
        if (drivingProfiles[i].populated) {
          state.system.activeDrivingProfile = i;
          writeSystemNamespace();
          break;
        }
      }
    }
    outNewActive = static_cast<int>(state.system.activeDrivingProfile);
    return true;
  }

  // ==================== Servo Registry Public API (Phase 4) ====================

  void loadServoRegistry() {
    servoRegistry = {};
    readRegistryFromNVS();
  }

  const ServoRegistry& getServoRegistry() const { return servoRegistry; }

  AuxServoConfig* findAuxServo(const String& ns) {
    for (int i = 0; i < servoRegistry.auxCount; i++) {
      if (String(servoRegistry.auxServos[i].ns) == ns) {
        return &servoRegistry.auxServos[i];
      }
    }
    return nullptr;
  }

  // Add a new aux servo. Returns false if MAX_AUX_SERVOS is already reached.
  // outNs receives the namespace string (e.g. "srv_aux_03").
  bool addAuxServo(const String& type, const String& label, String& outNs) {
    if (servoRegistry.auxCount >= MAX_AUX_SERVOS) return false;

    // Find first slot not currently in use
    int slot = -1;
    for (int s = 0; s < MAX_AUX_SERVOS; s++) {
      String candidate = getAuxNs(s);
      bool inUse = false;
      for (int i = 0; i < servoRegistry.auxCount; i++) {
        if (String(servoRegistry.auxServos[i].ns) == candidate) { inUse = true; break; }
      }
      if (!inUse) { slot = s; break; }
    }
    if (slot < 0) return false;

    String ns = getAuxNs(slot);
    outNs = ns;

    // Write common keys
    {
      Preferences pref;
      if (!pref.begin(ns.c_str(), false)) return false;
      String safeLabel = label;
      if (safeLabel.length() == 0) safeLabel = String("Aux ") + String(slot);
      if (safeLabel.length() > 20) safeLabel = safeLabel.substring(0, 20);
      pref.putString("label",  safeLabel);
      pref.putString("type",   type);
      pref.putUChar("enabled", DEFAULT_AUX_ENABLED);
      pref.end();
    }
    writeAuxTypeDefaults(ns, type);

    // Load into RAM registry
    readAuxServoFromNVS(ns, servoRegistry.auxServos[servoRegistry.auxCount]);
    servoRegistry.auxCount++;

    writeRegistryToNVS();
    return true;
  }

  // Remove an aux servo by namespace. Compacts the registry (no gaps).
  bool removeAuxServo(const String& ns) {
    int found = -1;
    for (int i = 0; i < servoRegistry.auxCount; i++) {
      if (String(servoRegistry.auxServos[i].ns) == ns) { found = i; break; }
    }
    if (found < 0) return false;

    // Erase NVS namespace
    {
      Preferences pref;
      if (pref.begin(ns.c_str(), false)) { pref.clear(); pref.end(); }
    }

    // Compact array (shift elements left)
    for (int i = found; i < servoRegistry.auxCount - 1; i++) {
      servoRegistry.auxServos[i] = servoRegistry.auxServos[i + 1];
    }
    servoRegistry.auxServos[servoRegistry.auxCount - 1] = {};
    servoRegistry.auxCount--;

    writeRegistryToNVS();
    return true;
  }

  // Set the runtime speed for a continuous servo (not persisted).
  void setAuxServoSpeed(const String& ns, int32_t speed) {
    AuxServoConfig* aux = findAuxServo(ns);
    if (aux) aux->currentSpeed = clampI32(speed, -100, 100);
  }

  // Zero all continuous servos (called by watchdog).
  void stopAllContinuousServos() {
    for (int i = 0; i < servoRegistry.auxCount; i++) {
      if (strcmp(servoRegistry.auxServos[i].type, AUX_TYPE_CONTINUOUS) == 0) {
        servoRegistry.auxServos[i].currentSpeed = 0;
      }
    }
  }

  LEDConfig getLEDConfig() const {    return ledConfig;
  }

  void setLEDColor(const String& colorName) {
    if (colorName == "red") ledConfig.color = LED_COLOR_RED;
    else if (colorName == "green") ledConfig.color = LED_COLOR_GREEN;
    else if (colorName == "blue") ledConfig.color = LED_COLOR_BLUE;
  }

  void loadLights() {
    if (!littleFsReady) {
      Serial.println("LittleFS unavailable, using default lights config");
      return;
    }

    if (!LittleFS.exists(LIGHTS_SPIFFS_PATH)) {
      Serial.println("Lights config file not found in LittleFS, using defaults");
      return;
    }

    File file = LittleFS.open(LIGHTS_SPIFFS_PATH, "r");
    if (!file) {
      Serial.println("Failed to open lights config file in LittleFS");
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

    newLightsConfig.legacy = lightsConfig;

    if (doc.containsKey("lightGroupsArray")) {
      JsonArray groupsArray = doc["lightGroupsArray"];
      newLightsConfig.useLegacyMode = false;
      newLightsConfig.groupCount = 0;

      for (JsonObject groupObj : groupsArray) {
        if (newLightsConfig.groupCount >= MAX_DYNAMIC_LIGHT_GROUPS) break;

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
            if (group.ledCount >= MAX_DYNAMIC_GROUP_LEDS) break;
            group.ledIndices[group.ledCount++] = idx;
          }
        }

        newLightsConfig.groupCount++;
      }
    }

    Serial.println("Lights config loaded from LittleFS");
  }

  void saveLights() {
    if (!littleFsReady) {
      Serial.println("LittleFS unavailable, skipping lights config save");
      return;
    }

    static DynamicJsonDocument doc(8192);
    doc.clear();

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

    JsonArray dynamicGroups = doc.createNestedArray("lightGroupsArray");
    for (uint8_t i = 0; i < newLightsConfig.groupCount && i < MAX_DYNAMIC_LIGHT_GROUPS; i++) {
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
      for (uint8_t led = 0; led < group.ledCount && led < MAX_DYNAMIC_GROUP_LEDS; led++) {
        idx.add(group.ledIndices[led]);
      }
    }

    File file = LittleFS.open(LIGHTS_SPIFFS_PATH, "w");
    if (!file) {
      Serial.println("Failed to create lights config file in LittleFS");
      return;
    }

    serializeJson(doc, file);
    file.close();

    Serial.println("Lights config saved to LittleFS");
  }

  LightsConfig getLightsConfig() const {
    return lightsConfig;
  }

  String getLightsConfigJSON() {
    static DynamicJsonDocument doc(8192);
    doc.clear();

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
    for (uint8_t i = 0; i < newLightsConfig.groupCount && i < MAX_DYNAMIC_LIGHT_GROUPS; i++) {
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
      for (uint8_t led = 0; led < group.ledCount && led < MAX_DYNAMIC_GROUP_LEDS; led++) {
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

  void setNewLightsConfig(const NewLightsConfig& config) {
    newLightsConfig = config;
    newLightsConfig.legacy = lightsConfig;
    saveLights();
  }

  NewLightsConfig* getNewLightsConfig() {
    return &newLightsConfig;
  }

  // ==================== Phase 5: Lighting Profile Management ====================
  // Lighting profiles are completely independent from driving profiles.
  // Profiles are stored as JSON files in LittleFS: lt_p0.json through lt_p9.json.
  // Only the active profile index (system.act_lt_prof) is stored in NVS.
  // LED indices are ZERO-BASED throughout.

private:
  // Helper: Convert hex color string (#RRGGBB) to 32-bit RGB
  uint32_t hexToRGB(const char* hexStr) {
    if (!hexStr || hexStr[0] != '#' || strlen(hexStr) < 7) return 0;
    uint32_t r = strtol(hexStr + 1, nullptr, 16) >> 16 & 0xFF;
    uint32_t g = (strtol(hexStr + 1, nullptr, 16) >> 8) & 0xFF;
    uint32_t b = strtol(hexStr + 1, nullptr, 16) & 0xFF;
    return (r << 16) | (g << 8) | b;
  }

  // Helper: Convert 32-bit RGB to hex string (#RRGGBB)
  String rgbToHex(uint32_t rgb) {
    char buf[8];
    snprintf(buf, sizeof(buf), "#%06X", rgb & 0xFFFFFF);
    return String(buf);
  }

  // Helper: Get LittleFS filename for profile index
  String getLightingProfilePath(int index) {
    char buf[32];
    snprintf(buf, sizeof(buf), "/lt_p%d.json", index);
    return String(buf);
  }

  int getActiveLightingProfileIndex() {
    int activeLtProf = state.system.activeLightingProfile;
    Preferences pref;
    if (pref.begin("system", false)) {
      activeLtProf = pref.getInt("act_lt_prof", activeLtProf);
      pref.end();
    }
    if (activeLtProf < 0) activeLtProf = 0;
    if (activeLtProf >= MAX_LIGHTING_PROFILES) activeLtProf = MAX_LIGHTING_PROFILES - 1;
    return activeLtProf;
  }

public:
  // Load a lighting profile from LittleFS
  bool loadLightingProfile(int index, LightingProfile& profile) {
    if (index < 0 || index >= MAX_LIGHTING_PROFILES) return false;
    if (!littleFsReady) return false;
    
    String path = getLightingProfilePath(index);
    if (!LittleFS.exists(path)) {
      Serial.printf("[StorageManager] Lighting profile %d not found: %s\n", index, path.c_str());
      return false;
    }

    File file = LittleFS.open(path, "r");
    if (!file) {
      Serial.printf("[StorageManager] Failed to open profile: %s\n", path.c_str());
      return false;
    }

    static DynamicJsonDocument doc(8192);
    doc.clear();
    DeserializationError err = deserializeJson(doc, file);
    file.close();

    if (err) {
      Serial.printf("[StorageManager] JSON parse error in %s: %s\n", path.c_str(), err.c_str());
      return false;
    }

    // Parse profile from JSON
    strncpy(profile.name, doc["name"] | "Unnamed", sizeof(profile.name) - 1);
    profile.master = doc["master"] | true;
    profile.totalLeds = constrain(static_cast<uint16_t>(doc["total_leds"] | 20), static_cast<uint16_t>(1), static_cast<uint16_t>(MAX_LIGHTS_TOTAL_LEDS));
    profile.groupCount = 0;

    if (doc.containsKey("groups") && doc["groups"].is<JsonArray>()) {
      JsonArray groupsArr = doc["groups"];
      for (JsonObject groupObj : groupsArr) {
        if (profile.groupCount >= MAX_GROUPS_PER_PROFILE) break;
        
        LightingGroup& grp = profile.groups[profile.groupCount];
        grp.id = groupObj["id"] | profile.groupCount;
        strncpy(grp.name, groupObj["name"] | "Group", sizeof(grp.name) - 1);
        grp.enabled = groupObj["enabled"] | true;
        strncpy(grp.effect, groupObj["effect"] | EFFECT_SOLID, sizeof(grp.effect) - 1);
        strncpy(grp.colorPrimary, groupObj["color_primary"] | "#FFFFFF", sizeof(grp.colorPrimary) - 1);
        strncpy(grp.colorSecondary, groupObj["color_secondary"] | "#000000", sizeof(grp.colorSecondary) - 1);
        grp.brightness = groupObj["brightness"] | DEFAULT_BRIGHTNESS;
        grp.effectSpeed = groupObj["effect_speed"] | DEFAULT_EFFECT_SPEED;
        grp.effectIntensity = groupObj["effect_intensity"] | DEFAULT_EFFECT_INTENSITY;
        
        // Parse LED indices (zero-based)
        grp.ledCount = 0;
        if (groupObj.containsKey("leds") && groupObj["leds"].is<JsonArray>()) {
          JsonArray ledsArr = groupObj["leds"];
          for (JsonVariant ledVal : ledsArr) {
            if (grp.ledCount >= MAX_GROUP_LEDS) break;
            const uint16_t led = ledVal.as<uint16_t>();
            if (led < MAX_LIGHTS_TOTAL_LEDS) {
              grp.leds[grp.ledCount++] = led;
            }
          }
        }
        
        profile.groupCount++;
      }
    }

    Serial.printf("[StorageManager] Loaded lighting profile %d: %s (%d groups)\n", 
                  index, profile.name, profile.groupCount);
    return true;
  }

  // Save a lighting profile to LittleFS
  bool saveLightingProfile(int index, const LightingProfile& profile) {
    if (index < 0 || index >= MAX_LIGHTING_PROFILES) return false;
    if (!littleFsReady) return false;

    static DynamicJsonDocument doc(8192);
    doc.clear();
    doc["name"]        = profile.name;
    doc["master"]      = profile.master;
    doc["total_leds"]  = constrain(profile.totalLeds, static_cast<uint16_t>(1), static_cast<uint16_t>(MAX_LIGHTS_TOTAL_LEDS));

    JsonArray groupsArr = doc.createNestedArray("groups");
    for (int i = 0; i < profile.groupCount; i++) {
      const LightingGroup& grp = profile.groups[i];
      JsonObject groupObj = groupsArr.createNestedObject();
      
      groupObj["id"]               = grp.id;
      groupObj["name"]             = grp.name;
      groupObj["enabled"]          = grp.enabled;
      groupObj["effect"]           = grp.effect;
      groupObj["color_primary"]    = grp.colorPrimary;
      groupObj["color_secondary"]  = grp.colorSecondary;
      groupObj["brightness"]       = grp.brightness;
      groupObj["effect_speed"]     = grp.effectSpeed;
      groupObj["effect_intensity"] = grp.effectIntensity;
      
      JsonArray ledsArr = groupObj.createNestedArray("leds");
      for (int j = 0; j < grp.ledCount; j++) {
        if (grp.leds[j] < MAX_LIGHTS_TOTAL_LEDS) {
          ledsArr.add(grp.leds[j]);  // Zero-based LED indices
        }
      }
    }

    String path = getLightingProfilePath(index);
    File file = LittleFS.open(path, "w");
    if (!file) {
      Serial.printf("[StorageManager] Failed to open profile for writing: %s\n", path.c_str());
      return false;
    }

    size_t written = serializeJson(doc, file);
    file.close();

    if (written == 0) {
      Serial.printf("[StorageManager] Failed to serialize profile to %s\n", path.c_str());
      return false;
    }

    Serial.printf("[StorageManager] Saved lighting profile %d: %s (%d groups, %d bytes)\n", 
                  index, profile.name, profile.groupCount, written);
    return true;
  }

  // Delete a lighting profile from LittleFS
  bool deleteLightingProfile(int index) {
    if (index < 0 || index >= MAX_LIGHTING_PROFILES) return false;
    if (!littleFsReady) return false;

    String path = getLightingProfilePath(index);
    if (LittleFS.remove(path)) {
      Serial.printf("[StorageManager] Deleted lighting profile: %s\n", path.c_str());
      return true;
    } else {
      Serial.printf("[StorageManager] Failed to delete profile: %s\n", path.c_str());
      return false;
    }
  }

  // Count existing lighting profiles
  int getLightingProfileCount() {
    if (!littleFsReady) return 0;
    int count = 0;
    for (int i = 0; i < MAX_LIGHTING_PROFILES; i++) {
      if (LittleFS.exists(getLightingProfilePath(i))) {
        count++;
      }
    }
    return count;
  }

  // Get names of all lighting profiles
  void getLightingProfileNames(JsonArray& outArray) {
    if (!littleFsReady) return;
    for (int i = 0; i < MAX_LIGHTING_PROFILES; i++) {
      String path = getLightingProfilePath(i);
      if (LittleFS.exists(path)) {
        File file = LittleFS.open(path, "r");
        if (file) {
          DynamicJsonDocument doc(512);
          if (deserializeJson(doc, file) == DeserializationError::Ok) {
            JsonObject entry = outArray.createNestedObject();
            entry["index"] = i;
            entry["name"]  = doc["name"] | "Unnamed";
          }
          file.close();
        }
      }
    }
  }

  // Build lightweight active lighting profile index payload for BLE.
  // Includes only metadata and a compact group list (no LED arrays).
  bool getActiveLightingGroupIndexJSON(String& outJson) {
    outJson = "{}";
    const int activeLtProf = getActiveLightingProfileIndex();

    DynamicJsonDocument doc(4096);
    JsonArray ltProfArr = doc.createNestedArray("lt_profiles");
    getLightingProfileNames(ltProfArr);
    doc["lt_profile_count"] = ltProfArr.size();
    doc["act_lt_prof"] = activeLtProf;

    static LightingProfile activeProfile = {};
    if (!loadLightingProfile(activeLtProf, activeProfile)) {
      doc["active_lt_profile_missing"] = true;
      serializeJson(doc, outJson);
      return false;
    }

    JsonObject ap = doc.createNestedObject("active_lt_profile");
    ap["index"] = activeLtProf;
    ap["name"] = activeProfile.name;
    ap["master"] = activeProfile.master;
    ap["total_leds"] = activeProfile.totalLeds;
    ap["group_count"] = activeProfile.groupCount;

    JsonArray groups = ap.createNestedArray("groups");
    for (uint8_t i = 0; i < activeProfile.groupCount; i++) {
      const LightingGroup& g = activeProfile.groups[i];
      JsonObject go = groups.createNestedObject();
      go["cursor"] = i;
      go["id"] = g.id;
      go["name"] = g.name;
      go["enabled"] = g.enabled;
      go["effect"] = g.effect;
      go["brightness"] = g.brightness;
      go["led_count"] = g.ledCount;
    }

    serializeJson(doc, outJson);
    return true;
  }

  // Build one active lighting group payload by cursor index.
  // Returns false when profile/group is unavailable.
  bool getActiveLightingGroupDetailJSON(int cursor, String& outJson, int& nextCursor, bool& done) {
    outJson = "{}";
    nextCursor = 0;
    done = true;

    const int activeLtProf = getActiveLightingProfileIndex();
    static LightingProfile activeProfile = {};
    if (!loadLightingProfile(activeLtProf, activeProfile)) {
      DynamicJsonDocument missDoc(256);
      missDoc["mode"] = "lights_group_detail";
      missDoc["ok"] = false;
      missDoc["reason"] = "active_profile_missing";
      missDoc["act_lt_prof"] = activeLtProf;
      serializeJson(missDoc, outJson);
      return false;
    }

    const int safeCursor = cursor < 0 ? 0 : cursor;
    if (safeCursor >= activeProfile.groupCount) {
      DynamicJsonDocument doneDoc(320);
      doneDoc["mode"] = "lights_group_detail";
      doneDoc["ok"] = true;
      doneDoc["act_lt_prof"] = activeLtProf;
      doneDoc["cursor"] = safeCursor;
      doneDoc["group_count"] = activeProfile.groupCount;
      doneDoc["done"] = true;
      doneDoc["next_cursor"] = activeProfile.groupCount;
      serializeJson(doneDoc, outJson);
      nextCursor = activeProfile.groupCount;
      done = true;
      return true;
    }

    const LightingGroup& g = activeProfile.groups[safeCursor];
    DynamicJsonDocument doc(3072);
    doc["mode"] = "lights_group_detail";
    doc["ok"] = true;
    doc["act_lt_prof"] = activeLtProf;
    doc["cursor"] = safeCursor;
    doc["group_count"] = activeProfile.groupCount;
    doc["done"] = (safeCursor + 1) >= activeProfile.groupCount;
    doc["next_cursor"] = doc["done"].as<bool>() ? activeProfile.groupCount : (safeCursor + 1);

    JsonObject go = doc.createNestedObject("group");
    go["id"] = g.id;
    go["name"] = g.name;
    go["enabled"] = g.enabled;
    go["effect"] = g.effect;
    go["color_primary"] = g.colorPrimary;
    go["color_secondary"] = g.colorSecondary;
    go["brightness"] = g.brightness;
    go["effect_speed"] = g.effectSpeed;
    go["effect_intensity"] = g.effectIntensity;
    JsonArray leds = go.createNestedArray("leds");
    for (uint16_t j = 0; j < g.ledCount; j++) {
      leds.add(g.leds[j]);
    }

    serializeJson(doc, outJson);
    nextCursor = doc["next_cursor"].as<int>();
    done = doc["done"].as<bool>();
    return true;
  }

  // Create default lighting profiles on first boot
  void createDefaultLightingProfiles() {
    if (!littleFsReady) {
      Serial.println("LittleFS unavailable, skipping default lighting profile creation");
      return;
    }

    // Check if profiles already exist
    if (LittleFS.exists("/lt_p0.json")) {
      Serial.println("[StorageManager] Lighting profiles already exist, skipping defaults");
      return;
    }

    // Default profile 0: "Daytime Running"
    {
      static LightingProfile p0 = {};
      strncpy(p0.name, "Daytime Running", sizeof(p0.name) - 1);
      p0.master = true;
      p0.totalLeds = 20;
      p0.groupCount =  1;

      LightingGroup& grp = p0.groups[0];
      grp.id = 0;
      strncpy(grp.name, "Headlights", sizeof(grp.name) - 1);
      grp.leds[0] = 0; grp.leds[1] = 1;  // LEDs 0,1 (zero-based)
      grp.ledCount = 2;
      grp.enabled = true;
      strncpy(grp.effect, EFFECT_SOLID, sizeof(grp.effect) - 1);
      strncpy(grp.colorPrimary, "#FFFFFF", sizeof(grp.colorPrimary) - 1);
      strncpy(grp.colorSecondary, "#000000", sizeof(grp.colorSecondary) - 1);
      grp.brightness = 100;
      grp.effectSpeed = 50;
      grp.effectIntensity = 100;

      saveLightingProfile(0, p0);
    }

    // Default profile 1: "Night Mode"
    {
      static LightingProfile p1 = {};
      strncpy(p1.name, "Night Mode", sizeof(p1.name) - 1);
      p1.master = true;
      p1.totalLeds = 20;
      p1.groupCount = 2;

      // Group 0: Headlights (warm white)
      LightingGroup& grp0 = p1.groups[0];
      grp0.id = 0;
      strncpy(grp0.name, "Headlights", sizeof(grp0.name) - 1);
      grp0.leds[0] = 0; grp0.leds[1] = 1;
      grp0.ledCount = 2;
      grp0.enabled = true;
      strncpy(grp0.effect, EFFECT_SOLID, sizeof(grp0.effect) - 1);
      strncpy(grp0.colorPrimary, "#FFE0A0", sizeof(grp0.colorPrimary) - 1);
      strncpy(grp0.colorSecondary, "#000000", sizeof(grp0.colorSecondary) - 1);
      grp0.brightness = 60;
      grp0.effectSpeed = 50;
      grp0.effectIntensity = 100;

      // Group 1: Underglow (red, breathing)
      LightingGroup& grp1 = p1.groups[1];
      grp1.id = 1;
      strncpy(grp1.name, "Underglow", sizeof(grp1.name) - 1);
      grp1.leds[0] = 4; grp1.leds[1] = 5; grp1.leds[2] = 6; grp1.leds[3] = 7;
      grp1.ledCount = 4;
      grp1.enabled = true;
      strncpy(grp1.effect, EFFECT_BREATHE, sizeof(grp1.effect) - 1);
      strncpy(grp1.colorPrimary, "#FF0000", sizeof(grp1.colorPrimary) - 1);
      strncpy(grp1.colorSecondary, "#000000", sizeof(grp1.colorSecondary) - 1);
      grp1.brightness = 40;
      grp1.effectSpeed = 40;
      grp1.effectIntensity = 100;

      saveLightingProfile(1, p1);
    }

    // Set initial active profile to 0
    {
      Preferences pref;
      if (pref.begin("system", false)) {
        pref.putInt("act_lt_prof", 0);
        pref.end();
        state.system.activeLightingProfile = 0;
      }
    }

    Serial.println("[StorageManager] Created default lighting profiles");
  }
};

#endif
