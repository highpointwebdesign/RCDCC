#ifndef BLUETOOTH_SERVICE_H
#define BLUETOOTH_SERVICE_H

#include <Arduino.h>
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
#define KV_WRITE_UUID       "7c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e"

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
    BLECharacteristic* pKvWriteChar;
    BLECharacteristic* pTelemetryChar;
    BLECharacteristic* pServoCommandChar;
    BLECharacteristic* pLightsCommandChar;
    BLECharacteristic* pSystemCommandChar;
    
    StorageManager* storage;
    volatile bool deviceConnected;
    std::function<void(bool)> connectionStateHandler;
    std::function<bool(const String&)> configWriteHandler;
    std::function<bool(const String&)> kvWriteHandler;
    std::function<bool(const String&)> servoWriteHandler;
    std::function<bool(const String&)> lightsWriteHandler;
    std::function<bool(const String&)> systemWriteHandler;

    portMUX_TYPE queueMux = portMUX_INITIALIZER_UNLOCKED;
    String cachedConfigJson;
    volatile bool configCacheDirty = true;
    String activeReadScope = "bootstrap";
    int32_t activeReadChunk = 0;
    String cachedScopePayload;
    String cachedScopePayloadScope;
    // Chunk size must fit inside one ATT Read Response: MTU(247) - 1(opcode) = 246 bytes
    // Envelope overhead is ~88 bytes, leaving 158 bytes for payload -> use 150 for safety.
    static constexpr size_t CONFIG_CHUNK_SIZE = 150;

    String pendingConfigWrite;
    String pendingKvWrite;
    String pendingServoWrite;
    String pendingLightsWrite;
    String pendingLightsMasterSystemWrite;
    static constexpr size_t SYSTEM_QUEUE_CAPACITY = 8;
    String pendingSystemWrites[SYSTEM_QUEUE_CAPACITY];
    size_t pendingSystemHead = 0;
    size_t pendingSystemTail = 0;
    size_t pendingSystemCount = 0;
    volatile bool hasPendingConfigWrite = false;
    volatile bool hasPendingKvWrite = false;
    volatile bool hasPendingServoWrite = false;
    volatile bool hasPendingLightsWrite = false;
    volatile bool hasPendingLightsMasterSystemWrite = false;
    volatile bool hasPendingSystemWrite = false;

    bool isLightsMasterSystemCommand(const String& payload) {
        // Fast-path matcher to coalesce master-light toggles without parsing overhead.
        return payload.indexOf("\"command\"") >= 0 && payload.indexOf("lights_master") >= 0;
    }

    void queuePayload(String& slot, volatile bool& hasPending, const String& payload) {
        taskENTER_CRITICAL(&queueMux);
        slot = payload;
        hasPending = true;
        taskEXIT_CRITICAL(&queueMux);
    }

    bool dequeuePayload(String& slot, volatile bool& hasPending, String& out) {
        bool dequeued = false;
        taskENTER_CRITICAL(&queueMux);
        if (hasPending) {
            out = slot;
            slot = "";
            hasPending = false;
            dequeued = true;
        }
        taskEXIT_CRITICAL(&queueMux);
        return dequeued;
    }

    bool queueSystemPayload(const String& payload) {
        bool queued = false;
        taskENTER_CRITICAL(&queueMux);
        if (isLightsMasterSystemCommand(payload)) {
            pendingLightsMasterSystemWrite = payload;
            hasPendingLightsMasterSystemWrite = true;
            queued = true;
        } else if (pendingSystemCount < SYSTEM_QUEUE_CAPACITY) {
            pendingSystemWrites[pendingSystemTail] = payload;
            pendingSystemTail = (pendingSystemTail + 1) % SYSTEM_QUEUE_CAPACITY;
            pendingSystemCount++;
            hasPendingSystemWrite = true;
            queued = true;
        }
        taskEXIT_CRITICAL(&queueMux);
        return queued;
    }

    bool dequeueSystemPayload(String& out) {
        bool dequeued = false;
        taskENTER_CRITICAL(&queueMux);
        if (pendingSystemCount > 0) {
            out = pendingSystemWrites[pendingSystemHead];
            pendingSystemWrites[pendingSystemHead] = "";
            pendingSystemHead = (pendingSystemHead + 1) % SYSTEM_QUEUE_CAPACITY;
            pendingSystemCount--;
            hasPendingSystemWrite = (pendingSystemCount > 0);
            dequeued = true;
        }
        taskEXIT_CRITICAL(&queueMux);
        return dequeued;
    }

    bool dequeueLightsMasterSystemPayload(String& out) {
        bool dequeued = false;
        taskENTER_CRITICAL(&queueMux);
        if (hasPendingLightsMasterSystemWrite) {
            out = pendingLightsMasterSystemWrite;
            pendingLightsMasterSystemWrite = "";
            hasPendingLightsMasterSystemWrite = false;
            dequeued = true;
        }
        taskEXIT_CRITICAL(&queueMux);
        return dequeued;
    }

    String getCachedConfigSnapshot() {
        String snapshot;
        taskENTER_CRITICAL(&queueMux);
        snapshot = cachedConfigJson;
        taskEXIT_CRITICAL(&queueMux);
        if (snapshot.length() == 0) {
            snapshot = "{\"status\":\"booting\"}";
        }
        return snapshot;
    }

    void markConfigDirty() {
        taskENTER_CRITICAL(&queueMux);
        configCacheDirty = true;
        taskEXIT_CRITICAL(&queueMux);
    }

    void buildChunkedSnapshot() {
        if (!storage) return;

        String scope;
        int32_t chunk = 0;
        bool shouldRebuildPayload = false;
        taskENTER_CRITICAL(&queueMux);
        scope = activeReadScope;
        chunk = activeReadChunk;
        shouldRebuildPayload = configCacheDirty;
        taskEXIT_CRITICAL(&queueMux);

        if (scope.length() == 0) scope = "bootstrap";
        if (chunk < 0) chunk = 0;

        if (shouldRebuildPayload || cachedScopePayload.length() == 0 || cachedScopePayloadScope != scope) {
            cachedScopePayload = storage->getScopedConfigJSON(scope);
            cachedScopePayloadScope = scope;
        }

        const size_t totalBytes = cachedScopePayload.length();
        const size_t totalChunks = totalBytes == 0 ? 1 : ((totalBytes + CONFIG_CHUNK_SIZE - 1) / CONFIG_CHUNK_SIZE);
        const size_t chunkIndex = static_cast<size_t>(chunk) >= totalChunks ? (totalChunks - 1) : static_cast<size_t>(chunk);
        const size_t start = chunkIndex * CONFIG_CHUNK_SIZE;
        const String payloadChunk = cachedScopePayload.substring(start, start + CONFIG_CHUNK_SIZE);

        Serial.printf("[BLE] cfg scope=%s chunk=%d/%d bytes=%d\n",
                  scope.c_str(),
                  static_cast<int>(chunkIndex + 1),
                  static_cast<int>(totalChunks),
                  static_cast<int>(totalBytes));

        DynamicJsonDocument envelope(640);
        envelope["mode"] = "chunked";
        envelope["scope"] = scope;
        envelope["chunk"] = static_cast<int32_t>(chunkIndex);
        envelope["chunks"] = static_cast<int32_t>(totalChunks);
        envelope["bytes"] = static_cast<int32_t>(totalBytes);
        envelope["payload"] = payloadChunk;

        String snapshot;
        serializeJson(envelope, snapshot);

        taskENTER_CRITICAL(&queueMux);
        cachedConfigJson = snapshot;
        configCacheDirty = false;
        taskEXIT_CRITICAL(&queueMux);
    }

    friend class ConfigReadCallbacks;
    friend class ConfigWriteCallbacks;
    friend class KVWriteCallbacks;
    friend class ServoCommandCallbacks;
    friend class LightsCommandCallbacks;
    friend class SystemCommandCallbacks;
    
