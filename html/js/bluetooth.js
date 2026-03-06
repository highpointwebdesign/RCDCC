// ====================================================================================
// Bluetooth Low Energy Manager for ESP32 RCDCC Communication
// ====================================================================================
// This module provides BLE connectivity as an alternative to HTTP/WebSocket communication.
// Benefits: Lower latency (~20ms vs ~100ms), less network congestion, better for real-time telemetry.
//
// Architecture:
// - Service UUID: Identifies the RCDCC device
// - Characteristics: Different "channels" for config, telemetry, commands, etc.
// - Notifications: Push-based telemetry updates (replaces HTTP polling)
//
// Web Bluetooth API requires:
// - HTTPS (or localhost for testing)
// - User gesture to initiate connection (button click, etc.)
// - Chrome 56+, Edge 79+, or Samsung Internet 6.2+ (limited Safari iOS 16.4+)
// ====================================================================================

class BluetoothManager {
    constructor() {
        // Service and characteristic UUIDs (must match ESP32 firmware)
        this.SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
        this.CHAR_CONFIG_READ = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
        this.CHAR_CONFIG_WRITE = '1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e';
        this.CHAR_TELEMETRY = 'd8de624e-140f-4a22-8594-e2216b84a5f2';
        this.CHAR_SERVO_CMD = 'e8a3c5f2-4b9d-11ec-81d3-0242ac130003';
        this.CHAR_LIGHTS_CMD = 'f2b4d6e8-4b9d-11ec-81d3-0242ac130003';
        this.CHAR_SYSTEM_CMD = '068c1d3a-4b9e-11ec-81d3-0242ac130003';
        this.PREFERRED_DEVICE_ID_KEY = 'rcdccBlePreferredDeviceId';
        
        // BLE connection objects
        this.device = null;
        this.server = null;
        this.service = null;
        this.characteristics = {};
        
        // Connection state
        this.isConnected = false;
        this.isConnecting = false;
        this.boundDisconnectHandler = this.handleDisconnection.bind(this);
        this.preferredDeviceId = localStorage.getItem(this.PREFERRED_DEVICE_ID_KEY) || null;
        this.gattOperationChain = Promise.resolve();
        
        // Telemetry callback
        this.telemetryCallback = null;
        
        // Statistics
        this.stats = {
            bytesReceived: 0,
            bytesSent: 0,
            telemetryPackets: 0,
            lastLatency: 0
        };
    }
    
    // Check if Web Bluetooth API is available in this browser
    isSupported() {
        return 'bluetooth' in navigator;
    }
    
    // Get connection status
    getConnectionStatus() {
        return this.isConnected;
    }
    
    // Connect to ESP32 via BLE
    async connect() {
        if (!this.isSupported()) {
            throw new Error('Web Bluetooth API not supported in this browser. Try Chrome, Edge, or Samsung Internet.');
        }
        
        if (this.isConnecting) {
            throw new Error('Connection already in progress');
        }
        
        if (this.isConnected) {
            console.log('Already connected to BLE device');
            return;
        }
        
        try {
            console.log('Requesting BLE device with service:', this.SERVICE_UUID);

            const selectedDevice = await this.requestDeviceWithFallback();
            console.log('Device selected:', selectedDevice.name);

            await this.connectToDevice(selectedDevice, 'picker');
            return true;
            
        } catch (error) {
            this.resetConnectionState();
            
            if (error.name === 'NotFoundError') {
                throw new Error('No BLE device found. Make sure ESP32 is powered on and in range.');
            } else if (error.name === 'SecurityError') {
                throw new Error('BLE access denied. Make sure you are on HTTPS or localhost.');
            } else if (error.name === 'NetworkError') {
                throw new Error('BLE adapter not available. Check if Bluetooth is enabled on your device.');
            }
            
            throw error;
        }
    }

    async requestDeviceWithFallback() {
        try {
            // Primary path: strict filter for RCDCC BLE service
            return await navigator.bluetooth.requestDevice({
                filters: [{
                    services: [this.SERVICE_UUID]
                }],
                optionalServices: [this.SERVICE_UUID]
            });
        } catch (error) {
            // Some stacks/devices do not always expose service UUIDs during scan.
            if (error && error.name === 'NotFoundError') {
                console.warn('No device matched service filter. Retrying with broad picker...');
                return await navigator.bluetooth.requestDevice({
                    acceptAllDevices: true,
                    optionalServices: [this.SERVICE_UUID]
                });
            }
            throw error;
        }
    }

