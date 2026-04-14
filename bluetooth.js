// ====================================================================================
// Bluetooth Low Energy Manager for ESP32 RCDCC Communication
// ====================================================================================
// CAPACITOR NATIVE VERSION
// Uses @capacitor-community/bluetooth-le instead of Web Bluetooth API.
// This provides true native BLE access including background reconnect support.
//
// All public method signatures are IDENTICAL to the original Web Bluetooth version
// so app.js requires zero changes.
//
// Architecture:
// - Service UUID: Identifies the RCDCC device
// - Characteristics: Different "channels" for config, telemetry, commands, etc.
// - Notifications: Push-based telemetry updates
// ====================================================================================

class BluetoothManager {
    constructor() {
        // Service and characteristic UUIDs (must match ESP32 firmware)
        this.SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
        this.CHAR_CONFIG_READ  = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
        this.CHAR_CONFIG_WRITE = '1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e';
        this.CHAR_TELEMETRY    = 'd8de624e-140f-4a22-8594-e2216b84a5f2';
        this.CHAR_SERVO_CMD    = 'e8a3c5f2-4b9d-11ec-81d3-0242ac130003';
        this.CHAR_SYSTEM_CMD   = '068c1d3a-4b9e-11ec-81d3-0242ac130003';
        this.PREFERRED_DEVICE_ID_KEY = 'rcdccBlePreferredDeviceId';

        // BLE state
        this.deviceId = null;           // Capacitor uses string device IDs
        this.deviceName = null;
        this.isConnected = false;
        this.isConnecting = false;
        this.preferredDeviceId = localStorage.getItem(this.PREFERRED_DEVICE_ID_KEY) || null;
        this.gattOperationChain = Promise.resolve();

        // Callbacks
        this.telemetryCallback = null;
        this.onDisconnect = null;

        // Statistics
        this.stats = {
            bytesReceived: 0,
            bytesSent: 0,
            telemetryPackets: 0,
            lastLatency: 0
        };

        // BleClient reference — resolved after Capacitor is ready
        this._ble = null;
    }

    // -------------------------------------------------------------------------
    // Internal: get BleClient, waiting for Capacitor to be ready if needed
    // -------------------------------------------------------------------------
    async _getBle() {
        if (this._ble) return this._ble;

        // Wait for Capacitor plugins to be available
        await this._waitForCapacitor();
        this._ble = window.CapacitorBluetoothLe.BleClient;
        await this._ble.initialize();
        return this._ble;
    }

    _waitForCapacitor() {
        return new Promise((resolve, reject) => {
            const maxWait = 5000;
            const interval = 100;
            let elapsed = 0;

            const check = () => {
                if (window.CapacitorBluetoothLe && window.CapacitorBluetoothLe.BleClient) {
                    resolve();
                } else if (elapsed >= maxWait) {
                    reject(new Error('Capacitor BLE plugin not available. Make sure the app was built with @capacitor-community/bluetooth-le.'));
                } else {
                    elapsed += interval;
                    setTimeout(check, interval);
                }
            };
            check();
        });
    }

    // -------------------------------------------------------------------------
    // Helpers: encode/decode
    // -------------------------------------------------------------------------
    _encodeJson(obj) {
        const json = JSON.stringify(obj);
        const bytes = new TextEncoder().encode(json);
        // Capacitor BLE expects a DataView
        const buf = new ArrayBuffer(bytes.length);
        const view = new DataView(buf);
        bytes.forEach((b, i) => view.setUint8(i, b));
        return view;
    }

    _decodeDataView(dataView) {
        const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
        return new TextDecoder('utf-8').decode(bytes);
    }

    // -------------------------------------------------------------------------
    // isSupported — always true in native app, but check plugin availability
    // -------------------------------------------------------------------------
    isSupported() {
        return !!(window.CapacitorBluetoothLe && window.CapacitorBluetoothLe.BleClient);
    }

    getConnectionStatus() {
        return this.isConnected;
    }

    // -------------------------------------------------------------------------
    // connect — show device picker then connect (requires user gesture)
    // -------------------------------------------------------------------------
    async connect() {
        if (this.isConnecting) throw new Error('Connection already in progress');
        if (this.isConnected) return true;

        this.isConnecting = true;
        try {
            const ble = await this._getBle();

            // Request device — show picker filtered to our service UUID
            const device = await ble.requestDevice({
                services: [this.SERVICE_UUID]
            });

            if (!device) throw new Error('No device selected');

            await this._connectToDeviceId(ble, device.deviceId, device.name || 'RCDCC');
            return true;

        } catch (error) {
            this._resetConnectionState();
            if (error.message && error.message.includes('cancelled')) {
                throw new Error('Device selection cancelled');
            }
            throw error;
        } finally {
            this.isConnecting = false;
        }
    }