public:
    BluetoothService(StorageManager* storageManager);
    
    void begin(const char* deviceName);
    void update();
    
    // Send telemetry data (called from main loop)
    void sendTelemetry(float roll, float pitch, float accelX, float accelY, float accelZ);

    void setConfigWriteHandler(std::function<bool(const String&)> handler) { configWriteHandler = handler; }
    void setKVWriteHandler(std::function<bool(const String&)> handler) { kvWriteHandler = handler; }
    void setServoWriteHandler(std::function<bool(const String&)> handler) { servoWriteHandler = handler; }
    void setLightsWriteHandler(std::function<bool(const String&)> handler) { lightsWriteHandler = handler; }
    void setSystemWriteHandler(std::function<bool(const String&)> handler) { systemWriteHandler = handler; }
    void setConnectionStateHandler(std::function<void(bool)> handler) { connectionStateHandler = handler; }

    void requestConfigScope(const String& scope) {
        taskENTER_CRITICAL(&queueMux);
        if (scope.length() > 0) {
            activeReadScope = scope;
            activeReadChunk = 0;
        }
        configCacheDirty = true;
        taskEXIT_CRITICAL(&queueMux);
    }

    void requestConfigChunk(int32_t chunkIndex) {
        taskENTER_CRITICAL(&queueMux);
        activeReadChunk = chunkIndex < 0 ? 0 : chunkIndex;
        configCacheDirty = true;
        taskEXIT_CRITICAL(&queueMux);
    }
    
    // Connection status
    bool isConnected() { return deviceConnected; }
    
    // Callback classes (defined below)
    class ServerCallbacks;
    class ConfigReadCallbacks;
    class ConfigWriteCallbacks;
    class KVWriteCallbacks;
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
        service->markConfigDirty();
        if (service->connectionStateHandler) {
            service->connectionStateHandler(true);
        }
        Serial.println("BLE Client connected");
    }
    
    void onDisconnect(BLEServer* pServer) {
        service->deviceConnected = false;
        if (service->connectionStateHandler) {
            service->connectionStateHandler(false);
        }
        Serial.println("BLE Client disconnected");
        // Restart advertising
        pServer->startAdvertising();
    }
};

