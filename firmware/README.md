# ESP32 Active Suspension - Firmware

ESP32 firmware for active suspension control system with API-only web server.

## Hardware Requirements

- ESP32-D0WD-V3 (or compatible)
- MPU6050 IMU (I2C: SDA=GPIO21, SCL=GPIO22)
- 4x Servo motors (PWM: GPIO12-15)
- 3x Battery voltage monitoring (ADC: GPIO34-35, GPIO32)
- Voltage dividers: 70kΩ + 10kΩ (8:1 ratio) for battery inputs

## Development

### Prerequisites
```bash
PlatformIO Core or PlatformIO IDE
```

### Build
```bash
cd firmware
pio run
```

### Upload
```bash
pio run --target upload
```

### Serial Monitor
```bash
pio device monitor --baud 115200
```

## Project Structure

```
firmware/
├── platformio.ini           # Build configuration
├── src/
│   └── main.cpp            # Main application loop
└── include/
    ├── Config.h            # Constants and structures
    ├── SensorFusion.h      # IMU complementary filter
    ├── SuspensionSimulator.h  # Physics simulation
    ├── StorageManager.h    # SPIFFS persistence
    ├── PWMOutputs.h        # Servo PWM control
    └── WebServer.h         # API-only web server
```

## Network Configuration

### Access Point Mode (Default)
```
SSID: ESP32-Suspension
Password: 12345678
IP: 192.168.4.1
```

### Local Network Mode (Fallback)
Edit Config.h to set your WiFi credentials:
```cpp
#define WIFI_SSID "YourNetwork"
#define WIFI_PASSWORD "YourPassword"
```

## API Endpoints

All endpoints return JSON.

### Health Check
```
GET /api/health
Response: {"status":"ok","mpu6050":true}
```

### Configuration
```
GET /api/config
POST /api/config
Body: {"param":"damping","value":0.8}
```

### Battery Configuration
```
GET /api/battery-config
POST /api/battery-config
Body: {"battery":1,"param":"cellCount","value":3}
```

### Servo Configuration
```
GET /api/servo-config?servo=FL
POST /api/servo-config
Body: {"servo":"FL","param":"minPulse","value":1000}
```

### Servo Calibration
```
POST /api/calibrate
Body: {"servo":"FL"}
```

### WebSocket
```
WS /ws
Messages:
- {"type":"sensor","roll":0.0,"pitch":0.0,"accelZ":0.0}
- {"type":"servo","FL":90,"FR":90,"RL":90,"RR":90}
- {"type":"battery","voltage0":12.6,"voltage1":7.4,"voltage2":0.0}
```

## CORS Headers

CORS is enabled for all origins to allow PWA app connection.

## Flash Usage

- ~30-40% (minimal HTML, API-only)
- Previous version: ~77% (with embedded HTML pages)

## Key Features

- 50Hz MPU6050 sensor loop
- Complementary filter for orientation
- 4-corner independent suspension control
- Real-time WebSocket data streaming
- Persistent configuration in SPIFFS
- Battery voltage monitoring with color-coded thresholds
- Automatic AP fallback if WiFi connection fails
