#ifndef CONFIG_H
#define CONFIG_H

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "26.03.4"
#endif

// Sensor configuration
#define SUSPENSION_SAMPLE_RATE_HZ 25  // 25 Hz update rate (reduced from 50 Hz for I2C stability)
#define DEFAULT_TELEMETRY_RATE_HZ 5   // 5 Hz WebSocket broadcast rate (configurable 1-10 Hz)
#define I2C_SDA_PIN 21
#define I2C_SCL_PIN 22

// PWM Output configuration (using PCA9685 or direct GPIO)
#define PWM_FREQ 50  // 50 Hz for servo control
// Note: PWM_RESOLUTION is defined in PWMOutputs.h

// GPIO assignments for PWM outputs (if using direct GPIO instead of PCA9685)
#define PWM_FL_PIN 12  // Front Left
#define PWM_FR_PIN 13  // Front Right
#define PWM_RL_PIN 14  // Rear Left
#define PWM_RR_PIN 15  // Rear Right

// Addressable LED configuration
#define STATUS_LED_PIN 27         // GPIO pin for addressable LED strip (WS2812B/NeoPixel)
#define STATUS_LED_COUNT 100      // Total number of LEDs in the strip (adjust to your hardware)
#define LED_BRIGHTNESS_MAX 255    // Maximum brightness value

// Phase 1 default values (NVS-backed schema)
#define DEFAULT_DEVICE_NAME "RCDCC"
#define DEFAULT_SERVO_LABEL_FL "Front Left"
#define DEFAULT_SERVO_LABEL_FR "Front Right"
#define DEFAULT_SERVO_LABEL_RL "Rear Left"
#define DEFAULT_SERVO_LABEL_RR "Rear Right"
#define DEFAULT_SERVO_TYPE "positional"
#define DEFAULT_SERVO_ENABLED 1
#define DEFAULT_SERVO_TRIM_US 1500
#define DEFAULT_SERVO_MIN_US 1000
#define DEFAULT_SERVO_MAX_US 2000
#define DEFAULT_SERVO_REVERSE 0
#define DEFAULT_SERVO_RIDE_HT 50

#define DEFAULT_SUSP_DAMPING 50
#define DEFAULT_SUSP_STIFFNESS 50
#define DEFAULT_SUSP_REACT_SPD 50
#define DEFAULT_SUSP_FR_BALANCE 0

#define DEFAULT_IMU_ORIENT 0
#define DEFAULT_IMU_ROLL_TRIM 0.0f
#define DEFAULT_IMU_PITCH_TRIM 0.0f

#define DEFAULT_ACTIVE_DRIVING_PROFILE 0
#define DEFAULT_ACTIVE_LIGHTING_PROFILE 0

// Legacy runtime defaults retained for simulator compatibility.
#define DEFAULT_REACTION_SPEED 1.0f
#define DEFAULT_RIDE_HEIGHT 50.0f
#define DEFAULT_RANGE_LIMIT 60.0f
#define DEFAULT_DAMPING 0.5f
#define DEFAULT_FRONT_REAR_BALANCE 0.5f
#define DEFAULT_STIFFNESS 1.0f
#define DEFAULT_FPV_AUTO_MODE false
#define DEFAULT_SERVO_TRIM 0
#define DEFAULT_SERVO_MIN 0
#define DEFAULT_SERVO_MAX 180
#define DEFAULT_SERVO_REVERSED false

// WiFi configuration - Home network (STA mode)
#define HOME_WIFI_SSID "CAMELOT"  // Change this to your WiFi name
#define HOME_WIFI_PASSWORD "bluedaisy347"  // Change this to your WiFi password
#define WIFI_CONNECT_TIMEOUT 30000  // 30 seconds timeout

// WiFi configuration - Access Point mode (fallback)
#define WIFI_AP_SSID "RCDCC"
#define WIFI_AP_PASSWORD "12345678"
#define WIFI_AP_IP 192, 168, 4, 1
#define WIFI_AP_GATEWAY 192, 168, 4, 1
#define WIFI_AP_SUBNET 255, 255, 255, 0

// Storage configuration
#define LIGHTS_SPIFFS_PATH "/lights.json"

// MPU6050 Orientation Options
enum MPU6050Orientation {
  ARROW_FORWARD_UP = 0,    // Arrow points forward, chip faces up (default)
  ARROW_UP_FORWARD = 1,    // Arrow points up, chip faces forward
  ARROW_BACKWARD_UP = 2,   // Arrow points backward, chip faces up
  ARROW_DOWN_FORWARD = 3,  // Arrow points down, chip faces forward
  ARROW_RIGHT_UP = 4,      // Arrow points right, chip faces up
  ARROW_LEFT_UP = 5        // Arrow points left, chip faces up
};