    // -------------------------------------------------------------------------
    // connectToKnownDevice — silent reconnect using stored device ID
    // Called automatically by the auto-reconnect timer in app.js
    // -------------------------------------------------------------------------
    async connectToKnownDevice() {
        if (this.isConnected) return true;
        if (this.isConnecting) return false;
        if (!this.preferredDeviceId) return false;

        this.isConnecting = true;
        try {
            const ble = await this._getBle();
            await this._connectToDeviceId(ble, this.preferredDeviceId, null);
            return true;
        } catch (error) {
            console.debug('Auto reconnect to known device failed:', error.message || error);
            this._resetConnectionState();
            return false;
        } finally {
            this.isConnecting = false;
        }
    }

    // -------------------------------------------------------------------------
    // Internal: connect to a specific deviceId string
    // -------------------------------------------------------------------------
    async _connectToDeviceId(ble, deviceId, deviceName) {
        console.log('Connecting to device:', deviceId);

        // Register disconnect handler BEFORE connecting
        await ble.connect(deviceId, (disconnectedDeviceId) => {
            console.warn('⚠️ BLE device disconnected:', disconnectedDeviceId);
            this._resetConnectionState();
            if (this.onDisconnect) this.onDisconnect();
        });

        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.isConnected = true;

        // Save as preferred device for future reconnects
        this.preferredDeviceId = deviceId;
        localStorage.setItem(this.PREFERRED_DEVICE_ID_KEY, deviceId);

        // Subscribe to telemetry notifications
        await this._subscribeTelemetry(ble);

        console.log('✅ BLE connection successful, device:', deviceId);
    }

    // -------------------------------------------------------------------------
    // disconnect
    // -------------------------------------------------------------------------
    async disconnect() {
        if (!this.isConnected || !this.deviceId) return;

        try {
            const ble = await this._getBle();

            // Stop telemetry notifications first
            try {
                await ble.stopNotifications(this.deviceId, this.SERVICE_UUID, this.CHAR_TELEMETRY);
            } catch (e) {
                // Best effort — ignore if already stopped
            }

            await ble.disconnect(this.deviceId);
            console.log('✅ BLE disconnected successfully');
        } catch (error) {
            console.error('Error during disconnect:', error);
        } finally {
            this._resetConnectionState();
        }
    }

    // -------------------------------------------------------------------------
    // readConfig — read JSON config from ESP32
    // -------------------------------------------------------------------------
    async readConfig() {
        if (!this.isConnected) throw new Error('Not connected to BLE device');

        const startTime = performance.now();
        const ble = await this._getBle();

        const dataView = await this.enqueueGattOperation('read-config', () =>
            ble.read(this.deviceId, this.SERVICE_UUID, this.CHAR_CONFIG_READ)
        );

        const jsonString = this._decodeDataView(dataView);
        const config = JSON.parse(jsonString);

        const latency = performance.now() - startTime;
        this.stats.lastLatency = latency;
        this.stats.bytesReceived += jsonString.length;

        console.log(`📥 Config received via BLE (${latency.toFixed(1)}ms, ${jsonString.length} bytes)`);
        return config;
    }

    // -------------------------------------------------------------------------
    // writeConfig — send JSON config to ESP32
    // -------------------------------------------------------------------------
    async writeConfig(config) {
        if (!this.isConnected) throw new Error('Not connected to BLE device');

        const startTime = performance.now();
        const ble = await this._getBle();
        const data = this._encodeJson(config);

        const MAX_CHUNK_SIZE = 512;
        if (data.byteLength > MAX_CHUNK_SIZE) {
            console.warn(`⚠️ Config size (${data.byteLength} bytes) exceeds MTU. Consider chunking.`);
        }

        await this.enqueueGattOperation('write-config', () =>
            ble.write(this.deviceId, this.SERVICE_UUID, this.CHAR_CONFIG_WRITE, data)
        );

        const latency = performance.now() - startTime;
        this.stats.lastLatency = latency;
        this.stats.bytesSent += data.byteLength;

        console.log(`📤 Config sent via BLE (${latency.toFixed(1)}ms, ${data.byteLength} bytes)`);
    }

