#ifndef BLUETOOTH_SERVICE_H
#define BLUETOOTH_SERVICE_H

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <functional>
#include "StorageManager.h"

// Service UUID for RCDCC
#define RCDCC_SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"

// Configuration Characteristics
#define CONFIG_READ_UUID    "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define CONFIG_WRITE_UUID   "1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e"

// Telemetry Characteristics (real-time sensor data)
#define TELEMETRY_UUID      "d8de624e-140f-4a22-8594-e2216b84a5f2"

// Command Characteristics
#define SERVO_CMD_UUID      "e8a3c5f2-4b9d-11ec-81d3-0242ac130003"
#define LIGHTS_CMD_UUID     "f2b4d6e8-4b9d-11ec-81d3-0242ac130003"
#define SYSTEM_CMD_UUID     "068c1d3a-4b9e-11ec-81d3-0242ac130003"

class BluetoothService {
private:
    BLEServer* pServer;
    BLEService* pService;
    
    // Characteristics
    BLECharacteristic* pConfigReadChar;
    BLECharacteristic* pConfigWriteChar;
    BLECharacteristic* pTelemetryChar;
    BLECharacteristic* pServoCommandChar;
    BLECharacteristic* pLightsCommandChar;
    BLECharacteristic* pSystemCommandChar;
    
    StorageManager* storage;
    bool deviceConnected;
    std::function<bool(const String&)> configWriteHandler;
    std::function<bool(const String&)> servoWriteHandler;
    std::function<bool(const String&)> lightsWriteHandler;
    std::function<bool(const String&)> systemWriteHandler;
    
    // Maximum MTU size for chunked transfers
    static const int MAX_CHUNK_SIZE = 512;
    
public:
    BluetoothService(StorageManager* storageManager);
    
    void begin(const char* deviceName);
    void update();
    
    // Send telemetry data (called from main loop)
    void sendTelemetry(float roll, float pitch, float accelX, float accelY, float accelZ);

    void setConfigWriteHandler(std::function<bool(const String&)> handler) { configWriteHandler = handler; }
    void setServoWriteHandler(std::function<bool(const String&)> handler) { servoWriteHandler = handler; }
    void setLightsWriteHandler(std::function<bool(const String&)> handler) { lightsWriteHandler = handler; }
    void setSystemWriteHandler(std::function<bool(const String&)> handler) { systemWriteHandler = handler; }
    
    // Connection status
    bool isConnected() { return deviceConnected; }
    
    // Callback classes (defined below)
    class ServerCallbacks;
    class ConfigReadCallbacks;
    class ConfigWriteCallbacks;
    class ServoCommandCallbacks;
    class LightsCommandCallbacks;
    class SystemCommandCallbacks;
};

// Server connection callbacks
class BluetoothService::ServerCallbacks : public BLEServerCallbacks {
private:
    BluetoothService* service;
public:
    ServerCallbacks(BluetoothService* svc) : service(svc) {}
    
    void onConnect(BLEServer* pServer) {
        service->deviceConnected = true;
        Serial.println("BLE Client connected");
    }
    
    void onDisconnect(BLEServer* pServer) {
        service->deviceConnected = false;
        Serial.println("BLE Client disconnected");
        // Restart advertising
        pServer->startAdvertising();
    }
};

// Configuration read callbacks
class BluetoothService::ConfigReadCallbacks : public BLECharacteristicCallbacks {
private:
    StorageManager* storage;
public:
    ConfigReadCallbacks(StorageManager* storageManager) : storage(storageManager) {}
    
    void onRead(BLECharacteristic* pCharacteristic) {
        String json = storage->getConfigJSON();
        Serial.println("BLE: Config read requested");
        
        // For large JSON, we'll need to chunk it
        if (json.length() > MAX_CHUNK_SIZE) {
            // Send size indicator first
            String sizeMsg = "{\"size\":" + String(json.length()) + "}";
            pCharacteristic->setValue(sizeMsg.c_str());
        } else {
            pCharacteristic->setValue(json.c_str());
        }
    }
};

// Configuration write callbacks
class BluetoothService::ConfigWriteCallbacks : public BLECharacteristicCallbacks {
private:
    BluetoothService* service;
public:
    ConfigWriteCallbacks(BluetoothService* bleService) : service(bleService) {}
    
    void onWrite(BLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() > 0) {
            Serial.println("BLE: Config write received");
            String jsonStr = String(value.c_str());

            bool ok = service->configWriteHandler ? service->configWriteHandler(jsonStr) : false;
            Serial.println(ok ? "BLE: Config saved successfully" : "BLE: Config write handler failed");
        }
    }
};

// Servo command callbacks
class BluetoothService::ServoCommandCallbacks : public BLECharacteristicCallbacks {
private:
    BluetoothService* service;
public:
    ServoCommandCallbacks(BluetoothService* bleService) : service(bleService) {}
    