// Configuration read callbacks
class BluetoothService::ConfigReadCallbacks : public BLECharacteristicCallbacks {
private:
    BluetoothService* service;
public:
    ConfigReadCallbacks(BluetoothService* bleService) : service(bleService) {}
    
    void onRead(BLECharacteristic* pCharacteristic) {
        String json = service->getCachedConfigSnapshot();
        Serial.printf("BLE: Config read requested (%d bytes)\n", json.length());
        pCharacteristic->setValue(json.c_str());
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
            service->queuePayload(service->pendingConfigWrite, service->hasPendingConfigWrite, jsonStr);
        }
    }
};

// Key-value write callbacks
class BluetoothService::KVWriteCallbacks : public BLECharacteristicCallbacks {
private:
    BluetoothService* service;
public:
    KVWriteCallbacks(BluetoothService* bleService) : service(bleService) {}

    void onWrite(BLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() > 0) {
            String jsonStr = String(value.c_str());
            service->queuePayload(service->pendingKvWrite, service->hasPendingKvWrite, jsonStr);
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
            service->queuePayload(service->pendingServoWrite, service->hasPendingServoWrite, jsonStr);
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
            service->queuePayload(service->pendingLightsWrite, service->hasPendingLightsWrite, jsonStr);
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
            if (!service->queueSystemPayload(jsonStr)) {
                Serial.println("BLE: System command queue full; dropping command");
            }
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
    
    // MTU 247 is the safe limit for ESP32's default BTC_TASK stack (3072 bytes).
    // Higher values (e.g. 517) cause BTC_TASK stack overflow on connect.
    BLEDevice::setMTU(247);
    Serial.println("BLE: MTU set to 247 bytes");
    
    // Create BLE Server
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks(this));
    
