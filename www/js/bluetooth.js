// ====================================================================================
// Bluetooth Low Energy Manager for ESP32 RCDCC Communication
// ====================================================================================
// CAPACITOR NATIVE VERSION - All BLE calls use named object parameters
// ====================================================================================

const RCDCC_KEYS = {
    SERVO_FL_TRIM:        'srv_fl.trim',
    SERVO_FL_MIN:         'srv_fl.min',
    SERVO_FL_MAX:         'srv_fl.max',
    SERVO_FL_REVERSE:     'srv_fl.reverse',
    SERVO_FL_RIDE_HT:     'srv_fl.ride_ht',
    SERVO_FL_LABEL:       'srv_fl.label',
    SERVO_FR_TRIM:        'srv_fr.trim',
    SERVO_FR_MIN:         'srv_fr.min',
    SERVO_FR_MAX:         'srv_fr.max',
    SERVO_FR_REVERSE:     'srv_fr.reverse',
    SERVO_FR_RIDE_HT:     'srv_fr.ride_ht',
    SERVO_FR_LABEL:       'srv_fr.label',
    SERVO_RL_TRIM:        'srv_rl.trim',
    SERVO_RL_MIN:         'srv_rl.min',
    SERVO_RL_MAX:         'srv_rl.max',
    SERVO_RL_REVERSE:     'srv_rl.reverse',
    SERVO_RL_RIDE_HT:     'srv_rl.ride_ht',
    SERVO_RL_LABEL:       'srv_rl.label',
    SERVO_RR_TRIM:        'srv_rr.trim',
    SERVO_RR_MIN:         'srv_rr.min',
    SERVO_RR_MAX:         'srv_rr.max',
    SERVO_RR_REVERSE:     'srv_rr.reverse',
    SERVO_RR_RIDE_HT:     'srv_rr.ride_ht',
    SERVO_RR_LABEL:       'srv_rr.label',
    SUSPENSION_DAMPING:   'suspension.damping',
    SUSPENSION_STIFFNESS: 'suspension.stiffness',
    SUSPENSION_REACT_SPD: 'suspension.react_spd',
    SUSPENSION_FR_BAL:    'suspension.fr_balance',
    IMU_ORIENT:           'imu.orient',
    IMU_ROLL_TRIM:        'imu.roll_trim',
    IMU_PITCH_TRIM:       'imu.pitch_trim',
    SYSTEM_DEVICE_NM:     'system.device_nm',
};

/**
 * Build a dotted NVS key for an aux servo slot.
 * @param {number} index  0-9
 * @param {string} key    e.g. 'label', 'trim', 'state'
 * @returns {string}      e.g. 'srv_aux_00.label'
 * Phase 4
 */
function auxServoKey(index, key) {
    return `srv_aux_${index.toString().padStart(2, '0')}.${key}`;
}

class BluetoothManager {
    constructor() {
        this.SERVICE_UUID      = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
        this.CHAR_CONFIG_READ  = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
        this.CHAR_CONFIG_WRITE = '1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e';
        this.CHAR_KV_WRITE     = '7c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e';
        this.CHAR_TELEMETRY    = 'd8de624e-140f-4a22-8594-e2216b84a5f2';
        this.CHAR_SERVO_CMD    = 'e8a3c5f2-4b9d-11ec-81d3-0242ac130003';
        this.CHAR_LIGHTS_CMD   = 'f2b4d6e8-4b9d-11ec-81d3-0242ac130003';
        this.CHAR_SYSTEM_CMD   = '068c1d3a-4b9e-11ec-81d3-0242ac130003';
        this.PREFERRED_DEVICE_ID_KEY = 'rcdccBlePreferredDeviceId';

        this.deviceId   = null;
        this.deviceName = null;
        this.isConnected  = false;
        this.isConnecting = false;
        this.connectPromise = null;
        this.preferredDeviceId = localStorage.getItem(this.PREFERRED_DEVICE_ID_KEY) || null;
        this.gattOperationChain = Promise.resolve();
        this.telemetryCallback = null;
        this.onDisconnect = null;
        this.stats = { bytesReceived: 0, bytesSent: 0, telemetryPackets: 0, lastLatency: 0 };
        this.lastKnownSavedState = null;
        this.firmwareVersion = null;
        this.supportsKvUpdates = false;
        this.isLegacyPath = true;
        this.writeFailureCallback = null;
        this._ble = null;
    }