#define DEFAULT_MPU6050_ORIENTATION ARROW_FORWARD_UP

// Data structures
struct SuspensionConfig {
  float reactionSpeed;
  float rideHeightOffset;
  float rangeLimit;
  float damping;
  float frontRearBalance;  // 0.0 = all rear, 1.0 = all front
  float stiffness;
  uint16_t sampleRate;
  uint8_t telemetryRate;   // WebSocket broadcast rate in Hz (1-10)
  uint8_t mpuOrientation;  // MPU6050 mounting orientation
  bool fpvAutoMode;        // FPV auto mode persistent setting
  char deviceName[64];     // Device hostname for network (e.g., "esp32-frontleft")
};

// Phase 1 key-value config contract (RAM mirror of NVS values)
struct RCDCCServoState {
  char label[21];
  char type[16];
  uint8_t enabled;
  int32_t trimUs;
  int32_t minUs;
  int32_t maxUs;
  uint8_t reverse;
  int32_t rideHeight;
};

struct RCDCCSuspensionState {
  int32_t damping;
  int32_t stiffness;
  int32_t reactSpeed;
  int32_t frontRearBalance;
};

struct RCDCCImuState {
  int32_t orient;
  float rollTrim;
  float pitchTrim;
};

struct RCDCCSystemState {
  char deviceName[64];
  char firmwareVersion[16];
  int32_t activeDrivingProfile;
  int32_t activeLightingProfile;
};

// Phase 6 runtime-only Dance Mode state.
// Values are normalized and not persisted to storage.
struct DanceMode {
  bool enabled;
  float last_roll;
  float last_pitch;
};

struct RCDCCConfigState {
  RCDCCServoState servoFL;
  RCDCCServoState servoFR;
  RCDCCServoState servoRL;
  RCDCCServoState servoRR;
  RCDCCSuspensionState suspension;
  RCDCCImuState imu;
  RCDCCSystemState system;
  DanceMode danceMode;
};

// Per-servo calibration settings
struct ServoCalibration {
  int8_t trim;        // Offset in degrees (-45 to +45)
  uint8_t minLimit;   // Minimum angle (0-90 degrees)
  uint8_t maxLimit;   // Maximum angle (90-180 degrees)
  bool reversed;      // Reverse direction flag
};

struct ServoConfig {
  ServoCalibration frontLeft;
  ServoCalibration frontRight;
  ServoCalibration rearLeft;
  ServoCalibration rearRight;
};

// LED color enumeration
enum LEDColor {
  LED_COLOR_RED = 0,
  LED_COLOR_GREEN = 1,
  LED_COLOR_BLUE = 2
};

// LED configuration structure
struct LEDConfig {
  LEDColor color;  // Selected color for status LED
};

#define DEFAULT_LED_COLOR LED_COLOR_RED

// Light modes/patterns enumeration
enum LightMode {
  LIGHT_MODE_OFF = 0,
  LIGHT_MODE_SOLID = 1,      // mode: 1 (solid color)
  LIGHT_MODE_BLINK = 2,      // mode: 2 (flash/blink patterns)
  LIGHT_MODE_PULSE = 3,      // mode: 3 (pulse/breathe patterns)
  LIGHT_MODE_WIPE = 4,       // mode: 4 (moving wipe)
  LIGHT_MODE_CHASE = 5,      // mode: 5 (theater chase)
  LIGHT_MODE_TWINKLE = 6,    // mode: 6 (random twinkle)
  LIGHT_MODE_DUAL_BREATHE = 7 // mode: 7 (dual-color breathing)
};

// Individual light group configuration (for fixed 3-group mode)
struct LightGroup {
  bool enabled;           // Whether this light group is active
  uint8_t brightness;     // Brightness 0-255
  uint8_t mode;          // LightMode enum value
  uint16_t blinkRate;    // Blink rate in milliseconds (for blink/pulse modes)
};

// Extended light group with arbitrary indices and RGB colors
struct ExtendedLightGroup {
  char name[64];          // Group name
  char pattern[64];       // UI pattern label (for round-trip persistence)
  bool enabled;           // Whether enabled
  uint8_t brightness;     // 0-255
  uint8_t mode;          // LightMode enum
  uint16_t blinkRate;    // Blink rate in ms
  uint32_t color;        // Primary color (RGB)
  uint32_t color2;       // Secondary color (RGB)
  uint16_t ledIndices[15]; // Which LED indices belong to this group (max 15 per group)
  uint8_t ledCount;      // How many LEDs in this group
};