    // Attempt reconnect using devices previously granted permission by the browser.
    async connectToKnownDevice() {
        if (!this.isSupported()) {
            throw new Error('Web Bluetooth API not supported in this browser.');
        }

        if (this.isConnected) {
            return true;
        }

        if (this.isConnecting) {
            return false;
        }

        if (!navigator.bluetooth.getDevices) {
            throw new Error('Browser does not support background BLE reconnect.');
        }

        const knownDevices = await navigator.bluetooth.getDevices();
        if (!knownDevices || knownDevices.length === 0) {
            return false;
        }

        const candidates = [];
        if (this.preferredDeviceId) {
            const preferred = knownDevices.find((device) => device.id === this.preferredDeviceId);
            if (preferred) candidates.push(preferred);
        }

        for (const device of knownDevices) {
            if (!candidates.some((candidate) => candidate.id === device.id)) {
                candidates.push(device);
            }
        }

        for (const device of candidates) {
            try {
                await this.connectToDevice(device, 'known-device');
                return true;
            } catch (error) {
                console.debug('Auto reconnect candidate failed:', device?.name || device?.id, error);
            }
        }

        return false;
    }

    async connectToDevice(device, source = 'unknown') {
        if (!device) {
            throw new Error('No BLE device selected');
        }

        this.isConnecting = true;

        try {
            this.device = device;

            // Ensure handler is not duplicated across reconnect attempts.
            this.device.removeEventListener('gattserverdisconnected', this.boundDisconnectHandler);
            this.device.addEventListener('gattserverdisconnected', this.boundDisconnectHandler);

            console.log(`Connecting to GATT server (${source})...`);
            this.server = await this.device.gatt.connect();

            console.log('Getting RCDCC service...');
            this.service = await this.server.getPrimaryService(this.SERVICE_UUID);

            console.log('Getting characteristics...');
            this.characteristics.configRead = await this.service.getCharacteristic(this.CHAR_CONFIG_READ);
            this.characteristics.configWrite = await this.service.getCharacteristic(this.CHAR_CONFIG_WRITE);
            this.characteristics.telemetry = await this.service.getCharacteristic(this.CHAR_TELEMETRY);
            this.characteristics.servoCmd = await this.service.getCharacteristic(this.CHAR_SERVO_CMD);
            this.characteristics.lightsCmd = await this.service.getCharacteristic(this.CHAR_LIGHTS_CMD);
            this.characteristics.systemCmd = await this.service.getCharacteristic(this.CHAR_SYSTEM_CMD);

            this.isConnected = true;
            await this.subscribeTelemetry();

            this.preferredDeviceId = this.device.id;
            localStorage.setItem(this.PREFERRED_DEVICE_ID_KEY, this.preferredDeviceId);

            console.log('✅ BLE connection successful');
            console.log('Device name:', this.device.name);
            console.log('Device ID:', this.device.id);
        } catch (error) {
            this.resetConnectionState();
            throw error;
        } finally {
            this.isConnecting = false;
        }
    }
    
    // Disconnect from BLE device
    async disconnect() {
        if (!this.isConnected || !this.device) {
            return;
        }
        
        try {
            if (this.device.gatt.connected) {
                await this.device.gatt.disconnect();
            }
            
            this.handleDisconnection();
            console.log('✅ BLE disconnected successfully');
            
        } catch (error) {
            console.error('Error during disconnect:', error);
            throw error;
        }
    }
    
    // Handle disconnection event
    handleDisconnection() {
        this.resetConnectionState();
        
        console.log('⚠️ BLE device disconnected');
        
        // Notify application if callback is set
        if (this.onDisconnect) {
            this.onDisconnect();
        }
    }

    resetConnectionState() {
        this.isConnected = false;
        this.isConnecting = false;
        this.device = null;
        this.server = null;
        this.service = null;
        this.characteristics = {};
        this.gattOperationChain = Promise.resolve();
    }