    void onWrite(BLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() > 0) {
            Serial.println("BLE: Servo command received");
            String jsonStr = String(value.c_str());

            bool ok = service->servoWriteHandler ? service->servoWriteHandler(jsonStr) : false;
            Serial.println(ok ? "BLE: Servo command processed" : "BLE: Servo command handler failed");
        }
    }
};

// Lights command callbacks
class BluetoothService::LightsCommandCallbacks : public BLECharacteristicCallbacks {
private:
    BluetoothService* service;
public:
    LightsCommandCallbacks(BluetoothService* bleService) : service(bleService) {}
    
    void onWrite(BLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() > 0) {
            Serial.println("BLE: Lights command received");
            String jsonStr = String(value.c_str());

            bool ok = service->lightsWriteHandler ? service->lightsWriteHandler(jsonStr) : false;
            Serial.println(ok ? "BLE: Lights command processed" : "BLE: Lights command handler failed");
        }
    }
};

// System command callbacks
class BluetoothService::SystemCommandCallbacks : public BLECharacteristicCallbacks {
private:
    BluetoothService* service;
public:
    SystemCommandCallbacks(BluetoothService* bleService) : service(bleService) {}
    
    void onWrite(BLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() > 0) {
            Serial.println("BLE: System command received");
            String jsonStr = String(value.c_str());

            bool ok = service->systemWriteHandler ? service->systemWriteHandler(jsonStr) : false;
            Serial.println(ok ? "BLE: System command processed" : "BLE: System command handler failed");
        }
    }
};

// Implementation
BluetoothService::BluetoothService(StorageManager* storageManager) {
    storage = storageManager;
    deviceConnected = false;
    pServer = nullptr;
    pService = nullptr;
}

void BluetoothService::begin(const char* deviceName) {
    Serial.println("Initializing BLE...");
    
    // Create BLE Device
    BLEDevice::init(deviceName);
    
    // Create BLE Server
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks(this));
    
    // Create BLE Service
    pService = pServer->createService(RCDCC_SERVICE_UUID);
    
    // Create Configuration Read Characteristic
    pConfigReadChar = pService->createCharacteristic(
        CONFIG_READ_UUID,
        BLECharacteristic::PROPERTY_READ
    );
    pConfigReadChar->setCallbacks(new ConfigReadCallbacks(storage));
    
    // Create Configuration Write Characteristic
    pConfigWriteChar = pService->createCharacteristic(
        CONFIG_WRITE_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    pConfigWriteChar->setCallbacks(new ConfigWriteCallbacks(this));
    
    // Create Telemetry Characteristic (with notifications)
    pTelemetryChar = pService->createCharacteristic(
        TELEMETRY_UUID,
        BLECharacteristic::PROPERTY_NOTIFY
    );
    pTelemetryChar->addDescriptor(new BLE2902());
    
    // Create Servo Command Characteristic
    pServoCommandChar = pService->createCharacteristic(
        SERVO_CMD_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    pServoCommandChar->setCallbacks(new ServoCommandCallbacks(this));
    
    // Create Lights Command Characteristic
    pLightsCommandChar = pService->createCharacteristic(
        LIGHTS_CMD_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    pLightsCommandChar->setCallbacks(new LightsCommandCallbacks(this));
    
    // Create System Command Characteristic
    pSystemCommandChar = pService->createCharacteristic(
        SYSTEM_CMD_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    pSystemCommandChar->setCallbacks(new SystemCommandCallbacks(this));
    
    // Start the service
    pService->start();
    
    // Start advertising
    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(RCDCC_SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    pAdvertising->setMinPreferred(0x06);  // iPhone connection optimization
    pAdvertising->setMinPreferred(0x12);
    BLEDevice::startAdvertising();
    
    Serial.println("BLE Service started. Waiting for connections...");
}

void BluetoothService::update() {
    // Placeholder for any periodic BLE tasks
    // Currently handled by callbacks
}

void BluetoothService::sendTelemetry(float roll, float pitch, float accelX, float accelY, float accelZ) {
    if (!deviceConnected) return;
    
    // Pack telemetry data into compact binary format
    // Format: [roll(float)][pitch(float)][accelX(float)][accelY(float)][accelZ(float)]
    uint8_t telemetryData[20];  // 5 floats × 4 bytes = 20 bytes
    
    memcpy(&telemetryData[0], &roll, 4);
    memcpy(&telemetryData[4], &pitch, 4);
    memcpy(&telemetryData[8], &accelX, 4);
    memcpy(&telemetryData[12], &accelY, 4);
    memcpy(&telemetryData[16], &accelZ, 4);
    
    pTelemetryChar->setValue(telemetryData, 20);
    pTelemetryChar->notify();
}

#endif // BLUETOOTH_SERVICE_H
