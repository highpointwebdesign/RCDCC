window.addEventListener('unhandledrejection', function(event) {
    console.error('UNHANDLED REJECTION:', event.reason);
    event.preventDefault(); // prevents crash
});

window.addEventListener('error', function(event) {
    console.error('GLOBAL ERROR:', event.message, event.filename, event.lineno);
});


window.onerror = function (msg, url, line) {
    console.log("JS ERROR:", msg, "Line:", line);
};

// ==================== Safe Area Insets ====================
function applySafeAreaInsets() {
    // Try Visual Viewport API first (most reliable in Capacitor)
    if (window.visualViewport) {
        const top = window.visualViewport.offsetTop || 0;
        const screenH = screen.height;
        const viewH = window.visualViewport.height;
        const bottom = screenH - viewH - top;
        document.documentElement.style.setProperty('--sat', Math.max(top, 24) + 'px');
        document.documentElement.style.setProperty('--sab', Math.max(bottom, 0) + 'px');
    } else {
        // Fallback: hardcode typical Samsung S24 Ultra values
        document.documentElement.style.setProperty('--sat', '44px');
        document.documentElement.style.setProperty('--sab', '24px');
    }
}

// Apply on load and on resize
applySafeAreaInsets();
window.addEventListener('resize', applySafeAreaInsets);
document.addEventListener('DOMContentLoaded', applySafeAreaInsets);

        // Hide Android navigation bar (immersive mode)
        // ==================== Status Bar ====================
        // ==================== Status Bar ====================
        // setTimeout(async () => {
        //     try {
        //         const { StatusBar } = window.Capacitor.Plugins;
        //         await StatusBar.setOverlaysWebView({ overlay: true });
        //         await StatusBar.setBackgroundColor({ color: '#ff000000' });
        //         await StatusBar.setStyle({ style: 'LIGHT' });
        //         console.log('StatusBar configured');
        //     } catch(e) {
        //         console.log('StatusBar error:', e.message);
        //     }
        // }, 1000);
        
        // ==================== Version Configuration ====================
        // Update this version number when releasing new app versions
        // For automated versioning, this could be replaced by a build script that:
        // - Reads from package.json
        // - Uses git tags: $(git describe --tags --always)
        // - Generates from CI/CD pipeline build number
        const APP_VERSION = '6f3e740';
        const BUILD_DATE = '2026-03-04';
        const DEVELOPER_MODE_KEY = 'developerModeEnabled';
        
        // BLE manager is optional and only available when bluetooth.js is loaded.
        const bleManager = window.BluetoothManager ? new window.BluetoothManager() : null;
        let communicationMode = 'ble';
        const AUTO_RECONNECT_INTERVAL_MS = 5000;
        let autoReconnectTimer = null;
        let autoReconnectInFlight = false;
        let manualBleDisconnect = false;

        function isBleConnected() {
            return !!(bleManager && bleManager.getConnectionStatus && bleManager.getConnectionStatus());
        }

        function applyDeveloperModeVisibility(enabled) {
            const debugCardsContainer = document.getElementById('developerDebugCard');
            if (debugCardsContainer) {
                debugCardsContainer.style.display = enabled ? 'block' : 'none';
            }
        }

        function initDeveloperMode() {
            const developerToggle = document.getElementById('developerModeToggle');
            if (!developerToggle) return;

            const enabled = localStorage.getItem(DEVELOPER_MODE_KEY) === 'true';
            developerToggle.checked = enabled;
            applyDeveloperModeVisibility(enabled);

            developerToggle.addEventListener('change', function() {
                localStorage.setItem(DEVELOPER_MODE_KEY, String(this.checked));
                applyDeveloperModeVisibility(this.checked);
                toast.success(this.checked ? 'Developer mode enabled' : 'Developer mode disabled');
            });
        }

        function ensureBleConnectedOrThrow() {
            if (!isBleConnected()) {
                communicationMode = 'ble';
                throw new Error('Bluetooth LE not connected');
            }
        }

        async function pushConfigPayload(payload, signal = null) {
            try {
                ensureBleConnectedOrThrow();
            } catch (e) {
                return Promise.reject(e);  // now it's a rejected promise, caught by .catch()
            }
            communicationMode = 'ble';
            await bleManager.writeConfig(payload);
            return { status: 'ok' };
        }

        async function pushServoPayload(payload, signal = null) {
            ensureBleConnectedOrThrow();
            communicationMode = 'ble';
            await bleManager.sendServoCommand(payload);
            return { status: 'ok' };
        }

        async function pushLightsPayload(payload, signal = null) {
            ensureBleConnectedOrThrow();
            communicationMode = 'ble';
            await bleManager.sendLightsCommand(payload);
            return { status: 'ok' };
        }

        async function pushSystemCommand(command, params = {}, signal = null) {
            ensureBleConnectedOrThrow();
            communicationMode = 'ble';
            await bleManager.sendSystemCommand(command, params);
            return { status: 'ok' };
        }

        async function connectBLE() {
            if (!bleManager) {
                toast.error('Bluetooth manager unavailable in this build');
                return false;
            }

            try {
                manualBleDisconnect = false;
                await bleManager.connect();
                communicationMode = 'ble';
                stopAutoReconnect();
                stopHeartbeat();
                updateConnectionStatus(true);
                updateConnectionMethodDisplay();
                refreshConfigAfterConnection('manual-connect');
                toast.dismiss('ble-config-required');
                toast.success('Connected via Bluetooth LE');
                return true;
            } catch (error) {
                communicationMode = 'ble';
                updateConnectionStatus(false);
                toast.error(`BLE connect failed: ${error.message}`);
                return false;
            }
        }

        async function disconnectBLE() {
            if (!bleManager) return;
            manualBleDisconnect = true;
            stopAutoReconnect();
            await bleManager.disconnect();
            communicationMode = 'ble';
            hasLoadedConfigFromDevice = false;
            startHeartbeat();
            updateConnectionStatus(false);
            updateConnectionMethodDisplay();
        }

        async function attemptAutoReconnect(source = 'timer') {
            if (!bleManager || !bleManager.connectToKnownDevice) return false;
            if (manualBleDisconnect || autoReconnectInFlight || isBleConnected() || document.hidden || !navigator.onLine) {
                return false;
            }

            autoReconnectInFlight = true;
            try {
                const didReconnect = await bleManager.connectToKnownDevice();
                if (didReconnect) {
                    communicationMode = 'ble';
                    stopHeartbeat();
                    stopAutoReconnect();
                    updateConnectionStatus(true);
                    updateConnectionMethodDisplay();
                    refreshConfigAfterConnection(`auto-reconnect:${source}`);
                    toast.dismiss('ble-config-required');
                    toast.success('Bluetooth reconnected', { duration: 2200 });
                    console.log(`BLE auto reconnect succeeded (${source})`);
                    return true;
                }
            } catch (error) {
                console.debug(`BLE auto reconnect attempt failed (${source}):`, error);
            } finally {
                autoReconnectInFlight = false;
            }

            return false;
        }

        function startAutoReconnect(reason = 'disconnect') {
            if (!bleManager || manualBleDisconnect) return;
            if (autoReconnectTimer) return;

            // Try immediately, then continue in the background.
            attemptAutoReconnect(reason);

            autoReconnectTimer = setInterval(() => {
                attemptAutoReconnect('interval');
            }, AUTO_RECONNECT_INTERVAL_MS);
        }

        function stopAutoReconnect() {
            if (autoReconnectTimer) {
                clearInterval(autoReconnectTimer);
                autoReconnectTimer = null;
            }
        }

        // Expose manual control for quick testing from browser console.
        window.connectBLE = connectBLE;
        window.disconnectBLE = disconnectBLE;

        function refreshConfigAfterConnection(reason = 'ble-connect') {
            if (!isBleConnected()) return;
            if (configRefreshInFlight) return;

            configRefreshInFlight = fetchConfigFromESP32(false)
                .catch((error) => {
                    console.warn(`Config refresh failed (${reason}):`, error?.message || error);
                })
                .finally(() => {
                    configRefreshInFlight = null;
                });
        }
        
        // ==================== LED Pattern Definitions ====================
        // Hex colors in RGB format (will be converted to GRB for ESP32)
        const RED = "FF0000";
        const BLUE = "0000FF";
        const AMBER = "FFA500";
        const OFF = "000000";
        
        const PATTERNS = {
            police: [
                {
                    name: "Whip Sweep",
                    isLooping: true,
                    sequence: [
                        { led0: RED, led1: OFF, duration: 250 },
                        { led0: OFF, led1: BLUE, duration: 250 }
                    ]
                },
                {
                    name: "Flicker",
                    isLooping: true,
                    sequence: [
                        { led0: RED, led1: BLUE, duration: 80 },
                        { led0: "800000", led1: "000080", duration: 60 },
                        { led0: RED, led1: BLUE, duration: 90 },
                        { led0: OFF, led1: OFF, duration: 50 },
                        { led0: RED, led1: BLUE, duration: 70 },
                        { led0: "400000", led1: "000040", duration: 40 }
                    ]
                },
                {
                    name: "Dual Beacon",
                    isLooping: true,
                    sequence: [
                        { led0: RED, led1: RED, duration: 250 },
                        { led0: BLUE, led1: BLUE, duration: 250 }
                    ]
                },
                {
                    name: "Chase",
                    isLooping: true,
                    sequence: [
                        { led0: RED, led1: OFF, duration: 250 },
                        { led0: OFF, led1: RED, duration: 250 },
                        { led0: BLUE, led1: OFF, duration: 250 },
                        { led0: OFF, led1: BLUE, duration: 250 }
                    ]
                },
                {
                    name: "Dual Color Pulse",
                    isLooping: true,
                    sequence: [
                        { led0: RED, led1: OFF, duration: 250 },
                        { led0: RED, led1: BLUE, duration: 250 },
                        { led0: OFF, led1: BLUE, duration: 250 }
                    ]
                },
                {
                    name: "Wig Wag",
                    isLooping: true,
                    sequence: [
                        { led0: RED, led1: BLUE, duration: 250 },
                        { led0: BLUE, led1: RED, duration: 250 }
                    ]
                },
                {
                    name: "Strobe",
                    isLooping: true,
                    sequence: [
                        { led0: RED, led1: OFF, duration: 75 },
                        { led0: OFF, led1: BLUE, duration: 75 }
                    ]
                },
                {
                    name: "Breathe",
                    isLooping: true,
                    sequence: [
                        { led0: RED, led1: BLUE, duration: 200 },
                        { led0: "BF0000", led1: "0000BF", duration: 200 },
                        { led0: "800000", led1: "000080", duration: 200 },
                        { led0: "400000", led1: "000040", duration: 200 },
                        { led0: "200000", led1: "000020", duration: 200 },
                        { led0: "400000", led1: "000040", duration: 200 },
                        { led0: "800000", led1: "000080", duration: 200 },
                        { led0: "BF0000", led1: "0000BF", duration: 200 }
                    ]
                }
            ],
            construction: [
                {
                    name: "Steady Amber",
                    isLooping: false,
                    sequence: [
                        { led0: AMBER, led1: AMBER, duration: 60000 }  // Long duration for steady
                    ]
                },
                {
                    name: "Double Pulse",
                    isLooping: true,
                    sequence: [
                        { led0: AMBER, led1: AMBER, duration: 250 },
                        { led0: OFF, led1: OFF, duration: 250 }
                    ]
                },
                {
                    name: "Strobe",
                    isLooping: true,
                    sequence: [
                        { led0: AMBER, led1: OFF, duration: 75 },
                        { led0: OFF, led1: AMBER, duration: 75 }
                    ]
                },
                {
                    name: "Breathe",
                    isLooping: true,
                    sequence: [
                        { led0: AMBER, led1: AMBER, duration: 200 },
                        { led0: "BF7C00", led1: "BF7C00", duration: 200 },
                        { led0: "805300", led1: "805300", duration: 200 },
                        { led0: "402900", led1: "402900", duration: 200 },
                        { led0: "201500", led1: "201500", duration: 200 },
                        { led0: "402900", led1: "402900", duration: 200 },
                        { led0: "805300", led1: "805300", duration: 200 },
                        { led0: "BF7C00", led1: "BF7C00", duration: 200 }
                    ]
                },
                {
                    name: "Flicker",
                    isLooping: true,
                    sequence: [
                        { led0: AMBER, led1: AMBER, duration: 80 },
                        { led0: "805300", led1: "805300", duration: 60 },
                        { led0: AMBER, led1: AMBER, duration: 90 },
                        { led0: OFF, led1: OFF, duration: 50 },
                        { led0: AMBER, led1: AMBER, duration: 70 },
                        { led0: "402900", led1: "402900", duration: 40 }
                    ]
                }
            ],
            warning: [
                {
                    name: "Slow Beacon",
                    isLooping: true,
                    sequence: [
                        { led0: AMBER, led1: AMBER, duration: 500 },
                        { led0: OFF, led1: OFF, duration: 500 }
                    ]
                },
                {
                    name: "Fast Flash",
                    isLooping: true,
                    sequence: [
                        { led0: AMBER, led1: AMBER, duration: 250 },
                        { led0: OFF, led1: OFF, duration: 250 }
                    ]
                },
                {
                    name: "Strobe",
                    isLooping: true,
                    sequence: [
                        { led0: AMBER, led1: OFF, duration: 75 },
                        { led0: OFF, led1: AMBER, duration: 75 }
                    ]
                },
                {
                    name: "Breathe",
                    isLooping: true,
                    sequence: [
                        { led0: AMBER, led1: AMBER, duration: 200 },
                        { led0: "BF7C00", led1: "BF7C00", duration: 200 },
                        { led0: "805300", led1: "805300", duration: 200 },
                        { led0: "402900", led1: "402900", duration: 200 },
                        { led0: "201500", led1: "201500", duration: 200 },
                        { led0: "402900", led1: "402900", duration: 200 },
                        { led0: "805300", led1: "805300", duration: 200 },
                        { led0: "BF7C00", led1: "BF7C00", duration: 200 }
                    ]
                },
                {
                    name: "Flicker",
                    isLooping: true,
                    sequence: [
                        { led0: AMBER, led1: AMBER, duration: 80 },
                        { led0: "805300", led1: "805300", duration: 60 },
                        { led0: AMBER, led1: AMBER, duration: 90 },
                        { led0: OFF, led1: OFF, duration: 50 },
                        { led0: AMBER, led1: AMBER, duration: 70 },
                        { led0: "402900", led1: "402900", duration: 40 }
                    ]
                }
            ]
        };
        
        let fullConfig = null;
        let hasLoadedConfigFromDevice = false;
        let configRefreshInFlight = null;
        let hasAppliedInitialDeviceConfig = false;
        const rSliders = {};
        const rSliderSilentTimers = {};
        const rSliderInitState = new Set();

        function setCardBodiesLoading(isLoading) {
            const cardBodies = document.querySelectorAll('.card-body');
            cardBodies.forEach((cardBody) => {
                cardBody.classList.toggle('is-loading', isLoading);
                cardBody.setAttribute('aria-busy', isLoading ? 'true' : 'false');
            });
            document.body.classList.toggle('app-config-loading', isLoading);
        }

        function finishInitialCardLoading(reason = 'config-loaded') {
            if (hasAppliedInitialDeviceConfig) return;
            hasAppliedInitialDeviceConfig = true;
            setCardBodiesLoading(false);
            console.log(`Initial card loading finished: ${reason}`);
        }


        function ensureWritableFullConfig() {
            if (!fullConfig || typeof fullConfig !== 'object') {
                fullConfig = {};
            }
            return fullConfig;
        }

        // Custom toast implementation using toast-box with toasty sounds
        let notificationSoundsEnabled = localStorage.getItem('notificationSoundsEnabled') !== 'false'; // Default to true
        
        window.toast = {
            sounds: {
                info: new Audio("./toasty/dist/sounds/info/1.mp3"),
                success: new Audio("./toasty/dist/sounds/success/1.mp3"),
                warning: new Audio("./toasty/dist/sounds/warning/1.mp3"),
                error: new Audio("./toasty/dist/sounds/error/1.mp3")
            },
            activeToastsByKey: {},
            
            show(message, type = 'info', options = {}) {
                const duration = options.duration || 3000;
                const toastKey = options.key || null;
                const bgClass = {
                    success: 'bg-success',
                    error: 'bg-danger',
                    warning: 'bg-warning',
                    info: 'bg-info'
                }[type] || 'bg-info';

                if (toastKey) {
                    this.dismiss(toastKey);
                }
                
                // Create toast element
                const toastId = 'toast-' + Date.now();
                const toastEl = document.createElement('div');
                toastEl.id = toastId;
                toastEl.className = `toast-box ${bgClass} toast-top tap-to-close`;
                toastEl.innerHTML = `<div class="in"><div class="text">${message}</div></div>`;

                if (toastKey) {
                    toastEl.dataset.toastKey = toastKey;
                    this.activeToastsByKey[toastKey] = toastEl;
                }

                const removeToast = () => {
                    toastEl.classList.remove('show');
                    setTimeout(() => {
                        if (toastKey && this.activeToastsByKey[toastKey] === toastEl) {
                            delete this.activeToastsByKey[toastKey];
                        }
                        toastEl.remove();
                    }, 800);
                };
                
                // Add to body
                document.body.appendChild(toastEl);
                
                // Play sound if enabled
                if (notificationSoundsEnabled && this.sounds[type]) {
                    this.sounds[type].play().catch(() => {});
                }
                
                // Show toast
                setTimeout(() => {
                    toastEl.classList.add('show');
                }, 10);
                
                // Auto-hide
                setTimeout(() => {
                    removeToast();
                }, duration);
                
                // Tap to close
                toastEl.addEventListener('click', () => {
                    removeToast();
                });

                return toastEl;
            },

            dismiss(key) {
                const toastEl = this.activeToastsByKey[key];
                if (!toastEl) return;
                delete this.activeToastsByKey[key];
                toastEl.classList.remove('show');
                setTimeout(() => {
                    toastEl.remove();
                }, 800);
            },
            
            success(message, options) {
                this.show(message, 'success', options);
                flashNotificationLEDs('success');
            },
            
            error(message, options) {
                this.show(message, 'error', options);
                flashNotificationLEDs('error');
            },
            
            warning(message, options) {
                this.show(message, 'warning', options);
                flashNotificationLEDs('warning');
            },
            
            info(message, options) {
                this.show(message, 'info', options);
                flashNotificationLEDs('info');
            }
        };
    

        // Helper function to get element by ID
        function $(id) {
            if (id.startsWith('#')) {
                return document.getElementById(id.substring(1));
            } else if (id.startsWith('.')) {
                return document.querySelectorAll(id.substring(1));
            }
            return document.getElementById(id);
        }

        function delay(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // ==================== Emergency Lights Helper Functions ====================
        // Convert hex color (RGB) to object
        function hexToRgb(hex) {
            const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return result ? {
                r: parseInt(result[1], 16),
                g: parseInt(result[2], 16),
                b: parseInt(result[3], 16)
            } : { r: 0, g: 0, b: 0 };
        }
        
        // Convert RGB object to hex CSS color
        function rgbToHex(r, g, b) {
            return `rgb(${r}, ${g}, ${b})`;
        }
        
        // Animate LED preview based on pattern
        let ledPreviewAnimation = null;
        function animateLedPreview(mode, patternIndex) {
            // Stop previous animation
            if (ledPreviewAnimation) {
                clearInterval(ledPreviewAnimation);
            }
            
            const patterns = PATTERNS[mode];
            if (!patterns || !patterns[patternIndex]) {
                // Clear LEDs
                document.getElementById('ledPreview0').style.backgroundColor = '#333';
                document.getElementById('ledPreview1').style.backgroundColor = '#333';
                return;
            }
            
            const pattern = patterns[patternIndex];
            let stepIndex = 0;
            
            function updateLedDisplay() {
                const step = pattern.sequence[stepIndex];
                const color0 = hexToRgb(step.led0);
                const color1 = hexToRgb(step.led1);
                
                const led0El = document.getElementById('ledPreview0');
                const led1El = document.getElementById('ledPreview1');
                
                // Set color and glow effect
                led0El.style.backgroundColor = rgbToHex(color0.r, color0.g, color0.b);
                led1El.style.backgroundColor = rgbToHex(color1.r, color1.g, color1.b);
                
                // Apply glow to lit LEDs
                if (step.led0 !== OFF) {
                    led0El.style.boxShadow = `inset 0 2px 5px rgba(0,0,0,0.5), 0 0 10px ${rgbToHex(color0.r, color0.g, color0.b)}`;
                } else {
                    led0El.style.boxShadow = 'inset 0 2px 5px rgba(0,0,0,0.5)';
                }
                
                if (step.led1 !== OFF) {
                    led1El.style.boxShadow = `inset 0 2px 5px rgba(0,0,0,0.5), 0 0 10px ${rgbToHex(color1.r, color1.g, color1.b)}`;
                } else {
                    led1El.style.boxShadow = 'inset 0 2px 5px rgba(0,0,0,0.5)';
                }
                
                // Next step
                stepIndex = (stepIndex + 1) % pattern.sequence.length;
            }
            
            updateLedDisplay();  // Show first step immediately
            
            // Loop through pattern steps
            if (pattern.sequence.length > 1) {
                let currentDuration = pattern.sequence[0].duration;
                
                ledPreviewAnimation = setInterval(() => {
                    let nextStepIndex = (stepIndex + 1) % pattern.sequence.length;
                    currentDuration = pattern.sequence[stepIndex].duration;
                    
                    // Schedule the update
                    setTimeout(() => {
                        updateLedDisplay();
                    }, pattern.sequence[stepIndex].duration);
                    
                }, pattern.sequence[stepIndex].duration);
            }
        }
        
        function updateEmergencyLightPatterns(mode) {
            const patternSelect = document.getElementById('emergencyLightPattern');
            if (!patternSelect) return;
            
            // Clear current options
            patternSelect.innerHTML = '';
            
            // Get patterns from PATTERNS object
            const modePatterns = PATTERNS[mode] || [];
            modePatterns.forEach((pattern, index) => {
                const option = document.createElement('option');
                option.value = index;
                option.textContent = pattern.name;
                patternSelect.appendChild(option);
            });
            
            // Animate preview with first pattern
            if (modePatterns.length > 0) {
                animateLedPreview(mode, 0);
            }
        }
        
        function loadEmergencyLightsState() {
            const modeSelect = document.getElementById('emergencyLightMode');
            const patternSelect = document.getElementById('emergencyLightPattern');

            if (modeSelect) {
                modeSelect.value = 'police';
                updateEmergencyLightPatterns('police');
            }
            if (patternSelect) {
                patternSelect.value = 0;
                animateLedPreview('police', 0);
            }
        }

        function buildValueArray(min, max, step, decimals) {
            const values = [];
            const count = Math.round((max - min) / step);
            for (let i = 0; i <= count; i += 1) {
                const raw = min + step * i;
                if (typeof decimals === 'number') {
                    values.push(raw.toFixed(decimals));
                } else {
                    values.push(String(Math.round(raw)));
                }
            }
            const last = typeof decimals === 'number' ? max.toFixed(decimals) : String(Math.round(max));
            if (values[values.length - 1] !== last) {
                values.push(last);
            }
            return values;
        }

        function createRSlider(id, config) {
            const input = document.getElementById(id);
            if (!input) return null;
            if (rSliders[id]) {
                rSliders[id].destroy();
            }
            rSliderInitState.add(id);
            const slider = new rSlider({
                target: input,
                ...config
            });
            rSliders[id] = slider;
            return slider;
        }

        function parseRSliderValue(value) {
            if (value === null || value === undefined) return [];
            if (Array.isArray(value)) return value.map(v => parseFloat(v));
            if (typeof value === 'string') {
                return value.split(',').map(v => parseFloat(v));
            }
            return [Number(value)];
        }

        function formatSliderValue(value, decimals) {
            const numeric = Number(value);
            if (Number.isNaN(numeric)) return '';
            if (typeof decimals === 'number') return numeric.toFixed(decimals);
            return String(Math.round(numeric));
        }

        function setRSliderValue(id, value, options = {}) {
            const slider = rSliders[id];
            if (!slider) return;
            const silent = options.silent === true;
            if (silent) {
                slider._silent = true;
                if (rSliderSilentTimers[id]) clearTimeout(rSliderSilentTimers[id]);
                if (rSliderInitState.has(id)) rSliderInitState.delete(id);
            }

            if (Array.isArray(value)) {
                slider.setValues(value[0], value[1]);
            } else {
                slider.setValues(value);
            }

            if (silent) {
                rSliderSilentTimers[id] = setTimeout(() => {
                    if (rSliders[id]) rSliders[id]._silent = false;
                }, 700);
            }
        }

        function getRSliderValue(id) {
            const slider = rSliders[id];
            if (!slider) return [];
            return parseRSliderValue(slider.getValue());
        }

        function canSaveRSlider(id) {
            const slider = rSliders[id];
            if (!slider) return false;
            if (slider._silent) return false;
            if (rSliderInitState.has(id)) {
                rSliderInitState.delete(id);
                return false;
            }
            return true;
        }

        function setButtonBusy(button, busyText) {
            if (!button) return;
            if (!button.dataset.originalText) {
                button.dataset.originalText = button.textContent.trim();
            }
            button.disabled = true;
            button.textContent = busyText;
        }

        function restoreButton(button) {
            if (!button) return;
            const originalText = button.dataset.originalText || button.textContent;
            button.textContent = originalText;
            button.disabled = false;
        }

        // Capture GPS coordinates and update display
        function captureGPSCoordinates() {
            if (!('geolocation' in navigator)) {
                console.log('Geolocation not supported');
                return;
            }

            navigator.geolocation.getCurrentPosition(
                position => {
                    const lat = position.coords.latitude.toFixed(6);
                    const lon = position.coords.longitude.toFixed(6);
                    const accMeters = position.coords.accuracy.toFixed(1);
                    const accFeet = (accMeters * 3.28084).toFixed(1);
                    const altMeters = position.coords.altitude ? position.coords.altitude.toFixed(1) : null;
                    const altFeet = altMeters ? (altMeters * 3.28084).toFixed(1) : 'N/A';
                    
                    const latEl = document.getElementById('latitude');
                    const lonEl = document.getElementById('longitude');
                    const accEl = document.getElementById('accuracy');
                    const altEl = document.getElementById('altitude');
                    
                    if (latEl) latEl.textContent = lat + '°';
                    if (lonEl) lonEl.textContent = lon + '°';
                    if (accEl) accEl.textContent = '±' + accFeet + ' ft';
                    if (altEl) altEl.textContent = altFeet + ' ft';
                    
                    console.log(`GPS captured: Lat ${lat}, Lon ${lon}, Acc ±${accFeet}ft, Alt ${altFeet}ft`);
                },
                error => {
                    console.warn('GPS capture failed:', error.message);
                    const latEl = document.getElementById('latitude');
                    const lonEl = document.getElementById('longitude');
                    const accEl = document.getElementById('accuracy');
                    const altEl = document.getElementById('altitude');
                    if (latEl) latEl.textContent = 'Error';
                    if (lonEl) lonEl.textContent = 'Error';
                    if (accEl) accEl.textContent = 'Error';
                    if (altEl) altEl.textContent = 'Error';
                },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
            );
        }

        async function handleSetAsLevel() {
            const button = document.getElementById('setLevelBtn');
            if (!button || button.disabled) return;
            button.classList.add('pulsating');
            const icon = button.querySelector('.material-symbols-outlined');
            if (icon) icon.classList.add('rotate-cw');
            
            // Capture GPS coordinates
            captureGPSCoordinates();
            
            // Clear roll/pitch display while resetting
            const rollDisplay = document.getElementById('rollPitchRollValue');
            const pitchDisplay = document.getElementById('rollPitchPitchValue');
            if (rollDisplay) rollDisplay.textContent = '--';
            if (pitchDisplay) pitchDisplay.textContent = '--';
            
            let shouldDelay = false;

            try {
                await pushSystemCommand('calibrate', {});
                shouldDelay = true;
            } catch (error) {
                console.error('Calibration failed:', error);
            }

            if (shouldDelay) {
                await delay(2000);
                await delay(500);
                await fetchRollPitchSnapshot();
            }
            button.classList.remove('pulsating');
            if (icon) icon.classList.remove('rotate-cw');
            restoreButton(button);
        }

        // ==================== Auto Level ====================
        let currentTelemetry = { roll: 0, pitch: 0 };
        const telemetryListeners = new Set();

        function applyTelemetrySample(sample) {
            const roll = Number.isFinite(Number(sample?.roll)) ? Number(sample.roll) : 0;
            const pitch = Number.isFinite(Number(sample?.pitch)) ? Number(sample.pitch) : 0;

            currentTelemetry.roll = roll;
            currentTelemetry.pitch = pitch;
            notifyTelemetryListeners(roll, pitch);

            return { roll, pitch };
        }

        function subscribeTelemetry(listener) {
            telemetryListeners.add(listener);
            return () => telemetryListeners.delete(listener);
        }

        function notifyTelemetryListeners(roll, pitch) {
            telemetryListeners.forEach(listener => listener({ roll, pitch }));
        }


        let bubbleTelemetryUnsubscribe = null;

        function normalizeTelemetryValue(value) {
            const parsed = parseFloat(value);
            return Number.isFinite(parsed) ? parsed : 0;
        }

        function updateBubbleLevelUI(rollValue, pitchValue, disableSnapping = false) {
            const roll = normalizeTelemetryValue(rollValue);
            const pitch = normalizeTelemetryValue(pitchValue);

            // Snap to center only when not in Phase A (disableSnapping = false)
            const isWithinThreshold = !disableSnapping && Math.abs(roll) < 5 && Math.abs(pitch) < 5;
            const bubbleX = isWithinThreshold ? 8 : (roll * 3 + 8);
            const bubbleY = isWithinThreshold ? 0 : (pitch * 3);

            const bubble = document.getElementById('bubbleLevelBubble');
            if (bubble) {
                bubble.style.transform = `translate(calc(-50% + ${bubbleX}px), calc(-50% + ${bubbleY}px))`;
            }

            const face = document.getElementById('bubbleLevelFace');
            if (face) {
                face.classList.toggle('level', isWithinThreshold);
            }

            const badge = document.getElementById('bubbleLevelBadge');
            if (badge) {
                badge.classList.toggle('visible', isWithinThreshold);
            }
        }

        function setBubbleLevelStatus(message) {
            const status = document.getElementById('bubbleLevelStatus');
            if (status) {
                status.textContent = message;
            }
        }

        let autoLevelPhaseA = false; // Global flag to disable bubble snapping during Phase A
        
        function initBubbleLevelContainer() {
            const containerElement = document.getElementById('autoLevelProgressContainer');
            if (!containerElement) return;

            // Initialize the bubble level display when container is shown
            if (bubbleTelemetryUnsubscribe) {
                bubbleTelemetryUnsubscribe();
            }
            bubbleTelemetryUnsubscribe = subscribeTelemetry(({ roll, pitch }) => {
                // Pass disableSnapping=true if Phase A is active
                updateBubbleLevelUI(roll, pitch, autoLevelPhaseA);
            });
            updateBubbleLevelUI(currentTelemetry.roll, currentTelemetry.pitch, autoLevelPhaseA);
            setBubbleLevelStatus('Ready to auto-level.');
        }

        function closeBubbleLevelContainer() {
            const containerElement = document.getElementById('autoLevelProgressContainer');
            if (containerElement) {
                containerElement.style.display = 'none';
            }
            if (bubbleTelemetryUnsubscribe) {
                bubbleTelemetryUnsubscribe();
                bubbleTelemetryUnsubscribe = null;
            }
        }

        function openBubbleLevelContainer() {
            const containerElement = document.getElementById('autoLevelProgressContainer');
            if (containerElement) {
                containerElement.style.display = 'block';
                initBubbleLevelContainer();
            }
        }

        
        async function getSensorData() {
            ensureBleConnectedOrThrow();
            communicationMode = 'ble';
            return applyTelemetrySample(currentTelemetry);
        }

        async function fetchRollPitchSnapshot() {
            const iconClick = document.getElementById('rollPitchRefreshBtn');
            // Add spin animation to Material Symbols refresh icon
            if (iconClick) {
                iconClick.classList.add('spin');
            }

            try {
                const sensor = await getSensorData();
                const rollDisplay = document.getElementById('rollPitchRollValue');
                const pitchDisplay = document.getElementById('rollPitchPitchValue');

                if (rollDisplay) {
                    const rollVal = sensor.roll.toFixed(0);
                    const rollDirection = sensor.roll > 0 ? 'leaning right' : sensor.roll < 0 ? 'leaning left' : 'level';
                    rollDisplay.textContent = `${rollVal}° (${rollDirection})`;
                }
                if (pitchDisplay) {
                    const pitchVal = sensor.pitch.toFixed(0);
                    const pitchDirection = sensor.pitch > 0 ? 'nose up' : sensor.pitch < 0 ? 'nose down' : 'level';
                    pitchDisplay.textContent = `${pitchVal}° (${pitchDirection})`;
                }
            } catch (error) {
                toast.error('Failed to fetch roll/pitch');
            } finally {
                if (iconClick) {
                    iconClick.classList.remove('spin');
                }
            }
        }
        
        async function updateServoTrim(servo, value) {
            // Update trim using the servo-config API
            const payload = {
                servo: servo,
                param: 'trim',
                value: value
            };
            const controller = registerAjaxController(new AbortController());
            const timeout = setTimeout(() => controller.abort(), 8000);
            
            let response;
            try {
                response = await pushServoPayload(payload, controller.signal);
            } catch (error) {
                if (error.name === 'AbortError') return;
                throw error;
            } finally {
                clearTimeout(timeout);
                unregisterAjaxController(controller);
            }
            
            if (response.status === 'error') {
                throw new Error(`Failed to update ${servo} trim`);
            }
            
            // Update local config
            if (fullConfig && fullConfig.servos && fullConfig.servos[servo]) {
                fullConfig.servos[servo].trim = value;
            }
            
            // Update UI slider - use config values for calculation
            const servoAbbrevMap = {
                'frontLeft': 'FL',
                'frontRight': 'FR',
                'rearLeft': 'RL',
                'rearRight': 'RR'
            };
            const abbrev = servoAbbrevMap[servo];
            
            if (abbrev && fullConfig && fullConfig.servos && fullConfig.servos[servo]) {
                const trimSliderId = `servo${abbrev}TrimSlider`;
                const trimDisplay = document.getElementById(`servo${abbrev}TrimDisplay`);
                
                if (rSliders[trimSliderId]) {
                    const trimOffset = value;
                    
                    // Update slider (this will trigger the display update via the 'update' event)
                    console.log(`Updating ${servo} trim slider: offset=${trimOffset}`);
                    setRSliderValue(trimSliderId, formatSliderValue(trimOffset), { silent: true });
                    
                    // Also manually update the display in case the event doesn't fire
                    if (trimDisplay) {
                        const roundedOffset = Math.round(trimOffset);
                        trimDisplay.textContent = roundedOffset >= 0 ? `+${roundedOffset}°` : `${roundedOffset}°`;
                    }
                } else {
                    console.warn(`Trim slider not found or not initialized: servo${abbrev}TrimSlider`);
                }
            }
        }
        
        async function updateServoReversed(servo, value) {
            // Update reversed using the servo-config API
            const payload = {
                servo: servo,
                param: 'reversed',
                value: value
            };
            const controller = registerAjaxController(new AbortController());
            const timeout = setTimeout(() => controller.abort(), 8000);
            
            let response;
            try {
                response = await pushServoPayload(payload, controller.signal);
            } catch (error) {
                if (error.name === 'AbortError') return;
                throw error;
            } finally {
                clearTimeout(timeout);
                unregisterAjaxController(controller);
            }
            
            if (response.status === 'error') {
                throw new Error(`Failed to update ${servo} reversed`);
            }
            
            // Update local config
            if (fullConfig && fullConfig.servos && fullConfig.servos[servo]) {
                fullConfig.servos[servo].reversed = value;
            }
            
            // Update UI checkbox
            const servoAbbrevMap = {
                'frontLeft': 'FL',
                'frontRight': 'FR',
                'rearLeft': 'RL',
                'rearRight': 'RR'
            };
            const abbrev = servoAbbrevMap[servo];
            if (abbrev) {
                const checkbox = document.getElementById(`servo${abbrev}Reversed`);
                if (checkbox) {
                    checkbox.checked = value;
                }
            }
        }
        
        async function handleAutoLevel() {
            console.log('handleAutoLevel called');
            const button = document.getElementById('autoLevelBtn');
            console.log('Button found:', button);
            console.log('Button disabled:', button ? button.disabled : 'N/A');
            console.log('Button has active class:', button ? button.classList.contains('active') : 'N/A');
            
            if (!button) {
                console.error('Auto Level button not found!');
                return;
            }
            
            if (button.disabled) {
                console.warn('Auto Level button is disabled');
                return;
            }
            
            if (button.classList.contains('active')) {
                console.warn('Auto Level button is already active');
                return;
            }

            // Check if config is loaded
            if (!fullConfig || !fullConfig.servos) {
                console.error('Configuration not loaded');
                toast.error('Configuration not loaded');
                return;
            }
            
            // Start auto-level immediately (no modal)
            executeAutoLevel(false);
        }

        async function executeAutoLevel(resetTrims = false) {
            const button = document.getElementById('autoLevelBtn');
            const setLevelBtn = document.getElementById('setLevelBtn');
            
            // Open bubble level container to show progress
            openBubbleLevelContainer();
            setBubbleLevelStatus('Initializing auto-level...');
            
            // Set button to active/busy state
            button.classList.add('active');
            button.disabled = true;
            if (setLevelBtn) setLevelBtn.disabled = true;
            
            // Make wand icon pulsate
            const wandIcon = button.querySelector('.material-symbols-outlined');
            if (wandIcon) wandIcon.classList.add('pulsating');
            
            // Constants
            const MAX_ADJUSTMENT = 20;
            const LEVEL_TOLERANCE = 1.5;
            const ADJUSTMENT_STEP = 2;
            const MAX_ITERATIONS = 15;
            const TEST_MOVEMENT = 10;
            const SENSOR_SETTLE_MS = 1000;
            
            const servos = ['frontLeft', 'frontRight', 'rearLeft', 'rearRight'];
            const servoLabelMap = {
                frontLeft: 'Front Left',
                frontRight: 'Front Right',
                rearLeft: 'Rear Left',
                rearRight: 'Rear Right'
            };
            const servoState = {};
            
            // Initialize servo state from config
            servos.forEach(servo => {
                if (fullConfig.servos[servo]) {
                    const configuredTrim = fullConfig.servos[servo].trim;
                    servoState[servo] = {
                        trim: Number.isFinite(configuredTrim) ? configuredTrim : 0,
                        reversed: fullConfig.servos[servo].reversed || false
                    };
                }
            });
            
            try {
                // ==================== Phase 0: Reset trims to neutral (center) if requested ====================
                if (resetTrims) {
                    console.log('Phase 0: Starting trim reset to neutral...');
                    setBubbleLevelStatus('Resetting trims to neutral...');
                    
                    for (const servo of servos) {
                        // Neutral trim offset is always 0
                        const center = 0;
                        console.log(`Phase 0: Resetting ${servo} to neutral (trim=${center})`);
                        
                        // Send API call to update servo trim
                        await updateServoTrim(servo, center);
                        servoState[servo].trim = center;
                        
                        // Wait 1500ms total (servo movement 1000ms + SPIFFS save 500ms happen concurrently)
                        await delay(1500);
                    }
                    
                    console.log('Phase 0: Trim reset complete, fetching updated config from RCDCCC module...');
                    setBubbleLevelStatus('Neutral position set. Confirming data saved correctly...');
                    
                    // Fetch latest config from RCDCCC module to confirm all values were saved
                    ensureBleConnectedOrThrow();
                    const updatedConfig = await bleManager.readConfig();
                    if (updatedConfig) {
                        if (updatedConfig && updatedConfig.servos) {
                            fullConfig = updatedConfig;
                            servos.forEach(servo => {
                                if (updatedConfig.servos[servo]) {
                                    servoState[servo].trim = updatedConfig.servos[servo].trim || 0;
                                }
                            });
                            console.log('Phase 0: Config refreshed from RCDCCC module.');
                        }
                    }
                    
                    setBubbleLevelStatus('Neutral confirmed. Let chassis settle...');
                    await delay(SENSOR_SETTLE_MS);
                }
                

                // ==================== Phase A: Servo Direction Verification (Pitch-Only) ====================
                autoLevelPhaseA = true; // Enable smooth bubble animation
                setBubbleLevelStatus('Verifying servo directions...');
                await delay(SENSOR_SETTLE_MS);
                
                // Expected pitch change when moving +10° (front up = +pitch)
                const servoExpectedPitch = {
                    frontLeft: 'positive',
                    frontRight: 'positive',
                    rearLeft: 'negative',
                    rearRight: 'negative'
                };
                
                const needsReversal = {};
                
                // FIRST PASS: Test all servos to detect which ones need reversal
                for (const servo of servos) {
                    const servoLabel = servoLabelMap[servo] || servo;
                    setBubbleLevelStatus(`Testing ${servoLabel}...`);
                    
                    const initialTrim = servoState[servo].trim;
                    const testTrim = initialTrim + TEST_MOVEMENT; // Move +10°
                    
                    // Get baseline reading at neutral position
                    const baselineSensor = await getSensorData();
                    const baselinePitch = baselineSensor.pitch;
                    
                    // Move servo +10° and read response
                    await updateServoTrim(servo, testTrim);
                    servoState[servo].trim = testTrim;
                    console.log(`Phase A: Testing ${servo} at +10 (trim=${testTrim})`);
                    await delay(SENSOR_SETTLE_MS);
                    
                    const movedSensor = await getSensorData();
                    const pitchChange = movedSensor.pitch - baselinePitch;
                    
                    // Check if direction is correct (threshold avoids noise)
                    const expected = servoExpectedPitch[servo];
                    const isCorrectDirection = (expected === 'positive' && pitchChange > 1) ||
                                               (expected === 'negative' && pitchChange < -1);
                    
                    needsReversal[servo] = !isCorrectDirection;
                    console.log(`Phase A: ${servo} pitch change: ${pitchChange.toFixed(2)}°. ${isCorrectDirection ? 'CORRECT' : 'NEEDS REVERSAL'}`);
                    
                    // Return to neutral
                    await updateServoTrim(servo, initialTrim);
                    servoState[servo].trim = initialTrim;
                    await delay(SENSOR_SETTLE_MS);
                }
                
                // SECOND PASS: Apply reversals and verify they work
                for (const servo of servos) {
                    if (needsReversal[servo]) {
                        const servoLabel = servoLabelMap[servo] || servo;
                        const newReversedState = !servoState[servo].reversed;
                        
                        setBubbleLevelStatus(`Fixing ${servoLabel} direction...`);
                        await updateServoReversed(servo, newReversedState);
                        servoState[servo].reversed = newReversedState;
                        await delay(500); // Let reversal setting take effect
                        
                        // Verify the reversal fixed the direction
                        setBubbleLevelStatus(`Verifying ${servoLabel}...`);
                        const initialTrim = servoState[servo].trim;
                        const testTrim = initialTrim + TEST_MOVEMENT;
                        
                        const baselineSensor = await getSensorData();
                        const baselinePitch = baselineSensor.pitch;
                        
                        await updateServoTrim(servo, testTrim);
                        servoState[servo].trim = testTrim;
                        await delay(SENSOR_SETTLE_MS);
                        
                        const movedSensor = await getSensorData();
                        const pitchChange = movedSensor.pitch - baselinePitch;
                        
                        const expected = servoExpectedPitch[servo];
                        const isNowCorrect = (expected === 'positive' && pitchChange > 1) ||
                                             (expected === 'negative' && pitchChange < -1);
                        
                        if (!isNowCorrect) {
                            console.log(`Phase A: ${servo} reversal verification FAILED. Pitch change: ${pitchChange.toFixed(2)}°`);
                            throw new Error(`Servo ${servoLabel} failed direction verification after reversal.`);
                        }
                        console.log(`Phase A: ${servo} verified OK after reversal`);
                        
                        // Return to neutral
                        await updateServoTrim(servo, initialTrim);
                        servoState[servo].trim = initialTrim;
                        await delay(SENSOR_SETTLE_MS);
                    }
                }
                
                autoLevelPhaseA = false; // Disable smooth animation, re-enable snapping
                
                // ==================== Phase B: Iterative leveling ====================
                setBubbleLevelStatus('Starting auto-level...');
                await delay(SENSOR_SETTLE_MS);
                
                let levelAchieved = false;
                
                for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
                    setBubbleLevelStatus(`Attempting to auto level... (${iteration}/${MAX_ITERATIONS})`);
                    
                    // Read current orientation
                    const sensor = await getSensorData();
                    const roll = sensor.roll;
                    const pitch = sensor.pitch;
                    
                    // Check if level achieved
                    if (Math.abs(roll) < LEVEL_TOLERANCE && Math.abs(pitch) < LEVEL_TOLERANCE) {
                        setBubbleLevelStatus('Level achieved!');
                        levelAchieved = true;
                        await delay(2000);
                        break;
                    }
                    
                    // Compute adjustments (clamped to ADJUSTMENT_STEP)
                    const rollAdjustment = Math.min(Math.abs(roll), ADJUSTMENT_STEP) * Math.sign(roll);
                    const pitchAdjustment = Math.min(Math.abs(pitch), ADJUSTMENT_STEP) * Math.sign(pitch);
                    
                    // Compute per-servo trim deltas
                    const deltas = {
                        frontLeft: rollAdjustment - pitchAdjustment,
                        frontRight: -rollAdjustment - pitchAdjustment,
                        rearLeft: rollAdjustment + pitchAdjustment,
                        rearRight: -rollAdjustment + pitchAdjustment
                    };
                    
                    // Update trims (clamped to ±MAX_ADJUSTMENT)
                    for (const servo of servos) {
                        const currentTrim = servoState[servo].trim;
                        const newTrim = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, currentTrim + deltas[servo]));
                        const roundedTrim = Math.round(newTrim);
                        
                        if (roundedTrim !== currentTrim) {
                            await updateServoTrim(servo, roundedTrim);
                            servoState[servo].trim = roundedTrim;
                        }
                    }
                    
                    await delay(SENSOR_SETTLE_MS);
                }
                
                if (!levelAchieved) {
                    setBubbleLevelStatus('Vehicle is too unlevel for auto level to correct');
                    // Persistent failure toast - stays until clicked (duration: 0)
                    toast.error('Auto level failed - the vehicle is too unlevel for auto level to correct. Please ensure it is on a relatively flat surface and try again.', { duration: 0 });
                    await delay(3000);
                }
                
                // Close bubble level
                closeBubbleLevelContainer();
                
                if (levelAchieved) {
                    // Show success toast (auto-dismisses after 4 seconds)
                    toast.success('Vehicle leveled successfully! All trim adjustments have been applied and saved.', { duration: 4000 });
                }
                
            } catch (error) {
                console.error('Auto-leveling failed:', error);
                setBubbleLevelStatus('Error occurred.');
                
                // Close bubble level and show persistent error toast
                closeBubbleLevelContainer();
                toast.error(`Auto-level error: ${error.message}`, { duration: 0 });
            } finally {
                // Restore button state
                button.classList.remove('active');
                button.disabled = false;
                if (setLevelBtn) setLevelBtn.disabled = false;
                
                // Stop wand icon pulsating
                const wandIcon = button.querySelector('.material-symbols-outlined');
                if (wandIcon) wandIcon.classList.remove('pulsating');
            }
        }

        document.addEventListener('DOMContentLoaded', function() {
            setCardBodiesLoading(true);

            if (bleManager && bleManager.setDisconnectCallback) {
                bleManager.setDisconnectCallback(() => {
                    communicationMode = 'ble';
                    hasLoadedConfigFromDevice = false;
                    startHeartbeat();
                    updateConnectionStatus(false);
                    updateConnectionMethodDisplay();
                    if (!manualBleDisconnect) {
                        startAutoReconnect('disconnect-callback');
                    }
                });
            }
            if (bleManager && bleManager.setTelemetryCallback) {
                bleManager.setTelemetryCallback((telemetry) => {
                    applyTelemetrySample(telemetry);
                    communicationMode = 'ble';
                    stopAutoReconnect();
                    updateConnectionStatus(true);
                    updateConnectionMethodDisplay();
                });
            }

            window.addEventListener('focus', () => {
                if (!isBleConnected()) startAutoReconnect('window-focus');
            });
            window.addEventListener('online', () => {
                if (!isBleConnected()) startAutoReconnect('online');
            });
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && !isBleConnected()) {
                    startAutoReconnect('visibility');
                }
            });

            // Disable pull-to-refresh by preventing overscroll-behavior
            document.documentElement.style.overscrollBehavior = 'none';
            document.body.style.overscrollBehavior = 'none';
            
            // Prevent touchmove pull-to-refresh on document level
            let lastY = 0;
            document.addEventListener('touchstart', function(e) {
                lastY = e.touches[0].clientY;
            }, { passive: true });
            
            document.addEventListener('touchmove', function(e) {
                const currentY = e.touches[0].clientY;
                // Prevent pull-to-refresh (scroll down from top)
                if (currentY > lastY && window.scrollY === 0) {
                    e.preventDefault();
                }
            }, { passive: false });
            
            // Register Service Worker only for browser/PWA mode, not native Capacitor WebView.
            const isCapacitorNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
            if (!isCapacitorNative && 'serviceWorker' in navigator) {
                navigator.serviceWorker.register('/sw.js')
                    .then(registration => {
                        console.log('[PWA] Service Worker registered:', registration.scope);
                    })
                    .catch(error => {
                        console.warn('[PWA] Service Worker registration failed:', error);
                    });
            } else if (isCapacitorNative && 'serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistrations()
                    .then(registrations => {
                        registrations.forEach(registration => registration.unregister());
                    })
                    .catch(() => {
                        // Best-effort cleanup; ignore if unsupported by current WebView.
                    });
            }
            
            // Start ESP32 heartbeat monitor
            initHeartbeatMonitor();
            
            // Display ESP32 IP address on dashboard
            const ipDisplay = document.getElementById('deviceIpDisplay');
            if (ipDisplay) ipDisplay.textContent = 'BLE';
            
            // Display connection method on dashboard
            updateConnectionMethodDisplay();

            // Best-effort reconnect on page load for already-authorized devices.
            startAutoReconnect('startup');
            
            // Display protocol and secure context for debugging (PWA)
            const protocolDisplay = document.getElementById('protocolDisplay');
            const secureContextDisplay = document.getElementById('secureContextDisplay');
            
            if (protocolDisplay) {
                const protocol = window.location.protocol;
                protocolDisplay.textContent = protocol;
                
                // Color-code the protocol
                if (protocol === 'https:') {
                    protocolDisplay.style.color = 'var(--lime-green)';
                } else if (protocol === 'http:') {
                    protocolDisplay.style.color = 'var(--warning)';
                } else if (protocol === 'file:') {
                    protocolDisplay.style.color = 'var(--danger)';
                }
            }
            
            if (secureContextDisplay) {
                const isSecure = window.isSecureContext;
                
                if (isSecure) {
                    secureContextDisplay.textContent = 'Yes';
                    secureContextDisplay.style.color = 'var(--lime-green)';
                } else {
                    secureContextDisplay.textContent = 'No';
                    secureContextDisplay.style.color = 'var(--danger)';
                    console.warn('Not a secure context. Protocol:', window.location.protocol);
                }
            }
            
            // Fetch config from ESP32
            fetchConfigFromESP32();
            
            // Initialize tuning sliders
            initTuningSliders();
            
            // Initialize servo sliders
            initServoSliders();
            
            // Initialize light controls
            // initLightControls(); // Commented out - slider library not yet connected
            
            // Initialize settings controls
            initServoControls(); // Initialize servo rotation badge click handlers
            // initGyroControls(); // Commented out - slider library not yet connected
            initNetworkSettings();
            applyRequestedLayoutMoves();
            initSettingsTabs();
            initDeveloperMode();

            // Initialize notification sounds toggle
            const enableSoundsCheckbox = document.getElementById('enableNotificationSounds');
            if (enableSoundsCheckbox) {
                // Set initial state from localStorage
                enableSoundsCheckbox.checked = localStorage.getItem('notificationSoundsEnabled') !== 'false';
                
                // Add change listener
                enableSoundsCheckbox.addEventListener('change', function() {
                    notificationSoundsEnabled = this.checked;
                    localStorage.setItem('notificationSoundsEnabled', this.checked);
                    toast.success('Notification sounds ' + (this.checked ? 'enabled' : 'disabled'));
                });
            }

            // Initialize GPS coordinates
            captureGPSCoordinates()

            // Initialize bubble level container
            initBubbleLevelContainer();
            
            // Restore tuning parameters lock state from localStorage
            const tuningLocked = localStorage.getItem('tuningParametersLocked') === 'true';
            const tuningLockIcon = document.getElementById('tuningLockIcon');
            const tuningCard = document.getElementById('tuningParametersCard');
            if (tuningLockIcon && tuningCard) {
                if (tuningLocked) {
                    tuningCard.classList.add('slider-locked');
                    tuningLockIcon.textContent = 'lock';
                    tuningLockIcon.style.color = 'var(--lime-green)'; // Lime green
                    // Set all individual slider locks to true
                    Object.keys(tuningSliderLocks).forEach(key => {
                        tuningSliderLocks[key] = true;
                    });
                } else {
                    tuningCard.classList.remove('slider-locked');
                    tuningLockIcon.textContent = 'lock_open_right';
                    tuningLockIcon.style.color = 'var(--high-impact-color)'; // Yellow
                    Object.keys(tuningSliderLocks).forEach(key => {
                        tuningSliderLocks[key] = false;
                    });
                }
            }
            
            // Restore formulas card collapse state from localStorage
            const formulasCollapsed = localStorage.getItem('formulasCardCollapsed') === 'true';
            const formulasCardBody = document.getElementById('formulasCardBody');
            const formulasChevron = document.getElementById('formulasChevron');
            if (formulasCardBody && formulasChevron) {
                formulasCardBody.style.display = formulasCollapsed ? 'none' : 'block';
                formulasChevron.textContent = formulasCollapsed ? 'keyboard_arrow_right' : 'keyboard_arrow_down';
            }

            // Restore light guide card collapse state from localStorage
            const lightsGuideCollapsed = localStorage.getItem('lightsGuideCardCollapsed') === 'true';
            const lightsGuideCardBody = document.getElementById('lightsGuideCardBody');
            const lightsGuideChevron = document.getElementById('lightsGuideChevron');
            if (lightsGuideCardBody && lightsGuideChevron) {
                lightsGuideCardBody.style.display = lightsGuideCollapsed ? 'none' : 'block';
                lightsGuideChevron.textContent = lightsGuideCollapsed ? 'keyboard_arrow_right' : 'keyboard_arrow_down';
            }
            
            // Restore servo range lock state from localStorage
            servoRangeLocked = localStorage.getItem('servoRangeLocked') === 'true';
            const servoRangeLockIcon = document.getElementById('servoRangeLockIcon');
            const servoRangeCard = document.getElementById('servoRangeCard');
            if (servoRangeLockIcon && servoRangeCard) {
                servoRangeCard.classList.toggle('slider-locked', servoRangeLocked);
                servoRangeLockIcon.textContent = servoRangeLocked ? 'lock' : 'lock_open_right';
                servoRangeLockIcon.style.color = servoRangeLocked ? 'var(--lime-green)' : 'var(--high-impact-color)'; // Lime green if locked, yellow if unlocked
            }
            
            // Restore servo trim lock state from localStorage
            servoTrimLocked = localStorage.getItem('servoTrimLocked') === 'true';
            const servoTrimLockIcon = document.getElementById('servoTrimLockIcon');
            const servoTrimCard = document.getElementById('servoTrimCard');
            if (servoTrimLockIcon && servoTrimCard) {
                servoTrimCard.classList.toggle('slider-locked', servoTrimLocked);
                servoTrimLockIcon.textContent = servoTrimLocked ? 'lock' : 'lock_open_right';
                servoTrimLockIcon.style.color = servoTrimLocked ? 'var(--lime-green)' : 'var(--high-impact-color)'; // Lime green if locked, yellow if unlocked
            }
            
            // Restore servo rotation lock state from localStorage
            servoRotationLocked = localStorage.getItem('servoRotationLocked') === 'true';
            const servoRotationLockIcon = document.getElementById('servoRotationLockIcon');
            const servoRotationCard = document.getElementById('servoRotationCard');
            if (servoRotationLockIcon && servoRotationCard) {
                servoRotationCard.classList.toggle('slider-locked', servoRotationLocked);
                servoRotationLockIcon.textContent = servoRotationLocked ? 'lock' : 'lock_open_right';
                servoRotationLockIcon.style.color = servoRotationLocked ? 'var(--lime-green)' : 'var(--high-impact-color)'; // Lime green if locked, yellow if unlocked
            }

            // Header scroll shrink effect
            const dashboardHeader = document.querySelector('.dashboard-header');
            const brandTitles = document.querySelectorAll('.brand-title');
            
            function updateHeaderScroll() {
                const scrollPosition = window.scrollY;
                const isScrolled = scrollPosition > 50;
                
                if (isScrolled) {
                    dashboardHeader.classList.add('scrolled');
                    // Update the title to show current page
                    brandTitles.forEach(brandTitle => {
                        let h1 = brandTitle.querySelector('h1');
                        if (!h1) {
                            h1 = document.createElement('h1');
                            brandTitle.appendChild(h1);
                        }
                        
                        const activeSection = document.querySelector('.page-section.active');
                        if (activeSection) {
                            const sectionTitle = activeSection.querySelector('.section-title');
                            if (sectionTitle) {
                                h1.textContent = sectionTitle.textContent;
                                h1.style.display = 'block';
                            }
                        }
                    });
                } else {
                    dashboardHeader.classList.remove('scrolled');
                    // Hide h1 elements and show images again
                    brandTitles.forEach(brandTitle => {
                        const h1 = brandTitle.querySelector('h1');
                        if (h1) {
                            h1.style.display = 'none';
                        }
                    });
                }
            }
            
            window.addEventListener('scroll', updateHeaderScroll, { passive: true });

            // Page navigation - footer nav buttons
            document.querySelectorAll('.footer-nav button').forEach(btn => {
                btn.addEventListener('click', function() {
                    const target = this.dataset.target;
                    if (target) {
                        navigateToSection(target);
                    }
                });
            });
            
            // Set as Level button
            const setLevelBtn = document.getElementById('setLevelBtn');
            if (setLevelBtn) {
                setLevelBtn.addEventListener('click', handleSetAsLevel);
            }
            
            // Auto Level button
            const autoLevelBtn = document.getElementById('autoLevelBtn');
            console.log('Auto Level button element:', autoLevelBtn);
            if (autoLevelBtn) {
                autoLevelBtn.addEventListener('click', handleAutoLevel);
                console.log('Auto Level button click listener attached');
                
                // Check if button is visible
                console.log('Button parent tab-pane:', autoLevelBtn.closest('.tab-pane'));
                console.log('Tab-pane is active:', autoLevelBtn.closest('.tab-pane')?.classList.contains('active'));
                console.log('Button computed style display:', window.getComputedStyle(autoLevelBtn).display);
                console.log('Button computed style visibility:', window.getComputedStyle(autoLevelBtn).visibility);
                console.log('Button computed style pointer-events:', window.getComputedStyle(autoLevelBtn).pointerEvents);
            } else {
                console.error('Auto Level button not found during initialization!');
            }

            // Auto Level Start button
            const autoLevelStartBtn = document.getElementById('autoLevelStartBtn');
            if (autoLevelStartBtn) {
                autoLevelStartBtn.addEventListener('click', function() {
                    const resetTrimsCheckbox = document.getElementById('resetTrimsCheckbox');
                    const resetTrims = resetTrimsCheckbox ? resetTrimsCheckbox.checked : false;
                    
                    // Close the setup modal
                    const modal = bootstrap.Modal.getInstance(document.getElementById('autoLevelSetupModal'));
                    if (modal) modal.hide();
                    
                    // Execute auto-level with the checkbox state
                    executeAutoLevel(resetTrims);
                });
            }

            // Roll/Pitch refresh button (on-demand)
            const rollPitchRefreshBtn = document.getElementById('rollPitchRefreshBtn');
            if (rollPitchRefreshBtn) {
                rollPitchRefreshBtn.addEventListener('click', () => {
                    captureGPSCoordinates();
                    fetchRollPitchSnapshot();
                });
            }

            // ==================== Light Hierarchy Controls ====================
            const lightsToggleIcon = document.getElementById('lightsToggleIcon');
            const lightsToggleDashboard = document.getElementById('lightsToggleDashboard');
            const lightsToggleHeaderIcon = document.getElementById('lightsToggleHeaderIcon');

            bindHeaderLightIcon(lightsToggleIcon);
            bindMasterLightSwitch(lightsToggleDashboard);
            bindHeaderLightIcon(lightsToggleHeaderIcon);
            syncMasterLightSwitches(getMasterLightsEnabled());
            
            // Suspension Settings gear click - navigate to Tuning
            const suspGear = document.getElementById('suspensionSettingsGear');
            if (suspGear) {
                suspGear.addEventListener('click', function() {
                    navigateToSection('tuning');
                });
            }
            
            // Connection Settings gear click - navigate to Settings
            ['connectionSettingsGear', 'wifiIcon'].forEach(elementId => {
                const element = document.getElementById(elementId);
                if (element) {
                    element.addEventListener('click', function() {
                        navigateToSection('settings');
                        setTimeout(() => openSettingsTab('network'), 0);
                    });
                }
            });
            
            // Console Clear button
            const consoleClearBtn = document.getElementById('consoleClearBtn');
            if (consoleClearBtn) {
                consoleClearBtn.addEventListener('click', function() {
                    const consoleOutput = document.getElementById('consoleOutput');
                    if (consoleOutput) {
                        consoleOutput.innerHTML = '';
                        console.log('Console cleared');
                    }
                });
            }
            
            // Console Copy button
            const consoleCopyBtn = document.getElementById('consoleCopyBtn');
            if (consoleCopyBtn) {
                consoleCopyBtn.addEventListener('click', function() {
                    const consoleOutput = document.getElementById('consoleOutput');
                    if (consoleOutput && consoleOutput.textContent) {
                        copyToClipboard(consoleOutput.textContent, consoleCopyBtn);
                    }
                });
            }
            
            // Config Copy button
            const configCopyBtn = document.getElementById('configCopyBtn');
            if (configCopyBtn) {
                configCopyBtn.addEventListener('click', function() {
                    const configData = document.getElementById('configData');
                    if (configData && configData.textContent) {
                        copyToClipboard(configData.textContent, configCopyBtn);
                    }
                });
            }

            // Tuning Configuration Copy button
            const tuningConfigCopyBtn = document.getElementById('tuningConfigCopyBtn');
            if (tuningConfigCopyBtn) {
                tuningConfigCopyBtn.addEventListener('click', function() {
                    const tuningConfigData = document.getElementById('tuningConfigData');
                    if (tuningConfigData && tuningConfigData.textContent) {
                        copyToClipboard(tuningConfigData.textContent, tuningConfigCopyBtn);
                    }
                });
            }

            // Lighting Configuration Copy button
            const lightingConfigCopyBtn = document.getElementById('lightingConfigCopyBtn');
            if (lightingConfigCopyBtn) {
                lightingConfigCopyBtn.addEventListener('click', function() {
                    const lightingConfigData = document.getElementById('lightingConfigData');
                    if (lightingConfigData && lightingConfigData.textContent) {
                        copyToClipboard(lightingConfigData.textContent, lightingConfigCopyBtn);
                    }
                });
            }
            
            // Restore page from localStorage
            const lastPage = localStorage.getItem('currentPage') || 'dashboard';
            navigateToSection(lastPage);

        });

        // Helper function to copy text to clipboard with fallback
        function copyToClipboard(text, element) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                // Modern Clipboard API
                navigator.clipboard.writeText(text).then(() => {
                    console.log('Text copied to clipboard');
                    showCopyFeedback(element);
                }).catch(err => {
                    console.error('Failed to copy: ', err);
                    fallbackCopy(text, element);
                });
            } else {
                // Fallback for older browsers
                fallbackCopy(text, element);
            }
        }

        // Fallback copy method using execCommand
        function fallbackCopy(text, element) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                console.log('Text copied to clipboard (fallback)');
                showCopyFeedback(element);
            } catch (err) {
                console.error('Failed to copy (fallback): ', err);
            }
            document.body.removeChild(textarea);
        }

        // Show visual feedback for copy action
        function showCopyFeedback(element) {
            if (element) {
                const originalTitle = element.title;
                element.title = 'Copied!';
                setTimeout(() => {
                    element.title = originalTitle;
                }, 2000);
            }
        }

        // Helper function to navigate to a section
        function navigateToSection(sectionId) {
            document.querySelectorAll('.footer-nav button').forEach(b => b.classList.remove('active'));
            const navBtn = document.querySelector(`.footer-nav button[data-target="${sectionId}"]`);
            if (navBtn) navBtn.classList.add('active');
            
            document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
            const section = document.getElementById(sectionId);
            if (section) section.classList.add('active');
            
            // Save current page to localStorage
            localStorage.setItem('currentPage', sectionId);
            
            // Trigger header scroll update for title change
            const scrollEvent = new Event('scroll');
            window.dispatchEvent(scrollEvent);
            
            window.scrollTo(0, 0);

            if (sectionId === 'settings') {
                setTimeout(refreshServoSliderRender, 50);
            }
        }

        // ==================== System Notification LEDs ====================
        const NOTIFICATION_GROUP_KEY = 'systemNotificationGroup';
        
        // Get the selected notification group name
        function getNotificationGroup() {
            return localStorage.getItem(NOTIFICATION_GROUP_KEY) || '__all__';
        }
        
        // Save the selected notification group
        function saveNotificationGroup() {
            const select = document.getElementById('notificationGroupSelect');
            if (!select) return;
            
            const value = select.value;
            localStorage.setItem(NOTIFICATION_GROUP_KEY, value);
            
            if (value === '__none__') {
                window.toast.success('LED notifications disabled');
            } else if (value === '__all__') {
                window.toast.success('All LEDs will flash for notifications');
            } else {
                window.toast.success(`"${value}" group will flash for notifications`);
            }
        }
        
        // Populate notification group dropdown with available light groups
        function populateNotificationGroupSelect() {
            const select = document.getElementById('notificationGroupSelect');
            if (!select) return;
            
            const savedValue = getNotificationGroup();
            
            // Clear existing light group options (keep __none__ and __all__)
            const staticOptions = Array.from(select.querySelectorAll('option[value^="__"]'));
            select.innerHTML = '';
            staticOptions.forEach(opt => select.appendChild(opt));
            
            // Add all light groups
            lightGroups.forEach(group => {
                const option = document.createElement('option');
                option.value = group.name;
                option.textContent = group.name;
                select.appendChild(option);
            });
            
            // Restore saved value (with fallback validation)
            if (savedValue === '__none__' || savedValue === '__all__') {
                select.value = savedValue;
            } else {
                // Check if saved group still exists
                const groupExists = lightGroups.some(g => g.name === savedValue);
                if (groupExists) {
                    select.value = savedValue;
                } else {
                    // Failover: Group was deleted, switch to "All LEDs"
                    select.value = '__all__';
                    localStorage.setItem(NOTIFICATION_GROUP_KEY, '__all__');
                }
            }
        }
        
        // Flash LEDs for system notifications
        function flashNotificationLEDs(type) {
            const groupName = getNotificationGroup();
            
            // Check if notifications are disabled
            if (groupName === '__none__') {
                return;
            }
            
            // Determine color based on notification type
            let color;
            switch (type) {
                case 'success':
                    color = '#00ff00'; // Green
                    break;
                case 'error':
                    color = '#ff0000'; // Red
                    break;
                case 'warning':
                    color = '#ffa500'; // Amber
                    break;
                case 'info':
                    color = '#0000ff'; // Blue
                    break;
                default:
                    color = '#ffffff'; // White fallback
            }
            
            // Get LED indices to flash
            let indices = [];
            if (groupName === '__all__') {
                // Flash all LEDs
                const totalCount = parseInt(localStorage.getItem(TOTAL_LED_COUNT_KEY)) || 100;
                indices = Array.from({ length: totalCount }, (_, i) => i);
            } else {
                // Find the group and use its LEDs
                const group = lightGroups.find(g => g.name === groupName);
                if (group && group.indices && group.indices.length > 0) {
                    indices = group.indices;
                } else {
                    // Failover: Group not found or has no LEDs, use all LEDs
                    const totalCount = parseInt(localStorage.getItem(TOTAL_LED_COUNT_KEY)) || 100;
                    indices = Array.from({ length: totalCount }, (_, i) => i);
                }
            }
            
            // TODO: Send flash command to ESP32
            // For now, log the flash request
            console.log(`Flash notification: type=${type}, color=${color}, LEDs=${indices.join(',')}`);
            
            // API call would look something like:
            // fetch(getApiUrl('/api/notification-flash'), {
            //     method: 'POST',
            //     headers: { 'Content-Type': 'application/json' },
            //     body: JSON.stringify({ indices, color, duration: 300, flashes: 2 })
            // });
        }
        
        // Test notification flash
        function testNotification(type) {
            flashNotificationLEDs(type);
            
            // Show a toast as visual confirmation
            const messages = {
                success: 'Testing success notification',
                error: 'Testing error notification',
                warning: 'Testing warning notification',
                info: 'Testing info notification'
            };
            
            window.toast[type](messages[type] || 'Testing notification flash');
        }

        // ==================== Light Groups Management ====================
        const LIGHT_GROUPS_STORAGE_KEY = 'lightGroups';
        const LIGHT_MASTER_STORAGE_KEY = 'lightsMasterEnabled';
        const TOTAL_LED_COUNT_KEY = 'totalLEDCount';
        const COLOR_PRESETS_KEY = 'lightGroupColorPresets';
        const LIGHT_GROUPS_INITIALIZED_KEY = 'lightGroupsInitialized';
        const LIGHT_GROUP_DEFAULT_PATTERN = 'Steady';
        const LIGHT_GROUP_CYCLE_INTERVAL_SECONDS = 30;
        const LIGHT_GROUP_EXTRA_PATTERNS = ['Steady', 'Double Flash', 'Strobe', 'Breathe', 'Flicker', 'Cycle', 'Cycle Favorites'];
        
        // Predefined light groups (initialized on first load)
        const PREDEFINED_LIGHT_GROUPS = [
            { name: 'Brake Lights', indices: [], brightness: 255, color: '#ff0000', color2: '#000000', pattern: 'Steady', enabled: false, isPredefined: true },
            { name: 'Emergency/Police Lights', indices: [], brightness: 255, color: '#ff0000', color2: '#0000ff', pattern: 'Whip Sweep', enabled: false, isPredefined: true },
            { name: 'Hazard Lights', indices: [], brightness: 255, color: '#ffa500', color2: '#000000', pattern: 'Fast Flash', enabled: false, isPredefined: true },
            { name: 'Headlights', indices: [], brightness: 255, color: '#ffffff', color2: '#000000', pattern: 'Steady', enabled: false, isPredefined: true },
            { name: 'Reverse Lights', indices: [], brightness: 255, color: '#ffffff', color2: '#000000', pattern: 'Steady', enabled: false, isPredefined: true },
            { name: 'Taillights', indices: [], brightness: 128, color: '#ff0000', color2: '#000000', pattern: 'Steady', enabled: false, isPredefined: true },
            { name: 'Turn Signals Left', indices: [], brightness: 255, color: '#ffa500', color2: '#000000', pattern: 'Fast Flash', enabled: false, isPredefined: true },
            { name: 'Turn Signals Right', indices: [], brightness: 255, color: '#ffa500', color2: '#000000', pattern: 'Fast Flash', enabled: false, isPredefined: true }
        ];
        const DEFAULT_COLOR_PRESETS = [
            '#ff0000', // Red
            '#00ff00', // Green
            '#0000ff', // Blue
            '#ffff00', // Yellow
            '#ff00ff', // Magenta
            '#00ffff', // Cyan
            '#ff8800', // Orange
            '#8800ff', // Purple
            '#ffffff', // White
            '#ffc107'  // Amber
        ];
        let lightGroups = [];
        let colorPresets = [];
        let currentColor2 = '#000000'; // Second color for dual-color patterns
        let activeFavoriteColorTarget = 'primary';
        let lightGroupsStateBeforeModal = null;
        let masterStateBeforeModal = false;
        let lightGroupModalSaved = false;

        // Load color presets from localStorage or use defaults
        function loadColorPresets() {
            const stored = localStorage.getItem(COLOR_PRESETS_KEY);
            colorPresets = stored ? JSON.parse(stored) : [...DEFAULT_COLOR_PRESETS];
            // Keep compatibility with older saved arrays that had fewer slots.
            if (!Array.isArray(colorPresets)) {
                colorPresets = [...DEFAULT_COLOR_PRESETS];
            }
            while (colorPresets.length < DEFAULT_COLOR_PRESETS.length) {
                colorPresets.push(DEFAULT_COLOR_PRESETS[colorPresets.length]);
            }
            if (colorPresets.length > DEFAULT_COLOR_PRESETS.length) {
                colorPresets = colorPresets.slice(0, DEFAULT_COLOR_PRESETS.length);
            }
            renderColorPresets();
        }

        // Save color presets to localStorage
        function saveColorPresets() {
            localStorage.setItem(COLOR_PRESETS_KEY, JSON.stringify(colorPresets));
            renderColorPresets();
        }

        // Render color preset buttons
        function renderColorPresets() {
            const container = document.getElementById('colorPresetsContainer');
            if (!container) return;
            
            container.innerHTML = '';
            
            colorPresets.forEach((color, index) => {
                const presetBtn = document.createElement('div');
                presetBtn.style.cssText = 'position: relative; display: inline-block;';
                
                const colorBtn = document.createElement('button');
                colorBtn.type = 'button';
                colorBtn.className = 'btn btn-sm';
                colorBtn.style.cssText = `background-color: ${color}; width: 40px; height: 40px; border: 2px solid #ddd; position: relative;`;
                colorBtn.title = `Use ${color} (${activeFavoriteColorTarget})`;
                colorBtn.onclick = () => setLightGroupColor(color, activeFavoriteColorTarget);
                
                const editIcon = document.createElement('span');
                editIcon.className = 'material-symbols-outlined';
                editIcon.textContent = 'edit';
                editIcon.style.cssText = 'position: absolute; top: -8px; right: -8px; font-size: 16px; background: white; border-radius: 50%; padding: 2px; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.3);';
                editIcon.title = 'Save current color to this slot';
                editIcon.onclick = (e) => {
                    e.stopPropagation();
                    updateColorPreset(index);
                };
                
                presetBtn.appendChild(colorBtn);
                presetBtn.appendChild(editIcon);
                container.appendChild(presetBtn);
            });
        }

        function getActiveFavoriteColor() {
            return activeFavoriteColorTarget === 'secondary' ? currentColor2 : currentColor;
        }

        // Update a specific preset slot with the currently selected target color
        function updateColorPreset(index) {
            const selectedColor = getActiveFavoriteColor();
            colorPresets[index] = selectedColor;
            saveColorPresets();
            window.toast.success(`Preset ${index + 1} updated to ${selectedColor.toUpperCase()}`);
        }

        // Reset presets to defaults
        function resetColorPresets() {
            if (confirm('Reset all favorite colors to defaults?')) {
                colorPresets = [...DEFAULT_COLOR_PRESETS];
                saveColorPresets();
                window.toast.success('Color presets reset to defaults!');
            }
        }

        function firmwareColorToHex(value, fallback = '#000000') {
            if (typeof value === 'string') {
                const normalized = value.replace('#', '').trim();
                if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
                    return `#${normalized.toLowerCase()}`;
                }
            }

            if (typeof value === 'number' && Number.isFinite(value)) {
                return `#${(value & 0xFFFFFF).toString(16).padStart(6, '0')}`;
            }

            return fallback;
        }

        function patternFromMode(mode, blinkRate = 0) {
            switch (Number(mode)) {
                case 1: return 'Steady';
                case 2: return 'Strobe';
                case 3: return 'Breathe';
                case 4: return 'Whip Sweep';
                case 5: return 'Chase';
                case 6: return 'Flicker';
                case 7: return 'Dual Color Pulse';
                default:
                    return blinkRate > 0 ? 'Strobe' : LIGHT_GROUP_DEFAULT_PATTERN;
            }
        }

        async function loadLightGroups(esp32LightsData = null) {
            // Priority: 1) ESP32 data (if provided), 2) localStorage cache, 3) defaults
            if (esp32LightsData && esp32LightsData.length > 0) {
                // Load from ESP32 - this is the source of truth
                lightGroups = esp32LightsData.map(group => ({
                    ...group,
                    enabled: !!group.enabled
                }));
                console.log('Loaded light groups from ESP32:', lightGroups.length);
                
                // Cache to localStorage for offline editing
                localStorage.setItem(LIGHT_GROUPS_STORAGE_KEY, JSON.stringify(lightGroups));
                localStorage.setItem(LIGHT_GROUPS_INITIALIZED_KEY, 'true');
            } else {
                // Fallback to localStorage or defaults (offline mode)
                const initialized = localStorage.getItem(LIGHT_GROUPS_INITIALIZED_KEY);
                const stored = localStorage.getItem(LIGHT_GROUPS_STORAGE_KEY);

                if (!initialized) {
                    lightGroups = JSON.parse(JSON.stringify(PREDEFINED_LIGHT_GROUPS));
                    localStorage.setItem(LIGHT_GROUPS_INITIALIZED_KEY, 'true');
                } else {
                    lightGroups = stored ? JSON.parse(stored) : [];
                }

                lightGroups = lightGroups.map(group => ({
                    ...group,
                    enabled: !!group.enabled
                }));
                console.log('Loaded light groups from localStorage cache:', lightGroups.length);
            }

            saveLightGroups(false);
            renderLightGroupsList();
            renderLightsHierarchyControls();
        }

        function saveLightGroups(pushToHardware = true) {
            localStorage.setItem(LIGHT_GROUPS_STORAGE_KEY, JSON.stringify(lightGroups));
            renderLightGroupsList();
            renderLightsHierarchyControls();
            populateNotificationGroupSelect(); // Update notification group dropdown

            if (pushToHardware) {
                applyLightsHierarchyToHardware();
            }
        }

        function getMasterLightsEnabled() {
            return localStorage.getItem(LIGHT_MASTER_STORAGE_KEY) === 'true';
        }

        function setMasterLightsEnabled(isEnabled, applyNow = true) {
            localStorage.setItem(LIGHT_MASTER_STORAGE_KEY, isEnabled ? 'true' : 'false');
            syncMasterLightSwitches(isEnabled);
            if (applyNow) {
                applyLightsHierarchyToHardware();
            }
        }

        function syncMasterLightSwitches(isEnabled) {
            const masterIcon = document.getElementById('lightsToggleIcon');
            const dashboardToggle = document.getElementById('lightsToggleDashboard');
            const headerIcon = document.getElementById('lightsToggleHeaderIcon');
            if (dashboardToggle) dashboardToggle.checked = isEnabled;
            if (masterIcon) {
                masterIcon.style.color = isEnabled ? 'var(--bluetooth-blue)' : 'var(--text-muted)';
                masterIcon.setAttribute('aria-pressed', isEnabled ? 'true' : 'false');
            }
            if (headerIcon) {
                headerIcon.style.color = isEnabled ? 'var(--bluetooth-blue)' : 'var(--text-muted)';
                headerIcon.setAttribute('aria-pressed', isEnabled ? 'true' : 'false');
            }
        }

        function bindMasterLightSwitch(toggleElement) {
            if (!toggleElement || toggleElement.dataset.bound === 'true') return;

            toggleElement.dataset.bound = 'true';
            toggleElement.checked = getMasterLightsEnabled();
            toggleElement.addEventListener('change', function() {
                setMasterLightsEnabled(this.checked, true);
            });
        }

        function bindHeaderLightIcon(iconElement) {
            if (!iconElement || iconElement.dataset.bound === 'true') return;

            iconElement.dataset.bound = 'true';
            iconElement.addEventListener('click', function() {
                setMasterLightsEnabled(!getMasterLightsEnabled(), true);
            });
            iconElement.addEventListener('keydown', function(event) {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setMasterLightsEnabled(!getMasterLightsEnabled(), true);
                }
            });
        }

        function getPatternMode(patternName) {
            const value = (patternName || '').toLowerCase();
            if (!value) return 1;
            if (value.includes('dual color pulse')) return 7;
            if (value.includes('breathe') || value.includes('pulse')) return 3;
            if (value.includes('whip sweep') || value.includes('cycle')) return 4;
            if (value.includes('chase') || value.includes('wig wag')) return 5;
            if (value.includes('flicker')) return 6;
            if (value.includes('flash') || value.includes('strobe') || value.includes('beacon') || value.includes('double')) return 2;
            return 1;
        }

        function getPatternBlinkRate(patternName) {
            const value = (patternName || '').toLowerCase();
            if (value.includes('wig wag') || value.includes('chase')) return 120;
            if (value.includes('whip sweep') || value.includes('cycle')) return 210;
            if (value.includes('flicker')) return 90;
            if (value.includes('dual color pulse') || value.includes('breathe')) return 650;
            if (value.includes('strobe')) return 120;
            if (value.includes('fast')) return 180;
            if (value.includes('double')) return 220;
            if (value.includes('slow')) return 650;
            return 450;
        }

        function findFirstGroupByAliases(groups, aliases) {
            return groups.find(group => {
                const name = (group.name || '').toLowerCase();
                return aliases.some(alias => name.includes(alias));
            }) || null;
        }

        function buildFirmwareGroupState(group, forceEnabled = null) {
            const isEnabled = forceEnabled !== null ? forceEnabled : !!group?.enabled;
            if (!group || !isEnabled) {
                return { enabled: false, brightness: 100, mode: 0, blinkRate: 500 };
            }

            const rawBrightness = Number(group.brightness);
            const brightness = Number.isFinite(rawBrightness)
                ? Math.max(0, Math.min(255, rawBrightness))
                : 255;

            return {
                enabled: true,
                brightness,
                mode: getPatternMode(group.pattern),
                blinkRate: getPatternBlinkRate(group.pattern)
            };
        }

        function getFirmwareLightsPayload(groups, masterEnabled) {
            const active = masterEnabled ? groups : [];
            
            // Build new format with full light groups array
            const lightGroupsArray = active.map(group => {
                // Parse pattern to get mode and blink rate
                const mode = getPatternMode(group.pattern);
                const blinkRate = getPatternBlinkRate(group.pattern);
                const rawBrightness = Number(group.brightness);
                const brightness = Number.isFinite(rawBrightness)
                    ? Math.max(0, Math.min(255, rawBrightness))
                    : 255;
                
                // Convert hex colors to firmware format (remove #)
                const colorStr = (group.color || '#ff0000').replace('#', '');
                const color2Str = (group.color2 || '#000000').replace('#', '');
                
                return {
                    name: group.name,
                    enabled: !!group.enabled,
                    brightness,
                    color: colorStr,
                    color2: color2Str,
                    indices: group.indices || [],
                    mode: mode,
                    blinkRate: blinkRate,
                    pattern: group.pattern
                };
            });

            // Reverse order so top priority (index 0) processes last and wins LED conflicts
            return {
                lightGroupsArray: lightGroupsArray.reverse()
            };
        }

        function renderLightsHierarchyControls() {
            const container = document.getElementById('lightsHierarchyGroups');
            if (!container) return;

            container.innerHTML = '';

            if (!lightGroups.length) {
                container.innerHTML = '<div class="form-text"><small>No light groups available yet. Add groups in Settings > Light Settings.</small></div>';
                return;
            }

            const sortedGroups = [...lightGroups].sort((a, b) => a.name.localeCompare(b.name));
            sortedGroups.forEach(group => {
                const index = lightGroups.indexOf(group);
                const row = document.createElement('div');
                row.className = 'd-flex justify-content-between align-items-center border rounded px-2 py-2';

                const label = document.createElement('div');
                label.innerHTML = `<strong>${group.name}</strong><div class="form-text"><small>${group.indices?.length || 0} LED(s)</small></div>`;

                const switchWrap = document.createElement('div');
                switchWrap.className = 'form-check form-switch m-0';
                switchWrap.innerHTML = `<input class="form-check-input" type="checkbox" id="groupSwitch${index}" ${group.enabled ? 'checked' : ''}>`;

                const input = switchWrap.querySelector('input');
                input.addEventListener('change', () => {
                    lightGroups[index].enabled = input.checked;
                    saveLightGroups(true);
                });

                row.appendChild(label);
                row.appendChild(switchWrap);
                container.appendChild(row);
            });
        }

        function applyLightsHierarchyToHardware(override = null) {
            if (!isBleConnected()) {
                // Startup and offline states can update local light groups before BLE is connected.
                console.debug('[Lights] Skipping hardware sync: BLE not connected');
                return Promise.resolve();
            }

            const masterEnabled = override?.masterEnabled ?? getMasterLightsEnabled();
            const sourceGroups = override?.groups || lightGroups;
            const payload = getFirmwareLightsPayload(sourceGroups, masterEnabled || !!override?.forceMasterOn);

            console.log('[Lights] Sending to ESP32:', JSON.stringify(payload, null, 2));
            console.log('[Lights] Source groups:', sourceGroups.map(g => ({ name: g.name, enabled: g.enabled, indices: g.indices?.length })));

            return pushLightsPayload(payload)
            .catch(error => {
                console.error('Failed to apply hierarchy lights payload:', error);
            });
        }

        function isolateGroupForPreview(index, draftGroup = null) {
            const previewGroups = lightGroups.map((group, i) => ({
                ...group,
                enabled: i === index
            }));

            if (index !== null && draftGroup) {
                previewGroups[index] = {
                    ...previewGroups[index],
                    ...draftGroup,
                    enabled: true
                };
            }

            if (index === null && draftGroup) {
                previewGroups.push({ ...draftGroup, enabled: true });
            }

            return applyLightsHierarchyToHardware({
                forceMasterOn: true,
                groups: previewGroups,
                masterEnabled: true
            });
        }

        function restoreLightsAfterModal() {
            if (!lightGroupsStateBeforeModal) {
                applyLightsHierarchyToHardware();
                return;
            }

            // Restore enabled state exactly as it was before edit/test
            lightGroups = lightGroups.map((group, idx) => ({
                ...group,
                enabled: !!lightGroupsStateBeforeModal[idx]?.enabled
            }));

            saveLightGroups(false);
            setMasterLightsEnabled(masterStateBeforeModal, false);
            applyLightsHierarchyToHardware();

            lightGroupsStateBeforeModal = null;
        }

        function renderLightGroupsList() {
            const listContainer = document.getElementById('lightGroupsList');
            const emptyState = document.getElementById('lightGroupsEmptyState');
            
            if (!listContainer) return;
            
            listContainer.innerHTML = '';
            
            if (lightGroups.length === 0) {
                emptyState.style.display = 'block';
            } else {
                emptyState.style.display = 'none';
                // Render in current order (top = priority 1)
                lightGroups.forEach((group, index) => {
                    const item = document.createElement('div');
                    item.className = 'light-group-item';
                    item.setAttribute('data-index', index);
                    
                    const ledDisplay = formatLedRanges(group.indices);
                    const brightnessPercent = group.brightness !== undefined ? 
                        Math.round(group.brightness * 100 / 255) : 100;
                    const color = group.color || '#ff0000';
                    const color2 = group.color2 || '#000000';
                    const pattern = group.pattern || LIGHT_GROUP_DEFAULT_PATTERN;
                    const patternDisplay = (pattern === 'Cycle' || pattern === 'Cycle Favorites')
                        ? `${pattern} (${LIGHT_GROUP_CYCLE_INTERVAL_SECONDS}s)`
                        : pattern;
                    
                    // Show both colors if second color is not black/off
                    const colorDisplay = color2 !== '#000000' && color2 !== '#00000000'
                        ? `<span style="display: inline-block; width: 14px; height: 14px; background-color: ${color}; border: 1px solid #ddd; border-radius: 50%; vertical-align: middle; margin-right: 3px;"></span><span style="display: inline-block; width: 14px; height: 14px; background-color: ${color2}; border: 1px solid #ddd; border-radius: 50%; vertical-align: middle; margin-right: 6px;"></span>`
                        : `<span style="display: inline-block; width: 14px; height: 14px; background-color: ${color}; border: 1px solid #ddd; border-radius: 50%; vertical-align: middle; margin-right: 6px;"></span>`;
                    
                    const colorText = color2 !== '#000000' && color2 !== '#00000000'
                        ? `${color.toUpperCase()} / ${color2.toUpperCase()}`
                        : color.toUpperCase();
                    
                    // Determine configuration status
                    const isConfigured = group.indices && group.indices.length > 0;
                    const statusIcon = isConfigured
                        ? '<span class="material-symbols-outlined light-group-status-icon configured" title="Configured - LEDs assigned" style="font-size: 18px;">check_circle</span>'
                        : '<span class="material-symbols-outlined light-group-status-icon not-configured" title="Setup Required - No LEDs assigned" style="font-size: 18px;">warning</span>';
                    
                    // Disable up button if first item, down button if last item
                    const disableUp = index === 0;
                    const disableDown = index === lightGroups.length - 1;
                    
                    item.innerHTML = `
                        <div class="light-group-reorder-buttons">
                            <button onclick="moveLightGroupUp(${index})" ${disableUp ? 'disabled' : ''} title="Move up (higher priority)" class="btn-reorder" aria-label="Move up">
                                <span class="material-symbols-outlined">arrow_upward</span>
                            </button>
                            <button onclick="moveLightGroupDown(${index})" ${disableDown ? 'disabled' : ''} title="Move down (lower priority)" class="btn-reorder" aria-label="Move down">
                                <span class="material-symbols-outlined">arrow_downward</span>
                            </button>
                        </div>
                        <div class="light-group-priority" title="Priority (top = higher)">#${index + 1}</div>
                        <div class="light-group-info">
                            <div class="light-group-name">
                                ${colorDisplay}
                                <strong>${group.name}</strong>
                                ${statusIcon}
                            </div>
                            <div class="light-group-details">
                                <span title="LED indices">LEDs: ${ledDisplay}</span>
                                <span title="Brightness">Br: ${brightnessPercent}%</span>
                                <span title="Pattern">${patternDisplay}</span>
                            </div>
                        </div>
                        <div class="light-group-actions">
                            <button onclick="editLightGroup(${index})" title="Edit this group" class="btn-edit">
                                <span class="material-symbols-outlined">edit</span>
                            </button>
                            <button onclick="deleteLightGroup(${index})" class="btn-delete" title="Delete this group">
                                <span class="material-symbols-outlined">delete</span>
                            </button>
                        </div>
                    `;
                    
                    listContainer.appendChild(item);
                });
            }
        }
        
        // Replace drag-and-drop with up/down buttons
        function moveLightGroupUp(index) {
            if (index <= 0) return; // Already at top
            
            // Swap with previous item
            const temp = lightGroups[index];
            lightGroups[index] = lightGroups[index - 1];
            lightGroups[index - 1] = temp;
            
            // Save and re-render
            saveLightGroups(false); // Don't push to hardware yet
            renderLightGroupsList();
            renderLightsHierarchyControls();
            
            // Now push to hardware with updated order
            applyLightsHierarchyToHardware();
        }
        
        function moveLightGroupDown(index) {
            if (index >= lightGroups.length - 1) return; // Already at bottom
            
            // Swap with next item
            const temp = lightGroups[index];
            lightGroups[index] = lightGroups[index + 1];
            lightGroups[index + 1] = temp;
            
            // Save and re-render
            saveLightGroups(false); // Don't push to hardware yet
            renderLightGroupsList();
            renderLightsHierarchyControls();
            
            // Now push to hardware with updated order
            applyLightsHierarchyToHardware();
        }
        
        // Make functions globally accessible
        window.moveLightGroupUp = moveLightGroupUp;
        window.moveLightGroupDown = moveLightGroupDown;

        // Store current editing context
        let currentEditingGroupIndex = null;
        let currentSelectedLEDs = new Set();
        let currentBrightness = 80; // Default 80% (preserve LED longevity)
        let currentColor = '#ff0000'; // Default red
        let currentPattern = LIGHT_GROUP_DEFAULT_PATTERN;
        let lightGroupBrightnessSliderInstance = null;

        function updateLightGroupBrightnessThumbLabel(value) {
            const sliderElement = document.querySelector('#lightGroupBrightnessSlider');
            if (!sliderElement) return;
            const thumb = sliderElement.querySelector('.range-slider__thumb[data-upper]');
            if (thumb) {
                thumb.textContent = String(Math.round(value));
            }
        }

        // Pattern metadata: which patterns need dual colors
        const PATTERN_METADATA = {
            // Single-color patterns
            'Steady': { needsDualColor: false },
            'Double Flash': { needsDualColor: false },
            'Strobe': { needsDualColor: false },
            'Breathe': { needsDualColor: false },
            'Flicker': { needsDualColor: false },
            'Cycle': { needsDualColor: false },
            'Cycle Favorites': { needsDualColor: false },
            // Dual-color patterns
            'Whip Sweep': { needsDualColor: true },
            'Dual Beacon': { needsDualColor: true },
            'Chase': { needsDualColor: true },
            'Dual Color Pulse': { needsDualColor: true },
            'Wig Wag': { needsDualColor: true },
            'Steady Amber': { needsDualColor: false },
            'Double Pulse': { needsDualColor: false },
            'Slow Beacon': { needsDualColor: false },
            'Fast Flash': { needsDualColor: false }
        };

        function getLightGroupPatternNames() {
            return {
                general: LIGHT_GROUP_EXTRA_PATTERNS.filter(p => p !== 'Cycle').sort(),
                emergency: [...new Set(PATTERNS.police.map(p => p.name))].sort(),
                warning: [...new Set([...PATTERNS.construction.map(p => p.name), ...PATTERNS.warning.map(p => p.name)])].filter(p => !PATTERNS.police.find(pp => pp.name === p)).sort()
            };
        }

        function populateLightGroupPatternOptions(selectedPattern = LIGHT_GROUP_DEFAULT_PATTERN) {
            const patternSelect = document.getElementById('lightGroupPatternSelect');
            if (!patternSelect) return;

            const patterns = getLightGroupPatternNames();
            patternSelect.innerHTML = '';

            // Consolidate all patterns into single flat list and deduplicate
            const allPatternsMap = new Map();
            [...patterns.general, 'Cycle', 'Cycle Favorites', ...patterns.emergency, ...patterns.warning].forEach(p => {
                if (!allPatternsMap.has(p)) {
                    allPatternsMap.set(p, p);
                }
            });
            
            const uniquePatterns = Array.from(allPatternsMap.keys()).sort();

            uniquePatterns.forEach(patternName => {
                const option = document.createElement('option');
                option.value = patternName;
                // Add asterisk for dual-color patterns
                const metadata = PATTERN_METADATA[patternName];
                const displayName = metadata?.needsDualColor ? `${patternName} *` : patternName;
                option.textContent = displayName;
                patternSelect.appendChild(option);
            });

            patternSelect.value = selectedPattern;
            currentPattern = selectedPattern;
            
            // Update color defaults and visibility based on pattern
            updateColorDefaultsForPattern(selectedPattern);
            toggleSecondaryColorVisibility(selectedPattern);
        }
        
        function toggleSecondaryColorVisibility(pattern) {
            const secondaryColorContainer = document.getElementById('secondaryColorPickerContainer');
            const secondaryTargetBtn = document.getElementById('favoriteColorTargetSecondary')?.closest('label');
            const secondaryTargetInput = document.getElementById('favoriteColorTargetSecondary');
            
            if (!secondaryColorContainer) return;

            const metadata = PATTERN_METADATA[pattern];
            const needsDualColor = metadata?.needsDualColor ?? false;

            if (needsDualColor) {
                secondaryColorContainer.style.display = 'block';
                if (secondaryTargetBtn) secondaryTargetBtn.style.display = '';
            } else {
                secondaryColorContainer.style.display = 'none';
                if (secondaryTargetBtn) secondaryTargetBtn.style.display = 'none';
                // Switch to primary target if secondary was selected
                if (secondaryTargetInput && secondaryTargetInput.checked) {
                    const primaryInput = document.getElementById('favoriteColorTargetPrimary');
                    if (primaryInput) {
                        primaryInput.checked = true;
                        activeFavoriteColorTarget = 'primary';
                    }
                }
            }
        }

        function updateColorDefaultsForPattern(pattern) {
            // Use metadata to determine color requirements
            const metadata = PATTERN_METADATA[pattern];
            if (!metadata) return;

            if (metadata.needsDualColor) {
                // Ensure we have two distinct colors for dual-color patterns
                if (currentColor === currentColor2 || currentColor2 === '#000000') {
                    if (pattern.includes('Police') || pattern.includes('Whip') || pattern.includes('Chase') || pattern.includes('Dual') || pattern.includes('Wig')) {
                        // Emergency patterns: Red + Blue
                        currentColor = '#ff0000';
                        currentColor2 = '#0000ff';
                    } else {
                        // Warning patterns: Amber + White
                        currentColor = '#ffa500';
                        currentColor2 = '#ffffff';
                    }
                }
            } else {
                // Single-color patterns - reset secondary color to off
                currentColor2 = '#000000';
            }
            
            // Update UI
            const colorPicker = document.getElementById('lightGroupColorPicker');
            const colorHex = document.getElementById('lightGroupColorHex');
            const colorPicker2 = document.getElementById('lightGroupColorPicker2');
            const colorHex2 = document.getElementById('lightGroupColorHex2');
            
            if (colorPicker) colorPicker.value = currentColor;
            if (colorHex) colorHex.textContent = currentColor.toUpperCase();
            if (colorPicker2) colorPicker2.value = currentColor2;
            if (colorHex2) colorHex2.textContent = currentColor2.toUpperCase();
        }

        function openLightGroupModal(index = null) {
            currentEditingGroupIndex = index;
            currentSelectedLEDs = new Set();
            lightGroupModalSaved = false;

            // Snapshot pre-edit runtime state so Cancel/Close can fully restore it.
            lightGroupsStateBeforeModal = JSON.parse(JSON.stringify(lightGroups));
            masterStateBeforeModal = getMasterLightsEnabled();
            
            const modal = document.getElementById('lightGroupEditorModal');
            const titleSpan = document.getElementById('lightGroupEditMode');
            const nameInput = document.getElementById('lightGroupNameInput');
            const brightnessSlider = document.getElementById('lightGroupBrightnessSlider');
            const brightnessValue = document.getElementById('lightGroupBrightnessValue');
            const patternSelect = document.getElementById('lightGroupPatternSelect');
            const colorPicker = document.getElementById('lightGroupColorPicker');
            const colorHex = document.getElementById('lightGroupColorHex');
            const totalLEDCount = parseInt(document.getElementById('totalLEDCount').value) || 100;
            
            // Update modal title and total LED count display
            const modalTotalLedsSpan = document.getElementById('modalTotalLeds');
            if (modalTotalLedsSpan) {
                modalTotalLedsSpan.textContent = totalLEDCount;
            }
            
            if (index !== null) {
                // Edit mode
                const group = lightGroups[index];
                titleSpan.textContent = 'Edit';
                nameInput.value = group.name;
                group.indices.forEach(idx => currentSelectedLEDs.add(idx));
                
                // Set brightness (convert 0-255 to 0-100 percentage)
                const brightnessPercent = group.brightness !== undefined ? 
                    Math.round(group.brightness * 100 / 255) : 80;
                currentBrightness = brightnessPercent;
                if (lightGroupBrightnessSliderInstance) {
                    lightGroupBrightnessSliderInstance.value([0, brightnessPercent]);
                }
                updateLightGroupBrightnessThumbLabel(brightnessPercent);
                brightnessValue.textContent = brightnessPercent + '%';

                // Set pattern
                currentPattern = group.pattern || LIGHT_GROUP_DEFAULT_PATTERN;
                populateLightGroupPatternOptions(currentPattern);
                if (patternSelect) {
                    patternSelect.value = currentPattern;
                }
                
                // Set colors
                const color = group.color || '#ff0000';
                const color2 = group.color2 || '#000000';
                currentColor = color;
                currentColor2 = color2;
                colorPicker.value = color;
                colorHex.textContent = color.toUpperCase();
                
                const colorPicker2 = document.getElementById('lightGroupColorPicker2');
                const colorHex2 = document.getElementById('lightGroupColorHex2');
                if (colorPicker2) colorPicker2.value = color2;
                if (colorHex2) colorHex2.textContent = color2.toUpperCase();
            } else {
                // Add mode
                titleSpan.textContent = 'Add';
                nameInput.value = '';
                currentBrightness = 80;
                if (lightGroupBrightnessSliderInstance) {
                    lightGroupBrightnessSliderInstance.value([0, 80]);
                }
                updateLightGroupBrightnessThumbLabel(80);
                brightnessValue.textContent = '80%';
                currentPattern = LIGHT_GROUP_DEFAULT_PATTERN;
                populateLightGroupPatternOptions(LIGHT_GROUP_DEFAULT_PATTERN);
                if (patternSelect) {
                    patternSelect.value = LIGHT_GROUP_DEFAULT_PATTERN;
                }
                currentColor = '#ff0000';
                currentColor2 = '#000000';
                colorPicker.value = '#ff0000';
                colorHex.textContent = '#FF0000';
                
                const colorPicker2 = document.getElementById('lightGroupColorPicker2');
                const colorHex2 = document.getElementById('lightGroupColorHex2');
                if (colorPicker2) colorPicker2.value = '#000000';
                if (colorHex2) colorHex2.textContent = '#000000';
            }
            
            renderLedGrid(totalLEDCount);
            updateSelectionSummary();
            renderColorPresets();

            // While editing, isolate only this group for visual feedback.
            if (index !== null) {
                isolateGroupForPreview(index, lightGroups[index]);
            } else {
                applyLightsHierarchyToHardware({ masterEnabled: true, groups: [] });
            }
            
            const bsModal = new bootstrap.Modal(modal);
            bsModal.show();
        }

        function addLightGroup() {
            openLightGroupModal(null);
        }

        function editLightGroup(index) {
            openLightGroupModal(index);
        }

        function renderLedGrid(totalCount = 100) {
            const gridContainer = document.getElementById('ledGrid');
            gridContainer.innerHTML = '';
            gridContainer.style.display = 'grid';
            gridContainer.style.gridTemplateColumns = 'repeat(10, 1fr)';
            gridContainer.style.gap = '0.5rem';
            
            // Clamp total to max 100 (10x10 grid)
            const maxLEDs = Math.min(totalCount, 100);
            
            for (let i = 0; i < maxLEDs; i++) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'led-grid-button';
                button.textContent = (i + 1); // Display 1-100 for user
                
                // Check if this LED is already selected
                if (currentSelectedLEDs.has(i)) {
                    button.classList.add('selected');
                }
                
                button.addEventListener('click', function(e) {
                    e.preventDefault();
                    toggleLedSelection(i);
                });
                
                gridContainer.appendChild(button);
            }
        }

        function toggleLedSelection(ledIndex) {
            if (currentSelectedLEDs.has(ledIndex)) {
                currentSelectedLEDs.delete(ledIndex);
            } else {
                currentSelectedLEDs.add(ledIndex);
            }
            
            // Update visual state for this button
            const buttons = document.querySelectorAll('.led-grid-button');
            if (buttons[ledIndex]) {
                buttons[ledIndex].classList.toggle('selected');
            }
            
            updateSelectionSummary();
            attemptAutoPreviewFromModal();
        }

        function updateSelectionSummary() {
            const summaryDiv = document.getElementById('lightGroupSelectedSummary');
            const countDiv = document.querySelector('[id="lightGroupSelectedCount"]');
            const indices = Array.from(currentSelectedLEDs).sort((a, b) => a - b);
            const count = indices.length;
            
            if (countDiv) {
                countDiv.textContent = count;
            }
            
            let summaryText = '';
            if (count === 0) {
                summaryText = 'No LEDs selected';
            } else {
                const ranges = formatLedRanges(indices);
                summaryText = ranges;
            }
            
            if (summaryDiv) {
                summaryDiv.textContent = summaryText;
            }
        }

        function formatLedRanges(indices) {
            if (indices.length === 0) return '';
            
            const ranges = [];
            let rangeStart = indices[0];
            let rangeEnd = indices[0];
            
            for (let i = 1; i < indices.length; i++) {
                if (indices[i] === rangeEnd + 1) {
                    rangeEnd = indices[i];
                } else {
                    ranges.push(rangeStart === rangeEnd ? 
                        String(rangeStart + 1) : 
                        `${rangeStart + 1}-${rangeEnd + 1}`);
                    rangeStart = indices[i];
                    rangeEnd = indices[i];
                }
            }
            ranges.push(rangeStart === rangeEnd ? 
                String(rangeStart + 1) : 
                `${rangeStart + 1}-${rangeEnd + 1}`);
            
            return ranges.join(', ');
        }

        function clearLedSelection() {
            currentSelectedLEDs.clear();
            document.querySelectorAll('.led-grid-button.selected').forEach(btn => {
                btn.classList.remove('selected');
            });
            updateSelectionSummary();
        }

        function getLightGroupDraftFromModal() {
            const nameInput = document.getElementById('lightGroupNameInput');
            const patternSelect = document.getElementById('lightGroupPatternSelect');
            const name = nameInput ? nameInput.value.trim() : 'Preview Group';
            const selectedPattern = (patternSelect && patternSelect.value) ? patternSelect.value : LIGHT_GROUP_DEFAULT_PATTERN;

            return {
                name: name || 'Preview Group',
                indices: Array.from(currentSelectedLEDs).sort((a, b) => a - b),
                brightness: Math.round(currentBrightness * 255 / 100),
                color: currentColor,
                color2: currentColor2,
                pattern: selectedPattern,
                cycleIntervalSeconds: (selectedPattern === 'Cycle' || selectedPattern === 'Cycle Favorites') ? LIGHT_GROUP_CYCLE_INTERVAL_SECONDS : undefined,
                enabled: true
            };
        }

        function canAutoPreviewGroup(draftGroup) {
            return !!draftGroup.name && draftGroup.indices.length > 0;
        }

        function testLightGroupFromModal(showValidationErrors = false) {
            const draftGroup = getLightGroupDraftFromModal();

            if (!canAutoPreviewGroup(draftGroup)) {
                if (showValidationErrors && !draftGroup.name) {
                    window.toast.error('Enter a group name before testing');
                }
                if (showValidationErrors && draftGroup.indices.length === 0) {
                    window.toast.error('Select at least one LED before testing');
                }
                return Promise.resolve();
            }

            return isolateGroupForPreview(currentEditingGroupIndex, draftGroup);
        }

        function attemptAutoPreviewFromModal() {
            // Do not show toasts while editing; preview only after required fields exist.
            testLightGroupFromModal(false);
        }

        function saveLightGroupFromModal() {
            const nameInput = document.getElementById('lightGroupNameInput');
            const name = nameInput.value.trim();
            
            if (!name) {
                alert('Please enter a light group name');
                nameInput.focus();
                return;
            }
            
            const indices = Array.from(currentSelectedLEDs).sort((a, b) => a - b);
            const patternSelect = document.getElementById('lightGroupPatternSelect');
            const selectedPattern = (patternSelect && patternSelect.value) ? patternSelect.value : LIGHT_GROUP_DEFAULT_PATTERN;
            
            // Convert brightness percentage (0-100) to 0-255 scale
            const brightness255 = Math.round(currentBrightness * 255 / 100);
            const cycleIntervalSeconds = (selectedPattern === 'Cycle' || selectedPattern === 'Cycle Favorites') ? LIGHT_GROUP_CYCLE_INTERVAL_SECONDS : undefined;
            
            if (currentEditingGroupIndex !== null) {
                // Update existing group while preserving enabled state.
                const wasEnabled = !!lightGroups[currentEditingGroupIndex]?.enabled;
                lightGroups[currentEditingGroupIndex] = {
                    name: name,
                    indices: indices,
                    brightness: brightness255,
                    color: currentColor,
                    color2: currentColor2,
                    pattern: selectedPattern,
                    cycleIntervalSeconds,
                    enabled: wasEnabled
                };
                saveLightGroups(false);
                window.toast.success(`Light group "${name}" updated!`);
            } else {
                // Create new group disabled by default so save does not force it on.
                lightGroups.push({
                    name: name,
                    indices: indices,
                    brightness: brightness255,
                    color: currentColor,
                    color2: currentColor2,
                    pattern: selectedPattern,
                    cycleIntervalSeconds,
                    enabled: false
                });
                saveLightGroups(false);
                window.toast.success(`Light group "${name}" created with ${indices.length} LED(s)!`);
            }

            lightGroupModalSaved = true;
            
            // Close modal
            const modal = bootstrap.Modal.getInstance(document.getElementById('lightGroupEditorModal'));
            if (modal) modal.hide();
            
            currentEditingGroupIndex = null;
            currentSelectedLEDs.clear();
            currentBrightness = 80;
            currentColor = '#ff0000';
            currentColor2 = '#000000';
            currentPattern = LIGHT_GROUP_DEFAULT_PATTERN;
        }

        function setLightGroupColor(color, target = 'primary') {
            if (target === 'secondary') {
                currentColor2 = color;
                const colorPicker2 = document.getElementById('lightGroupColorPicker2');
                const colorHex2 = document.getElementById('lightGroupColorHex2');
                if (colorPicker2) colorPicker2.value = color;
                if (colorHex2) colorHex2.textContent = color.toUpperCase();
            } else {
                currentColor = color;
                const colorPicker = document.getElementById('lightGroupColorPicker');
                const colorHex = document.getElementById('lightGroupColorHex');
                if (colorPicker) colorPicker.value = color;
                if (colorHex) colorHex.textContent = color.toUpperCase();
            }

            attemptAutoPreviewFromModal();
        }

        function deleteLightGroup(index) {
            const group = lightGroups[index];
            if (!group) return;
            
            // Warn if deleting the last group
            if (lightGroups.length === 1) {
                if (!confirm(`Delete light group "${group.name}"?\n\nThis is your last light group. You can create new ones anytime.`)) {
                    return;
                }
            } else {
                if (!confirm(`Delete light group "${group.name}"? This cannot be undone.`)) {
                    return;
                }
            }
            
            // Check if this group is used for system notifications
            const notificationGroup = getNotificationGroup();
            const wasNotificationGroup = notificationGroup === group.name;
            
            // Delete the group
            lightGroups.splice(index, 1);
            saveLightGroups();
            
            // Failover: If deleted group was used for notifications, switch to "All LEDs"
            if (wasNotificationGroup) {
                localStorage.setItem(NOTIFICATION_GROUP_KEY, '__all__');
                populateNotificationGroupSelect();
                window.toast.warning(`Light group deleted. System notifications switched to "All LEDs".`);
            } else {
                window.toast.success('Light group deleted');
            }
        }

        function parseLEDIndices(str) {
            const indices = new Set();
            const parts = str.split(',');
            
            parts.forEach(part => {
                part = part.trim();
                if (part.includes('-')) {
                    const [start, end] = part.split('-').map(x => parseInt(x.trim()));
                    if (!isNaN(start) && !isNaN(end)) {
                        const min = Math.min(start, end);
                        const max = Math.max(start, end);
                        for (let i = min; i <= max; i++) {
                            indices.add(i);
                        }
                    }
                } else {
                    const num = parseInt(part);
                    if (!isNaN(num)) {
                        indices.add(num);
                    }
                }
            });
            
            return Array.from(indices).sort((a, b) => a - b);
        }

        // Wire up Light Groups UI events
        window.addEventListener('DOMContentLoaded', async function() {
            const addBtn = document.getElementById('addLightGroupBtn');
            if (addBtn) {
                addBtn.addEventListener('click', addLightGroup);
            }
            
            const totalLEDInput = document.getElementById('totalLEDCount');
            if (totalLEDInput) {
                // Load saved value
                const saved = localStorage.getItem(TOTAL_LED_COUNT_KEY);
                if (saved) totalLEDInput.value = saved;
                
                // Save on change
                totalLEDInput.addEventListener('change', function() {
                    const value = parseInt(this.value);
                    if (value >= 1 && value <= 300) {
                        localStorage.setItem(TOTAL_LED_COUNT_KEY, value);
                        window.toast.success(`Total LED count set to ${value}`);
                    } else {
                        alert('Please enter a value between 1 and 300');
                        this.value = localStorage.getItem(TOTAL_LED_COUNT_KEY) || 100;
                    }
                });
            }
            
            const brightnessValue = document.getElementById('lightGroupBrightnessValue');
            const brightnessSliderElement = document.querySelector('#lightGroupBrightnessSlider');
            if (brightnessSliderElement && brightnessValue) {
                lightGroupBrightnessSliderInstance = rangeSlider(brightnessSliderElement, {
                    value: [0, 80],
                    min: 0,
                    max: 100,
                    step: 10,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        const percent = Array.isArray(value) ? parseInt(value[1], 10) : parseInt(value, 10);
                        if (Number.isNaN(percent)) return;
                        currentBrightness = percent;
                        brightnessValue.textContent = percent + '%';
                        updateLightGroupBrightnessThumbLabel(percent);
                        attemptAutoPreviewFromModal();
                    }
                });
                updateLightGroupBrightnessThumbLabel(80);
            }

            const lightGroupPatternSelect = document.getElementById('lightGroupPatternSelect');
            populateLightGroupPatternOptions(LIGHT_GROUP_DEFAULT_PATTERN);
            if (lightGroupPatternSelect) {
                lightGroupPatternSelect.value = LIGHT_GROUP_DEFAULT_PATTERN;
                lightGroupPatternSelect.addEventListener('change', function() {
                    currentPattern = this.value || LIGHT_GROUP_DEFAULT_PATTERN;
                    updateColorDefaultsForPattern(currentPattern);
                    toggleSecondaryColorVisibility(currentPattern);
                    attemptAutoPreviewFromModal();
                });
            }

            const favoriteTargetInputs = document.querySelectorAll('input[name="favoriteColorTarget"]');
            favoriteTargetInputs.forEach(input => {
                input.addEventListener('change', function() {
                    if (this.checked) {
                        activeFavoriteColorTarget = this.value === 'secondary' ? 'secondary' : 'primary';
                        renderColorPresets();
                    }
                });
            });
            
            // Color picker event listeners
            const colorPicker = document.getElementById('lightGroupColorPicker');
            const colorHex = document.getElementById('lightGroupColorHex');
            if (colorPicker && colorHex) {
                colorPicker.addEventListener('input', function() {
                    currentColor = this.value;
                    colorHex.textContent = this.value.toUpperCase();
                    attemptAutoPreviewFromModal();
                });
            }
            
            // Second color picker event listeners
            const colorPicker2 = document.getElementById('lightGroupColorPicker2');
            const colorHex2 = document.getElementById('lightGroupColorHex2');
            if (colorPicker2 && colorHex2) {
                colorPicker2.addEventListener('input', function() {
                    currentColor2 = this.value;
                    colorHex2.textContent = this.value.toUpperCase();
                    attemptAutoPreviewFromModal();
                });
            }

            const lightGroupNameInput = document.getElementById('lightGroupNameInput');
            if (lightGroupNameInput) {
                lightGroupNameInput.addEventListener('input', attemptAutoPreviewFromModal);
            }

            // Treat all modal close paths (Cancel/X/backdrop/Esc) the same.
            const lightGroupModal = document.getElementById('lightGroupEditorModal');
            if (lightGroupModal) {
                lightGroupModal.addEventListener('hidden.bs.modal', () => {
                    restoreLightsAfterModal();
                    lightGroupModalSaved = false;
                    currentEditingGroupIndex = null;
                });
            }
            
            // Load light groups and color presets
            await loadLightGroups();
            loadColorPresets();
            populateNotificationGroupSelect(); // Initialize system notification LED dropdown
            setMasterLightsEnabled(getMasterLightsEnabled(), false);
            applyLightsHierarchyToHardware();
            
            // Load version information
            loadVersionInfo();
        });
        
        function loadVersionInfo() {
            // Display app version and build date
            const appVersionEl = document.getElementById('appVersion');
            const buildDateEl = document.getElementById('buildDate');
            
            if (appVersionEl) appVersionEl.textContent = APP_VERSION;
            if (buildDateEl) buildDateEl.textContent = BUILD_DATE;

            // Prefer native app metadata when running under Capacitor.
            const appPlugin = window.Capacitor?.Plugins?.App;
            if (appPlugin && typeof appPlugin.getInfo === 'function') {
                appPlugin.getInfo()
                    .then(info => {
                        if (appVersionEl && info?.version) {
                            appVersionEl.textContent = info.version;
                        }
                        if (buildDateEl && (info?.build || info?.version)) {
                            buildDateEl.textContent = info.build || info.version;
                        }
                    })
                    .catch(error => {
                        console.warn('Unable to load native app metadata:', error);
                    });
            }
            
            // Fetch firmware version from ESP32
            fetchFirmwareVersion();
        }
        
        function fetchFirmwareVersion() {
            const firmwareVersionEl = document.getElementById('firmwareVersion');
            if (!firmwareVersionEl) return;

            if (isBleConnected()) {
                bleManager.readConfig()
                    .then(data => {
                        if (data?.version || data?.firmwareVersion) {
                            firmwareVersionEl.textContent = data.version || data.firmwareVersion;
                        } else {
                            firmwareVersionEl.textContent = 'Not available';
                        }
                    })
                    .catch(error => {
                        console.error('Failed to fetch firmware version via BLE:', error);
                        firmwareVersionEl.textContent = 'Connection error';
                    });
                return;
            }

            firmwareVersionEl.textContent = 'Connect BLE to load';
        }

        function updateConnectionStatus(connected) {
            const icon = document.getElementById('wifiIcon');
            if (!icon) return;

            const bleConnected = !!(bleManager && bleManager.getConnectionStatus && bleManager.getConnectionStatus());

            // BLE state has priority for this header icon.
            if (bleConnected) {
                icon.classList.remove('connecting', 'disconnected');
                icon.textContent = 'bluetooth';
                icon.style.color = 'var(--bluetooth-blue)';
                const status = document.getElementById('telemetryStatus');
                if (status) status.textContent = 'Live';
                return;
            }

            if (connected) {
                icon.classList.remove('connecting', 'disconnected');
                icon.textContent = 'bluetooth_disabled';
                icon.style.color = 'var(--bluetooth-blue)';
                const status = document.getElementById('telemetryStatus');
                if (status) status.textContent = 'Live';
            } else {
                icon.classList.remove('connecting');
                icon.classList.add('disconnected');
                icon.textContent = 'bluetooth_disabled';
                icon.style.color = 'var(--text-muted)';
                const status = document.getElementById('telemetryStatus');
                if (status) status.textContent = 'Inactive';
            }
        }

        const activeAjaxControllers = new Set();

        function registerAjaxController(controller) {
            activeAjaxControllers.add(controller);
            return controller;
        }

        function unregisterAjaxController(controller) {
            activeAjaxControllers.delete(controller);
        }

        function cancelActiveAjaxRequests() {
            activeAjaxControllers.forEach(controller => controller.abort());
            activeAjaxControllers.clear();
        }

        const HEARTBEAT_INTERVAL_MS = 10000;
        const HEARTBEAT_TIMEOUT_MS = 4000;
        const HEARTBEAT_RECOVERY_RESET_MS = 30000; // Reset recovery flag every 30 seconds to allow multiple recovery attempts
        let heartbeatTimer = null;
        let heartbeatFailures = 0;
        let heartbeatAlerted = false;
        let heartbeatRecoveryTriggered = false;
        let heartbeatInFlight = null;
        let heartbeatRecoveryResetTimer = null;

        function handleHeartbeatSuccess() {
            const wasDown = heartbeatFailures > 0 || heartbeatRecoveryTriggered;
            
            heartbeatFailures = 0;
            heartbeatAlerted = false;
            heartbeatRecoveryTriggered = false;
            if (heartbeatRecoveryResetTimer) {
                clearTimeout(heartbeatRecoveryResetTimer);
                heartbeatRecoveryResetTimer = null;
            }
            updateConnectionStatus(true);
            
            if (wasDown) {
                toast.success('Connection restored');
            }
        }

        function handleHeartbeatFailure() {
            heartbeatFailures += 1;
            updateConnectionStatus(false);

            if (!heartbeatAlerted) {
                toast.error('Connection lost');
                heartbeatAlerted = true;
            }

            if (heartbeatFailures >= 2 && !heartbeatRecoveryTriggered) {
                heartbeatRecoveryTriggered = true;
                cancelActiveAjaxRequests();
                
                // Reset recovery flag every 30 seconds to allow multiple recovery attempts
                if (heartbeatRecoveryResetTimer) clearTimeout(heartbeatRecoveryResetTimer);
                heartbeatRecoveryResetTimer = setTimeout(() => {
                    heartbeatRecoveryTriggered = false;
                    heartbeatRecoveryResetTimer = null;
                }, HEARTBEAT_RECOVERY_RESET_MS);
            }
        }

        function runHeartbeatOnce() {
            if (isBleConnected()) {
                handleHeartbeatSuccess();
                return;
            }
            handleHeartbeatFailure();
        }

        function startHeartbeat() {
            if (heartbeatTimer) return;
            runHeartbeatOnce();
            heartbeatTimer = setInterval(runHeartbeatOnce, HEARTBEAT_INTERVAL_MS);
        }

        function stopHeartbeat() {
            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
            if (heartbeatRecoveryResetTimer) {
                clearTimeout(heartbeatRecoveryResetTimer);
                heartbeatRecoveryResetTimer = null;
            }
            if (heartbeatInFlight) {
                heartbeatInFlight.abort();
                heartbeatInFlight = null;
            }
        }

        function initHeartbeatMonitor() {
            const updateHeartbeatState = () => {
                if (isBleConnected()) {
                    stopHeartbeat();
                    handleHeartbeatSuccess();
                } else if (document.hidden || !navigator.onLine) {
                    stopHeartbeat();
                } else {
                    startHeartbeat();
                }
            };

            document.addEventListener('visibilitychange', updateHeartbeatState);
            window.addEventListener('focus', updateHeartbeatState);
            window.addEventListener('blur', updateHeartbeatState);
            window.addEventListener('online', updateHeartbeatState);
            window.addEventListener('offline', () => {
                stopHeartbeat();
                handleHeartbeatFailure();
            });
            updateHeartbeatState();
        }

        // ==================== Distance Calculation ====================
        function haversineDistance(lat1, lon1, lat2, lon2) {
            // Convert degrees to radians
            const toRad = Math.PI / 180;
            const R = 3959; // Earth radius in miles
            
            const dLat = (lat2 - lat1) * toRad;
            const dLon = (lon2 - lon1) * toRad;
            
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
                      Math.sin(dLon / 2) * Math.sin(dLon / 2);
            
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        }

        // ==================== Config Fetching ====================
        let hasShownInitialConfigToast = false;

        async function fetchConfigFromESP32(showToast = true) {
            const applyLoadedConfig = (data) => {
                fullConfig = data;
                hasLoadedConfigFromDevice = true;

                // Update suspension settings display
                updateSuspensionSettings(data);

                // Load settings into Settings page
                loadSettingsFromConfig(data);

                // Update tuning sliders from config data
                updateTuningSliders(data);

                // Update servo sliders from config data
                updateServoSliders(data);

                // Load light groups from ESP32 if available
                if (data.lightGroupsArray && Array.isArray(data.lightGroupsArray)) {
                    loadLightGroups(data.lightGroupsArray);
                }

                if (data.warnings && data.warnings.servoTrimReset) {
                    const warningMessage = data.warnings.message
                        || 'Unexpected servo trim value was reset to 0. Check settings before driving.';
                    toast.warning(warningMessage, { duration: 10000 });
                }

                // Display config data in the Config Data card (Settings page)
                const configData = document.getElementById('configData');
                if (configData) configData.textContent = JSON.stringify(data, null, 2);

                // Display tuning data in the Tuning Configuration Data card.
                const tuningConfigData = document.getElementById('tuningConfigData');
                if (tuningConfigData) tuningConfigData.textContent = JSON.stringify(data, null, 2);

                // Display lighting data in the Lighting Configuration Data card.
                const lightingConfigData = document.getElementById('lightingConfigData');
                if (lightingConfigData) {
                    const lightingData = data?.lights || data?.lightConfig || data;
                    lightingConfigData.textContent = JSON.stringify(lightingData, null, 2);
                }

                if (showToast && !hasShownInitialConfigToast) {
                    toast.dismiss('ble-config-required');
                    toast.success('Configuration loaded from RCDCC module (Bluetooth LE)');
                    hasShownInitialConfigToast = true;
                }

                finishInitialCardLoading('config-loaded');
            };

            if (!isBleConnected()) {
                hasLoadedConfigFromDevice = false;
                const configData = document.getElementById('configData');
                if (configData) configData.textContent = 'Bluetooth LE not connected';
                const tuningConfigData = document.getElementById('tuningConfigData');
                if (tuningConfigData) tuningConfigData.textContent = 'Bluetooth LE not connected';
                const lightingConfigData = document.getElementById('lightingConfigData');
                if (lightingConfigData) lightingConfigData.textContent = 'Bluetooth LE not connected';
                if (showToast) {
                    toast.warning('Connect via Bluetooth LE to load configuration', { key: 'ble-config-required' });
                }
                return;
            }

            try {
                communicationMode = 'ble';
                const bleData = await bleManager.readConfig();
                applyLoadedConfig(bleData);
            } catch (error) {
                console.error('Failed to fetch config:', error);
                const configData = document.getElementById('configData');
                if (configData) configData.textContent = `Error: ${error.message}`;
                const tuningConfigData = document.getElementById('tuningConfigData');
                if (tuningConfigData) tuningConfigData.textContent = `Error: ${error.message}`;
                const lightingConfigData = document.getElementById('lightingConfigData');
                if (lightingConfigData) lightingConfigData.textContent = `Error: ${error.message}`;
                if (showToast) {
                    toast.warning('Could not load configuration from RCDCC module');
                }

                // Prevent a permanent skeleton lock if the first read fails.
                finishInitialCardLoading('config-load-failed');
            }
        }

        function updateSuspensionSettings(config) {
            if (!config) return;
            
            // Update Reaction Speed
            if (config.reactionSpeed !== undefined) {
                const badge = document.getElementById('reactionSpeedBadge');
                if (badge) badge.textContent = config.reactionSpeed.toFixed(1);
            }
            
            // Update Ride Height
            if (config.rideHeightOffset !== undefined) {
                const display = document.getElementById('rideHeightDisplay');
                if (display) display.textContent = `${config.rideHeightOffset.toFixed(0)}%`;
            }
            
            // Update Damping
            if (config.damping !== undefined) {
                const display = document.getElementById('dampingDisplay');
                if (display) display.textContent = config.damping.toFixed(1);
            }
            
            // Update Stiffness
            if (config.stiffness !== undefined) {
                const display = document.getElementById('stiffnessDisplay');
                if (display) display.textContent = config.stiffness.toFixed(1);
            }
            
            // Update Front/Rear Balance
            if (config.frontRearBalance !== undefined) {
                const balancePercent = Math.round(config.frontRearBalance);
                const display = document.getElementById('frontRearBalanceDisplay');
                if (display) display.textContent = `${balancePercent}%`;
            }
            
            // Update tuning sliders
            updateTuningSliders(config);
        }

        // ==================== Tuning Functions ====================
        function toggleHelp(param) {
            const helpId = `help${param.charAt(0).toUpperCase() + param.slice(1)}`;
            const element = document.getElementById(helpId);
            if (element) {
                const isHidden = element.style.display === 'none';
                element.style.display = isHidden ? 'block' : 'none';
            }
        }

        // Track debounce timers for each slider
        const tuningSliderSaveTimers = {
            rideHeight: null,
            damping: null,
            stiffness: null,
            reactionSpeed: null,
            balance: null,
            sensorRate: null
        };
        let tuningRefreshAfterSaveTimer = null;

        function getSaveErrorMessage(contextLabel, error) {
            if (!error) {
                return `${contextLabel} failed`;
            }

            if (error.name === 'AbortError') {
                return `${contextLabel} timed out. Check BLE connection and retry.`;
            }

            if (typeof error.message === 'string' && error.message.trim().length > 0) {
                return `${contextLabel} failed: ${error.message}`;
            }

            return `${contextLabel} failed`;
        }

        function saveTuningSliderValue(sliderName, value) {
            // Check if slider is locked
            if (tuningSliderLocks[sliderName]) {
                return; // Don't save if locked
            }

            if (!isBleConnected()) {
                updateConnectionStatus(false);
                updateConnectionMethodDisplay();
                toast.warning(`Bluetooth disconnected. Reconnect before saving ${sliderName}.`, { duration: 3500 });
                return;
            }

            if (!hasLoadedConfigFromDevice && !hasAppliedInitialDeviceConfig) {
                toast.warning('Waiting for device config. Try this slider again in a moment.', { duration: 2500 });
                refreshConfigAfterConnection('tuning-save-before-hydration');
                return;
            }

            // Build complete payload with ALL current tuning values
            const payload = {
                rideHeightOffset: tuningSliderValues.rideHeightOffset,
                damping: tuningSliderValues.damping,
                stiffness: tuningSliderValues.stiffness,
                reactionSpeed: tuningSliderValues.reactionSpeed,
                frontRearBalance: tuningSliderValues.frontRearBalance,
                sampleRate: tuningSliderValues.sampleRate
            };
            
            console.log('saveTuningSliderValue triggered for:', sliderName, 'with payload:', payload);
            
            const controller = registerAjaxController(new AbortController());
            const timeout = setTimeout(() => controller.abort(), 8000);

            pushConfigPayload(payload, controller.signal)
            .then(data => {
                console.log('Tuning slider saved:', sliderName, value);
                
                // Show toasty alert with status (accept both 'success' and 'ok')
                if (data.status === 'success' || data.status === 'ok') {
                    toast.success('Tuning updated');
                } else if (data.status === 'error') {
                    toast.error('Failed to save tuning');
                }

                // Keep dashboard/tuning cards in sync with the latest user-applied values.
                updateSuspensionSettings(payload);

                // Update local config snapshot even if initial config fetch has not completed yet.
                const configRef = ensureWritableFullConfig();
                configRef.rideHeightOffset = payload.rideHeightOffset;
                configRef.damping = payload.damping;
                configRef.stiffness = payload.stiffness;
                configRef.reactionSpeed = payload.reactionSpeed;
                configRef.frontRearBalance = payload.frontRearBalance;
                configRef.sampleRate = payload.sampleRate;

                // Re-read config from device to confirm persistence and normalize UI values.
                if (tuningRefreshAfterSaveTimer) clearTimeout(tuningRefreshAfterSaveTimer);
                tuningRefreshAfterSaveTimer = setTimeout(() => {
                    fetchConfigFromESP32(false);
                }, 900);
            })
            .catch(error => {
                if (error && error.message === 'Bluetooth LE not connected') {
                    updateConnectionStatus(false);
                    updateConnectionMethodDisplay();
                }
                console.error('Failed to save tuning slider:', error);
                toast.error(getSaveErrorMessage(`Saving ${sliderName}`, error), { duration: 5000 });
            })
            .finally(() => {
                clearTimeout(timeout);
                unregisterAjaxController(controller);
            });
        }

        function saveServoParameter(servoName, param, value) {
            if (!isBleConnected()) {
                updateConnectionStatus(false);
                updateConnectionMethodDisplay();
                toast.warning('Bluetooth disconnected. Reconnect before saving servo settings.', { duration: 3500 });
                return;
            }

            // Update the stored value
            servoSliderValues[servoName][param] = Math.round(value);
            
            // Build complete servo config payload with ALL servo values
            const payload = {
                servos: {
                    frontLeft: servoSliderValues.frontLeft,
                    frontRight: servoSliderValues.frontRight,
                    rearLeft: servoSliderValues.rearLeft,
                    rearRight: servoSliderValues.rearRight
                }
            };
            
            console.log('saveServoParameter triggered for:', servoName, param, '- sending all servos:', payload);
            
            const controller = registerAjaxController(new AbortController());
            const timeout = setTimeout(() => controller.abort(), 8000);

            pushConfigPayload(payload, controller.signal)
            .then(data => {
                console.log('Servo config saved:', data);
                
                // Show toasty alert with status (accept both 'success' and 'ok')
                if (data.status === 'success' || data.status === 'ok') {
                    toast.success('Servo configuration saved');
                    
                    // Update local config snapshot even if initial config fetch has not completed yet.
                    const configRef = ensureWritableFullConfig();
                    if (!configRef.servos) configRef.servos = {};
                    configRef.servos.frontLeft = servoSliderValues.frontLeft;
                    configRef.servos.frontRight = servoSliderValues.frontRight;
                    configRef.servos.rearLeft = servoSliderValues.rearLeft;
                    configRef.servos.rearRight = servoSliderValues.rearRight;
                    
                    // Update the config data display card
                    const configData = document.getElementById('configData');
                    if (configData) configData.textContent = JSON.stringify(configRef, null, 2);
                } else if (data.status === 'error') {
                    toast.error('Failed to save servo config');
                }
            })
            .catch(error => {
                if (error && error.message === 'Bluetooth LE not connected') {
                    updateConnectionStatus(false);
                    updateConnectionMethodDisplay();
                }
                console.error('Failed to save servo config:', error);
                toast.error(getSaveErrorMessage('Saving servo configuration', error), { duration: 5000 });
            })
            .finally(() => {
                clearTimeout(timeout);
                unregisterAjaxController(controller);
            });
        }

        function saveServoRange(servoName, min, max) {
            const normalizedMin = Math.round(min);
            const normalizedMax = Math.round(max);
            servoSliderValues[servoName].min = normalizedMin;
            servoSliderValues[servoName].max = normalizedMax;
            saveServoParameter(servoName, 'min', normalizedMin);
        }

        function initTuningSliders() {
            // Helper function to update tuning slider thumb label
            function updateTuningThumbLabel(sliderId, value, decimals = 0) {
                const slider = document.querySelector(`#${sliderId}`);
                if (!slider) return;
                const thumb = slider.querySelector('.range-slider__thumb[data-upper]')
                    || slider.querySelector('.range-slider__thumb');
                if (thumb) thumb.textContent = decimals > 0 ? value.toFixed(decimals) : Math.round(value);
            }

            // Initialize Ride Height - Horizontal slider (0-100%)
            let rideHeightElement = document.querySelector('#sliderRideHeight');
            const rideHeightInstance = rangeSlider(rideHeightElement, {
                value: [0, 50],
                min: 0,
                max: 100,
                step: 2,
                thumbsDisabled: [true, false],
                rangeSlideDisabled: true,
                onInput: function(value, userInteraction) {
                    const val = Math.round(value[1]);
                    tuningSliderValues.rideHeightOffset = val;
                    updateTuningThumbLabel('sliderRideHeight', val, 0);
                    
                    if (!isLoadingTuningConfig) {
                        clearTimeout(tuningSliderSaveTimers.rideHeight);
                        tuningSliderSaveTimers.rideHeight = setTimeout(() => {
                            saveTuningSliderValue('rideHeight', tuningSliderValues.rideHeightOffset);
                        }, 800);
                    }
                }
            });
            tuningSliderInstances.rideHeight = { element: rideHeightElement, instance: rideHeightInstance };
            updateTuningThumbLabel('sliderRideHeight', 50, 0);

            // Initialize Damping - Horizontal slider (0.1-2.0)
            let dampingElement = document.querySelector('#sliderDamping');
            const dampingInstance = rangeSlider(dampingElement, {
                value: [0.1, 0.8],
                min: 0.1,
                max: 2.0,
                step: 0.2,
                thumbsDisabled: [true, false],
                rangeSlideDisabled: true,
                onInput: function(value, userInteraction) {
                    console.log('🎚️ dampingInstance.onInput fired - value:', value, 'userInteraction:', userInteraction);
                    tuningSliderValues.damping = value[1];
                    updateTuningThumbLabel('sliderDamping', value[1], 1);
                    
                    // Save on user interaction (but not during config load)
                    if (!isLoadingTuningConfig) {
                        console.log('Damping input - scheduling save:', value[1]);
                        clearTimeout(tuningSliderSaveTimers.damping);
                        tuningSliderSaveTimers.damping = setTimeout(() => {
                            saveTuningSliderValue('damping', tuningSliderValues.damping);
                        }, 800);
                    }
                }
            });
            tuningSliderInstances.damping = { element: dampingElement, instance: dampingInstance };
            updateTuningThumbLabel('sliderDamping', 0.8, 1);

            // Initialize Stiffness - Horizontal slider (0.5-3.0)
            let stiffnessElement = document.querySelector('#sliderStiffness');
            const stiffnessInstance = rangeSlider(stiffnessElement, {
                value: [0.5, 1.0],
                min: 0.5,
                max: 3.0,
                step: 0.2,
                thumbsDisabled: [true, false],
                rangeSlideDisabled: true,
                onInput: function(value, userInteraction) {
                    tuningSliderValues.stiffness = value[1];
                    updateTuningThumbLabel('sliderStiffness', value[1], 1);
                    
                    if (!isLoadingTuningConfig) {
                        clearTimeout(tuningSliderSaveTimers.stiffness);
                        tuningSliderSaveTimers.stiffness = setTimeout(() => {
                            saveTuningSliderValue('stiffness', tuningSliderValues.stiffness);
                        }, 800);
                    }
                }
            });
            tuningSliderInstances.stiffness = { element: stiffnessElement, instance: stiffnessInstance };
            updateTuningThumbLabel('sliderStiffness', 1.0, 1);

            // Initialize Reaction Speed - Horizontal slider (0.1-5.0)
            let reactionElement = document.querySelector('#sliderReactionSpeed');
            const reactionInstance = rangeSlider(reactionElement, {
                value: [0.1, 1.0],
                min: 0.1,
                max: 5.0,
                step: 0.2,
                thumbsDisabled: [true, false],
                rangeSlideDisabled: true,
                onInput: function(value, userInteraction) {
                    tuningSliderValues.reactionSpeed = value[1];
                    updateTuningThumbLabel('sliderReactionSpeed', value[1], 1);
                    
                    if (!isLoadingTuningConfig) {
                        clearTimeout(tuningSliderSaveTimers.reactionSpeed);
                        tuningSliderSaveTimers.reactionSpeed = setTimeout(() => {
                            saveTuningSliderValue('reactionSpeed', tuningSliderValues.reactionSpeed);
                        }, 800);
                    }
                }
            });
            tuningSliderInstances.reactionSpeed = { element: reactionElement, instance: reactionInstance };
            updateTuningThumbLabel('sliderReactionSpeed', 1.0, 1);

            // Initialize Balance - Horizontal slider (0-100%)
            let balanceElement = document.querySelector('#sliderBalance');
            const balanceInstance = rangeSlider(balanceElement, {
                value: [0, 50],
                min: 0,
                max: 100,
                step: 2,
                thumbsDisabled: [true, false],
                rangeSlideDisabled: true,
                onInput: function(value, userInteraction) {
                    tuningSliderValues.frontRearBalance = Math.round(value[1]);
                    updateTuningThumbLabel('sliderBalance', tuningSliderValues.frontRearBalance, 0);
                    
                    if (!isLoadingTuningConfig) {
                        clearTimeout(tuningSliderSaveTimers.balance);
                        tuningSliderSaveTimers.balance = setTimeout(() => {
                            saveTuningSliderValue('balance', tuningSliderValues.frontRearBalance);
                        }, 800);
                    }
                }
            });
            tuningSliderInstances.balance = { element: balanceElement, instance: balanceInstance };
            updateTuningThumbLabel('sliderBalance', 50, 0);

            // Initialize Sensor Refresh Rate - Horizontal slider (5-50 Hz)
            let sensorElement = document.querySelector('#sliderSensorRate');
            const sensorInstance = rangeSlider(sensorElement, {
                value: [5, 25],
                min: 5,
                max: 50,
                step: 2,
                thumbsDisabled: [true, false],
                rangeSlideDisabled: true,
                onInput: function(value, userInteraction) {
                    tuningSliderValues.sampleRate = Math.round(value[1]);
                    updateTuningThumbLabel('sliderSensorRate', tuningSliderValues.sampleRate, 0);
                    
                    if (!isLoadingTuningConfig) {
                        clearTimeout(tuningSliderSaveTimers.sensorRate);
                        tuningSliderSaveTimers.sensorRate = setTimeout(() => {
                            saveTuningSliderValue('sensorRate', tuningSliderValues.sampleRate);
                        }, 800);
                    }
                }
            });
            tuningSliderInstances.sensorRate = { element: sensorElement, instance: sensorInstance };
            updateTuningThumbLabel('sliderSensorRate', 25, 0);
        }

        // Track locked state for each slider
        const tuningSliderLocks = {
            rideHeight: false,
            damping: false,
            stiffness: false,
            reactionSpeed: false,
            balance: false,
            sensorRate: false
        };

        // Track locked state for servo sliders
        let servoRangeLocked = false;
        let servoTrimLocked = false;
        let servoRotationLocked = false;

        // Flag to prevent saving while loading config
        let isLoadingTuningConfig = false;

        // Store servo slider instances for later updates
        const servoSliderInstances = {
            frontLeft: { rangeElement: null, trimElement: null, rangeInstance: null, trimInstance: null, lastRangeValue: [10, 170] },
            frontRight: { rangeElement: null, trimElement: null, rangeInstance: null, trimInstance: null, lastRangeValue: [10, 170] },
            rearLeft: { rangeElement: null, trimElement: null, rangeInstance: null, trimInstance: null, lastRangeValue: [10, 170] },
            rearRight: { rangeElement: null, trimElement: null, rangeInstance: null, trimInstance: null, lastRangeValue: [10, 170] }
        };

        // Debounce timers for servo parameter saves
        const servoSliderSaveTimers = {
            frontLeft: { range: null, trim: null },
            frontRight: { range: null, trim: null },
            rearLeft: { range: null, trim: null },
            rearRight: { range: null, trim: null }
        };

        // ==================== Servo Slider Initialization ====================
        function initServoSliders() {
            // Helper function to update thumb labels
            function updateThumbLabels(sliderId, values) {
                const slider = document.querySelector(`#${sliderId}`);
                if (!slider) return;
                const thumbs = slider.querySelectorAll('.range-slider__thumb');
                if (thumbs[0]) thumbs[0].textContent = Math.round(values[0]);
                if (thumbs[1]) thumbs[1].textContent = Math.round(values[1]);
            }

            function updateTrimThumbLabel(sliderId, value) {
                const slider = document.querySelector(`#${sliderId}`);
                if (!slider) return;
                const thumb = slider.querySelector('.range-slider__thumb[data-upper]')
                    || slider.querySelector('.range-slider__thumb');
                if (thumb) thumb.textContent = Math.round(value);
            }

            // Servo PWM units: 0-180 degrees (standard servo range)
            // Safe defaults: min=10, max=170 to prevent mechanical damage
            const defaultMin = 10;
            const defaultMax = 170;

            // Front Left Servo
            let frontLeftElement = document.querySelector('#sliderFrontLeft');
            if (frontLeftElement) {
                const frontLeftInstance = rangeSlider(frontLeftElement, {
                    value: [defaultMin, defaultMax],
                    min: 0,
                    max: 180,
                    step: 2,
                    onInput: function(value) {
                        updateThumbLabels('sliderFrontLeft', value);
                        
                        // Save with 800ms debounce - only save values that changed
                        if (!isLoadingTuningConfig && !servoRangeLocked) {
                            clearTimeout(servoSliderSaveTimers.frontLeft.range);
                            servoSliderSaveTimers.frontLeft.range = setTimeout(() => {
                                const lastValue = servoSliderInstances.frontLeft.lastRangeValue;
                                if (value[0] !== lastValue[0] || value[1] !== lastValue[1]) {
                                    saveServoRange('frontLeft', value[0], value[1]);
                                }
                                servoSliderInstances.frontLeft.lastRangeValue = [value[0], value[1]];
                            }, 1500);
                        }
                    }
                });
                servoSliderInstances.frontLeft.rangeElement = frontLeftElement;
                servoSliderInstances.frontLeft.rangeInstance = frontLeftInstance;
                // Set initial display values on thumbs
                updateThumbLabels('sliderFrontLeft', [defaultMin, defaultMax]);
            }

            // Front Left Servo Trim
            let frontLeftTrimElement = document.querySelector('#sliderFrontLeftTrim');
            if (frontLeftTrimElement) {
                const frontLeftTrimInstance = rangeSlider(frontLeftTrimElement, {
                    value: [-20, 0],
                    min: -20,
                    max: 20,
                    step: 2,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        updateTrimThumbLabel('sliderFrontLeftTrim', value[1]);
                        
                        // Save with 800ms debounce
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            clearTimeout(servoSliderSaveTimers.frontLeft.trim);
                            servoSliderSaveTimers.frontLeft.trim = setTimeout(() => {
                                saveServoParameter('frontLeft', 'trim', value[1]);
                            }, 800);
                        }
                    }
                });
                servoSliderInstances.frontLeft.trimElement = frontLeftTrimElement;
                servoSliderInstances.frontLeft.trimInstance = frontLeftTrimInstance;
                // Set initial display value on thumb
                updateTrimThumbLabel('sliderFrontLeftTrim', 0);
            }

            // Front Right Servo
            let frontRightElement = document.querySelector('#sliderFrontRight');
            if (frontRightElement) {
                const frontRightInstance = rangeSlider(frontRightElement, {
                    value: [defaultMin, defaultMax],
                    min: 0,
                    max: 180,
                    step: 2,
                    onInput: function(value) {
                        updateThumbLabels('sliderFrontRight', value);
                        
                        // Save with 800ms debounce - only save values that changed
                        if (!isLoadingTuningConfig && !servoRangeLocked) {
                            clearTimeout(servoSliderSaveTimers.frontRight.range);
                            servoSliderSaveTimers.frontRight.range = setTimeout(() => {
                                const lastValue = servoSliderInstances.frontRight.lastRangeValue;
                                if (value[0] !== lastValue[0] || value[1] !== lastValue[1]) {
                                    saveServoRange('frontRight', value[0], value[1]);
                                }
                                servoSliderInstances.frontRight.lastRangeValue = [value[0], value[1]];
                            }, 800);
                        }
                    }
                });
                servoSliderInstances.frontRight.rangeElement = frontRightElement;
                servoSliderInstances.frontRight.rangeInstance = frontRightInstance;
                // Set initial display values on thumbs
                updateThumbLabels('sliderFrontRight', [defaultMin, defaultMax]);
            }

            // Front Right Servo Trim
            let frontRightTrimElement = document.querySelector('#sliderFrontRightTrim');
            if (frontRightTrimElement) {
                const frontRightTrimInstance = rangeSlider(frontRightTrimElement, {
                    value: [-20, 0],
                    min: -20,
                    max: 20,
                    step: 2,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        updateTrimThumbLabel('sliderFrontRightTrim', value[1]);
                        
                        // Save with 800ms debounce
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            clearTimeout(servoSliderSaveTimers.frontRight.trim);
                            servoSliderSaveTimers.frontRight.trim = setTimeout(() => {
                                saveServoParameter('frontRight', 'trim', value[1]);
                            }, 800);
                        }
                    }
                });
                servoSliderInstances.frontRight.trimElement = frontRightTrimElement;
                servoSliderInstances.frontRight.trimInstance = frontRightTrimInstance;
                // Set initial display value on thumb
                updateTrimThumbLabel('sliderFrontRightTrim', 0);
            }

            // Rear Left Servo
            let rearLeftElement = document.querySelector('#sliderRearLeft');
            if (rearLeftElement) {
                const rearLeftInstance = rangeSlider(rearLeftElement, {
                    value: [defaultMin, defaultMax],
                    min: 0,
                    max: 180,
                    step: 2,
                    onInput: function(value) {
                        updateThumbLabels('sliderRearLeft', value);
                        
                        // Save with 800ms debounce - only save values that changed
                        if (!isLoadingTuningConfig && !servoRangeLocked) {
                            clearTimeout(servoSliderSaveTimers.rearLeft.range);
                            servoSliderSaveTimers.rearLeft.range = setTimeout(() => {
                                const lastValue = servoSliderInstances.rearLeft.lastRangeValue;
                                if (value[0] !== lastValue[0] || value[1] !== lastValue[1]) {
                                    saveServoRange('rearLeft', value[0], value[1]);
                                }
                                servoSliderInstances.rearLeft.lastRangeValue = [value[0], value[1]];
                            }, 800);
                        }
                    }
                });
                servoSliderInstances.rearLeft.rangeElement = rearLeftElement;
                servoSliderInstances.rearLeft.rangeInstance = rearLeftInstance;
                // Set initial display values on thumbs
                updateThumbLabels('sliderRearLeft', [defaultMin, defaultMax]);
            }

            // Rear Left Servo Trim
            let rearLeftTrimElement = document.querySelector('#sliderRearLeftTrim');
            if (rearLeftTrimElement) {
                const rearLeftTrimInstance = rangeSlider(rearLeftTrimElement, {
                    value: [-20, 0],
                    min: -20,
                    max: 20,
                    step: 2,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        updateTrimThumbLabel('sliderRearLeftTrim', value[1]);
                        
                        // Save with 800ms debounce
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            clearTimeout(servoSliderSaveTimers.rearLeft.trim);
                            servoSliderSaveTimers.rearLeft.trim = setTimeout(() => {
                                saveServoParameter('rearLeft', 'trim', value[1]);
                            }, 800);
                        }
                    }
                });
                servoSliderInstances.rearLeft.trimElement = rearLeftTrimElement;
                servoSliderInstances.rearLeft.trimInstance = rearLeftTrimInstance;
                // Set initial display value on thumb
                updateTrimThumbLabel('sliderRearLeftTrim', 0);
            }

            // Rear Right Servo
            let rearRightElement = document.querySelector('#sliderRearRight');
            if (rearRightElement) {
                const rearRightInstance = rangeSlider(rearRightElement, {
                    value: [defaultMin, defaultMax],
                    min: 0,
                    max: 180,
                    step: 2,
                    onInput: function(value) {
                        updateThumbLabels('sliderRearRight', value);
                        
                        // Save with 800ms debounce - only save values that changed
                        if (!isLoadingTuningConfig && !servoRangeLocked) {
                            clearTimeout(servoSliderSaveTimers.rearRight.range);
                            servoSliderSaveTimers.rearRight.range = setTimeout(() => {
                                const lastValue = servoSliderInstances.rearRight.lastRangeValue;
                                if (value[0] !== lastValue[0] || value[1] !== lastValue[1]) {
                                    saveServoRange('rearRight', value[0], value[1]);
                                }
                                servoSliderInstances.rearRight.lastRangeValue = [value[0], value[1]];
                            }, 800);
                        }
                    }
                });
                servoSliderInstances.rearRight.rangeElement = rearRightElement;
                servoSliderInstances.rearRight.rangeInstance = rearRightInstance;
                // Set initial display values on thumbs
                updateThumbLabels('sliderRearRight', [defaultMin, defaultMax]);
            }

            // Rear Right Servo Trim
            let rearRightTrimElement = document.querySelector('#sliderRearRightTrim');
            if (rearRightTrimElement) {
                const rearRightTrimInstance = rangeSlider(rearRightTrimElement, {
                    value: [-20, 0],
                    min: -20,
                    max: 20,
                    step: 2,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        updateTrimThumbLabel('sliderRearRightTrim', value[1]);
                        
                        // Save with 800ms debounce
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            clearTimeout(servoSliderSaveTimers.rearRight.trim);
                            servoSliderSaveTimers.rearRight.trim = setTimeout(() => {
                                saveServoParameter('rearRight', 'trim', value[1]);
                            }, 800);
                        }
                    }
                });
                servoSliderInstances.rearRight.trimElement = rearRightTrimElement;
                servoSliderInstances.rearRight.trimInstance = rearRightTrimInstance;
                // Set initial display value on thumb
                updateTrimThumbLabel('sliderRearRightTrim', 0);
            }

            // Force layout recalculation to render slider colors correctly
            setTimeout(() => {
                document.body.offsetHeight; // Trigger reflow
                window.dispatchEvent(new Event('resize'));
            }, 50);
        }

        // Track current values of servo sliders
        const servoSliderValues = {
            frontLeft: { min: 10, max: 170, trim: 0 },
            frontRight: { min: 10, max: 170, trim: 0 },
            rearLeft: { min: 10, max: 170, trim: 0 },
            rearRight: { min: 10, max: 170, trim: 0 }
        };
        const tuningSliderValues = {
            rideHeightOffset: 50,
            damping: 0.8,
            stiffness: 1.0,
            reactionSpeed: 1.0,
            frontRearBalance: 50,
            sampleRate: 25
        };

        // Store rangeSlider instances for tuning sliders
        const tuningSliderInstances = {
            rideHeight: null,
            damping: null,
            stiffness: null,
            reactionSpeed: null,
            balance: null,
            sensorRate: null
        };

        function updateTuningSliders(config) {
            if (!config) return;
            
            // Set flag to prevent saving during config load
            isLoadingTuningConfig = true;
            
            // Helper function to update tuning slider thumb label
            function updateThumbnailLabel(sliderId, value, decimals = 0) {
                const slider = document.querySelector(`#${sliderId}`);
                if (!slider) return;
                const thumb = slider.querySelector('.range-slider__thumb[data-upper]')
                    || slider.querySelector('.range-slider__thumb');
                if (thumb) thumb.textContent = decimals > 0 ? value.toFixed(decimals) : Math.round(value);
            }
            
            // Helper function to update a slider element
            function updateSliderElement(sliderKey, fieldName, minVal, newValue) {
                if (config[fieldName] === undefined) return;
                
                const store = tuningSliderInstances[sliderKey];
                if (!store || !store.element || !store.instance) {
                    return;
                }
                
                // Get the hidden input elements and update them
                const inputs = store.element.querySelectorAll('input[type="range"]');
                if (inputs.length >= 2) {
                    inputs[0].value = minVal;
                    inputs[1].value = newValue;
                }
                
                // Call the instance setter via the getter/setter function
                store.instance.value([minVal, newValue]);
                
                // Dispatch input event on the element to trigger any internal watchers
                store.element.dispatchEvent(new Event('input', { bubbles: true }));
            }
            
            // Update each slider
            if (config.rideHeightOffset !== undefined) {
                tuningSliderValues.rideHeightOffset = Math.round(config.rideHeightOffset);
                updateSliderElement('rideHeight', 'rideHeightOffset', 0, config.rideHeightOffset);
                updateThumbnailLabel('sliderRideHeight', tuningSliderValues.rideHeightOffset, 0);
            }
            
            if (config.damping !== undefined) {
                tuningSliderValues.damping = config.damping;
                updateSliderElement('damping', 'damping', 0.1, config.damping);
                updateThumbnailLabel('sliderDamping', config.damping, 1);
            }
            
            if (config.stiffness !== undefined) {
                tuningSliderValues.stiffness = config.stiffness;
                updateSliderElement('stiffness', 'stiffness', 0.5, config.stiffness);
                updateThumbnailLabel('sliderStiffness', config.stiffness, 1);
            }
            
            if (config.reactionSpeed !== undefined) {
                tuningSliderValues.reactionSpeed = config.reactionSpeed;
                updateSliderElement('reactionSpeed', 'reactionSpeed', 0.1, config.reactionSpeed);
                updateThumbnailLabel('sliderReactionSpeed', config.reactionSpeed, 1);
            }
            
            if (config.frontRearBalance !== undefined) {
                tuningSliderValues.frontRearBalance = Math.round(config.frontRearBalance);
                updateSliderElement('balance', 'frontRearBalance', 0, config.frontRearBalance);
                updateThumbnailLabel('sliderBalance', tuningSliderValues.frontRearBalance, 0);
            }
            
            if (config.sampleRate !== undefined) {
                tuningSliderValues.sampleRate = Math.round(config.sampleRate);
                updateSliderElement('sensorRate', 'sampleRate', 5, config.sampleRate);
                updateThumbnailLabel('sliderSensorRate', tuningSliderValues.sampleRate, 0);
            }
            
            isLoadingTuningConfig = false;
        }

        // ==================== Update Servo Sliders from Config ====================
        function updateServoSliders(config) {
            console.log('updateServoSliders called with config:', config);
            
            // Set flag to prevent saving during config load
            isLoadingTuningConfig = true;
            
            if (!config.servos) {
                console.warn('No servos property in config');
                isLoadingTuningConfig = false;
                return;
            }

            const servoConfigs = {
                frontLeft: config.servos.frontLeft,
                frontRight: config.servos.frontRight,
                rearLeft: config.servos.rearLeft,
                rearRight: config.servos.rearRight
            };

            console.log('Servo configs:', servoConfigs);

            for (const [servoName, servoConfig] of Object.entries(servoConfigs)) {
                if (!servoConfig) {
                    console.warn(`No config for servo: ${servoName}`);
                    continue;
                }

                console.log(`Processing ${servoName}:`, servoConfig);

                // Update stored values for this servo
                servoSliderValues[servoName].min = servoConfig.min !== undefined ? servoConfig.min : 10;
                servoSliderValues[servoName].max = servoConfig.max !== undefined ? servoConfig.max : 170;
                servoSliderValues[servoName].trim = servoConfig.trim !== undefined ? servoConfig.trim : 0;

                const sliderData = servoSliderInstances[servoName];
                if (!sliderData) {
                    console.warn(`No slider data for servo: ${servoName}`);
                    continue;
                }

                // Update range slider (min/max PWM)
                if (sliderData.rangeInstance) {
                    const rangeMin = servoConfig.min !== undefined ? servoConfig.min : 10;
                    const rangeMax = servoConfig.max !== undefined ? servoConfig.max : 170;
                    console.log(`Setting ${servoName} range to [${rangeMin}, ${rangeMax}]`);
                    sliderData.rangeInstance.value([rangeMin, rangeMax]);
                    sliderData.lastRangeValue = [rangeMin, rangeMax];
                    
                    // Update thumb labels
                    if (sliderData.rangeElement) {
                        const thumbs = sliderData.rangeElement.querySelectorAll('.range-slider__thumb');
                        if (thumbs[0]) thumbs[0].textContent = Math.round(rangeMin);
                        if (thumbs[1]) thumbs[1].textContent = Math.round(rangeMax);
                    }
                } else {
                    console.warn(`No rangeInstance for ${servoName}`);
                }

                // Update trim slider
                if (sliderData.trimInstance) {
                    const trimValue = servoConfig.trim !== undefined ? servoConfig.trim : 0;
                    console.log(`Setting ${servoName} trim to ${trimValue}`);
                    // Trim slider has fixed min:-20, max:20 range with right thumb as trim value
                    sliderData.trimInstance.value([-20, trimValue]);
                    
                    // Update thumb label
                    if (sliderData.trimElement) {
                        const trimThumb = sliderData.trimElement.querySelector('.range-slider__thumb[data-upper]')
                            || sliderData.trimElement.querySelector('.range-slider__thumb');
                        if (trimThumb) trimThumb.textContent = Math.round(trimValue);
                    }
                } else {
                    console.warn(`No trimInstance for ${servoName}`);
                }
            }
            
            // Clear flag after updating all sliders
            isLoadingTuningConfig = false;
        }

        function toggleTuningLock(iconElement) {
            // Play click sound
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));
            
            // Get current state from localStorage or default to false
            const isLocked = localStorage.getItem('tuningParametersLocked') === 'true';
            const newState = !isLocked;
            
            // Save to localStorage
            localStorage.setItem('tuningParametersLocked', newState.toString());
            
            // Find the card container
            const card = iconElement.closest('.card');
            
            if (newState) {
                // Lock all sliders
                card.classList.add('slider-locked');
                iconElement.textContent = 'lock';
                iconElement.style.color = 'var(--lime-green)'; // Lime green
                
                // Set all individual slider locks to true
                Object.keys(tuningSliderLocks).forEach(key => {
                    tuningSliderLocks[key] = true;
                });
            } else {
                // Unlock all sliders
                card.classList.remove('slider-locked');
                iconElement.textContent = 'lock_open_right';
                iconElement.style.color = 'var(--high-impact-color)'; // Yellow
                
                // Set all individual slider locks to false
                Object.keys(tuningSliderLocks).forEach(key => {
                    tuningSliderLocks[key] = false;
                });
            }
        }
        
        function toggleFormulasCard() {
            const cardBody = document.getElementById('formulasCardBody');
            const chevron = document.getElementById('formulasChevron');
            
            if (!cardBody || !chevron) return;
            
            // Toggle visibility
            const isCollapsed = cardBody.style.display === 'none';
            
            if (isCollapsed) {
                cardBody.style.display = 'block';
                chevron.textContent = 'keyboard_arrow_down';
                localStorage.setItem('formulasCardCollapsed', 'false');
            } else {
                cardBody.style.display = 'none';
                chevron.textContent = 'keyboard_arrow_right';
                localStorage.setItem('formulasCardCollapsed', 'true');
            }
        }

        function toggleLightsGuideCard() {
            const cardBody = document.getElementById('lightsGuideCardBody');
            const chevron = document.getElementById('lightsGuideChevron');

            if (!cardBody || !chevron) return;

            const isCollapsed = cardBody.style.display === 'none';

            if (isCollapsed) {
                cardBody.style.display = 'block';
                chevron.textContent = 'keyboard_arrow_down';
                localStorage.setItem('lightsGuideCardCollapsed', 'false');
            } else {
                cardBody.style.display = 'none';
                chevron.textContent = 'keyboard_arrow_right';
                localStorage.setItem('lightsGuideCardCollapsed', 'true');
            }
        }
        
        function toggleServoRangeLock(iconElement) {
            // Play click sound
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));
            
            // Toggle the lock state
            servoRangeLocked = !servoRangeLocked;
            
            // Save to localStorage
            localStorage.setItem('servoRangeLocked', servoRangeLocked.toString());
            
            // Find the card container
            const card = iconElement.closest('.card');
            
            if (servoRangeLocked) {
                // Lock the sliders
                card.classList.add('slider-locked');
                iconElement.textContent = 'lock';
                iconElement.style.color = 'var(--lime-green)'; // Lime green
            } else {
                // Unlock the sliders
                card.classList.remove('slider-locked');
                iconElement.textContent = 'lock_open_right';
                iconElement.style.color = 'var(--high-impact-color)'; // Yellow
            }
        }
        
        function toggleServoTrimLock(iconElement) {
            // Play click sound
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));
            
            // Toggle the lock state
            servoTrimLocked = !servoTrimLocked;
            
            // Save to localStorage
            localStorage.setItem('servoTrimLocked', servoTrimLocked.toString());
            
            // Find the card container
            const card = iconElement.closest('.card');
            
            if (servoTrimLocked) {
                // Lock the sliders
                card.classList.add('slider-locked');
                iconElement.textContent = 'lock';
                iconElement.style.color = 'var(--lime-green)'; // Lime green
            } else {
                // Unlock the sliders
                card.classList.remove('slider-locked');
                iconElement.textContent = 'lock_open_right';
                iconElement.style.color = 'var(--high-impact-color)'; // Yellow
            }
        }
        
        function toggleServoRotationLock(iconElement) {
            // Play click sound
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));
            
            // Toggle the lock state
            servoRotationLocked = !servoRotationLocked;
            
            // Save to localStorage
            localStorage.setItem('servoRotationLocked', servoRotationLocked.toString());
            
            // Find the card container
            const card = iconElement.closest('.card');
            
            if (servoRotationLocked) {
                // Lock the badges
                card.classList.add('slider-locked');
                iconElement.textContent = 'lock';
                iconElement.style.color = 'var(--lime-green)'; // Lime green
            } else {
                // Unlock the badges
                card.classList.remove('slider-locked');
                iconElement.textContent = 'lock_open_right';
                iconElement.style.color = 'var(--high-impact-color)'; // Yellow
            }
        }
        
        function initLightControls() {
            // Headlight Brightness slider
            const brightnessLabel = document.getElementById('brightnessLabel');

            // Helper function to get brightness label
            function getBrightnessLabel(value) {
                if (value <= 0) return 'Low';
                if (value <= 50) return 'Medium';
                return 'High';
            }

            createRSlider('headlightBrightness', {
                values: buildValueArray(0, 100, 50),
                range: false,
                set: [formatSliderValue(100)],
                scale: false,
                labels: false,
                tooltip: false,
                onChange: function (value) {
                    const parsed = parseRSliderValue(value)[0];
                    if (brightnessLabel && Number.isFinite(parsed)) {
                        brightnessLabel.textContent = getBrightnessLabel(Math.round(parsed));
                    }
                    if (canSaveRSlider('headlightBrightness') && Number.isFinite(parsed)) {
                        const brightness = Math.round(parsed);
                        // TODO: Send brightness value to ESP32
                        console.log('Headlight brightness:', brightness, getBrightnessLabel(brightness));
                    }
                }
            });
        }

        // ==================== Settings Functions ====================
        
        // Load settings from config and populate UI
        function loadSettingsFromConfig(config) {
            if (!config) return;
            
            // Load servo settings into rSlider
            const servoKeys = ['frontLeft', 'frontRight', 'rearLeft', 'rearRight'];
            const servoAbbrev = ['FL', 'FR', 'RL', 'RR'];
            
            servoKeys.forEach((key, index) => {
                const abbrev = servoAbbrev[index];
                const servo = config.servos && config.servos[key];
                const rangeSliderId = `servo${abbrev}RangeSlider`;
                const trimSliderId = `servo${abbrev}TrimSlider`;
                
                if (servo && rSliders[rangeSliderId] && rSliders[trimSliderId]) {
                    // Set range slider (min/max)
                    setRSliderValue(rangeSliderId, [
                        formatSliderValue(servo.min || 30),
                        formatSliderValue(servo.max || 150)
                    ], { silent: true });
                    
                    // Set trim slider (offset from center)
                    const trimOffset = Number.isFinite(servo.trim) ? servo.trim : 0;
                    setRSliderValue(trimSliderId, formatSliderValue(trimOffset), { silent: true });
                }
                
                // Always update reversed checkbox and badge (independent of rSliders)
                const checkbox = document.getElementById(`servo${abbrev}Reversed`);
                const badge = document.getElementById(`servo${abbrev}RevBadge`);
                const isReversed = servo.reversed || false;
                if (checkbox) checkbox.checked = isReversed;
                if (badge) {
                    const icon = isReversed ? '<span class="material-symbols-outlined rotate-ccw">rotate_left</span>' : '<span class="material-symbols-outlined rotate-cw">rotate_right</span>';
                    const text = isReversed ? 'CCW' : 'CW';
                    badge.innerHTML = icon + text;
                }
            });
            
            // Load gyro orientation
            const gyroSelect = document.getElementById('mpuOrientation');
            if (gyroSelect && config.mpuOrientation !== undefined) {
                gyroSelect.value = config.mpuOrientation;
            }
            
            // Load sample rate
            const sampleRateLabel = document.getElementById('sampleRateLabel');
            if (rSliders.sampleRateSlider && config.sampleRate !== undefined) {
                setRSliderValue('sampleRateSlider', formatSliderValue(config.sampleRate), { silent: true });
                if (sampleRateLabel) sampleRateLabel.textContent = getSampleRateLabel(config.sampleRate);
            }
            
            // Load LED color configuration
            const ledSelect = document.getElementById('ledColorSelect');
            const ledPreview = document.getElementById('ledPreview');
            if (ledSelect && config.ledColor) {
                ledSelect.value = config.ledColor;
                const selectedOption = ledSelect.options[ledSelect.selectedIndex];
                const rgbValues = selectedOption.getAttribute('data-rgb');
                if (ledPreview && rgbValues) {
                    ledPreview.style.backgroundColor = `rgb(${rgbValues})`;
                    ledPreview.style.boxShadow = `0 0 10px rgba(${rgbValues}, 0.5)`;
                }
            }
            
            // Load device name
            const deviceNameInput = document.getElementById('deviceNameInput');
            if (deviceNameInput && config.deviceName) {
                deviceNameInput.value = config.deviceName;
            }
        }

        // Helper function to convert telemetry slider position to Hz and label
        
        // Helper function to get sample rate label from Hz value
        function getSampleRateLabel(hz) {
            hz = parseInt(hz);
            if (hz >= 20) return 'Very Responsive';
            if (hz >= 16) return 'Responsive (Default)';
            if (hz >= 12) return 'Balanced';
            if (hz >= 8) return 'Stable';
            return 'Conservative';
        }

        // Update servo parameter
        async function updateServoParam(servoKey, param, value, options = {}) {
            const servoMap = {
                'frontLeft': 'FL',
                'frontRight': 'FR',
                'rearLeft': 'RL',
                'rearRight': 'RR'
            };
            const abbrev = servoMap[servoKey];
            const showToast = options.showToast !== false;
            const refreshConfig = options.refreshConfig !== false;
            
            // Build update payload for /api/servo-config
            const payload = {
                servo: servoKey,
                param: param,
                value: value
            };
            
            // Save to ESP32
            const controller = registerAjaxController(new AbortController());
            const timeout = setTimeout(() => controller.abort(), 8000);

            try {
                await pushServoPayload(payload, controller.signal);
                fullConfig.servos[servoKey][param] = value;
                if (showToast) toast.success('Saved');
                if (refreshConfig) {
                    setTimeout(() => {
                        fetchConfigFromESP32(false);
                    }, 800);
                }
            } catch (error) {
                if (error.name === 'AbortError') return;
                if (showToast) toast.error('Failed to save settings');
                // Revert UI
                if (param === 'reversed') {
                    const checkbox = document.getElementById(`servo${abbrev}Reversed`);
                    if (checkbox) checkbox.checked = fullConfig.servos[servoKey].reversed;
                }
                throw error;
            } finally {
                clearTimeout(timeout);
                unregisterAjaxController(controller);
            }
        }

        // Update LED Color
        // Update gyro orientation
        function updateGyroOrientation(value) {
            const payload = {
                mpuOrientation: parseInt(value)
            };

            const controller = registerAjaxController(new AbortController());
            const timeout = setTimeout(() => controller.abort(), 8000);

            pushConfigPayload(payload, controller.signal)
            .then(data => {
                fullConfig.mpuOrientation = parseInt(value);
                toast.success('Saved');
                // Re-fetch config to verify persistence
                setTimeout(() => {
                    fetchConfigFromESP32(false);
                }, 800);
            })
            .catch(error => {
                if (error.name === 'AbortError') return;
                toast.error('Failed to save settings');
                // Revert UI
                const select = document.getElementById('mpuOrientation');
                if (select) select.value = fullConfig.mpuOrientation;
            })
            .finally(() => {
                clearTimeout(timeout);
                unregisterAjaxController(controller);
            });
        }
        
        // Update sample rate
        function updateSampleRate(value) {
            const payload = {
                sampleRate: parseInt(value)
            };

            const controller = registerAjaxController(new AbortController());
            const timeout = setTimeout(() => controller.abort(), 8000);

            pushConfigPayload(payload, controller.signal)
            .then(data => {
                fullConfig.sampleRate = parseInt(value);
                toast.success('Saved');
                // Re-fetch config to verify persistence
                setTimeout(() => {
                    fetchConfigFromESP32(false);
                }, 800);
            })
            .catch(error => {
                if (error.name === 'AbortError') return;
                toast.error('Failed to save settings');
                // Revert UI
                const labelDisplay = document.getElementById('sampleRateLabel');
                if (rSliders.sampleRateSlider && fullConfig.sampleRate !== undefined) {
                    setRSliderValue('sampleRateSlider', formatSliderValue(fullConfig.sampleRate), { silent: true });
                    if (labelDisplay) labelDisplay.textContent = getSampleRateLabel(fullConfig.sampleRate);
                }
            })
            .finally(() => {
                clearTimeout(timeout);
                unregisterAjaxController(controller);
            });
        }
        
        // Initialize servo controls with rSlider
        function initServoControls() {
            const servoKeys = ['frontLeft', 'frontRight', 'rearLeft', 'rearRight'];
            const servoAbbrev = ['FL', 'FR', 'RL', 'RR'];
            
            servoKeys.forEach((key, index) => {
                const abbrev = servoAbbrev[index];
                const rangeSliderId = `servo${abbrev}RangeSlider`;
                const trimSliderId = `servo${abbrev}TrimSlider`;
                
                // Initialize rSliders only if elements exist
                if (document.getElementById(rangeSliderId) && document.getElementById(trimSliderId)) {
                    createRSlider(rangeSliderId, {
                        values: buildValueArray(0, 180, 2),
                        range: true,
                        set: [formatSliderValue(30), formatSliderValue(150)],
                        scale: false,
                        labels: false,
                        tooltip: false,
                        onChange: function (value) {
                            const rangeDisplay = document.getElementById(`servo${abbrev}RangeDisplay`);
                            const values = parseRSliderValue(value);
                            const min = Math.round(values[0] ?? 0);
                            const max = Math.round(values[1] ?? 0);

                            if (rangeDisplay) {
                                rangeDisplay.innerHTML = `<span class="servo-range-min">${min}°</span> - <span class="servo-range-max">${max}°</span>`;
                            }

                            if (canSaveRSlider(rangeSliderId)) {
                                const trimValue = getRSliderValue(trimSliderId)[0];
                                const actualTrim = Number.isFinite(trimValue) ? Math.round(trimValue) : 0;
                                saveServoValues(key, abbrev, min, actualTrim, max, rangeSliderId, trimSliderId);
                            }
                        }
                    });

                    createRSlider(trimSliderId, {
                        values: buildValueArray(-20, 20, 2),
                        range: false,
                        set: [formatSliderValue(0)],
                        scale: false,
                        labels: false,
                        tooltip: false,
                        onChange: function (value) {
                            const trimDisplay = document.getElementById(`servo${abbrev}TrimDisplay`);
                            const trimVal = Math.round(parseRSliderValue(value)[0] ?? 0);

                            if (trimDisplay) {
                                trimDisplay.textContent = trimVal >= 0 ? `+${trimVal}°` : `${trimVal}°`;
                            }

                            if (canSaveRSlider(trimSliderId)) {
                                const rangeValues = getRSliderValue(rangeSliderId);
                                const min = Math.round(rangeValues[0] ?? 0);
                                const max = Math.round(rangeValues[1] ?? 0);
                                saveServoValues(key, abbrev, min, trimVal, max, rangeSliderId, trimSliderId);
                            }
                        }
                    });
                }
                
                // Always initialize reversed checkbox and badge click handler (independent of rSliders)
                const checkbox = document.getElementById(`servo${abbrev}Reversed`);
                const badge = document.getElementById(`servo${abbrev}RevBadge`);
                
                if (badge) {
                    console.log(`Attaching click handler to badge: servo${abbrev}RevBadge`);
                    badge.addEventListener('click', function() {
                        console.log(`Badge clicked: ${abbrev}`);
                        // Don't allow clicks if servo rotation is locked
                        if (servoRotationLocked) {
                            console.log('Servo rotation is locked, ignoring click');
                            return;
                        }
                        // Toggle the checkbox state
                        if (checkbox) {
                            checkbox.checked = !checkbox.checked;
                            console.log(`Checkbox toggled to: ${checkbox.checked}`);
                            // Trigger change event
                            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    });
                }
                
                if (checkbox) {
                    console.log(`Attaching change handler to checkbox: servo${abbrev}Reversed`);
                    checkbox.addEventListener('change', function() {
                        console.log(`Checkbox changed: ${abbrev} = ${this.checked}`);
                        // Update badge display
                        // reversed=false (unchecked) = CW, reversed=true (checked) = CCW
                        if (badge) {
                            const icon = this.checked ? '<span class="material-symbols-outlined rotate-ccw">rotate_left</span>' : '<span class="material-symbols-outlined rotate-cw">rotate_right</span>';
                            const text = this.checked ? 'CCW' : 'CW';
                            badge.innerHTML = icon + text;
                        }
                        updateServoParam(key, 'reversed', this.checked);
                    });
                }
            });
        }
        
        // Helper function to save servo values
        async function saveServoValues(key, abbrev, min, trim, max, rangeSliderId, trimSliderId) {
            try {
                await updateServoParam(key, 'min', min, { showToast: false, refreshConfig: false });
                await updateServoParam(key, 'max', max, { showToast: false, refreshConfig: false });
                await updateServoParam(key, 'trim', trim, { showToast: true, refreshConfig: true });
            } catch (error) {
                // Revert sliders to previous values
                if (fullConfig.servos[key]) {
                    setRSliderValue(rangeSliderId, [
                        formatSliderValue(fullConfig.servos[key].min),
                        formatSliderValue(fullConfig.servos[key].max)
                    ], { silent: true });
                    const trimOffset = fullConfig.servos[key].trim;
                    setRSliderValue(trimSliderId, formatSliderValue(trimOffset), { silent: true });
                }
            }
        }

        // Initialize gyro controls
        function initGyroControls() {
            const select = document.getElementById('mpuOrientation');
            if (select) {
                select.addEventListener('change', function() {
                    updateGyroOrientation(this.value);
                });
            }
            
            // Sample rate slider
            createRSlider('sampleRateSlider', {
                values: buildValueArray(5, 25, 2),
                range: false,
                set: [formatSliderValue(25)],
                scale: false,
                labels: false,
                tooltip: false,
                onChange: function (value) {
                    const parsed = parseRSliderValue(value)[0];
                    const labelDisplay = document.getElementById('sampleRateLabel');
                    if (labelDisplay && Number.isFinite(parsed)) {
                        labelDisplay.textContent = getSampleRateLabel(Math.round(parsed));
                    }
                    if (canSaveRSlider('sampleRateSlider') && Number.isFinite(parsed)) {
                        updateSampleRate(Math.round(parsed));
                    }
                }
            });
        }

        // ==================== Network Settings Functions ====================
        
        // Update connection method display on dashboard
        function updateConnectionMethodDisplay() {
            const connectionMethodDisplay = document.getElementById('connectionMethodDisplay');
            if (!connectionMethodDisplay) return;

            if (isBleConnected()) {
                connectionMethodDisplay.textContent = 'Bluetooth LE';
                connectionMethodDisplay.style.color = 'var(--lime-green)';
            } else {
                connectionMethodDisplay.textContent = 'Bluetooth LE (Disconnected)';
                connectionMethodDisplay.style.color = 'var(--warning)';
            }
        }
        
        // Test ESP32 connection
        function testEsp32Connection() {
            const testBtn = document.getElementById('testConnectionBtn');
            
            // Disable button and show testing state
            if (testBtn) {
                testBtn.disabled = true;
                const icon = testBtn.querySelector('.material-symbols-outlined');
                if (icon) icon.classList.add('pulsating');
            }

            connectBLE()
            .then(success => {
                if (success) {
                    toast.success('Bluetooth connection successful!');
                }
            })
            .catch(error => {
                toast.error(`Bluetooth connection failed: ${error.message}`, { duration: 5000 });
            })
            .finally(() => {
                if (testBtn) {
                    testBtn.disabled = false;
                    const icon = testBtn.querySelector('.material-symbols-outlined');
                    if (icon) icon.classList.remove('pulsating');
                }
            });
        }

        // Save device name
        function saveAndApplyConnection() {
            const deviceNameInput = document.getElementById('deviceNameInput');
            const saveBtn = document.getElementById('saveNetworkBtn');
            const newDeviceName = deviceNameInput ? deviceNameInput.value.trim() : '';
            
            // Validate device name if provided
            if (newDeviceName) {
                const namePattern = /^[a-zA-Z0-9\-]+$/; // Allow alphanumeric and hyphens, no spaces
                if (!namePattern.test(newDeviceName) || newDeviceName.length > 63) {
                    toast.error('Device name must be alphanumeric (hyphens allowed, no spaces, max 63 chars)');
                    return;
                }
            }
            
            // Disable button and show saving state
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.innerHTML = 'Saving...';
            }

            if (!newDeviceName || !fullConfig || fullConfig.deviceName === newDeviceName) {
                toast.success('No changes to apply', { duration: 2000 });
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.innerHTML = '<span class="material-symbols-outlined" >save</span> Save Device Name';
                }
                return;
            }

            pushConfigPayload({ deviceName: newDeviceName })
                .then(() => {
                    fullConfig.deviceName = newDeviceName;
                    toast.success('Device name saved over Bluetooth LE');
                })
                .catch(error => {
                    toast.error(`Failed to save over Bluetooth LE: ${error.message}`);
                })
                .finally(() => {
                    updateConnectionMethodDisplay();
                    if (saveBtn) {
                        saveBtn.disabled = false;
                        saveBtn.innerHTML = '<span class="material-symbols-outlined" >save</span> Save Device Name';
                    }
                });
        }

        // Initialize network settings controls
        function initNetworkSettings() {
            // Test connection button
            const testBtn = document.getElementById('testConnectionBtn');
            if (testBtn) {
                testBtn.addEventListener('click', testEsp32Connection);
            }
            
            // Save Device Name button
            const saveBtn = document.getElementById('saveNetworkBtn');
            if (saveBtn) {
                saveBtn.addEventListener('click', saveAndApplyConnection);
            }
        }

        // ==================== Settings Tab Management ====================

        function refreshServoSliderRender() {
            const servoPane = document.getElementById('tab-servo');
            if (!servoPane || !servoPane.classList.contains('active')) return;
            requestAnimationFrame(() => {
                document.body.offsetHeight; // Trigger reflow
                window.dispatchEvent(new Event('resize'));
            });
        }

        function openSettingsTab(tabKey) {
            const tabButton = document.querySelector(`.settings-tab[data-tab="${tabKey}"]`);
            if (tabButton) {
                tabButton.click();
            }
        }

        function moveCardToTuning(cardId, beforeNode = null) {
            const card = document.getElementById(cardId);
            const tuningRow = document.querySelector('#tuning .row.g-3');
            if (!card || !tuningRow) return;

            const cardColumn = card.closest('div[class*="col-"]');
            if (!cardColumn || cardColumn.parentElement === tuningRow) return;

            if (beforeNode && beforeNode.parentElement === tuningRow) {
                tuningRow.insertBefore(cardColumn, beforeNode);
            } else {
                tuningRow.appendChild(cardColumn);
            }
        }

        function applyRequestedLayoutMoves() {
            const dashboardRow = document.querySelector('#dashboard .row.g-3');
            const rollPitchColumn = document.getElementById('rollPitchCard')
                ? document.getElementById('rollPitchCard').closest('div[class*="col-"]')
                : null;
            const connectionColumn = document.getElementById('connectionCard')
                ? document.getElementById('connectionCard').closest('div[class*="col-"]')
                : null;
            const danceModeColumn = document.getElementById('danceModeToggle')
                ? document.getElementById('danceModeToggle').closest('div[class*="col-"]')
                : null;

            const suspensionColumn = document.getElementById('tuningSuspensionSettingsCard')
                ? document.getElementById('tuningSuspensionSettingsCard').closest('div[class*="col-"]')
                : null;
            const parametersColumn = document.getElementById('tuningParametersCard')
                ? document.getElementById('tuningParametersCard').closest('div[class*="col-"]')
                : null;

            if (dashboardRow) {
                // Desired dashboard order: roll/pitch, connection, dance, suspension.
                [rollPitchColumn, connectionColumn, danceModeColumn, suspensionColumn]
                    .filter(Boolean)
                    .forEach(column => dashboardRow.appendChild(column));
            }

            if (parametersColumn && parametersColumn.parentElement) {
                parametersColumn.parentElement.insertBefore(parametersColumn, parametersColumn.parentElement.firstChild);
            }

            const formulasCardColumn = document.getElementById('formulasCardBody')
                ? document.getElementById('formulasCardBody').closest('div[class*="col-"]')
                : null;

            moveCardToTuning('servoRangeCard', formulasCardColumn);
            moveCardToTuning('servoTrimCard', formulasCardColumn);
            moveCardToTuning('servoRotationCard', formulasCardColumn);

            const servoPane = document.getElementById('tab-servo');
            if (servoPane) {
                servoPane.style.display = 'none';
            }
        }
        
        // Initialize settings tabs
        function initSettingsTabs() {
            // Restore last active tab from localStorage
            const preferredTab = localStorage.getItem('settings_active_tab') || 'network';
            const savedTab = document.querySelector(`.settings-tab[data-tab="${preferredTab}"]`)
                ? preferredTab
                : 'network';
            
            // Set up tab click handlers
            document.querySelectorAll('.settings-tab').forEach(tab => {
                tab.addEventListener('click', function() {
                    const tabName = this.dataset.tab;
                    
                    // Remove active class from all tabs and panes
                    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
                    
                    // Add active class to clicked tab and corresponding pane
                    this.classList.add('active');
                    const pane = document.getElementById(`tab-${tabName}`);
                    if (pane) {
                        pane.classList.add('active');
                    }
                    
                    // Save active tab to localStorage
                    localStorage.setItem('settings_active_tab', tabName);

                    if (tabName === 'servo') {
                        setTimeout(refreshServoSliderRender, 50);
                    }
                });
            });
            
            // Activate the saved tab
            openSettingsTab(savedTab);
        }

        function offlineMode() {
            const toast = document.getElementById('offline-toast');
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
            }, 3000);
        }

        function onlineMode() {
            const toast = document.getElementById('online-toast');
            toast.classList.add('show');
            
            setTimeout(() => {
                toast.classList.remove('show');
            }, 3000);
        }