    async enqueueGattOperation(opName, operation) {
        if (typeof operation !== 'function') {
            throw new Error('Invalid GATT operation');
        }

        const run = async () => {
            if (!this.isConnected) {
                throw new Error('Bluetooth LE not connected');
            }
            return operation();
        };

        const next = this.gattOperationChain.then(run, run);
        // Keep the queue usable even after a failed operation.
        this.gattOperationChain = next.catch(() => {});
        return next;
    }
    
    // Set disconnection callback
    setDisconnectCallback(callback) {
        this.onDisconnect = callback;
    }
    
    // Read configuration from ESP32
    async readConfig() {
        if (!this.isConnected) {
            throw new Error('Not connected to BLE device');
        }
        
        try {
            const startTime = performance.now();
            
            // Read config characteristic (serialized with writes to avoid overlapping GATT operations)
            const value = await this.enqueueGattOperation('read-config', () =>
                this.characteristics.configRead.readValue()
            );
            
            // Convert DataView to string
            const decoder = new TextDecoder('utf-8');
            const jsonString = decoder.decode(value);
            
            // Parse JSON
            const config = JSON.parse(jsonString);
            
            const latency = performance.now() - startTime;
            this.stats.lastLatency = latency;
            this.stats.bytesReceived += jsonString.length;
            
            console.log(`📥 Config received via BLE (${latency.toFixed(1)}ms, ${jsonString.length} bytes)`);
            
            return config;
            
        } catch (error) {
            console.error('Failed to read config via BLE:', error);
            throw error;
        }
    }
    
    // Write configuration to ESP32
    async writeConfig(config) {
        if (!this.isConnected) {
            throw new Error('Not connected to BLE device');
        }
        
        try {
            const startTime = performance.now();
            
            // Convert config object to JSON string
            const jsonString = JSON.stringify(config);
            
            // Convert string to ArrayBuffer
            const encoder = new TextEncoder();
            const data = encoder.encode(jsonString);
            
            // Check if we need to chunk the data (MTU limits)
            const MAX_CHUNK_SIZE = 512;
            if (data.length > MAX_CHUNK_SIZE) {
                console.warn(`⚠️ Config size (${data.length} bytes) exceeds MTU. Consider chunking implementation.`);
                // For now, try to send anyway - ESP32 may have larger MTU negotiated
            }
            
            // Write to config characteristic through serialized queue
            await this.enqueueGattOperation('write-config', () =>
                this.characteristics.configWrite.writeValue(data)
            );
            
            const latency = performance.now() - startTime;
            this.stats.lastLatency = latency;
            this.stats.bytesSent += data.length;
            
            console.log(`📤 Config sent via BLE (${latency.toFixed(1)}ms, ${data.length} bytes)`);
            
        } catch (error) {
            console.error('Failed to write config via BLE:', error);
            throw error;
        }
    }
    
    // Send servo command
    async sendServoCommand(servoConfig) {
        if (!this.isConnected) {
            throw new Error('Not connected to BLE device');
        }
        
        try {
            const jsonString = JSON.stringify(servoConfig);
            const encoder = new TextEncoder();
            const data = encoder.encode(jsonString);
            
            await this.enqueueGattOperation('write-servo', () =>
                this.characteristics.servoCmd.writeValue(data)
            );
            this.stats.bytesSent += data.length;
            
            console.log('📤 Servo command sent via BLE');
            
        } catch (error) {
            console.error('Failed to send servo command via BLE:', error);
            throw error;
        }
    }
    
    // Send lights command
    async sendLightsCommand(lightsConfig) {
        if (!this.isConnected) {
            throw new Error('Not connected to BLE device');
        }
        
        try {
            const jsonString = JSON.stringify(lightsConfig);
            const encoder = new TextEncoder();
            const data = encoder.encode(jsonString);
            
            await this.enqueueGattOperation('write-lights', () =>
                this.characteristics.lightsCmd.writeValue(data)
            );
            this.stats.bytesSent += data.length;
            
            console.log('📤 Lights command sent via BLE');
            
        } catch (error) {
            console.error('Failed to send lights command via BLE:', error);
            throw error;
        }
    }
    
