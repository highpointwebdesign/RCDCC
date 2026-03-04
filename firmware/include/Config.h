#ifndef CONFIG_H
#define CONFIG_H

// ==================== Version Configuration ====================
// Update this version when releasing new firmware builds
// For automated versioning from git, add to platformio.ini build_flags:
//   -DFIRMWARE_VERSION=\"$(git describe --tags --always)\"
// Or use a pre-build script to generate this from version.txt or package.json
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "1.0.0"
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
#define STATUS_LED_PIN 27  // GPIO pin for addressable LED (WS2812B/NeoPixel)
#define STATUS_LED_COUNT 3 // Number of LEDs in the strip (0-1: emergency lights, 2: alerts)

// Default suspension parameters
#define DEFAULT_REACTION_SPEED 1.0f
#define DEFAULT_RIDE_HEIGHT 90.0f
#define DEFAULT_RANGE_LIMIT 60.0f
#define DEFAULT_DAMPING 0.8f
#define DEFAULT_FRONT_REAR_BALANCE 0.5f
#define DEFAULT_STIFFNESS 1.0f
#define DEFAULT_FPV_AUTO_MODE false // FPV auto mode default
#define DEFAULT_DEVICE_NAME "ESP32-RCDCC" // Device hostname on network

// Default servo calibration parameters
#define DEFAULT_SERVO_TRIM 0         // No trim offset (degrees)
#define DEFAULT_SERVO_MIN 15         // Minimum angle (degrees)
#define DEFAULT_SERVO_MAX 165        // Maximum angle (degrees)
#define DEFAULT_SERVO_REVERSED false // Standard rotation direction

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
#define CONFIG_SPIFFS_PATH "/config.json"

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

#endif