// Lights configuration structure (legacy: 3 fixed groups)
struct LightsConfig {
  LightGroup headlights;
  LightGroup tailLights;
  LightGroup emergencyLights;
};

// New lights configuration: support both legacy and arbitrary groups
#define MAX_DYNAMIC_LIGHT_GROUPS 15
#define MAX_DYNAMIC_GROUP_LEDS 15
struct NewLightsConfig {
  bool useLegacyMode;    // If true, use the 3 fixed groups; if false, use dynamic groups
  LightsConfig legacy;   // Legacy 3-group config for backward compatibility
  ExtendedLightGroup groups[MAX_DYNAMIC_LIGHT_GROUPS]; // Support up to 15 dynamic custom groups
  uint8_t groupCount;    // Number of dynamic groups currently configured
};

// Default lights configuration
#define DEFAULT_HEADLIGHTS_ENABLED false
#define DEFAULT_HEADLIGHTS_BRIGHTNESS 100
#define DEFAULT_HEADLIGHTS_MODE LIGHT_MODE_OFF
#define DEFAULT_HEADLIGHTS_BLINK_RATE 500

#define DEFAULT_TAILLIGHTS_ENABLED false
#define DEFAULT_TAILLIGHTS_BRIGHTNESS 100
#define DEFAULT_TAILLIGHTS_MODE LIGHT_MODE_OFF
#define DEFAULT_TAILLIGHTS_BLINK_RATE 500

#define DEFAULT_EMERGENCY_LIGHTS_ENABLED false
#define DEFAULT_EMERGENCY_LIGHTS_BRIGHTNESS 100
#define DEFAULT_EMERGENCY_LIGHTS_MODE LIGHT_MODE_OFF
#define DEFAULT_EMERGENCY_LIGHTS_BLINK_RATE 500

// ==================== Aux Servo Architecture (Phase 4) ====================
#define MAX_AUX_SERVOS    10
#define MAX_SERVO_REGISTRY 14  // 4 reserved + 10 aux

// Aux servo output GPIO pins (slots 0-9).
// These use ESP32 LEDC channels 4-13 for PWM (positional/continuous/pan).
// All listed pins also support relay (digital HIGH/LOW) output.
// Note: GPIO 34-39 are input-only on ESP32 and cannot be used here.
static constexpr uint8_t AUX_SERVO_PINS[MAX_AUX_SERVOS] = {
  17, 18, 19, 23, 25, 26, 5, 27, 32, 33
};

// Aux servo type identifiers
#define AUX_TYPE_POSITIONAL "positional"
#define AUX_TYPE_CONTINUOUS "continuous"
#define AUX_TYPE_PAN        "pan"
#define AUX_TYPE_RELAY      "relay"

// Aux servo NVS defaults
#define DEFAULT_AUX_ENABLED   1
#define DEFAULT_AUX_TRIM_US   1500
#define DEFAULT_AUX_MIN_US    1000
#define DEFAULT_AUX_MAX_US    2000
#define DEFAULT_AUX_REVERSE   0
#define DEFAULT_AUX_RIDE_HT   50
#define DEFAULT_AUX_SPD_FWD   50
#define DEFAULT_AUX_SPD_REV   50
#define DEFAULT_AUX_SPD       50
#define DEFAULT_AUX_STATE     0
#define DEFAULT_AUX_MOMENTARY 0

// Single aux servo entry
struct AuxServoConfig {
  bool    populated;
  char    ns[16];       // e.g. "srv_aux_00"
  char    label[21];    // user-defined name, max 20 chars
  char    type[16];     // "positional" | "continuous" | "pan" | "relay"
  uint8_t enabled;
  // positional + pan
  int32_t trimUs;
  int32_t minUs;
  int32_t maxUs;
  uint8_t reverse;
  // positional only
  int32_t rideHeight;   // 0-100 %
  // continuous only
  int32_t spdFwd;       // 0-100
  int32_t spdRev;       // 0-100
  // pan only
  int32_t spd;          // 0-100
  // relay only
  uint8_t state;        // 0=off 1=on
  uint8_t momentary;    // 0=latching 1=momentary
  // runtime — NOT persisted to NVS
  int32_t currentSpeed; // -100..100 (continuous watchdog)
};

// Servo registry: all dynamic aux slots
struct ServoRegistry {
  int            auxCount;                         // 0-10
  AuxServoConfig auxServos[MAX_AUX_SERVOS];
};