    // Create BLE Service with enough attribute handles for all characteristics.
    // Handle budget:
    // 1 service
    // 2 each for ConfigRead/ConfigWrite/KV/Servo/Lights/System = 12
    // 3 for Telemetry (char + value + CCCD)
    // Total = 16, so allocate some headroom.
        pService = pServer->createService(BLEUUID(RCDCC_SERVICE_UUID), 20);
    
    // Create Configuration Read Characteristic
    pConfigReadChar = pService->createCharacteristic(
        CONFIG_READ_UUID,
        BLECharacteristic::PROPERTY_READ
    );
    pConfigReadChar->setCallbacks(new ConfigReadCallbacks(this));
    
    // Create Configuration Write Characteristic
    pConfigWriteChar = pService->createCharacteristic(
        CONFIG_WRITE_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    pConfigWriteChar->setCallbacks(new ConfigWriteCallbacks(this));

    // Create Key-Value Write Characteristic
    pKvWriteChar = pService->createCharacteristic(
        KV_WRITE_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    pKvWriteChar->setCallbacks(new KVWriteCallbacks(this));
    
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

    Serial.println("BLE self-test UUIDs:");
    Serial.printf("  Service      : %s\n", RCDCC_SERVICE_UUID);
    Serial.printf("  Config Read  : %s\n", CONFIG_READ_UUID);
    Serial.printf("  Config Write : %s\n", CONFIG_WRITE_UUID);
    Serial.printf("  KV Write     : %s\n", KV_WRITE_UUID);
    Serial.printf("  Telemetry    : %s\n", TELEMETRY_UUID);
    Serial.printf("  Servo Cmd    : %s\n", SERVO_CMD_UUID);
    Serial.printf("  Lights Cmd   : %s\n", LIGHTS_CMD_UUID);
    Serial.printf("  System Cmd   : %s\n", SYSTEM_CMD_UUID);
    
    Serial.println("BLE Service started. Waiting for connections...");
}

void BluetoothService::update() {
    if (storage && (configCacheDirty || cachedConfigJson.length() == 0)) {
        buildChunkedSnapshot();
    }

    String payload;

    if (dequeuePayload(pendingConfigWrite, hasPendingConfigWrite, payload)) {
        bool ok = configWriteHandler ? configWriteHandler(payload) : false;
        Serial.println(ok ? "BLE: Config saved successfully" : "BLE: Config write handler failed");
        if (ok) markConfigDirty();
    }

    if (dequeuePayload(pendingKvWrite, hasPendingKvWrite, payload)) {
        bool ok = kvWriteHandler ? kvWriteHandler(payload) : false;
        if (!ok) Serial.println("BLE: KV write handler failed");
        if (ok) markConfigDirty();
    }

    if (dequeuePayload(pendingServoWrite, hasPendingServoWrite, payload)) {
        bool ok = servoWriteHandler ? servoWriteHandler(payload) : false;
        Serial.println(ok ? "BLE: Servo command processed" : "BLE: Servo command handler failed");
        if (ok) markConfigDirty();
    }

    if (dequeuePayload(pendingLightsWrite, hasPendingLightsWrite, payload)) {
        bool ok = lightsWriteHandler ? lightsWriteHandler(payload) : false;
        Serial.println(ok ? "BLE: Lights command processed" : "BLE: Lights command handler failed");
        if (ok) markConfigDirty();
    }

    // Master light is a state command; coalesce to the latest requested state.
    if (dequeueLightsMasterSystemPayload(payload)) {
        bool ok = systemWriteHandler ? systemWriteHandler(payload) : false;
        Serial.println(ok ? "BLE: System command processed" : "BLE: System command handler failed");
        if (ok) markConfigDirty();
    }

    if (dequeueSystemPayload(payload)) {
        bool ok = systemWriteHandler ? systemWriteHandler(payload) : false;
        Serial.println(ok ? "BLE: System command processed" : "BLE: System command handler failed");
        if (ok) markConfigDirty();
    }
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
