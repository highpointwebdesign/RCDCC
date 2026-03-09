// ====================================================================================
// Bluetooth Low Energy Manager for ESP32 RCDCC Communication
// ====================================================================================
// CAPACITOR NATIVE VERSION - All BLE calls use named object parameters
// ====================================================================================

class BluetoothManager {
    constructor() {
        this.SERVICE_UUID      = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
        this.CHAR_CONFIG_READ  = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
        this.CHAR_CONFIG_WRITE = '1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e';
        this.CHAR_TELEMETRY    = 'd8de624e-140f-4a22-8594-e2216b84a5f2';
        this.CHAR_SERVO_CMD    = 'e8a3c5f2-4b9d-11ec-81d3-0242ac130003';
        this.CHAR_LIGHTS_CMD   = 'f2b4d6e8-4b9d-11ec-81d3-0242ac130003';
        this.CHAR_SYSTEM_CMD   = '068c1d3a-4b9e-11ec-81d3-0242ac130003';
        this.PREFERRED_DEVICE_ID_KEY = 'rcdccBlePreferredDeviceId';

        this.deviceId   = null;
        this.deviceName = null;
        this.isConnected  = false;
        this.isConnecting = false;
        this.preferredDeviceId = localStorage.getItem(this.PREFERRED_DEVICE_ID_KEY) || null;
        this.gattOperationChain = Promise.resolve();
        this.telemetryCallback = null;
        this.onDisconnect = null;
        this.stats = { bytesReceived: 0, bytesSent: 0, telemetryPackets: 0, lastLatency: 0 };
        this._ble = null;
    }

    async _getBle() {
        if (this._ble) return this._ble;
        await this._waitForCapacitor();
        this._ble = window.Capacitor.Plugins.BluetoothLe;
        await this._ble.initialize();
        return this._ble;
    }

