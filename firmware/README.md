# ESP32 Active Suspension - Firmware

ESP32 firmware for active suspension control over Bluetooth Low Energy (BLE).

## Hardware Requirements

- ESP32-D0WD-V3 (or compatible)
- MPU6050 IMU (I2C: SDA=GPIO21, SCL=GPIO22)
- 4x Servo motors (PWM via PCA9685)
- WS2812/NeoPixel LED strip

## Development

### Prerequisites
```bash
PlatformIO Core or PlatformIO IDE
```

### Build
```bash
cd firmware
pio run -e esp32
```

### Upload
```bash
pio run -e esp32 --target upload --upload-port COM7
```

### Serial Monitor
```bash
pio device monitor --baud 115200
```

## Project Structure

```
firmware/
├── platformio.ini             # Build configuration
├── src/
│   └── main.cpp               # Main loop + BLE payload handlers
└── include/
    ├── BluetoothService.h     # BLE service, characteristics, callbacks
    ├── Config.h               # Constants and structures
    ├── SensorFusion.h         # IMU complementary filter
    ├── SuspensionSimulator.h  # Suspension simulation
    ├── StorageManager.h       # SPIFFS persistence
    ├── PWMOutputs.h           # Servo PWM control
    └── LightsEngine.h         # LED group/pattern engine
```

## BLE Service

The firmware exposes one BLE GATT service with characteristics for:

- Config read
- Config write
- Telemetry notify (roll, pitch, accelX, accelY, accelZ)
- Servo command write
- Lights command write
- System command write

Device name in BLE advertising comes from persisted `deviceName` in config (default: `ESP32-RCDCC`).

## Flash Usage

- BLE-only firmware build is currently around ~64% flash on `min_spiffs.csv`.

## Notes

- HTTP/WebSocket webserver support has been removed from runtime code.
- Configuration and control now flow through BLE payload handlers and SPIFFS persistence.
