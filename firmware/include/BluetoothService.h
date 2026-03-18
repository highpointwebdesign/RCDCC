#ifndef BLUETOOTH_SERVICE_H
#define BLUETOOTH_SERVICE_H

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <freertos/semphr.h>
#include <functional>
#include <string>
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

    SemaphoreHandle_t queueMutex = nullptr;
    static constexpr size_t CONFIG_CACHE_CAPACITY = 1024;
    char cachedConfigBuffer[CONFIG_CACHE_CAPACITY] = "{\"status\":\"booting\"}";
    size_t cachedConfigLength = 20;
    volatile bool configCacheDirty = true;
    static constexpr size_t SCOPE_BUF_SIZE = 32;
    char activeReadScope[SCOPE_BUF_SIZE] = "bootstrap";
    int32_t activeReadChunk = 0;
    String cachedScopePayload;
    String cachedScopePayloadScope;
    // Chunk size must fit inside one ATT Read Response: MTU(247) - 1(opcode) = 246 bytes
    // Envelope overhead is ~88 bytes, leaving 158 bytes for payload -> use 150 for safety.
    static constexpr size_t CONFIG_CHUNK_SIZE = 150;

    static constexpr size_t CONFIG_WRITE_CAPACITY = 2048;
    static constexpr size_t KV_WRITE_CAPACITY = 256;
    static constexpr size_t SERVO_WRITE_CAPACITY = 256;
    static constexpr size_t LIGHTS_WRITE_CAPACITY = 4096;
    static constexpr size_t SYSTEM_WRITE_CAPACITY = 256;
    char pendingConfigWrite[CONFIG_WRITE_CAPACITY] = {};
    char pendingKvWrite[KV_WRITE_CAPACITY] = {};
    char pendingServoWrite[SERVO_WRITE_CAPACITY] = {};
    char pendingLightsWrite[LIGHTS_WRITE_CAPACITY] = {};
    char pendingLightsMasterSystemWrite[SYSTEM_WRITE_CAPACITY] = {};
    static constexpr size_t SYSTEM_QUEUE_CAPACITY = 8;
    char pendingSystemWrites[SYSTEM_QUEUE_CAPACITY][SYSTEM_WRITE_CAPACITY] = {};
    size_t pendingSystemHead = 0;
    size_t pendingSystemTail = 0;
    size_t pendingSystemCount = 0;
    volatile bool hasPendingConfigWrite = false;
    volatile bool hasPendingKvWrite = false;
    volatile bool hasPendingServoWrite = false;
    volatile bool hasPendingLightsWrite = false;
    volatile bool hasPendingLightsMasterSystemWrite = false;
    volatile bool hasPendingSystemWrite = false;
    volatile bool hasPendingConnectionStateChange = false;
    volatile bool pendingConnectionState = false;

    bool isLightsMasterSystemCommand(const String& payload) {
        // Fast-path matcher to coalesce master-light toggles without parsing overhead.
        return payload.indexOf("\"command\"") >= 0 && payload.indexOf("lights_master") >= 0;
    }

    bool isConfigReadControlCommand(const String& payload) {
        // These commands only paginate config reads and must not invalidate cache.
        return payload.indexOf("cfg_read_prepare") >= 0
            || payload.indexOf("cfg_read_chunk") >= 0
            || payload.indexOf("lights_group_index") >= 0
            || payload.indexOf("lights_group_detail") >= 0;
    }

    bool isLightsMasterSystemCommand(const std::string& payload) {
        return payload.find("\"command\"") != std::string::npos
            && payload.find("lights_master") != std::string::npos;
    }

    bool lockQueue(TickType_t timeout = portMAX_DELAY) {
        return queueMutex == nullptr || xSemaphoreTake(queueMutex, timeout) == pdTRUE;
    }

    void unlockQueue() {
        if (queueMutex != nullptr) {
            xSemaphoreGive(queueMutex);
        }
    }

    bool queuePayload(char* slot, size_t capacity, volatile bool& hasPending, const std::string& payload) {
        if (payload.empty() || payload.size() >= capacity) {
            return false;
        }
        if (!lockQueue()) {
            return false;
        }
        memcpy(slot, payload.c_str(), payload.size() + 1);
        hasPending = true;
        unlockQueue();
        return true;
    }

    bool dequeuePayload(char* slot, size_t capacity, volatile bool& hasPending, String& out) {
        bool dequeued = false;
        if (!slot || capacity == 0) return false;

        static char localCopy[LIGHTS_WRITE_CAPACITY];
        localCopy[0] = '\0';

        // Copy raw bytes while protected by the spinlock; convert to String later.
        if (!lockQueue()) {
            return false;
        }
        if (hasPending) {
            size_t copyLen = strnlen(slot, capacity - 1);
            memcpy(localCopy, slot, copyLen);
            localCopy[copyLen] = '\0';
            hasPending = false;
            slot[0] = '\0';
            dequeued = true;
        }
        unlockQueue();
        if (dequeued) {
            out = localCopy;
        }
        return dequeued;
    }

    bool queueSystemPayload(const std::string& payload) {
        if (payload.empty()) {
            return false;
        }

        const bool isMasterCommand = isLightsMasterSystemCommand(payload);

        bool queued = false;
        if (!lockQueue()) {
            return false;
        }
        if (isMasterCommand) {
            if (payload.size() < SYSTEM_WRITE_CAPACITY) {
                memcpy(pendingLightsMasterSystemWrite, payload.c_str(), payload.size() + 1);
            } else {
                pendingLightsMasterSystemWrite[0] = '\0';
            }
            hasPendingLightsMasterSystemWrite = true;
            queued = (payload.size() < SYSTEM_WRITE_CAPACITY);
        } else if (pendingSystemCount < SYSTEM_QUEUE_CAPACITY) {
            if (payload.size() < SYSTEM_WRITE_CAPACITY) {
                memcpy(pendingSystemWrites[pendingSystemTail], payload.c_str(), payload.size() + 1);
                pendingSystemTail = (pendingSystemTail + 1) % SYSTEM_QUEUE_CAPACITY;
                pendingSystemCount++;
                hasPendingSystemWrite = true;
                queued = true;
            }
        }
        unlockQueue();
        return queued;
    }

    bool dequeueSystemPayload(String& out) {
        bool dequeued = false;
        char localCopy[SYSTEM_WRITE_CAPACITY];
        localCopy[0] = '\0';
        if (!lockQueue()) {
            return false;
        }
        if (pendingSystemCount > 0) {
            const size_t headSnap = pendingSystemHead;
            size_t copyLen = strnlen(pendingSystemWrites[headSnap], SYSTEM_WRITE_CAPACITY - 1);
            memcpy(localCopy, pendingSystemWrites[headSnap], copyLen);
            localCopy[copyLen] = '\0';
            pendingSystemWrites[headSnap][0] = '\0';
            pendingSystemHead = (pendingSystemHead + 1) % SYSTEM_QUEUE_CAPACITY;
            pendingSystemCount--;
            hasPendingSystemWrite = (pendingSystemCount > 0);
            dequeued = true;
        }
        unlockQueue();
        if (dequeued) {
            out = localCopy;
        }
        return dequeued;
    }

    bool dequeueLightsMasterSystemPayload(String& out) {
        bool dequeued = false;
        char localCopy[SYSTEM_WRITE_CAPACITY];
        localCopy[0] = '\0';
        if (!lockQueue()) {
            return false;
        }
        if (hasPendingLightsMasterSystemWrite) {
            size_t copyLen = strnlen(pendingLightsMasterSystemWrite, SYSTEM_WRITE_CAPACITY - 1);
            memcpy(localCopy, pendingLightsMasterSystemWrite, copyLen);
            localCopy[copyLen] = '\0';
            hasPendingLightsMasterSystemWrite = false;
            pendingLightsMasterSystemWrite[0] = '\0';
            dequeued = true;
        }
        unlockQueue();
        if (dequeued) {
            out = localCopy;
        }
        return dequeued;
    }

    void queueConnectionStateChange(bool connected) {
        if (!lockQueue()) {
            return;
        }
        pendingConnectionState = connected;
        hasPendingConnectionStateChange = true;
        unlockQueue();
    }

    bool dequeueConnectionStateChange(bool& connected) {
        bool dequeued = false;
        if (!lockQueue()) {
            return false;
        }
        if (hasPendingConnectionStateChange) {
            connected = pendingConnectionState;
            hasPendingConnectionStateChange = false;
            dequeued = true;
        }
        unlockQueue();
        return dequeued;
    }

    String getCachedConfigSnapshot() {
        // Use the char buffer — never do String assignment inside a critical section.
        char localBuf[CONFIG_CACHE_CAPACITY];
        size_t len;
        if (!lockQueue()) {
            return String(F("{\"status\":\"booting\"}"));
        }
        len = cachedConfigLength;
        memcpy(localBuf, cachedConfigBuffer, len + 1); // memcpy is ISR-safe
        unlockQueue();
        if (len == 0) return String(F("{\"status\":\"booting\"}"));
        return String(localBuf); // heap alloc outside critical section
    }

    void markConfigDirty() {
        if (!lockQueue()) {
            return;
        }
        configCacheDirty = true;
        unlockQueue();
    }

    void buildChunkedSnapshot() {
        if (!storage) return;

        // Copy primitive values inside the critical section.
        // Never do String assignment (heap alloc) inside taskENTER_CRITICAL.
        char scopeBuf[SCOPE_BUF_SIZE] = "bootstrap";
        int32_t chunk = 0;
        bool shouldRebuildPayload = false;
        if (!lockQueue()) {
            return;
        }
        size_t scopeLen = strnlen(activeReadScope, SCOPE_BUF_SIZE - 1);
        if (scopeLen > 0) memcpy(scopeBuf, activeReadScope, scopeLen + 1);
        chunk = activeReadChunk;
        shouldRebuildPayload = configCacheDirty;
        unlockQueue();

        String scope = scopeBuf; // String construction outside critical section
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

        // Only safe (non-allocating) operations inside the critical section.
        size_t copyLen = snapshot.length();
        if (copyLen >= CONFIG_CACHE_CAPACITY) copyLen = CONFIG_CACHE_CAPACITY - 1;
        if (!lockQueue()) {
            return;
        }
        memcpy(cachedConfigBuffer, snapshot.c_str(), copyLen);
        cachedConfigBuffer[copyLen] = '\0';
        cachedConfigLength = copyLen;
        configCacheDirty = false;
        unlockQueue();
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
        if (!lockQueue()) {
            return;
        }
        if (scope.length() > 0 && scope.length() < SCOPE_BUF_SIZE) {
            memcpy(activeReadScope, scope.c_str(), scope.length() + 1); // memcpy is ISR-safe
            activeReadChunk = 0;
        }
        configCacheDirty = true;
        unlockQueue();
    }

    void requestConfigChunk(int32_t chunkIndex) {
        if (!lockQueue()) {
            return;
        }
        activeReadChunk = chunkIndex < 0 ? 0 : chunkIndex;
        // Chunk paging should reuse the existing scope snapshot.
        // Rebuild is only needed when scope changes or data is marked dirty by writes.
        configCacheDirty = false;
        unlockQueue();
    }

    // Push an immediate JSON reply for the next config-read characteristic fetch.
    // Used by lightweight system commands to avoid rebuilding large scoped snapshots.
    void setDirectConfigReadResponse(const String& json) {
        size_t copyLen = json.length();
        if (copyLen >= CONFIG_CACHE_CAPACITY) copyLen = CONFIG_CACHE_CAPACITY - 1;

        if (!lockQueue()) {
            return;
        }
        memcpy(cachedConfigBuffer, json.c_str(), copyLen);
        cachedConfigBuffer[copyLen] = '\0';
        cachedConfigLength = copyLen;
        configCacheDirty = false;
        unlockQueue();
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
        service->queueConnectionStateChange(true);
    }
    
    void onDisconnect(BLEServer* pServer) {
        service->deviceConnected = false;
        service->queueConnectionStateChange(false);
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
        // Snapshot under lock to avoid cross-core races while update() refreshes cache.
        static char localBuf[BluetoothService::CONFIG_CACHE_CAPACITY];
        localBuf[0] = '\0';
        size_t localLen = 0;
        if (!service->lockQueue()) {
            pCharacteristic->setValue(reinterpret_cast<uint8_t*>(localBuf), 0);
            return;
        }
        localLen = service->cachedConfigLength;
        if (localLen >= BluetoothService::CONFIG_CACHE_CAPACITY) {
            localLen = BluetoothService::CONFIG_CACHE_CAPACITY - 1;
        }
        memcpy(localBuf, service->cachedConfigBuffer, localLen);
        localBuf[localLen] = '\0';
        service->unlockQueue();

        pCharacteristic->setValue(reinterpret_cast<uint8_t*>(localBuf), localLen);
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
            if (!service->queuePayload(service->pendingConfigWrite, BluetoothService::CONFIG_WRITE_CAPACITY, service->hasPendingConfigWrite, value)) {
                Serial.println("BLE: Config write dropped");
            }
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
            if (!service->queuePayload(service->pendingKvWrite, BluetoothService::KV_WRITE_CAPACITY, service->hasPendingKvWrite, value)) {
                Serial.println("BLE: KV write dropped");
            }
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
            if (!service->queuePayload(service->pendingServoWrite, BluetoothService::SERVO_WRITE_CAPACITY, service->hasPendingServoWrite, value)) {
                Serial.println("BLE: Servo command dropped");
            }
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
            if (!service->queuePayload(service->pendingLightsWrite, BluetoothService::LIGHTS_WRITE_CAPACITY, service->hasPendingLightsWrite, value)) {
                Serial.println("BLE: Lights command dropped");
            }
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
            if (!service->queueSystemPayload(value)) {
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
    queueMutex = xSemaphoreCreateMutex();
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
    bool connected = false;
    if (dequeueConnectionStateChange(connected)) {
        if (connectionStateHandler) {
            connectionStateHandler(connected);
        }
        Serial.println(connected ? "BLE Client connected" : "BLE Client disconnected");
    }

    if (storage && (configCacheDirty || cachedConfigLength == 0)) {
        buildChunkedSnapshot();
    }

    String payload;

    if (dequeuePayload(pendingConfigWrite, CONFIG_WRITE_CAPACITY, hasPendingConfigWrite, payload)) {
        bool ok = configWriteHandler ? configWriteHandler(payload) : false;
        Serial.println(ok ? "BLE: Config saved successfully" : "BLE: Config write handler failed");
        if (ok) markConfigDirty();
    }

    if (dequeuePayload(pendingKvWrite, KV_WRITE_CAPACITY, hasPendingKvWrite, payload)) {
        bool ok = kvWriteHandler ? kvWriteHandler(payload) : false;
        if (!ok) Serial.println("BLE: KV write handler failed");
        if (ok) markConfigDirty();
    }

    if (dequeuePayload(pendingServoWrite, SERVO_WRITE_CAPACITY, hasPendingServoWrite, payload)) {
        bool ok = servoWriteHandler ? servoWriteHandler(payload) : false;
        Serial.println(ok ? "BLE: Servo command processed" : "BLE: Servo command handler failed");
        if (ok) markConfigDirty();
    }

    if (dequeuePayload(pendingLightsWrite, LIGHTS_WRITE_CAPACITY, hasPendingLightsWrite, payload)) {
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
        if (ok && !isConfigReadControlCommand(payload)) {
            markConfigDirty();
        }
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