// ==================== Driving Profile Schema ====================
#define MAX_DRIVING_PROFILES 10
#define DEFAULT_DRIVING_PROFILE_NAME "Default"

// A driving profile captures all mechanical tuning for a specific scenario.
// Stored in NVS namespaces "drv_p0" through "drv_p9".
struct DrivingProfile {
  bool populated;   // false = empty slot
  char name[21];    // user-defined name, max 20 chars + null terminator

  // Servo parameters stored as µs values (same scale as RCDCCServoState)
  int32_t srvFlTrim; int32_t srvFlMin; int32_t srvFlMax; int32_t srvFlRht; uint8_t srvFlRev;
  int32_t srvFrTrim; int32_t srvFrMin; int32_t srvFrMax; int32_t srvFrRht; uint8_t srvFrRev;
  int32_t srvRlTrim; int32_t srvRlMin; int32_t srvRlMax; int32_t srvRlRht; uint8_t srvRlRev;
  int32_t srvRrTrim; int32_t srvRrMin; int32_t srvRrMax; int32_t srvRrRht; uint8_t srvRrRev;

  // Suspension (same scale as RCDCCSuspensionState)
  int32_t damping;
  int32_t stiffness;
  int32_t reactSpd;
  int32_t frBalance;

  // IMU orientation index
  int32_t imuOrient;
};

// ==================== Lighting Profile Schema (Phase 5) ====================
// Lighting profiles are completely independent from driving profiles.
// Profiles are stored as JSON files in LittleFS (lt_p0.json through lt_p9.json).
// Only the active profile index (system.act_lt_prof) is stored in NVS.
// LED indices are ZERO-BASED throughout — LED 0 is the first LED on the strip.

#define MAX_LIGHTING_PROFILES 10
#define MAX_LIGHTS_TOTAL_LEDS 30
#define MAX_GROUP_LEDS 15  // Max individual LED indices per group
#define MAX_GROUPS_PER_PROFILE 15

// Effect names (string identifiers for JSON serialization)
#define EFFECT_SOLID           "solid"
#define EFFECT_BLINK           "blink"
#define EFFECT_STROBE          "strobe"
#define EFFECT_BREATHE         "breathe"
#define EFFECT_FADE            "fade"
#define EFFECT_TWINKLE         "twinkle"
#define EFFECT_SPARKLE         "sparkle"
#define EFFECT_FLASH_SPARKLE   "flash_sparkle"
#define EFFECT_GLITTER         "glitter"
#define EFFECT_SOLID_GLITTER   "solid_glitter"
#define EFFECT_RUNNING         "running"
#define EFFECT_LARSON          "larson"
#define EFFECT_FLICKER         "flicker"
#define EFFECT_FIRE_FLICKER    "fire_flicker"
#define EFFECT_HEARTBEAT       "heartbeat"

// Default effect for new groups
#define DEFAULT_EFFECT EFFECT_SOLID
#define DEFAULT_BRIGHTNESS 100
#define DEFAULT_EFFECT_SPEED 50
#define DEFAULT_EFFECT_INTENSITY 100

// Single light group within a lighting profile.
// A group is a named collection of individual LED indices (not a range).
// The same LED index can appear in multiple groups — overlapping is allowed.
// When two groups both write to the same LED, the last group processed wins.
struct LightingGroup {
  uint8_t  id;                  // 0-14, group identifier
  char     name[64];            // Group name (e.g., "Headlights")
  uint16_t leds[MAX_GROUP_LEDS]; // Array of zero-based LED indices (LED 0 = first LED)
  uint16_t ledCount;            // How many LEDs in this group (0 = disabled)
  
  bool     enabled;             // Whether this group is active
  char     effect[32];          // Effect name: solid, blink, strobe, etc.
  char     colorPrimary[8];     // Hex color #RRGGBB (e.g., "#FFFFFF")
  char     colorSecondary[8];   // Hex color #RRGGBB (e.g., "#FF0000")
  uint8_t  brightness;          // 0-100 % brightness
  uint8_t  effectSpeed;         // 0-100 effect speed/rate
  uint8_t  effectIntensity;     // 0-100 effect intensity
};

// Complete lighting profile.
// Profiles are serialized to JSON in LittleFS with filename lt_pN.json (0-9).
struct LightingProfile {
  char       name[64];          // Profile name (e.g., "Night Mode")
  bool       master;            // Master enable/disable
  uint16_t   totalLeds;         // Total LEDs on the strip (e.g., 100)
  uint8_t    groupCount;        // Number of groups (0-15)
  LightingGroup groups[MAX_GROUPS_PER_PROFILE];
};

#endif