    // Send system command (calibration, reset, etc.)
    async sendSystemCommand(command, params = {}) {
        if (!this.isConnected) {
            throw new Error('Not connected to BLE device');
        }
        
        try {
            const payload = { command, ...params };
            const jsonString = JSON.stringify(payload);
            const encoder = new TextEncoder();
            const data = encoder.encode(jsonString);
            
            await this.enqueueGattOperation('write-system', () =>
                this.characteristics.systemCmd.writeValue(data)
            );
            this.stats.bytesSent += data.length;
            
            console.log(`📤 System command '${command}' sent via BLE`);
            
        } catch (error) {
            console.error('Failed to send system command via BLE:', error);
            throw error;
        }
    }
    
    // Subscribe to telemetry notifications
    async subscribeTelemetry() {
        if (!this.server || !this.characteristics.telemetry) {
            throw new Error('BLE telemetry characteristic not available');
        }
        
        try {
            // Start notifications via serialized queue to avoid startup races.
            await this.enqueueGattOperation('start-telemetry-notifications', () =>
                this.characteristics.telemetry.startNotifications()
            );
            
            // Add event listener for telemetry data
            this.characteristics.telemetry.addEventListener('characteristicvaluechanged', (event) => {
                this.handleTelemetryNotification(event);
            });
            
            console.log('✅ Subscribed to telemetry notifications');
            
        } catch (error) {
            console.error('Failed to subscribe to telemetry:', error);
            throw error;
        }
    }
    
    // Handle telemetry notification
    handleTelemetryNotification(event) {
        try {
            const value = event.target.value;
            
            // Telemetry format from ESP32: 5 floats (20 bytes total)
            // [roll, pitch, accelX, accelY, accelZ]
            if (value.byteLength !== 20) {
                console.warn('Unexpected telemetry packet size:', value.byteLength);
                return;
            }
            
            // Parse binary telemetry data
            const roll = value.getFloat32(0, true);  // true = little-endian
            const pitch = value.getFloat32(4, true);
            const accelX = value.getFloat32(8, true);
            const accelY = value.getFloat32(12, true);
            const accelZ = value.getFloat32(16, true);
            
            // Update statistics
            this.stats.bytesReceived += 20;
            this.stats.telemetryPackets++;
            
            // Create telemetry object
            const telemetry = {
                roll,
                pitch,
                accelX,
                accelY,
                accelZ,
                timestamp: Date.now()
            };
            
            // Call registered callback
            if (this.telemetryCallback) {
                this.telemetryCallback(telemetry);
            }
            
        } catch (error) {
            console.error('Error parsing telemetry notification:', error);
        }
    }
    
    // Set telemetry callback
    setTelemetryCallback(callback) {
        this.telemetryCallback = callback;
    }
    
    // Get connection statistics
    getStats() {
        return {
            ...this.stats,
            isConnected: this.isConnected,
            deviceName: this.device ? this.device.name : null,
            deviceId: this.device ? this.device.id : null
        };
    }
    
    // Reset statistics
    resetStats() {
        this.stats = {
            bytesReceived: 0,
            bytesSent: 0,
            telemetryPackets: 0,
            lastLatency: 0
        };
    }
}

// Export for use in app.js
window.BluetoothManager = BluetoothManager;

// ====================================================================================
// USAGE EXAMPLES
// ====================================================================================
// 
// // Create instance
// const bleManager = new BluetoothManager();
// 
// // Check browser support
// if (!bleManager.isSupported()) {
//     alert('Your browser does not support Web Bluetooth API');
// }
// 
// // Connect (must be called from user gesture, e.g., button click)
// document.getElementById('connectBtn').addEventListener('click', async () => {
//     try {
//         await bleManager.connect();
//         console.log('Connected to ESP32 via BLE');
//     } catch (error) {
//         console.error('BLE connection failed:', error);
//     }
// });
// 
// // Set telemetry callback
// bleManager.setTelemetryCallback((telemetry) => {
//     console.log('Roll:', telemetry.roll, 'Pitch:', telemetry.pitch);
//     // Update UI with telemetry data
//     updateHorizon(telemetry.roll, telemetry.pitch);
// });
// 
// // Read configuration
// const config = await bleManager.readConfig();
// console.log('Config:', config);
// 
// // Write configuration
// await bleManager.writeConfig({ sampleRate: 100, telemetryRate: 20 });
// 
// // Send calibration command
// await bleManager.sendSystemCommand('autoLevel');
// 
// // Disconnect
// await bleManager.disconnect();
// 
// ====================================================================================