    _waitForCapacitor() {
        return new Promise((resolve, reject) => {
            const maxWait = 5000;
            const interval = 100;
            let elapsed = 0;
            const check = () => {
                if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BluetoothLe) {
                    resolve();
                } else if (elapsed >= maxWait) {
                    reject(new Error('Capacitor BLE plugin not available.'));
                } else {
                    elapsed += interval;
                    setTimeout(check, interval);
                }
            };
            check();
        });
    }

    _encodeJson(obj) {
        const bytes = new TextEncoder().encode(JSON.stringify(obj));
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    _decodeDataView(payload) {
        // Capacitor BLE can return different payload shapes by platform/plugin version.
        const dataView = payload && payload.value ? payload.value : payload;

        if (!dataView) return '';

        if (typeof dataView === 'string') {
            // Some implementations return a hex string (e.g., "7B22...").
            const maybeHex = dataView.trim();
            if (maybeHex.length >= 2 && maybeHex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(maybeHex)) {
                try {
                    const bytes = new Uint8Array(maybeHex.length / 2);
                    for (let i = 0; i < maybeHex.length; i += 2) {
                        bytes[i / 2] = parseInt(maybeHex.slice(i, i + 2), 16);
                    }
                    return new TextDecoder('utf-8').decode(bytes);
                } catch (e) {
                    console.warn('Failed to decode hex BLE payload:', e.message);
                }
            }

            // Otherwise treat it as already-decoded string.
            return dataView;
        }

        if (dataView.buffer && typeof dataView.byteOffset === 'number' && typeof dataView.byteLength === 'number') {
            return new TextDecoder('utf-8').decode(
                new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength)
            );
        }

        return '';
    }

    isSupported() {
        return !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BluetoothLe);
    }

    getConnectionStatus() { return this.isConnected; }

    async connect() {
        if (this.isConnecting) throw new Error('Connection already in progress');
        if (this.isConnected) return true;
        this.isConnecting = true;
        try {
            const ble = await this._getBle();
            const device = await ble.requestDevice({ services: [this.SERVICE_UUID] });
            if (!device) throw new Error('No device selected');
            await this._connectToDeviceId(ble, device.deviceId, device.name || 'RCDCC');
            return true;
        } catch (error) {
            this._resetConnectionState();
            if (error.message && error.message.includes('cancelled')) throw new Error('Device selection cancelled');
            throw error;
        } finally {
            this.isConnecting = false;
        }
    }

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
            console.debug('Auto reconnect failed:', error.message || error);
            this._resetConnectionState();
            return false;
        } finally {
            this.isConnecting = false;
        }
    }

    async _connectToDeviceId(ble, deviceId, deviceName) {
        console.log('Connecting to device:', deviceId);
        await ble.connect({
            deviceId: deviceId,
            onDisconnected: () => {
                console.warn('BLE device disconnected:', deviceId);
                this._resetConnectionState();
                if (this.onDisconnect) this.onDisconnect();
            }
        });
        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.isConnected = true;
        this.preferredDeviceId = deviceId;
        localStorage.setItem(this.PREFERRED_DEVICE_ID_KEY, deviceId);
        
        // Request larger MTU for bigger data transfers (config with servos ~455 bytes)
        try {
            await ble.requestMtu({ deviceId: deviceId, mtu: 517 });
            console.log('Requested MTU: 517 bytes');
        } catch (e) {
            console.warn('Could not request MTU (might not be supported):', e.message);
        }
        
        // Request high connection priority for better throughput
        try {
            await ble.requestConnectionPriority({ deviceId: deviceId, connectionPriority: 'high' });
            console.log('Requested high connection priority');
        } catch (e) {
            console.warn('Could not set connection priority:', e.message);
        }
        
        await this._subscribeTelemetry(ble);
        console.log('BLE connection successful:', deviceId);
    }

    async disconnect() {
        if (!this.isConnected || !this.deviceId) return;
        try {
            const ble = await this._getBle();
            try {
                await ble.stopNotifications({
                    deviceId: this.deviceId,
                    service: this.SERVICE_UUID,
                    characteristic: this.CHAR_TELEMETRY
                });
            } catch (e) { /* best effort */ }
            await ble.disconnect({ deviceId: this.deviceId });
        } catch (error) {
            console.error('Disconnect error:', error);
        } finally {
            this._resetConnectionState();
        }
    }

    async readConfig() {
        if (!this.isConnected) throw new Error('Not connected to BLE device');
        const startTime = performance.now();
        const ble = await this._getBle();

        let jsonString = '';
        const maxAttempts = 4;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const payload = await this.enqueueGattOperation('read-config', () =>
                ble.read({
                    deviceId: this.deviceId,
                    service: this.SERVICE_UUID,
                    characteristic: this.CHAR_CONFIG_READ
                })
            );

            jsonString = this._decodeDataView(payload).trim();
            if (jsonString.length > 0) {
                if (attempt > 1) {
                    console.log(`BLE config read succeeded on retry ${attempt}/${maxAttempts}`);
                }
                break;
            }

            console.warn(`BLE config read attempt ${attempt}/${maxAttempts} returned empty payload`);
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 80));
            }
        }

        console.log('BLE raw config data received:', jsonString.length, 'bytes');
        console.log('First 100 chars:', jsonString.substring(0, 100));
        console.log('Last 100 chars:', jsonString.substring(Math.max(0, jsonString.length - 100)));
        
        try {
            const config = JSON.parse(jsonString);
            const latency = performance.now() - startTime;
            this.stats.lastLatency = latency;
            this.stats.bytesReceived += jsonString.length;
            console.log('Config received via BLE (' + latency.toFixed(1) + 'ms, ' + jsonString.length + ' bytes)');
            return config;
        } catch (error) {
            console.error('Failed to parse config JSON:', error);
            console.error('Full raw data:', jsonString);
            throw new Error(`Invalid JSON from device: ${error.message}. Check device firmware.`);
        }
    }

    async writeConfig(config) {
        if (!this.isConnected) throw new Error('Not connected to BLE device');
        const startTime = performance.now();
        const ble = await this._getBle();
        const data = this._encodeJson(config);
        await this.enqueueGattOperation('write-config', () =>
            ble.write({
                deviceId: this.deviceId,
                service: this.SERVICE_UUID,
                characteristic: this.CHAR_CONFIG_WRITE,
                value: data
            })
        );
        const latency = performance.now() - startTime;
        this.stats.lastLatency = latency;
        this.stats.bytesSent += data.length;
        console.log('Config sent via BLE (' + latency.toFixed(1) + 'ms)');
    }

    async sendServoCommand(servoConfig) {
        if (!this.isConnected) throw new Error('Not connected to BLE device');
        const ble = await this._getBle();
        const data = this._encodeJson(servoConfig);
        await this.enqueueGattOperation('write-servo', () =>
            ble.write({
                deviceId: this.deviceId,
                service: this.SERVICE_UUID,
                characteristic: this.CHAR_SERVO_CMD,
                value: data
            })
        );
        this.stats.bytesSent += data.byteLength;
    }

    async sendLightsCommand(lightsConfig) {
        if (!this.isConnected) throw new Error('Not connected to BLE device');
        const ble = await this._getBle();
        const data = this._encodeJson(lightsConfig);
        await this.enqueueGattOperation('write-lights', () =>
            ble.write({
                deviceId: this.deviceId,
                service: this.SERVICE_UUID,
                characteristic: this.CHAR_LIGHTS_CMD,
                value: data
            })
        );
        this.stats.bytesSent += data.byteLength;
    }

    async sendSystemCommand(command, params = {}) {
        if (!this.isConnected) throw new Error('Not connected to BLE device');
        const ble = await this._getBle();
        const data = this._encodeJson({ command, ...params });
        await this.enqueueGattOperation('write-system', () =>
            ble.write({
                deviceId: this.deviceId,
                service: this.SERVICE_UUID,
                characteristic: this.CHAR_SYSTEM_CMD,
                value: data
            })
        );
        this.stats.bytesSent += data.byteLength;
    }

    async _subscribeTelemetry(ble) {
        await this.enqueueGattOperation('start-telemetry-notifications', () =>
            ble.startNotifications(
                {
                    deviceId: this.deviceId,
                    service: this.SERVICE_UUID,
                    characteristic: this.CHAR_TELEMETRY
                },
                (dataView) => this._handleTelemetryNotification(dataView)
            )
        );
        console.log('Subscribed to telemetry notifications');
    }

    _handleTelemetryNotification(dataView) {
        try {
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
            if (this.telemetryCallback) {
                this.telemetryCallback({ roll, pitch, accelX, accelY, accelZ, timestamp: Date.now() });
            }
        } catch (error) {
            console.error('Error parsing telemetry:', error);
        }
    }

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

    setTelemetryCallback(callback) { this.telemetryCallback = callback; }
    setDisconnectCallback(callback) { this.onDisconnect = callback; }

    getStats() {
        return { ...this.stats, isConnected: this.isConnected, deviceName: this.deviceName, deviceId: this.deviceId };
    }

    resetStats() {
        this.stats = { bytesReceived: 0, bytesSent: 0, telemetryPackets: 0, lastLatency: 0 };
    }

    _resetConnectionState() {
        this.isConnected  = false;
        this.isConnecting = false;
        this.deviceId     = null;
        this.deviceName   = null;
        this.gattOperationChain = Promise.resolve();
    }

    resetConnectionState() { this._resetConnectionState(); }
}

window.BluetoothManager = BluetoothManager;