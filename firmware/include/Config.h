#ifndef CONFIG_H
#define CONFIG_H

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "26.04.59"
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
#define PWM_FL_PIN 25  // Front Left
#define PWM_FR_PIN 26  // Front Right
#define PWM_RL_PIN 17  // Rear Left
#define PWM_RR_PIN 18  // Rear Right

// Addressable LED configuration
#define STATUS_LED_PIN 27         // GPIO pin for addressable LED strip (WS2812B/NeoPixel)
#define STATUS_LED_COUNT 30       // Buffer size for addressable LEDs; app configures actual count
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

#define DEFAULT_SUSP_OMEGA_N   300   // omegaN × 100  →  3.00 rad/s
#define DEFAULT_SUSP_ZETA       25   // zeta × 100    →  0.25 (underdamped)
#define DEFAULT_SUSP_REACT_SPD  50
#define DEFAULT_SUSP_FR_BALANCE  0
#define DEFAULT_SUSP_RANGE     100   // range × 100   →  1.00 (unit scale)
#define DEFAULT_SUSP_DEADBAND   30   // deadband × 100 → 0.30 deg
#define DEFAULT_SUSP_HYST       15   // hyst × 100    →  0.15 deg

#define DEFAULT_IMU_ORIENT 0
#define DEFAULT_IMU_ROLL_TRIM 0.0f
#define DEFAULT_IMU_PITCH_TRIM 0.0f

#define DEFAULT_ACTIVE_DRIVING_PROFILE 0

// Legacy runtime defaults retained for simulator compatibility.
#define DEFAULT_REACTION_SPEED 1.0f
#define DEFAULT_RIDE_HEIGHT 50.0f
#define DEFAULT_RANGE_LIMIT 60.0f
#define DEFAULT_OMEGA_N 3.0f
#define DEFAULT_ZETA 0.25f
#define DEFAULT_RANGE 1.0f
#define DEFAULT_FRONT_REAR_BALANCE 0.5f
#define DEFAULT_INPUT_DEADBAND 0.30f
#define DEFAULT_INPUT_HYST 0.15f
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
  float rangeLimit;        // legacy — travel envelope degrees (unused by new simulator)
  float omegaN;            // natural frequency rad/s  (0.5 – 15.0)
  float zeta;              // damping ratio            (0.05 – 0.95)
  float range;             // input scale factor       (0.1 – 4.0)
  float inputDeadband;     // noise gate around zero   (0.0 – 1.0)
  float inputHyst;         // hysteresis to prevent chatter (0.0 – 0.5)
  float frontRearBalance;  // 0.0 = all rear, 1.0 = all front
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
  int32_t omegaN;           // × 100  (50–1500  → 0.50–15.00 rad/s)
  int32_t zeta;             // × 100  (5–95     → 0.05–0.95)
  int32_t reactSpeed;       // 0–100
  int32_t frontRearBalance; // −100–100
  int32_t range;            // × 100  (10–400   → 0.10–4.00)
  int32_t inputDeadband;    // × 100  (0–100    → 0.00–1.00 deg)
  int32_t inputHyst;        // × 100  (0–50     → 0.00–0.50 deg)
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
  int32_t omegaN;
  int32_t zeta;
  int32_t reactSpd;
  int32_t frBalance;
  int32_t range;
  int32_t deadband;
  int32_t hyst;

  // IMU orientation index
  int32_t imuOrient;
};

#endif