    _compareSemver(a, b) {
        const parse = (v) => String(v || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
        const va = parse(a);
        const vb = parse(b);
        for (let i = 0; i < Math.max(va.length, vb.length); i++) {
            const da = va[i] || 0;
            const db = vb[i] || 0;
            if (da > db) return 1;
            if (da < db) return -1;
        }
        return 0;
    }

    _ensureLegacyBanner() {
        let banner = document.getElementById('legacyFirmwareBanner');
        if (banner) return banner;

        banner = document.createElement('div');
        banner.id = 'legacyFirmwareBanner';
        banner.style.cssText = 'display:none;position:sticky;top:0;z-index:9998;padding:10px 14px;background:#3b2f00;color:#ffe08a;border-bottom:1px solid #8a6f00;font-size:0.875rem;font-weight:600;text-align:center;';
        banner.textContent = 'Firmware update recommended for best performance.';
        document.body.prepend(banner);
        return banner;
    }

    _setLegacyBannerVisible(visible) {
        const banner = this._ensureLegacyBanner();
        banner.style.display = visible ? 'block' : 'none';
    }

    _updateFirmwareCapabilities(config) {
        this.firmwareVersion = config && (config.fw_version || (config.system && config.system.fw_version))
            ? (config.fw_version || config.system.fw_version)
            : null;
        this.supportsKvUpdates = this.firmwareVersion
            ? this._compareSemver(this.firmwareVersion, '2.0.0') >= 0
            : false;
        this.isLegacyPath = !this.supportsKvUpdates;
        this._setLegacyBannerVisible(this.isLegacyPath);
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

    _isRcdccDeviceName(name) {
        return String(name || '').toUpperCase().startsWith('RCDCC');
    }

    async connect() {
        if (this.isConnecting) {
            return this.connectPromise || false;
        }
        if (this.isConnected) return true;
        this.isConnecting = true;
        this.connectPromise = (async () => {
        try {
            const ble = await this._getBle();
            // Requirement: only discover RCDCC-prefixed ESP32 devices
            // (e.g., RCDCCA1B2C3 where suffix is last 6 of MAC address).
            const device = await ble.requestDevice({
                namePrefix: 'RCDCC',
                optionalServices: [this.SERVICE_UUID]
            });
            if (!device) throw new Error('No device selected');

            // Extra safety in case a platform picker ignores the prefix filter.
            if (!this._isRcdccDeviceName(device.name)) {
                throw new Error('Selected device is not an RCDCC unit');
            }

            await this._connectToDeviceId(ble, device.deviceId, device.name || 'RCDCC');
            return true;
        } catch (error) {
            this._resetConnectionState();
            if (error.message && error.message.includes('cancelled')) throw new Error('Device selection cancelled');
            throw error;
        } finally {
            this.isConnecting = false;
            this.connectPromise = null;
        }
        })();

        return this.connectPromise;
    }

    async connectToKnownDevice() {
        if (this.isConnected) return true;
        if (this.isConnecting) {
            return this.connectPromise || false;
        }
        if (!this.preferredDeviceId) return false;
        this.isConnecting = true;
        this.connectPromise = (async () => {
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
            this.connectPromise = null;
        }
        })();

        return this.connectPromise;
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

        // Phase 1 connect flow: negotiate MTU first (already done above), then read full config once.
        try {
            const config = await this.readConfig();
            this.lastKnownSavedState = config;
            this._updateFirmwareCapabilities(config);
        } catch (e) {
            console.warn('Initial config sync after BLE connect failed:', e.message || e);
        }

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

    async writeValue(key, value) {
        if (!this.isConnected) throw new Error('Not connected to BLE device');
        const ble = await this._getBle();
        const payload = this._encodeJson({ key, value });

        try {
            await this.enqueueGattOperation('write-kv', () =>
                ble.write({
                    deviceId: this.deviceId,
                    service: this.SERVICE_UUID,
                    characteristic: this.CHAR_KV_WRITE,
                    value: payload
                })
            );
        } catch (error) {
            if (typeof this.writeFailureCallback === 'function') {
                this.writeFailureCallback({ type: 'kv', key, value, error });
            }
            throw error;
        }

        this.stats.bytesSent += payload.length;
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

    async sendSaveCommandWithTimeout(timeoutMs = 3000) {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Save timed out')), timeoutMs);
        });
        return Promise.race([this.sendSystemCommand('save'), timeoutPromise]);
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
    setWriteFailureCallback(callback) { this.writeFailureCallback = callback; }

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
window.RCDCC_KEYS = RCDCC_KEYS;