    // -------------------------------------------------------------------------
    // sendServoCommand
    // -------------------------------------------------------------------------
    async sendServoCommand(servoConfig) {
        if (!this.isConnected) throw new Error('Not connected to BLE device');

        const ble = await this._getBle();
        const data = this._encodeJson(servoConfig);

        await this.enqueueGattOperation('write-servo', () =>
            ble.write(this.deviceId, this.SERVICE_UUID, this.CHAR_SERVO_CMD, data)
        );
        this.stats.bytesSent += data.byteLength;
        console.log('📤 Servo command sent via BLE');
    }

    async sendLightsCommand(lightsConfig) {
        throw new Error('Lighting features have been removed');
    }

    // -------------------------------------------------------------------------
    // sendSystemCommand
    // -------------------------------------------------------------------------
    async sendSystemCommand(command, params = {}) {
        if (!this.isConnected) throw new Error('Not connected to BLE device');

        const ble = await this._getBle();
        const payload = { command, ...params };
        const data = this._encodeJson(payload);

        await this.enqueueGattOperation('write-system', () =>
            ble.write(this.deviceId, this.SERVICE_UUID, this.CHAR_SYSTEM_CMD, data)
        );
        this.stats.bytesSent += data.byteLength;
        console.log(`📤 System command '${command}' sent via BLE`);
    }

    // -------------------------------------------------------------------------
    // Telemetry notifications
    // -------------------------------------------------------------------------
    async _subscribeTelemetry(ble) {
        await this.enqueueGattOperation('start-telemetry-notifications', () =>
            ble.startNotifications(
                this.deviceId,
                this.SERVICE_UUID,
                this.CHAR_TELEMETRY,
                (dataView) => this._handleTelemetryNotification(dataView)
            )
        );
        console.log('✅ Subscribed to telemetry notifications');
    }

    _handleTelemetryNotification(dataView) {
        try {
            // Telemetry format: 5 floats (20 bytes) [roll, pitch, accelX, accelY, accelZ]
            if (dataView.byteLength !== 20) {
                console.warn('Unexpected telemetry packet size:', dataView.byteLength);
                return;
            }

            const roll   = dataView.getFloat32(0, true);
            const pitch  = dataView.getFloat32(4, true);
            const accelX = dataView.getFloat32(8, true);
            const accelY = dataView.getFloat32(12, true);
            const accelZ = dataView.getFloat32(16, true);

            this.stats.bytesReceived += 20;
            this.stats.telemetryPackets++;

            const telemetry = { roll, pitch, accelX, accelY, accelZ, timestamp: Date.now() };

            if (this.telemetryCallback) {
                this.telemetryCallback(telemetry);
            }
        } catch (error) {
            console.error('Error parsing telemetry notification:', error);
        }
    }

    // -------------------------------------------------------------------------
    // GATT operation queue — prevents overlapping BLE operations
    // -------------------------------------------------------------------------
    enqueueGattOperation(opName, operation) {
        if (typeof operation !== 'function') throw new Error('Invalid GATT operation');

        const run = async () => {
            if (!this.isConnected) throw new Error('Bluetooth LE not connected');
            return operation();
        };

        const next = this.gattOperationChain.then(run, run);
        this.gattOperationChain = next.catch(() => {});
        return next;
    }

    // -------------------------------------------------------------------------
    // Callbacks
    // -------------------------------------------------------------------------
    setTelemetryCallback(callback) {
        this.telemetryCallback = callback;
    }

    setDisconnectCallback(callback) {
        this.onDisconnect = callback;
    }

    // -------------------------------------------------------------------------
    // Stats
    // -------------------------------------------------------------------------
    getStats() {
        return {
            ...this.stats,
            isConnected: this.isConnected,
            deviceName: this.deviceName,
            deviceId: this.deviceId
        };
    }

    resetStats() {
        this.stats = { bytesReceived: 0, bytesSent: 0, telemetryPackets: 0, lastLatency: 0 };
    }

    // -------------------------------------------------------------------------
    // Internal reset
    // -------------------------------------------------------------------------
    _resetConnectionState() {
        this.isConnected = false;
        this.isConnecting = false;
        this.deviceId = null;
        this.deviceName = null;
        this.gattOperationChain = Promise.resolve();
    }

    // Legacy alias used by a few places in app.js
    resetConnectionState() {
        this._resetConnectionState();
    }
}

// Export for use in app.js (same as original)
window.BluetoothManager = BluetoothManager;
