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
        
        // ==================== Configuration ====================
        // Determine ESP32 IP: prefer localStorage, then use actual IP if on ESP32 (192.168.x.x), else default to AP IP
        const ESP32_IP = localStorage.getItem('esp32Ip') || 
                         (window.location.hostname.startsWith('192.168.') ? window.location.hostname : '192.168.4.1');
        
        // ==================== Version Configuration ====================
        // Keep this value human-readable for the About screen.
        // `node build-version.js` refreshes these constants from package.json before builds.
        const APP_VERSION = '1.1.42';
        const BUILD_DATE = '2026-03-15';
        
        // BLE manager is optional and only available when bluetooth.js is loaded.
        const bleManager = window.BluetoothManager ? new window.BluetoothManager() : null;
        window.bleManager = bleManager;
        let communicationMode = 'ble';
        const AUTO_RECONNECT_WINDOW_MS = 120000;
        const AUTO_RECONNECT_BASE_DELAY_MS = 2000;
        const AUTO_RECONNECT_MAX_DELAY_MS = 90000;
        const AUTO_RECONNECT_JITTER_RATIO = 0.2;
        let autoReconnectTimeout = null;
        let autoReconnectInFlight = false;
        let autoReconnectStartedAtMs = 0;
        let autoReconnectAttemptCount = 0;
        let manualBleDisconnect = false;
        let hasEverBleConnection = false;
        const GARAGE_STORAGE_KEY = 'rcdcc_garage_vehicles';
        const VEHICLE_QUICK_SECTIONS = ['tuning', 'lights', 'fpv'];
        const VEHICLE_CONNECTION_REQUIRED_SECTIONS = ['tuning', 'lights', 'fpv'];

        // ==================== Phase 6: Dance Mode ====================
        const DANCE_TILT_INTERVAL_MS = 50; // ~20Hz
        const DANCE_TILT_FULL_SCALE_DEG = 45;
        const DANCE_DEADZONE_MIN_DEG = 1;
        const DANCE_DEADZONE_MAX_DEG = 15;
        const DANCE_DEADZONE_DEFAULT_DEG = 5;
        const DANCE_DEADZONE_STORAGE_KEY = 'danceModeDeadzoneDeg';

        const danceModeState = {
            enabled: false,
            toggleSync: false,
            deadzoneDeg: DANCE_DEADZONE_DEFAULT_DEG,
            latestRawRollDeg: 0,
            latestRawPitchDeg: 0,
            orientationListenerAttached: false,
            orientationTimerId: null,
            tiltSendInFlight: false,
            pendingTilt: null
        };

        function isBleConnected() {
            return !!(bleManager && bleManager.getConnectionStatus && bleManager.getConnectionStatus());
        }

        function getGarageVehicleNameById(deviceId) {
            try {
                const vehicles = JSON.parse(localStorage.getItem(GARAGE_STORAGE_KEY) || '[]');
                const hit = vehicles.find(v => v.id === deviceId);
                return hit ? (hit.friendlyName || hit.name || hit.bleName || null) : null;
            } catch (_) {
                return null;
            }
        }

        function updateDashboardVehicleName(name = null) {
            const el = document.getElementById('activeVehicleDisplay');
            if (!el) return;
            if (!isBleConnected()) {
                el.textContent = '--';
                updateVehicleQuickNav();
                return;
            }
            // Always prefer the garage custom label, fall back to passed name then BLE device name.
            const garageLabel = getGarageVehicleNameById(bleManager?.deviceId);
            el.textContent = garageLabel || (name && String(name).trim()) || bleManager?.deviceName || 'RCDCC Truck';
            updateVehicleQuickNav();
        }

        function updateVehicleQuickNav(sectionId = null) {
            const nav = document.getElementById('vehicleQuickNav');
            if (!nav) return;

            const activeSection = sectionId || localStorage.getItem('currentPage') || 'dashboard';
            const connected = isBleConnected();
            const shouldShow = connected && VEHICLE_QUICK_SECTIONS.includes(activeSection);
            nav.hidden = !shouldShow;
            if (!shouldShow) return;

            const activeSectionEl = document.getElementById(activeSection);
            if (activeSectionEl) {
                const sectionTitleRow = activeSectionEl.querySelector(':scope > .section-title-row');
                const sectionTitle = activeSectionEl.querySelector(':scope > .section-title');
                if (sectionTitleRow) {
                    sectionTitleRow.insertAdjacentElement('afterend', nav);
                } else if (sectionTitle) {
                    sectionTitle.insertAdjacentElement('afterend', nav);
                }
            }

            nav.querySelectorAll('.vehicle-quick-nav-btn').forEach(btn => {
                const isActive = btn.dataset.target === activeSection;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });
        }

        function clearDashboardActiveStatus() {
            const driving = document.getElementById('activeDrivingProfileDisplay');
            const lighting = document.getElementById('activeLightingProfileDisplay');
            if (driving) driving.textContent = '--';

        function getPreferredReconnectDeviceId() {
            if (bleManager?.preferredDeviceId) return bleManager.preferredDeviceId;
            const persisted = localStorage.getItem('rcdccBlePreferredDeviceId');
            if (persisted) return persisted;
            if (bleManager?.deviceId) return bleManager.deviceId;
            return null;
        }

        function syncGarageReconnectPulse(active, delayMs = 0) {
            if (!window.GarageManager || typeof window.GarageManager.setAutoReconnectState !== 'function') return;
            const targetDeviceId = getPreferredReconnectDeviceId();
            window.GarageManager.setAutoReconnectState(!!active, targetDeviceId, delayMs);
        }
            if (lighting) lighting.textContent = '--';
            updateDashboardVehicleName(null);
        }

        function appendToSettingsConsoleCard(message, level = 'error') {
            const consoleOutput = document.getElementById('consoleOutput');
            if (!consoleOutput) return;

            const line = document.createElement('div');
            const ts = new Date().toLocaleTimeString();
            line.textContent = `[TOAST ${String(level).toUpperCase()} ${ts}] ${String(message || '')}`;

            if (level === 'error') {
                line.style.color = '#ff5555';
            } else if (level === 'warn') {
                line.style.color = '#ffaa00';
            } else {
                line.style.color = '#00aaff';
            }

            consoleOutput.appendChild(line);
            while (consoleOutput.childElementCount > 300) {
                consoleOutput.removeChild(consoleOutput.firstElementChild);
            }
            consoleOutput.scrollTop = consoleOutput.scrollHeight;
        }

        function applyFeatureAvailabilityGate() {
            const kvReady = !!(bleManager && bleManager.supportsKvUpdates);
            const disable = !kvReady;

            const idsToDisable = [
                'saveNewProfileBtn',
                'saveLightingProfileBtn',
                'deleteLightingProfileBtn',
                'lightingProfileSelect',
                'addAuxServoBtn',
                'danceModeToggle',
                'addLightGroupBtn'
            ];
            idsToDisable.forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                el.disabled = disable || !isBleConnected();
            });

            const auxTabBtn = document.querySelector('.settings-tab[data-tab="aux-servos"]');
            if (auxTabBtn) {
                auxTabBtn.style.display = disable ? 'none' : '';
            }

            const dancePanel = document.getElementById('danceModePanel');
            if (dancePanel && disable) {
                dancePanel.style.display = 'none';
            }
        }

        function clearAllDirtyPages() {
            ['tuning', 'servo', 'system'].forEach(clearPageDirty);
        }

        function hasAnyDirtyPages() {
            return dirtyPages.size > 0;
        }

        function configsEqual(a, b) {
            try {
                return JSON.stringify(a) === JSON.stringify(b);
            } catch (_) {
                return false;
            }
        }

        function mergeConfigSnapshots(base, patch) {
            if (!patch || typeof patch !== 'object') {
                return (base && typeof base === 'object') ? JSON.parse(JSON.stringify(base)) : patch;
            }
            if (!base || typeof base !== 'object') {
                return JSON.parse(JSON.stringify(patch));
            }

            const result = Array.isArray(base)
                ? base.slice()
                : JSON.parse(JSON.stringify(base));

            Object.entries(patch).forEach(([key, value]) => {
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    const existing = (result && typeof result[key] === 'object' && !Array.isArray(result[key]))
                        ? result[key]
                        : {};
                    result[key] = mergeConfigSnapshots(existing, value);
                } else if (Array.isArray(value)) {
                    result[key] = JSON.parse(JSON.stringify(value));
                } else {
                    result[key] = value;
                }
            });

            return result;
        }

        async function reapplyDirtyPagesToDevice() {
            const reapplyWrites = [];
            if (isPageDirty('tuning')) {
                reapplyWrites.push(pushConfigPayload({
                    rideHeightOffset: tuningSliderValues.rideHeightOffset,
                    damping: tuningSliderValues.damping,
                    stiffness: tuningSliderValues.stiffness,
                    reactionSpeed: tuningSliderValues.reactionSpeed,
                    frontRearBalance: tuningSliderValues.frontRearBalance,
                    sampleRate: tuningSliderValues.sampleRate
                }));
            }
            if (isPageDirty('servo')) {
                reapplyWrites.push(pushConfigPayload({
                    servos: {
                        frontLeft: servoSliderValues.frontLeft,
                        frontRight: servoSliderValues.frontRight,
                        rearLeft: servoSliderValues.rearLeft,
                        rearRight: servoSliderValues.rearRight
                    }
                }));
            }
            if (isPageDirty('system')) {
                const mpuOrientation = parseInt(document.getElementById('mpuOrientation')?.value || '0', 10);
                if (Number.isFinite(mpuOrientation)) {
                    reapplyWrites.push(pushConfigPayload({ mpuOrientation }));
                }
            }

            await Promise.allSettled(reapplyWrites);
        }

        function handleBleWriteFailure(payload) {
            const key = String(payload?.key || '');
            const error = payload?.error;
            console.error('BLE writeValue failed:', key, error);

            if (key.startsWith('suspension.') || key.startsWith('imu.')) {
                markPageDirty('tuning');
            } else if (key.startsWith('srv_fl.') || key.startsWith('srv_fr.') || key.startsWith('srv_rl.') || key.startsWith('srv_rr.')) {
                markPageDirty('servo');
            } else if (key.startsWith('system.')) {
                markPageDirty('system');
            }

            toast.warning('Connection issue — changes may not have applied', { duration: 2500 });
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

            const canUseKv = !!(bleManager
                && typeof bleManager.writeValue === 'function'
                && bleManager.supportsKvUpdates);

            if (!canUseKv) {
                await bleManager.writeConfig(payload);
                return { status: 'ok' };
            }

            const writes = [];
            const pushWrite = (key, value) => writes.push(bleManager.writeValue(key, value));

            const toInt = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
            const degToUs = (deg) => 1000 + Math.round((Math.max(0, Math.min(180, Number(deg) || 0)) / 180) * 1000);
            const trimDegToUs = (trimDeg) => 1500 + Math.round((Number(trimDeg) || 0) * (1000 / 180));

            if (Object.prototype.hasOwnProperty.call(payload, 'reactionSpeed')) {
                pushWrite(window.RCDCC_KEYS.SUSPENSION_REACT_SPD, toInt((Number(payload.reactionSpeed) || 0) * 50));
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'damping')) {
                pushWrite(window.RCDCC_KEYS.SUSPENSION_DAMPING, toInt((Number(payload.damping) || 0) * 100));
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'stiffness')) {
                pushWrite(window.RCDCC_KEYS.SUSPENSION_STIFFNESS, toInt((Number(payload.stiffness) || 0) * 50));
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'frontRearBalance')) {
                const raw = Number(payload.frontRearBalance) || 0;
                const mapped = Math.abs(raw) <= 1 ? (raw * 200) - 100 : raw;
                pushWrite(window.RCDCC_KEYS.SUSPENSION_FR_BAL, toInt(mapped));
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'rideHeightOffset')) {
                const ride = toInt(payload.rideHeightOffset);
                pushWrite(window.RCDCC_KEYS.SERVO_FL_RIDE_HT, ride);
                pushWrite(window.RCDCC_KEYS.SERVO_FR_RIDE_HT, ride);
                pushWrite(window.RCDCC_KEYS.SERVO_RL_RIDE_HT, ride);
                pushWrite(window.RCDCC_KEYS.SERVO_RR_RIDE_HT, ride);
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'mpuOrientation')) {
                pushWrite(window.RCDCC_KEYS.IMU_ORIENT, toInt(payload.mpuOrientation));
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'deviceName')) {
                pushWrite(window.RCDCC_KEYS.SYSTEM_DEVICE_NM, String(payload.deviceName || ''));
            }

            if (payload && payload.servos) {
                const servoMap = [
                    { key: 'frontLeft', ns: 'SERVO_FL' },
                    { key: 'frontRight', ns: 'SERVO_FR' },
                    { key: 'rearLeft', ns: 'SERVO_RL' },
                    { key: 'rearRight', ns: 'SERVO_RR' }
                ];

                servoMap.forEach((entry) => {
                    const cfg = payload.servos[entry.key];
                    if (!cfg) return;

                    if (Object.prototype.hasOwnProperty.call(cfg, 'trim')) {
                        pushWrite(window.RCDCC_KEYS[`${entry.ns}_TRIM`], trimDegToUs(cfg.trim));
                    }
                    if (Object.prototype.hasOwnProperty.call(cfg, 'min')) {
                        pushWrite(window.RCDCC_KEYS[`${entry.ns}_MIN`], degToUs(cfg.min));
                    }
                    if (Object.prototype.hasOwnProperty.call(cfg, 'max')) {
                        pushWrite(window.RCDCC_KEYS[`${entry.ns}_MAX`], degToUs(cfg.max));
                    }
                    if (Object.prototype.hasOwnProperty.call(cfg, 'reversed')) {
                        pushWrite(window.RCDCC_KEYS[`${entry.ns}_REVERSE`], cfg.reversed ? 1 : 0);
                    }
                });
            }

            if (writes.length > 0) {
                for (const writeOp of writes) {
                    await writeOp;
                }
            }

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

        // ==================== Phase 2: Debounce Utility ====================
        function debounce(fn, delay) {
            let timer = null;
            return function(...args) {
                clearTimeout(timer);
                timer = setTimeout(() => fn.apply(this, args), delay);
            };
        }

        // ==================== Phase 2: Dirty State System ====================
        // pageKey: 'tuning' | 'servo' | 'system'
        const dirtyPages = new Set();

        function markPageDirty(pageKey) {
            dirtyPages.add(pageKey);
            updateDirtyUI(pageKey, true);
        }

        function clearPageDirty(pageKey) {
            dirtyPages.delete(pageKey);
            updateDirtyUI(pageKey, false);
        }

        function isPageDirty(pageKey) {
            return dirtyPages.has(pageKey);
        }

        function updateDirtyUI(pageKey, dirty) {
            const bannerId = `${pageKey}-dirty-banner`;
            const saveBtn  = document.getElementById(`${pageKey}-save-btn`);
            const banner   = document.getElementById(bannerId);
            if (banner) banner.style.display = dirty ? '' : 'none';
            if (saveBtn) {
                saveBtn.disabled = !dirty;
                saveBtn.classList.toggle('btn-gold', dirty);
                saveBtn.classList.toggle('btn-secondary', !dirty);
            }
            // Amber dot on section/tab title
            const dotId = `${pageKey}-dirty-dot`;
            const dot = document.getElementById(dotId);
            if (dot) dot.style.display = dirty ? 'inline' : 'none';
        }

        function showDirtyConfirmDialog() {
            return new Promise((resolve) => {
                const existing = document.getElementById('dirty-confirm-overlay');
                if (existing) existing.remove();
                const overlay = document.createElement('div');
                overlay.id = 'dirty-confirm-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
                overlay.innerHTML = `
                  <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
                    <h5 style="margin:0 0 12px;color:#fff;">Unsaved Changes</h5>
                    <p style="margin:0 0 20px;color:#aaa;font-size:0.9rem;">You have unsaved changes. Save before leaving?</p>
                    <div style="display:flex;gap:8px;">
                      <button id="ddc-save"    style="flex:1;padding:10px;border:none;border-radius:8px;background:#c8a800;color:#000;font-weight:600;cursor:pointer;">Save</button>
                      <button id="ddc-discard" style="flex:1;padding:10px;border:none;border-radius:8px;background:#555;color:#fff;cursor:pointer;">Discard</button>
                      <button id="ddc-cancel"  style="flex:1;padding:10px;border:none;border-radius:8px;background:#222;color:#aaa;border:1px solid #555;cursor:pointer;">Cancel</button>
                    </div>
                  </div>`;
                document.body.appendChild(overlay);
                overlay.querySelector('#ddc-save').onclick    = () => { overlay.remove(); resolve('save'); };
                overlay.querySelector('#ddc-discard').onclick = () => { overlay.remove(); resolve('discard'); };
                overlay.querySelector('#ddc-cancel').onclick  = () => { overlay.remove(); resolve('cancel'); };
            });
        }

        async function savePage(pageKey) {
            if (!isBleConnected()) {
                toast.warning('Connect to Bluetooth before saving');
                return;
            }
            const btn = document.getElementById(`${pageKey}-save-btn`);
            const originalText = btn ? btn.innerHTML : '';
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="material-symbols-outlined" style="vertical-align:middle;font-size:1rem;">hourglass_empty</span> Saving...';
            }
            try {
                await bleManager.sendSaveCommandWithTimeout(3000);
                clearPageDirty(pageKey);
                // Snapshot the current config as the new saved state
                try {
                    const latestBootstrap = await bleManager.readConfig();
                    bleManager.lastKnownSavedState = mergeConfigSnapshots(bleManager.lastKnownSavedState, latestBootstrap);
                } catch (_) { /* best effort */ }
                toast.success('Settings saved');
            } catch (e) {
                toast.error('Save failed - please try again');
                console.error('Save timeout or failure for page:', pageKey);
                console.error('savePage failed:', e);
                if (btn) { btn.disabled = false; }
            } finally {
                if (btn) btn.innerHTML = originalText;
                updateDirtyUI(pageKey, isPageDirty(pageKey));
            }
        }

        async function discardPage(pageKey) {
            const saved = bleManager && bleManager.lastKnownSavedState;
            if (!saved) {
                clearPageDirty(pageKey);
                return;
            }
            // Revert UI to saved state values
            if (pageKey === 'tuning') {
                isLoadingTuningConfig = true;
                updateTuningSliders(saved);
                isLoadingTuningConfig = false;
                // Re-send reverted values to ESP32 RAM
                const canUseKv = !!(bleManager && typeof bleManager.writeValue === 'function' && bleManager.supportsKvUpdates);
                if (canUseKv) {
                    const toInt = (v) => Math.round(Number(v) || 0);
                    const k = window.RCDCC_KEYS;
                    const promises = [];
                    if (saved.rideHeightOffset !== undefined) {
                        const ride = toInt(saved.rideHeightOffset);
                        promises.push(bleManager.writeValue(k.SERVO_FL_RIDE_HT, ride));
                        promises.push(bleManager.writeValue(k.SERVO_FR_RIDE_HT, ride));
                        promises.push(bleManager.writeValue(k.SERVO_RL_RIDE_HT, ride));
                        promises.push(bleManager.writeValue(k.SERVO_RR_RIDE_HT, ride));
                    }
                    if (saved.damping       !== undefined) promises.push(bleManager.writeValue(k.SUSPENSION_DAMPING,   toInt((saved.damping || 0) * 100)));
                    if (saved.stiffness     !== undefined) promises.push(bleManager.writeValue(k.SUSPENSION_STIFFNESS, toInt((saved.stiffness || 0) * 50)));
                    if (saved.reactionSpeed !== undefined) promises.push(bleManager.writeValue(k.SUSPENSION_REACT_SPD, toInt((saved.reactionSpeed || 0) * 50)));
                    if (saved.frontRearBalance !== undefined) {
                        const mapped = toInt(((Number(saved.frontRearBalance) || 0) / 100) * 200 - 100);
                        promises.push(bleManager.writeValue(k.SUSPENSION_FR_BAL, mapped));
                    }
                    await Promise.allSettled(promises);
                }
            } else if (pageKey === 'servo') {
                isLoadingTuningConfig = true;
                updateServoSliders(saved);
                loadSettingsFromConfig(saved);
                isLoadingTuningConfig = false;
                const canUseKv = !!(bleManager && typeof bleManager.writeValue === 'function' && bleManager.supportsKvUpdates);
                if (canUseKv && saved.servos) {
                    const trimDegToUs = (d) => 1500 + Math.round((Number(d) || 0) * (1000 / 180));
                    const degToUs     = (d) => 1000 + Math.round((Number(d) || 0) / 180 * 1000);
                    const k = window.RCDCC_KEYS;
                    const servoMap = [
                        { key: 'frontLeft',  ns: 'SERVO_FL' },
                        { key: 'frontRight', ns: 'SERVO_FR' },
                        { key: 'rearLeft',   ns: 'SERVO_RL' },
                        { key: 'rearRight',  ns: 'SERVO_RR' },
                    ];
                    const promises = [];
                    servoMap.forEach(({ key, ns }) => {
                        const cfg = saved.servos[key];
                        if (!cfg) return;
                        if (cfg.trim   !== undefined) promises.push(bleManager.writeValue(k[`${ns}_TRIM`],    trimDegToUs(cfg.trim)));
                        if (cfg.min    !== undefined) promises.push(bleManager.writeValue(k[`${ns}_MIN`],     degToUs(cfg.min)));
                        if (cfg.max    !== undefined) promises.push(bleManager.writeValue(k[`${ns}_MAX`],     degToUs(cfg.max)));
                        if (cfg.reversed !== undefined) promises.push(bleManager.writeValue(k[`${ns}_REVERSE`], cfg.reversed ? 1 : 0));
                    });
                    await Promise.allSettled(promises);
                }
            } else if (pageKey === 'system') {
                loadSettingsFromConfig(saved);
                const canUseKv = !!(bleManager && typeof bleManager.writeValue === 'function' && bleManager.supportsKvUpdates);
                if (canUseKv) {
                    const promises = [];
                    if (saved.mpuOrientation !== undefined) promises.push(bleManager.writeValue(window.RCDCC_KEYS.IMU_ORIENT, parseInt(saved.mpuOrientation)));
                    await Promise.allSettled(promises);
                }
            }
            clearPageDirty(pageKey);
        }

        async function runPostConnectFlow(connectionLabel = null, showToast = true) {
            communicationMode = 'ble';
            hasEverBleConnection = true;
            stopAutoReconnect();
            stopHeartbeat();
            updateConnectionStatus(true);
            updateConnectionMethodDisplay();

            resetSectionDataState();
            await fetchConfigFromESP32(false, { scope: 'bootstrap' });
            if (bleManager && bleManager.schemaCompatible === false) {
                toast.error('Connected, but this truck firmware is not compatible with this app build.');
                return;
            }
            applyFeatureAvailabilityGate();

            const vehicleName = connectionLabel
                || getGarageVehicleNameById(bleManager?.deviceId)
                || bleManager?.deviceName
                || 'RCDCC Truck';
            updateDashboardVehicleName(vehicleName);
            updateDashboardActiveProfile();
            updateDashboardActiveLightingProfile();

            try {
                await bleManager.sendSystemCommand('flash', { color: 'green', count: 2 });
            } catch (error) {
                const message = String(error?.message || error || '').toLowerCase();
                if (!message.includes('incompatible firmware ble schema')) {
                    console.warn('Post-connect green flash command failed:', error?.message || error);
                }
            }

            if (showToast) {
                toast.success(`Connected to ${vehicleName}`);
            }
        }

        async function connectBLE() {
            if (!bleManager) {
                toast.error('Bluetooth manager unavailable in this build');
                return false;
            }

            try {
                manualBleDisconnect = false;
                // Always open the OS picker fresh — disconnect any existing connection first.
                if (bleManager.isConnected) {
                    await bleManager.disconnect();
                }
                setHeaderSearching(true);
                await bleManager.connect();
                await runPostConnectFlow();
                return true;
            } catch (error) {
                const message = error?.message || '';
                communicationMode = 'ble';
                setHeaderSearching(false);
                clearDashboardActiveStatus();
                if (/cancel/i.test(message)) {
                    return false;
                }
                toast.error(`BLE connect failed: ${message}`);
                return false;
            }
        }

        async function connectBLEToVehicle(deviceId, vehicleName = null) {
            if (!bleManager) return false;

            manualBleDisconnect = false;

            try {
                const currentId = bleManager.deviceId;
                if (isBleConnected() && currentId && currentId !== deviceId) {
                    try {
                        await bleManager.sendSystemCommand('flash', { color: 'red', count: 2 });
                        await delay(800);
                    } catch (error) {
                        console.warn('Outgoing truck flash failed:', error?.message || error);
                    }
                    await disconnectBLE(false);
                }

                localStorage.setItem('rcdccBlePreferredDeviceId', deviceId);
                bleManager.preferredDeviceId = deviceId;

                setHeaderSearching(true);
                const connected = await bleManager.connectToKnownDevice();
                if (!connected) {
                    toast.error('Could not connect - make sure vehicle is powered on');
                    setHeaderSearching(false);
                    return false;
                }

                await runPostConnectFlow(vehicleName, true);
                return true;
            } catch (error) {
                console.error('connectBLEToVehicle failed:', error);
                toast.error('Could not connect - make sure vehicle is powered on');
                setHeaderSearching(false);
                return false;
            }
        }

        async function disconnectBLE(markManual = true) {
            if (!bleManager) return;
            manualBleDisconnect = !!markManual;
            stopAutoReconnect();
            await bleManager.disconnect();
            communicationMode = 'ble';
            hasLoadedConfigFromDevice = false;
            startHeartbeat();
            updateConnectionStatus(false);
            fetchFirmwareVersion();
            updateConnectionMethodDisplay();
            clearDashboardActiveStatus();
            applyFeatureAvailabilityGate();
            resetSectionDataState();
            // Refresh garage UI so Connected badges and button labels update.
            if (window.GarageManager && typeof window.GarageManager.renderGarage === 'function') {
                window.GarageManager.renderGarage();
            }
        }

        async function attemptAutoReconnect(source = 'timer') {
            if (!bleManager || !bleManager.connectToKnownDevice) return false;
            if (!hasEverBleConnection || manualBleDisconnect || autoReconnectInFlight || isBleConnected() || document.hidden || !navigator.onLine) {
                return false;
            }

            autoReconnectInFlight = true;
            try {
                const didReconnect = await bleManager.connectToKnownDevice();
                if (didReconnect) {
                    await runPostConnectFlow(null, false);
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

        function getAutoReconnectDelayMs(attemptNumber) {
            const exponent = Math.max(0, attemptNumber - 1);
            const baseDelay = Math.min(AUTO_RECONNECT_BASE_DELAY_MS * Math.pow(2, exponent), AUTO_RECONNECT_MAX_DELAY_MS);
            const jitterFactor = 1 + ((Math.random() * 2 - 1) * AUTO_RECONNECT_JITTER_RATIO);
            return Math.max(1000, Math.round(baseDelay * jitterFactor));
        }

        function scheduleAutoReconnectAttempt(delayMs, source = 'backoff') {
            if (autoReconnectTimeout) {
                clearTimeout(autoReconnectTimeout);
                autoReconnectTimeout = null;
            }

            autoReconnectTimeout = setTimeout(async () => {
                autoReconnectTimeout = null;

                if (manualBleDisconnect) {
                    stopAutoReconnect();
                    return;
                }

                const elapsed = Date.now() - autoReconnectStartedAtMs;
                if (elapsed >= AUTO_RECONNECT_WINDOW_MS) {
                    stopAutoReconnect();
                    console.log('BLE auto reconnect window expired');
                    return;
                }

                const didReconnect = await attemptAutoReconnect(source);
                if (didReconnect) {
                    stopAutoReconnect();
                    return;
                }

                autoReconnectAttemptCount += 1;
                const nextDelay = getAutoReconnectDelayMs(autoReconnectAttemptCount);
                const remainingWindow = AUTO_RECONNECT_WINDOW_MS - (Date.now() - autoReconnectStartedAtMs);
                if (remainingWindow <= 0) {
                    stopAutoReconnect();
                    return;
                }

                scheduleAutoReconnectAttempt(Math.min(nextDelay, remainingWindow), 'backoff');
            }, Math.max(0, delayMs));
        }

        function startAutoReconnect(reason = 'disconnect') {
            if (!bleManager || manualBleDisconnect) return;
            if (!hasEverBleConnection) return;
            if (autoReconnectTimeout || autoReconnectInFlight) return;

            // setHeaderSearching also updates the garage card via setAutoReconnectState.
            setHeaderSearching(true);
            autoReconnectStartedAtMs = Date.now();
            autoReconnectAttemptCount = 1;
            scheduleAutoReconnectAttempt(0, reason);
        }

        function stopAutoReconnect() {
            if (autoReconnectTimeout) {
                clearTimeout(autoReconnectTimeout);
                autoReconnectTimeout = null;
            }
            autoReconnectStartedAtMs = 0;
            autoReconnectAttemptCount = 0;
            // setHeaderSearching(false) clears both the header icon and garage card state.
            setHeaderSearching(false);
        }

        // Expose manual control for quick testing from browser console.
        window.connectBLE = connectBLE;
        window.connectBLEToVehicle = connectBLEToVehicle;
        window.disconnectBLE = disconnectBLE;

        function refreshConfigAfterConnection(reason = 'ble-connect') {
            if (!isBleConnected()) return;
            if (bleManager && bleManager.schemaCompatible === false) return;
            if (configRefreshInFlight) return;

            configRefreshInFlight = fetchConfigFromESP32(false)
                .catch((error) => {
                    console.warn(`Config refresh failed (${reason}):`, error?.message || error);
                })
                .finally(() => {
                    configRefreshInFlight = null;
                });
        }

            // Allow other modules (e.g. Garage card selection) to request a safe, de-duped refresh.
            window.refreshConfigAfterConnection = refreshConfigAfterConnection;
        
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
        const SECTION_LOAD_KEYS = ['tuning', 'lights', 'settings'];
        const sectionDataLoaded = { tuning: false, lights: false, settings: false };
        const sectionLoadPromises = { tuning: null, lights: null, settings: null };

        // Phase 3: Driving profile state
        let drivingProfiles = [];       // [{index, name}, ...]
        let activeDrivingProfileIndex = 0;

        // Phase 4: Servo registry state
        let servoRegistry = null;       // { count, aux_count, aux_servos: [...] }
        const rSliders = {};
        const rSliderSilentTimers = {};
        const rSliderInitState = new Set();

        function setCardBodiesLoading(isLoading) {
            const cardBodies = document.querySelectorAll('.card-body.is-loading');
            cardBodies.forEach((cardBody) => {
                cardBody.classList.remove('is-loading');
                cardBody.setAttribute('aria-busy', 'false');
            });
            document.body.classList.remove('app-config-loading');
        }

        function finishInitialCardLoading(reason = 'config-loaded') {
            if (hasAppliedInitialDeviceConfig) return;
            hasAppliedInitialDeviceConfig = true;
            setCardBodiesLoading(false);
            console.log(`Initial card loading finished: ${reason}`);
        }

        function resetSectionDataState() {
            SECTION_LOAD_KEYS.forEach((sectionId) => {
                sectionDataLoaded[sectionId] = false;
                sectionLoadPromises[sectionId] = null;
                setSectionLoading(sectionId, false);
            });
        }

        function ensureSectionLoadingOverlay(sectionId) {
            const section = document.getElementById(sectionId);
            if (!section) return null;

            let overlay = section.querySelector('.section-loading-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'section-loading-overlay';
                overlay.innerHTML = '<div class="section-loading-spinner" aria-hidden="true"></div><div class="section-loading-text">Loading…</div>';
                section.appendChild(overlay);
            }
            return overlay;
        }

        function setSectionLoading(sectionId, isLoading, message = 'Loading…') {
            const overlay = ensureSectionLoadingOverlay(sectionId);
            if (!overlay) return;
            const label = overlay.querySelector('.section-loading-text');
            if (label) label.textContent = message;
            overlay.style.display = isLoading ? 'flex' : 'none';
            overlay.setAttribute('aria-hidden', isLoading ? 'false' : 'true');
        }

        async function ensureSectionDataLoaded(sectionId, force = false) {
            if (!SECTION_LOAD_KEYS.includes(sectionId)) return;
            if (!isBleConnected()) return;
            if (!force && sectionDataLoaded[sectionId]) return;
            if (sectionLoadPromises[sectionId]) return sectionLoadPromises[sectionId];

            setSectionLoading(sectionId, true, `Loading ${sectionId}…`);

            sectionLoadPromises[sectionId] = (async () => {
                try {
                    await fetchConfigFromESP32(false, { scope: sectionId });
                    sectionDataLoaded[sectionId] = true;
                } finally {
                    setSectionLoading(sectionId, false);
                    sectionLoadPromises[sectionId] = null;
                }
            })();

            return sectionLoadPromises[sectionId];
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
            
            show(message, type = 'info', options = {}) {
                const duration = options.duration || 3000;
                const bgClass = {
                    success: 'bg-success',
                    error: 'bg-danger',
                    warning: 'bg-warning',
                    info: 'bg-info'
                }[type] || 'bg-info';
                
                // Create toast element
                const toastId = 'toast-' + Date.now();
                const toastEl = document.createElement('div');
                toastEl.id = toastId;
                toastEl.className = `toast-box ${bgClass} toast-top tap-to-close`;
                toastEl.innerHTML = `<div class="in"><div class="text">${message}</div></div>`;

                if (type === 'error') {
                    appendToSettingsConsoleCard(message, 'error');
                }
                
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
                    toastEl.classList.remove('show');
                    setTimeout(() => {
                        toastEl.remove();
                    }, 800);
                }, duration);
                
                // Tap to close
                toastEl.addEventListener('click', () => {
                    toastEl.classList.remove('show');
                    setTimeout(() => {
                        toastEl.remove();
                    }, 800);
                });
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

        function getDanceModeElements() {
            return {
                toggle: document.getElementById('danceModeToggle'),
                panel: document.getElementById('danceModePanel'),
                banner: document.getElementById('danceModeStatusBanner'),
                dot: document.getElementById('danceTiltDot'),
                deadzoneCircle: document.getElementById('danceDeadzoneCircle'),
                slider: document.getElementById('danceDeadzoneSlider'),
                deadzoneValue: document.getElementById('danceDeadzoneValue'),
                indicatorWrap: document.getElementById('danceTiltIndicatorWrap')
            };
        }

        function injectDanceModeStyles() {
            if (document.getElementById('danceModeStyles')) return;
            const style = document.createElement('style');
            style.id = 'danceModeStyles';
            style.textContent = `
                .dance-mode-panel {
                    margin-top: 14px;
                    display: none;
                    border-radius: 12px;
                    border: 1px solid rgba(200, 168, 0, 0.4);
                    background: linear-gradient(180deg, rgba(22, 22, 22, 0.95) 0%, rgba(10, 10, 10, 0.95) 100%);
                    padding: 12px;
                }
                .dance-mode-banner {
                    border: 1px solid rgba(200, 168, 0, 0.6);
                    border-radius: 10px;
                    padding: 8px 10px;
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: #ffe69a;
                    background: rgba(200, 168, 0, 0.08);
                    animation: dancePulseBorder 1.2s ease-in-out infinite;
                }
                .dance-tilt-wrap {
                    margin-top: 12px;
                    display: flex;
                    justify-content: center;
                }
                .dance-tilt-indicator {
                    width: 196px;
                    height: 196px;
                    border-radius: 50%;
                    position: relative;
                    border: 2px solid rgba(79, 156, 255, 0.7);
                    background: radial-gradient(circle at center, rgba(79, 156, 255, 0.18) 0%, rgba(79, 156, 255, 0.04) 45%, rgba(0, 0, 0, 0.25) 100%);
                    box-shadow: inset 0 0 24px rgba(79, 156, 255, 0.22);
                    overflow: hidden;
                }
                .dance-grid-line {
                    position: absolute;
                    background: rgba(79, 156, 255, 0.35);
                }
                .dance-grid-line.h {
                    left: 12px;
                    right: 12px;
                    top: 50%;
                    height: 1px;
                    transform: translateY(-50%);
                }
                .dance-grid-line.v {
                    top: 12px;
                    bottom: 12px;
                    left: 50%;
                    width: 1px;
                    transform: translateX(-50%);
                }
                .dance-deadzone-circle {
                    position: absolute;
                    left: 50%;
                    top: 50%;
                    width: 22px;
                    height: 22px;
                    border-radius: 50%;
                    border: 1.5px solid rgba(200, 168, 0, 0.9);
                    background: rgba(200, 168, 0, 0.12);
                    transform: translate(-50%, -50%);
                    transition: width 120ms linear, height 120ms linear;
                }
                .dance-tilt-dot {
                    position: absolute;
                    left: 50%;
                    top: 50%;
                    width: 14px;
                    height: 14px;
                    border-radius: 50%;
                    border: 2px solid #0d0d0d;
                    background: #50ff9a;
                    transform: translate(-50%, -50%);
                    box-shadow: 0 0 14px rgba(80, 255, 154, 0.65);
                    transition: transform 40ms linear;
                }
                @keyframes dancePulseBorder {
                    0% { box-shadow: 0 0 0 0 rgba(200, 168, 0, 0.35); }
                    70% { box-shadow: 0 0 0 8px rgba(200, 168, 0, 0); }
                    100% { box-shadow: 0 0 0 0 rgba(200, 168, 0, 0); }
                }
            `;
            document.head.appendChild(style);
        }

        function ensureDanceModePanel() {
            const toggle = document.getElementById('danceModeToggle');
            if (!toggle) return;

            const cardBody = toggle.closest('.card-body');
            if (!cardBody) return;
            if (document.getElementById('danceModePanel')) return;

            injectDanceModeStyles();

            const panel = document.createElement('div');
            panel.id = 'danceModePanel';
            panel.className = 'dance-mode-panel';
            panel.innerHTML = `
                <div id="danceModeStatusBanner" class="dance-mode-banner">
                    Dance Mode Active - Tilt phone to control suspension
                </div>
                <div id="danceTiltIndicatorWrap" class="dance-tilt-wrap" aria-label="Dance Mode Tilt Indicator">
                    <div class="dance-tilt-indicator">
                        <div class="dance-grid-line h"></div>
                        <div class="dance-grid-line v"></div>
                        <div id="danceDeadzoneCircle" class="dance-deadzone-circle"></div>
                        <div id="danceTiltDot" class="dance-tilt-dot"></div>
                    </div>
                </div>
                <div class="mt-3">
                    <label for="danceDeadzoneSlider" class="form-label mb-1"><strong>Deadzone</strong> <span id="danceDeadzoneValue">${DANCE_DEADZONE_DEFAULT_DEG}°</span></label>
                    <input type="range" id="danceDeadzoneSlider" class="form-range" min="${DANCE_DEADZONE_MIN_DEG}" max="${DANCE_DEADZONE_MAX_DEG}" step="1" value="${DANCE_DEADZONE_DEFAULT_DEG}">
                </div>
            `;

            cardBody.appendChild(panel);
        }

        function setDanceModeToggleChecked(checked) {
            const { toggle } = getDanceModeElements();
            if (!toggle) return;
            danceModeState.toggleSync = true;
            toggle.checked = !!checked;
            danceModeState.toggleSync = false;
        }

        function normalizeDanceAxis(rawTiltDeg, deadzoneDeg) {
            const magnitude = Math.abs(rawTiltDeg);
            if (magnitude < deadzoneDeg) return 0;

            const headroom = Math.max(1, DANCE_TILT_FULL_SCALE_DEG - deadzoneDeg);
            const normalized = (magnitude - deadzoneDeg) / headroom;
            const signed = (rawTiltDeg >= 0 ? 1 : -1) * Math.min(1, normalized);
            return Math.max(-1, Math.min(1, signed));
        }

        function updateDanceDeadzoneUi() {
            const { slider, deadzoneValue, deadzoneCircle } = getDanceModeElements();
            if (!slider || !deadzoneValue || !deadzoneCircle) return;

            slider.value = String(danceModeState.deadzoneDeg);
            deadzoneValue.textContent = `${danceModeState.deadzoneDeg}°`;

            const radiusMaxPx = 86;
            const ratio = Math.max(0, Math.min(1, danceModeState.deadzoneDeg / DANCE_TILT_FULL_SCALE_DEG));
            const radiusPx = Math.max(6, Math.round(radiusMaxPx * ratio));
            const diameterPx = radiusPx * 2;
            deadzoneCircle.style.width = `${diameterPx}px`;
            deadzoneCircle.style.height = `${diameterPx}px`;
        }

        function updateDanceTiltIndicator(rollNorm, pitchNorm) {
            const { dot } = getDanceModeElements();
            if (!dot) return;

            const limitPx = 86;
            const clampedRoll = Math.max(-1, Math.min(1, Number(rollNorm) || 0));
            const clampedPitch = Math.max(-1, Math.min(1, Number(pitchNorm) || 0));
            const x = clampedRoll * limitPx;
            const y = -clampedPitch * limitPx;

            dot.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
        }

        function centerDanceTiltIndicator() {
            updateDanceTiltIndicator(0, 0);
        }

        function handleDanceOrientationEvent(event) {
            if (!danceModeState.enabled) return;
            if (!event) return;

            // Map browser orientation to spec: left tilt = positive roll, forward tilt = positive pitch.
            const gamma = Number(event.gamma);
            const beta = Number(event.beta);
            if (!Number.isFinite(gamma) || !Number.isFinite(beta)) return;

            danceModeState.latestRawRollDeg = -gamma;
            danceModeState.latestRawPitchDeg = -beta;
        }

        async function drainDanceTiltQueue() {
            if (danceModeState.tiltSendInFlight) return;
            danceModeState.tiltSendInFlight = true;

            try {
                while (danceModeState.enabled && isBleConnected() && danceModeState.pendingTilt) {
                    const tilt = danceModeState.pendingTilt;
                    danceModeState.pendingTilt = null;
                    await pushSystemCommand('servo_tilt', { roll: tilt.roll, pitch: tilt.pitch });
                }
            } catch (error) {
                console.warn('Dance Mode tilt send failed:', error?.message || error);
            } finally {
                danceModeState.tiltSendInFlight = false;
                if (danceModeState.enabled && isBleConnected() && danceModeState.pendingTilt) {
                    drainDanceTiltQueue();
                }
            }
        }

        function queueDanceTiltUpdate(rollNorm, pitchNorm) {
            danceModeState.pendingTilt = {
                roll: Number((Number(rollNorm) || 0).toFixed(4)),
                pitch: Number((Number(pitchNorm) || 0).toFixed(4))
            };
            drainDanceTiltQueue();
        }

        function stopDanceModeSampling() {
            if (danceModeState.orientationTimerId) {
                clearInterval(danceModeState.orientationTimerId);
                danceModeState.orientationTimerId = null;
            }
            if (danceModeState.orientationListenerAttached) {
                window.removeEventListener('deviceorientation', handleDanceOrientationEvent, true);
                danceModeState.orientationListenerAttached = false;
            }
            danceModeState.pendingTilt = null;
        }

        function startDanceModeSampling() {
            if (!danceModeState.orientationListenerAttached) {
                window.addEventListener('deviceorientation', handleDanceOrientationEvent, true);
                danceModeState.orientationListenerAttached = true;
            }
            if (danceModeState.orientationTimerId) {
                clearInterval(danceModeState.orientationTimerId);
            }

            danceModeState.orientationTimerId = setInterval(() => {
                if (!danceModeState.enabled) return;
                if (!isBleConnected()) {
                    disableDanceMode({ sendCommand: false, bleDisconnected: true });
                    return;
                }

                const rollNorm = normalizeDanceAxis(danceModeState.latestRawRollDeg, danceModeState.deadzoneDeg);
                const pitchNorm = normalizeDanceAxis(danceModeState.latestRawPitchDeg, danceModeState.deadzoneDeg);
                updateDanceTiltIndicator(rollNorm, pitchNorm);
                queueDanceTiltUpdate(rollNorm, pitchNorm);
            }, DANCE_TILT_INTERVAL_MS);
        }

        async function requestDanceModeOrientationPermission() {
            if (typeof window.DeviceOrientationEvent === 'undefined') {
                toast.error('Device orientation is not supported on this device');
                return false;
            }

            if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
                try {
                    const result = await window.DeviceOrientationEvent.requestPermission();
                    if (result !== 'granted') {
                        toast.error('Gyroscope access is required for Dance Mode');
                        return false;
                    }
                } catch (error) {
                    toast.error('Gyroscope access is required for Dance Mode');
                    return false;
                }
            }

            return true;
        }

        async function enableDanceMode() {
            if (!(bleManager && bleManager.supportsKvUpdates)) {
                toast.warning('Dance Mode requires firmware 2.0.0 or newer');
                setDanceModeToggleChecked(false);
                return;
            }
            if (!isBleConnected()) {
                toast.warning('Connect to Bluetooth before enabling Dance Mode');
                setDanceModeToggleChecked(false);
                return;
            }

            const permissionGranted = await requestDanceModeOrientationPermission();
            if (!permissionGranted) {
                setDanceModeToggleChecked(false);
                return;
            }

            await pushSystemCommand('dance_mode', { enabled: true });

            const { panel } = getDanceModeElements();
            danceModeState.enabled = true;
            danceModeState.latestRawRollDeg = 0;
            danceModeState.latestRawPitchDeg = 0;
            if (panel) panel.style.display = 'block';
            centerDanceTiltIndicator();
            startDanceModeSampling();
        }

        async function disableDanceMode(options = {}) {
            const sendCommand = options.sendCommand !== false;
            const bleDisconnected = options.bleDisconnected === true;

            stopDanceModeSampling();
            danceModeState.enabled = false;
            danceModeState.latestRawRollDeg = 0;
            danceModeState.latestRawPitchDeg = 0;

            const { panel } = getDanceModeElements();
            if (panel) panel.style.display = 'none';
            centerDanceTiltIndicator();
            setDanceModeToggleChecked(false);

            if (sendCommand && isBleConnected()) {
                try {
                    await pushSystemCommand('dance_mode', { enabled: false });
                } catch (error) {
                    console.warn('Dance Mode disable command failed:', error?.message || error);
                }
            }

            if (bleDisconnected) {
                toast.warning('Dance Mode disabled - BLE disconnected');
            }
        }

        function handleDanceModeToggleChange(event) {
            if (danceModeState.toggleSync) return;
            const isEnabled = !!event?.target?.checked;

            if (isEnabled) {
                enableDanceMode().catch(error => {
                    console.error('Failed to enable Dance Mode:', error);
                    toast.error('Failed to enable Dance Mode');
                    setDanceModeToggleChecked(false);
                    danceModeState.enabled = false;
                    stopDanceModeSampling();
                });
            } else {
                disableDanceMode({ sendCommand: true }).catch(error => {
                    console.error('Failed to disable Dance Mode:', error);
                });
            }
        }

        function initDanceModeUi() {
            ensureDanceModePanel();
            const { toggle, slider } = getDanceModeElements();
            if (!toggle) return;

            const storedDeadzone = parseInt(localStorage.getItem(DANCE_DEADZONE_STORAGE_KEY) || `${DANCE_DEADZONE_DEFAULT_DEG}`, 10);
            danceModeState.deadzoneDeg = Math.max(
                DANCE_DEADZONE_MIN_DEG,
                Math.min(DANCE_DEADZONE_MAX_DEG, Number.isFinite(storedDeadzone) ? storedDeadzone : DANCE_DEADZONE_DEFAULT_DEG)
            );
            updateDanceDeadzoneUi();
            centerDanceTiltIndicator();

            toggle.addEventListener('change', handleDanceModeToggleChange);
            setDanceModeToggleChecked(false);

            if (slider) {
                slider.addEventListener('input', function() {
                    const next = parseInt(this.value || `${DANCE_DEADZONE_DEFAULT_DEG}`, 10);
                    danceModeState.deadzoneDeg = Math.max(DANCE_DEADZONE_MIN_DEG, Math.min(DANCE_DEADZONE_MAX_DEG, next));
                    localStorage.setItem(DANCE_DEADZONE_STORAGE_KEY, String(danceModeState.deadzoneDeg));
                    updateDanceDeadzoneUi();
                });
            }
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
        
        async function handleAutoLevel(buttonElement = null) {
            const button = buttonElement
                || document.getElementById('autoLevelBtn')
                || document.getElementById('servoAutoCalibrateBtn');

            if (!button) return;
            
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
            executeAutoLevel(false, button);
        }

        async function executeAutoLevel(resetTrims = false, sourceButton = null) {
            const button = sourceButton
                || document.getElementById('autoLevelBtn')
                || document.getElementById('servoAutoCalibrateBtn');
            const setLevelBtn = document.getElementById('setLevelBtn');

            if (!button) {
                toast.error('Auto-level control is unavailable');
                return;
            }
            
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
                    const updatedConfig = await bleManager.readConfigScoped('tuning');
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
            clearDashboardActiveStatus();
            applyFeatureAvailabilityGate();

            if (bleManager && bleManager.setWriteFailureCallback) {
                bleManager.setWriteFailureCallback(handleBleWriteFailure);
            }

            if (bleManager && bleManager.setDisconnectCallback) {
                bleManager.setDisconnectCallback(() => {
                    if (danceModeState.enabled) {
                        disableDanceMode({ sendCommand: false, bleDisconnected: true });
                    }
                    communicationMode = 'ble';
                    hasLoadedConfigFromDevice = false;
                    startHeartbeat();
                    updateConnectionStatus(false);
                    updateConnectionMethodDisplay();
                    clearDashboardActiveStatus();
                    applyFeatureAvailabilityGate();
                    resetSectionDataState();
                    if (window.GarageManager && typeof window.GarageManager.renderGarage === 'function') {
                        window.GarageManager.renderGarage();
                    }
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

            // Manual scan is preferred at startup. Auto-reconnect starts only
            // after the app has had at least one successful BLE session.
            
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
            initDanceModeUi();
            // initGyroControls(); // Commented out - slider library not yet connected
            initNetworkSettings();
            initSettingsTabs();

            // Initialize truck notifications toggle
            const enableTruckNotificationsCheckbox = document.getElementById('enableTruckNotifications');
            const ledNotificationsContent = document.getElementById('ledNotificationsContent');
            const applyTruckNotificationsVisibility = (enabled) => {
                if (ledNotificationsContent) {
                    ledNotificationsContent.style.display = enabled ? '' : 'none';
                }
            };
            if (enableTruckNotificationsCheckbox) {
                const truckNotificationsEnabled = localStorage.getItem('truckNotificationsEnabled') !== 'false';
                enableTruckNotificationsCheckbox.checked = truckNotificationsEnabled;
                applyTruckNotificationsVisibility(truckNotificationsEnabled);
                enableTruckNotificationsCheckbox.addEventListener('change', function() {
                    const enabled = this.checked;
                    localStorage.setItem('truckNotificationsEnabled', enabled);
                    applyTruckNotificationsVisibility(enabled);
                    toast.success('Truck notifications ' + (enabled ? 'enabled' : 'disabled'));
                });
            } else {
                applyTruckNotificationsVisibility(true);
            }

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
            const formulasCollapsed = localStorage.getItem('formulasCardCollapsed') !== 'false';
            const formulasCardBody = document.getElementById('formulasCardBody');
            const formulasChevron = document.getElementById('formulasChevron');
            if (formulasCardBody && formulasChevron) {
                formulasCardBody.style.display = formulasCollapsed ? 'none' : 'block';
                formulasChevron.textContent = formulasCollapsed ? 'keyboard_arrow_right' : 'keyboard_arrow_down';
            }

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
            
            // Restore servo settings lock state from localStorage.
            // Older builds stored trim and direction separately; the UI now uses one combined lock.
            const savedServoTrimLock = localStorage.getItem('servoTrimLocked') === 'true';
            const savedServoRotationLock = localStorage.getItem('servoRotationLocked') === 'true';
            const servoSettingsLocked = savedServoTrimLock || savedServoRotationLock;
            servoTrimLocked = servoSettingsLocked;
            servoRotationLocked = servoSettingsLocked;
            localStorage.setItem('servoTrimLocked', servoSettingsLocked.toString());
            localStorage.setItem('servoRotationLocked', servoSettingsLocked.toString());
            syncServoSettingsLockUI();

            // Header scroll shrink effect
            const dashboardHeader = document.querySelector('.dashboard-header');
            const brandTitles = document.querySelectorAll('.brand-title');
            const compactHeaderPageLabels = {
                garage: 'Garage',
                tuning: 'Suspension',
                lights: 'Lights',
                fpv: 'FPV'
            };
            
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
                            const sectionId = activeSection.id;

                            if (compactHeaderPageLabels[sectionId]) {
                                const dashboardVehicleLabel = document.getElementById('activeVehicleDisplay')?.textContent?.trim();
                                const preferredVehicleId = localStorage.getItem('rcdccBlePreferredDeviceId');
                                const vehicleName = ((dashboardVehicleLabel && dashboardVehicleLabel !== '--') ? dashboardVehicleLabel : null)
                                    || getGarageVehicleNameById(preferredVehicleId)
                                    || getGarageVehicleNameById(bleManager?.deviceId)
                                    || bleManager?.deviceName
                                    || 'Truck';
                                h1.textContent = `${vehicleName} - ${compactHeaderPageLabels[sectionId]}`;
                                h1.style.display = 'block';
                            } else if (sectionTitle) {
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
                btn.addEventListener('click', async function() {
                    const target = this.dataset.target;
                    if (target) {
                        await navigateToSection(target);
                    }
                });
            });

            document.querySelectorAll('#vehicleQuickNav .vehicle-quick-nav-btn').forEach(btn => {
                btn.addEventListener('click', async function() {
                    const target = this.dataset.target;
                    if (target) {
                        await navigateToSection(target);
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
            if (autoLevelBtn) {
                autoLevelBtn.addEventListener('click', handleAutoLevel);
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
            const lightsToggle = document.getElementById('lightsToggle');
            const lightsToggleDashboard = document.getElementById('lightsToggleDashboard');

            bindMasterLightSwitch(lightsToggle);
            bindMasterLightSwitch(lightsToggleDashboard);
            syncMasterLightSwitches(getMasterLightsEnabled());
            
            // Suspension Settings gear click - navigate to Tuning
            const suspGear = document.getElementById('suspensionSettingsGear');
            if (suspGear) {
                suspGear.addEventListener('click', function() {
                    navigateToSection('tuning');
                });
            }
            
            // Connection icon click - navigate to Garage (Bluetooth management lives there)
            ['connectionSettingsGear', 'wifiIcon'].forEach(elementId => {
                const element = document.getElementById(elementId);
                if (element) {
                    element.addEventListener('click', function() {
                        navigateToSection('garage');
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
        async function navigateToSection(sectionId) {
            const requestedSection = String(sectionId || 'dashboard');
            const requiresBle = VEHICLE_CONNECTION_REQUIRED_SECTIONS.includes(requestedSection);
            const targetSection = (requiresBle && !isBleConnected()) ? 'garage' : requestedSection;

            // Dirty guard: check page being navigated away from
            const currentSection = localStorage.getItem('currentPage') || 'dashboard';
            if (currentSection !== targetSection) {
                let dirtyKeys = [];
                if (currentSection === 'tuning') dirtyKeys = ['tuning'];
                else if (currentSection === 'settings') dirtyKeys = ['servo', 'system'];
                const dirtyKey = dirtyKeys.find(k => isPageDirty(k));
                if (dirtyKey) {
                    const choice = await showDirtyConfirmDialog();
                    if (choice === 'cancel') return;
                    if (choice === 'save') {
                        await savePage(dirtyKey);
                        if (isPageDirty(dirtyKey)) return; // save failed, abort
                    } else if (choice === 'discard') {
                        await discardPage(dirtyKey);
                    }
                }
            }

            document.querySelectorAll('.footer-nav button').forEach(b => b.classList.remove('active'));
            const navBtn = document.querySelector(`.footer-nav button[data-target="${targetSection}"]`);
            if (navBtn) navBtn.classList.add('active');
            
            document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
            const section = document.getElementById(targetSection);
            if (section) section.classList.add('active');
            
            // Save current page to localStorage
            localStorage.setItem('currentPage', targetSection);
            
            // Trigger header scroll update for title change
            const scrollEvent = new Event('scroll');
            window.dispatchEvent(scrollEvent);
            
            window.scrollTo(0, 0);

            if (targetSection === 'settings') {
                setTimeout(refreshServoSliderRender, 50);
            }

            if (SECTION_LOAD_KEYS.includes(targetSection)) {
                ensureSectionDataLoaded(targetSection).catch((error) => {
                    console.warn(`Lazy load failed for ${targetSection}:`, error?.message || error);
                });
            }

            updateVehicleQuickNav(targetSection);
        }

        window.navigateToSection = navigateToSection;

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
        const LIGHT_GROUP_DEFAULT_PATTERN = 'solid';
        const LIGHT_GROUP_CYCLE_INTERVAL_SECONDS = 30;
        const LIGHT_GROUP_EXTRA_PATTERNS = ['solid', 'blink', 'strobe', 'breathe', 'fade', 'twinkle', 'sparkle', 'flash_sparkle', 'glitter', 'running', 'larson', 'flicker', 'heartbeat', 'alternate'];

        // Phase 5: Lighting profiles are stored on ESP32 LittleFS (slots 0-9)
        let lightingProfiles = []; // [{index, name}]
        let activeLightingProfileIndex = 0;
        
        // Predefined light groups (initialized on first load)
        const PREDEFINED_LIGHT_GROUPS = [
            { name: 'Brake Lights', indices: [], brightness: 255, color: '#ff0000', color2: '#000000', pattern: 'solid', enabled: false, isPredefined: true },
            { name: 'Emergency/Police Lights', indices: [], brightness: 255, color: '#ff0000', color2: '#0000ff', pattern: 'alternate', enabled: false, isPredefined: true },
            { name: 'Hazard Lights', indices: [], brightness: 255, color: '#ffa500', color2: '#000000', pattern: 'blink', enabled: false, isPredefined: true },
            { name: 'Headlights', indices: [], brightness: 255, color: '#ffffff', color2: '#000000', pattern: 'solid', enabled: false, isPredefined: true },
            { name: 'Reverse Lights', indices: [], brightness: 255, color: '#ffffff', color2: '#000000', pattern: 'solid', enabled: false, isPredefined: true },
            { name: 'Taillights', indices: [], brightness: 128, color: '#ff0000', color2: '#000000', pattern: 'solid', enabled: false, isPredefined: true },
            { name: 'Turn Signals Left', indices: [], brightness: 255, color: '#ffa500', color2: '#000000', pattern: 'blink', enabled: false, isPredefined: true },
            { name: 'Turn Signals Right', indices: [], brightness: 255, color: '#ffa500', color2: '#000000', pattern: 'blink', enabled: false, isPredefined: true }
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
        const expandedLightGroupIds = new Set();

        function createLightGroupId() {
            return `lg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }

        function ensureLightGroupIds() {
            lightGroups = lightGroups.map(group => ({
                ...group,
                id: group.id || createLightGroupId()
            }));
        }

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

        async function loadLightGroups() {
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

            ensureLightGroupIds();

            saveLightGroups(false);
            renderLightGroupsList();
            renderLightsHierarchyControls();
        }

        function updateDashboardActiveLightingProfile() {
            const el = document.getElementById('activeLightingProfileDisplay');
            if (!el) return;
            if (!isBleConnected()) {
                el.textContent = '--';
                return;
            }
            const hit = lightingProfiles.find(p => Number(p.index) === Number(activeLightingProfileIndex));
            el.textContent = hit ? (hit.name || `Profile ${hit.index}`) : '--';
        }

        function populateLightingProfileSelector() {
            const select = document.getElementById('lightingProfileSelect');
            if (!select) return;
            select.innerHTML = '';
            lightingProfiles
                .slice()
                .sort((a, b) => Number(a.index) - Number(b.index))
                .forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = String(p.index);
                    opt.textContent = `${p.index}: ${p.name || 'Unnamed'}`;
                    if (Number(p.index) === Number(activeLightingProfileIndex)) opt.selected = true;
                    select.appendChild(opt);
                });
            updateDashboardActiveLightingProfile();
        }

        function hydrateLightGroupsFromActiveProfile(profileData) {
            if (!profileData) return;
            const totalLeds = Number(profileData.total_leds || 20);
            const totalInput = document.getElementById('totalLEDCount');
            if (totalInput) totalInput.value = totalLeds;
            localStorage.setItem(TOTAL_LED_COUNT_KEY, String(totalLeds));

            const groups = Array.isArray(profileData.groups) ? profileData.groups : [];
            lightGroups = groups.map(g => ({
                id: createLightGroupId(),
                name: g.name || `Group ${g.id}`,
                indices: Array.isArray(g.leds) ? g.leds.map(v => Number(v)).filter(v => Number.isFinite(v) && v >= 0) : [],
                brightness: Math.round((Number(g.brightness ?? 100) * 255) / 100),
                color: (g.color_primary || '#ffffff').toLowerCase(),
                color2: (g.color_secondary || '#000000').toLowerCase(),
                pattern: (g.effect || 'solid').toLowerCase(),
                effect_speed: Number(g.effect_speed ?? 50),
                effect_intensity: Number(g.effect_intensity ?? 100),
                enabled: !!g.enabled
            }));
            setMasterLightsEnabled(!!profileData.master, false);
            saveLightGroups(false);
            applyLightsHierarchyToHardware();
        }

        async function loadLightingProfileFlow(index) {
            if (!(bleManager && bleManager.supportsKvUpdates)) {
                toast.warning('Lighting profiles require firmware 2.0.0 or newer');
                return;
            }
            if (!isBleConnected()) {
                toast.warning('Connect via Bluetooth to load lighting profiles');
                return;
            }
            try {
                await bleManager.sendSystemCommand('load_lt_profile', { index: Number(index) });
                const cfg = await bleManager.readConfigScoped('lights');
                if (cfg.lt_profiles) lightingProfiles = cfg.lt_profiles;
                activeLightingProfileIndex = Number(cfg.act_lt_prof ?? index ?? 0);
                if (cfg.active_lt_profile) hydrateLightGroupsFromActiveProfile(cfg.active_lt_profile);
                populateLightingProfileSelector();
                toast.success('Lighting profile loaded');
            } catch (e) {
                toast.error('Failed to load lighting profile: ' + e.message);
            }
        }

        async function saveLightingProfileFlow() {
            if (!(bleManager && bleManager.supportsKvUpdates)) {
                toast.warning('Lighting profiles require firmware 2.0.0 or newer');
                return;
            }
            if (!isBleConnected()) {
                toast.warning('Connect via Bluetooth to save profiles');
                return;
            }
            const name = (prompt('Profile name (max 20 chars):', 'New Lighting Profile') || '').trim().substring(0, 20);
            if (!name) return;
            const used = new Set(lightingProfiles.map(p => Number(p.index)));
            let slot = -1;
            for (let i = 0; i < 10; i++) { if (!used.has(i)) { slot = i; break; } }
            if (slot < 0) {
                const replacementSlot = await showProfileOverwriteDialog(lightingProfiles);
                if (replacementSlot == null) return;
                const replacement = lightingProfiles.find(p => Number(p.index) === Number(replacementSlot));
                const replaceName = replacement ? replacement.name : `slot ${replacementSlot}`;
                const confirmed = confirm(`Overwrite lighting profile "${replaceName}"?`);
                if (!confirmed) {
                    return;
                }
                slot = Number(replacementSlot);
            }
            try {
                await bleManager.sendSystemCommand('save_lt_profile', { index: slot, name });
                const cfg = await bleManager.readConfigScoped('lights');
                if (cfg.lt_profiles) lightingProfiles = cfg.lt_profiles;
                activeLightingProfileIndex = Number(cfg.act_lt_prof ?? slot);
                populateLightingProfileSelector();
                toast.success(`Saved lighting profile "${name}" to slot ${slot}`);
            } catch (e) {
                toast.error('Failed to save lighting profile: ' + e.message);
            }
        }

        async function deleteLightingProfileFlow() {
            if (!(bleManager && bleManager.supportsKvUpdates)) {
                toast.warning('Lighting profiles require firmware 2.0.0 or newer');
                return;
            }
            if (!isBleConnected()) {
                toast.warning('Connect via Bluetooth to delete profiles');
                return;
            }
            if (lightingProfiles.length <= 1) {
                toast.warning('Cannot delete the last remaining profile.');
                return;
            }
            const select = document.getElementById('lightingProfileSelect');
            const idx = Number(select?.value ?? activeLightingProfileIndex);
            if (!confirm(`Delete lighting profile slot ${idx}? This cannot be undone.`)) return;
            try {
                await bleManager.sendSystemCommand('delete_lt_profile', { index: idx });
                const cfg = await bleManager.readConfigScoped('lights');
                if (cfg.lt_profiles) lightingProfiles = cfg.lt_profiles;
                activeLightingProfileIndex = Number(cfg.act_lt_prof ?? 0);
                if (cfg.active_lt_profile) hydrateLightGroupsFromActiveProfile(cfg.active_lt_profile);
                populateLightingProfileSelector();
                toast.success('Lighting profile deleted');
            } catch (e) {
                toast.error('Failed to delete lighting profile: ' + e.message);
            }
        }

        function saveLightGroups(pushToHardware = true) {
            ensureLightGroupIds();
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
            const masterToggle = document.getElementById('lightsToggle');
            const dashboardToggle = document.getElementById('lightsToggleDashboard');
            [masterToggle, dashboardToggle].forEach(toggleBtn => {
                if (!toggleBtn) return;
                toggleBtn.setAttribute('aria-pressed', isEnabled ? 'true' : 'false');
                toggleBtn.classList.toggle('is-active', isEnabled);
                toggleBtn.setAttribute('aria-label', isEnabled ? 'Master Light Switch on' : 'Master Light Switch off');
                toggleBtn.title = isEnabled ? 'Master lights on' : 'Master lights off';

                const icon = toggleBtn.querySelector('.lights-master-toggle-icon');
                if (icon) {
                    icon.textContent = isEnabled ? 'lightbulb' : 'light_off';
                }
            });
        }

        function bindMasterLightSwitch(toggleElement) {
            if (!toggleElement || toggleElement.dataset.bound === 'true') return;

            toggleElement.dataset.bound = 'true';
            syncMasterLightSwitches(getMasterLightsEnabled());
            toggleElement.addEventListener('click', function() {
                setMasterLightsEnabled(!getMasterLightsEnabled(), true);
            });
        }

        function getPatternMode(patternName) {
            const value = (patternName || '').toLowerCase();
            if (!value) return 1;
            if (value === 'blink' || value === 'strobe' || value === 'alternate') return 2;
            if (value === 'breathe' || value === 'fade' || value === 'heartbeat') return 3;
            if (value === 'running' || value === 'larson') return 4;
            if (value === 'twinkle' || value === 'sparkle' || value === 'flash_sparkle' || value === 'glitter') return 5;
            if (value === 'flicker') return 6;
            return 1; // solid default
        }

        function getPatternBlinkRate(patternName) {
            const value = (patternName || '').toLowerCase();
            if (value === 'strobe') return 80;
            if (value === 'blink' || value === 'alternate') return 220;
            if (value === 'flicker' || value === 'sparkle' || value === 'glitter') return 120;
            if (value === 'running' || value === 'larson') return 180;
            if (value === 'breathe' || value === 'fade' || value === 'heartbeat') return 650;
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
                    item.setAttribute('data-group-id', group.id || '');
                    item.setAttribute('data-index', index);
                    
                    const ledCount = group.indices?.length || 0;
                    const ledDisplay = ledCount > 0 ? formatLedRanges(group.indices) : 'No LEDs assigned';
                    const brightnessPercent = group.brightness !== undefined ?
                        Math.round(group.brightness * 100 / 255) : 100;
                    const color = group.color || '#ff0000';
                    const color2 = group.color2 || '#000000';
                    const pattern = group.pattern || LIGHT_GROUP_DEFAULT_PATTERN;
                    const patternDisplay = (pattern === 'Cycle' || pattern === 'Cycle Favorites')
                        ? `${pattern} (${LIGHT_GROUP_CYCLE_INTERVAL_SECONDS}s)`
                        : pattern;
                    const isConfigured = group.indices && group.indices.length > 0;
                    const detailsExpanded = expandedLightGroupIds.has(group.id);
                    const hasSecondaryColor = color2 !== '#000000' && color2 !== '#00000000';
                    const warningIcon = !isConfigured
                        ? '<button type="button" class="light-group-warning-btn" aria-label="No LEDs assigned" data-bs-toggle="popover" data-bs-trigger="click" data-bs-placement="top" data-bs-content="No LED lights assigned in this group."><span class="material-symbols-outlined light-group-warning-icon" aria-hidden="true">warning</span></button>'
                        : '';
                    
                    item.innerHTML = `
                        <div class="light-group-leading-controls" aria-label="Reorder group">
                            <button type="button" class="light-group-order-btn" aria-label="Move group up" title="Move up" onclick="moveLightGroup(${index}, -1)" ${index === 0 ? 'disabled' : ''}>
                                <span class="material-symbols-outlined">keyboard_arrow_up</span>
                            </button>
                            <button type="button" class="light-group-order-btn" aria-label="Move group down" title="Move down" onclick="moveLightGroup(${index}, 1)" ${index === lightGroups.length - 1 ? 'disabled' : ''}>
                                <span class="material-symbols-outlined">keyboard_arrow_down</span>
                            </button>
                        </div>
                        <div class="light-group-info">
                            <div class="light-group-name-row">
                                <div class="light-group-name">${group.name}${warningIcon}</div>
                            </div>
                            <div class="light-group-meta-row">
                                <div class="light-group-swatch-row" aria-label="Group colors">
                                    <span class="light-group-swatch" style="background-color: ${color};" title="Primary color"></span>
                                    ${hasSecondaryColor ? `<span class="light-group-swatch" style="background-color: ${color2};" title="Secondary color"></span>` : ''}
                                </div>
                            </div>
                            <div class="light-group-details ${detailsExpanded ? 'expanded' : ''}">
                                <div class="light-group-detail-line">LED Assignment: ${ledDisplay}</div>
                                <div class="light-group-detail-line">Pattern: ${patternDisplay}</div>
                                <div class="light-group-detail-line">Brightness: ${brightnessPercent}%</div>
                            </div>
                        </div>
                        <div class="light-group-controls">
                            <button type="button" class="light-group-details-toggle" aria-label="${detailsExpanded ? 'Collapse details' : 'Expand details'}" title="${detailsExpanded ? 'Collapse details' : 'Expand details'}" onclick="toggleLightGroupDetails('${group.id}')">
                                <span class="material-symbols-outlined">${detailsExpanded ? 'expand_less' : 'expand_more'}</span>
                            </button>
                            <div class="garage-card-overflow dropdown" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                                <button type="button" class="garage-card-overflow-btn dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Light group options" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                                    <span class="material-symbols-outlined">more_vert</span>
                                </button>
                                <ul class="dropdown-menu dropdown-menu-end garage-card-menu" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                                    <li>
                                        <button type="button" class="dropdown-item" onclick="event.stopPropagation(); editLightGroup(${index})" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">Edit</button>
                                    </li>
                                    <li>
                                        <button type="button" class="dropdown-item text-danger" onclick="event.stopPropagation(); deleteLightGroup(${index})" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">Delete</button>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    `;

                    listContainer.appendChild(item);
                });

                initLightGroupWarningPopovers(listContainer);
            }
        }

        function initLightGroupWarningPopovers(scopeElement = document) {
            if (!(window.bootstrap && bootstrap.Popover)) return;

            const triggers = scopeElement.querySelectorAll('.light-group-warning-btn[data-bs-toggle="popover"]');
            triggers.forEach(trigger => {
                const existing = bootstrap.Popover.getInstance(trigger);
                if (existing) existing.dispose();
                new bootstrap.Popover(trigger, {
                    container: 'body',
                    trigger: 'click',
                    placement: 'top'
                });
            });
        }

        function captureLightGroupPositions() {
            const map = new Map();
            const items = document.querySelectorAll('#lightGroupsList .light-group-item[data-group-id]');
            items.forEach(item => {
                map.set(item.dataset.groupId, item.getBoundingClientRect());
            });
            return map;
        }

        function animateLightGroupReorder(previousPositions) {
            if (!previousPositions || previousPositions.size === 0) return;

            const items = document.querySelectorAll('#lightGroupsList .light-group-item[data-group-id]');
            items.forEach(item => {
                const previousRect = previousPositions.get(item.dataset.groupId);
                if (!previousRect) return;

                const currentRect = item.getBoundingClientRect();
                const deltaY = previousRect.top - currentRect.top;
                if (Math.abs(deltaY) < 1) return;

                item.animate(
                    [
                        { transform: `translateY(${deltaY}px)` },
                        { transform: 'translateY(0)' }
                    ],
                    {
                        duration: 300,
                        easing: 'cubic-bezier(0.2, 0, 0, 1)'
                    }
                );
            });
        }

        function moveLightGroup(index, delta) {
            const targetIndex = index + delta;
            if (index < 0 || index >= lightGroups.length) return;
            if (targetIndex < 0 || targetIndex >= lightGroups.length) return;

            const previousPositions = captureLightGroupPositions();
            const [movedGroup] = lightGroups.splice(index, 1);
            lightGroups.splice(targetIndex, 0, movedGroup);

            saveLightGroups();
            requestAnimationFrame(() => animateLightGroupReorder(previousPositions));
        }

        function toggleLightGroupDetails(groupId) {
            if (!groupId) return;
            if (expandedLightGroupIds.has(groupId)) {
                expandedLightGroupIds.delete(groupId);
            } else {
                expandedLightGroupIds.add(groupId);
            }
            renderLightGroupsList();
        }

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
            solid: { needsDualColor: false },
            blink: { needsDualColor: true },
            strobe: { needsDualColor: false },
            breathe: { needsDualColor: false },
            fade: { needsDualColor: true },
            twinkle: { needsDualColor: true },
            sparkle: { needsDualColor: false },
            flash_sparkle: { needsDualColor: true },
            glitter: { needsDualColor: false },
            running: { needsDualColor: false },
            larson: { needsDualColor: false },
            flicker: { needsDualColor: false },
            heartbeat: { needsDualColor: false },
            alternate: { needsDualColor: true }
        };

        function getLightGroupPatternNames() {
            return [...LIGHT_GROUP_EXTRA_PATTERNS];
        }

        function populateLightGroupPatternOptions(selectedPattern = LIGHT_GROUP_DEFAULT_PATTERN) {
            const patternSelect = document.getElementById('lightGroupPatternSelect');
            if (!patternSelect) return;

            const patterns = getLightGroupPatternNames();
            patternSelect.innerHTML = '';

            patterns.forEach(patternName => {
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
                    currentColor = '#ff0000';
                    currentColor2 = '#0000ff';
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
                button.textContent = String(i); // Zero-based display: LED 0 is first LED
                
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
                        String(rangeStart) : 
                        `${rangeStart}-${rangeEnd}`);
                    rangeStart = indices[i];
                    rangeEnd = indices[i];
                }
            }
            ranges.push(rangeStart === rangeEnd ? 
                String(rangeStart) : 
                `${rangeStart}-${rangeEnd}`);
            
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
                const existingId = lightGroups[currentEditingGroupIndex]?.id || createLightGroupId();
                lightGroups[currentEditingGroupIndex] = {
                    id: existingId,
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
                    id: createLightGroupId(),
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
            if (group.id) {
                expandedLightGroupIds.delete(group.id);
            }
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

            const ltSelect = document.getElementById('lightingProfileSelect');
            const ltSaveBtn = document.getElementById('saveLightingProfileBtn');
            const ltDeleteBtn = document.getElementById('deleteLightingProfileBtn');
            if (ltSelect) {
                ltSelect.addEventListener('change', async () => {
                    const selectedIndex = Number(ltSelect.value || 0);
                    activeLightingProfileIndex = selectedIndex;
                    updateDashboardActiveLightingProfile();

                    if (!isBleConnected()) return;
                    await loadLightingProfileFlow(selectedIndex);
                });
            }
            if (ltSaveBtn) ltSaveBtn.addEventListener('click', saveLightingProfileFlow);
            if (ltDeleteBtn) ltDeleteBtn.addEventListener('click', deleteLightingProfileFlow);
            
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
            
            if (appVersionEl) {
                appVersionEl.textContent = APP_VERSION;
            }
            if (buildDateEl) {
                buildDateEl.textContent = BUILD_DATE;
            }
            
            // Fetch firmware version from ESP32
            fetchFirmwareVersion();
        }
        
        function fetchFirmwareVersion() {
            const firmwareVersionEl = document.getElementById('firmwareVersion');
            if (!firmwareVersionEl) return;

            if (isBleConnected()) {
                firmwareVersionEl.textContent = 'Loading...';
                bleManager.readConfigScoped('bootstrap')
                    .then(data => {
                        const fw = data?.fw_version
                            || data?.firmwareVersion
                            || data?.version
                            || data?.system?.fw_version
                            || data?.system?.firmwareVersion
                            || data?.system?.version;
                        if (fw) {
                            firmwareVersionEl.textContent = fw;
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
                icon.textContent = 'bluetooth_connected';
                icon.style.color = 'var(--bluetooth-blue)';
                const status = document.getElementById('telemetryStatus');
                if (status) status.textContent = 'Live';
                // Sync the garage card to connected state immediately.
                if (window.GarageManager && typeof window.GarageManager.renderGarage === 'function') {
                    window.GarageManager.renderGarage();
                }
                updateDashboardVehicleName(null);
                updateVehicleQuickNav();
                return;
            }

            // BLE is disconnected, show muted icon
            icon.classList.remove('connecting');
            icon.classList.add('disconnected');
            icon.textContent = 'bluetooth_disabled';
            icon.style.color = 'var(--text-muted)';
            const status = document.getElementById('telemetryStatus');
            if (status) status.textContent = 'Inactive';
            updateDashboardVehicleName(null);
            updateVehicleQuickNav();
        }

        function setHeaderSearching(active) {
            // Always sync the garage card state regardless of BLE connection status.
            if (window.GarageManager && typeof window.GarageManager.setAutoReconnectState === 'function') {
                const targetId = active ? getPreferredReconnectDeviceId() : null;
                window.GarageManager.setAutoReconnectState(!!active, targetId, 0);
            }

            // Only update the header icon when not already fully connected.
            const icon = document.getElementById('wifiIcon');
            if (!icon || isBleConnected()) return;
            if (active) {
                icon.classList.remove('disconnected');
                icon.classList.add('connecting');
                icon.textContent = 'bluetooth_searching';
                icon.style.color = 'var(--text-muted)';
            } else {
                icon.classList.remove('connecting');
                icon.classList.add('disconnected');
                icon.textContent = 'bluetooth_disabled';
                icon.style.color = 'var(--text-muted)';
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

        // ==================== Phase 4: Servo Registry ====================

        const MAX_AUX_SERVOS = 10;

        // Render editable label rows for the 4 reserved servos
        function renderReservedServoLabels(config) {
            const container = document.getElementById('reservedServoLabelsList');
            if (!container) return;
            container.innerHTML = '';

            const reserved = [
                { ns: 'srv_fl', label: config?.srv_fl?.label || 'Front Left',  key: RCDCC_KEYS.SERVO_FL_LABEL },
                { ns: 'srv_fr', label: config?.srv_fr?.label || 'Front Right', key: RCDCC_KEYS.SERVO_FR_LABEL },
                { ns: 'srv_rl', label: config?.srv_rl?.label || 'Rear Left',   key: RCDCC_KEYS.SERVO_RL_LABEL },
                { ns: 'srv_rr', label: config?.srv_rr?.label || 'Rear Right',  key: RCDCC_KEYS.SERVO_RR_LABEL },
            ];

            reserved.forEach(s => {
                const row = document.createElement('div');
                row.className = 'd-flex align-items-center gap-2';

                const lbl = document.createElement('label');
                lbl.className = 'text-muted flex-shrink-0';
                lbl.style.cssText = 'width:80px;font-size:0.8rem;';
                lbl.textContent = s.ns;

                const input = document.createElement('input');
                input.type = 'text';
                input.maxLength = 20;
                input.className = 'form-control form-control-sm flex-grow-1';
                input.value = s.label;
                input.disabled = !isBleConnected();

                let saveTimer = null;
                input.addEventListener('input', () => {
                    clearTimeout(saveTimer);
                    saveTimer = setTimeout(async () => {
                        if (!isBleConnected()) return;
                        try {
                            await bleManager.writeValue(s.key, input.value.trim() || s.label);
                        } catch (e) {
                            toast.error('Failed to save label: ' + e.message);
                        }
                    }, 800);
                });

                row.appendChild(lbl);
                row.appendChild(input);
                container.appendChild(row);
            });
        }

        function renderAuxServoRegistry(registry) {
            const container = document.getElementById('auxServoList');
            if (!container) return;
            container.innerHTML = '';

            // Enable/disable Add button
            const addBtn = document.getElementById('addAuxServoBtn');
            if (addBtn) {
                addBtn.disabled = !isBleConnected() || (registry && registry.aux_count >= MAX_AUX_SERVOS);
            }

            if (!registry || registry.aux_count === 0) {
                const msg = document.createElement('div');
                msg.className = 'text-muted text-center py-2';
                msg.style.fontSize = '0.875rem';
                msg.textContent = 'No aux servos configured. Tap "Add Servo" to get started.';
                container.appendChild(msg);
                return;
            }

            registry.aux_servos.forEach(aux => {
                const card = buildAuxServoCard(aux);
                container.appendChild(card);
            });
        }

        function buildAuxServoCard(aux) {
            const card = document.createElement('div');
            card.className = 'card mb-0';
            card.dataset.auxNs = aux.ns;

            // Header
            const header = document.createElement('div');
            header.className = 'card-header card-header-dark d-flex justify-content-between align-items-center py-2 px-3';
            header.innerHTML = `
                <div class="d-flex align-items-center gap-2">
                    <span class="material-symbols-outlined icon-danger" style="font-size:1.1rem;">cable</span>
                    <strong style="font-size:0.9rem;">${escapeHtml(aux.label)}</strong>
                    <span class="badge" style="background:#333;color:#aaa;font-size:0.7rem;">${escapeHtml(aux.ns)}</span>
                </div>
                <button type="button" class="btn btn-link p-0" style="color:#888;" title="Delete servo"
                        onclick="confirmRemoveAuxServo('${escapeHtml(aux.ns)}')">
                    <span class="material-symbols-outlined" style="font-size:1.1rem;">delete</span>
                </button>`;

            // Body
            const body = document.createElement('div');
            body.className = 'card-body p-3';
            body.appendChild(buildAuxServoControls(aux));

            card.appendChild(header);
            card.appendChild(body);
            return card;
        }

        function buildAuxServoControls(aux) {
            const frag = document.createDocumentFragment();
            const connected = isBleConnected();

            // Type selector
            const typeRow = document.createElement('div');
            typeRow.className = 'mb-3 d-flex align-items-center gap-2';
            typeRow.innerHTML = `<label class="form-label mb-0 flex-shrink-0" style="width:60px;font-size:0.8rem;">Type</label>`;
            const typeSelect = document.createElement('select');
            typeSelect.className = 'form-select form-select-sm flex-grow-1';
            typeSelect.disabled = !connected;
            ['positional', 'continuous', 'pan', 'relay'].forEach(t => {
                const opt = document.createElement('option');
                opt.value = t; opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
                if (t === aux.type) opt.selected = true;
                typeSelect.appendChild(opt);
            });
            typeSelect.addEventListener('change', async () => {
                if (!connected) return;
                try {
                    await bleManager.writeValue(auxServoKey(auxNsToSlot(aux.ns), 'type'), typeSelect.value);
                    // Re-fetch config to get updated controls
                    const cfg = await bleManager.readConfigScoped('settings');
                    bleManager.lastKnownSavedState = mergeConfigSnapshots(bleManager.lastKnownSavedState, cfg);
                    if (cfg.servo_registry) {
                        servoRegistry = cfg.servo_registry;
                        renderAuxServoRegistry(servoRegistry);
                        renderReservedServoLabels(cfg);
                    }
                } catch (e) { toast.error('Failed to change type: ' + e.message); }
            });
            typeRow.appendChild(typeSelect);
            frag.appendChild(typeRow);

            // Type-specific controls
            const t = aux.type;

            if (t === 'positional' || t === 'pan') {
                frag.appendChild(auxSliderRow(aux.ns, 'trim', 'Trim (µs)', aux.trim ?? 1500, 900, 2100));
                frag.appendChild(auxSliderRow(aux.ns, 'min',  'Min (µs)',  aux.min  ?? 1000, 900, 2100));
                frag.appendChild(auxSliderRow(aux.ns, 'max',  'Max (µs)',  aux.max  ?? 2000, 900, 2100));
                frag.appendChild(auxToggleRow(aux.ns, 'reverse', 'Reverse', aux.reverse));
            }
            if (t === 'positional') {
                frag.appendChild(auxSliderRow(aux.ns, 'ride_ht', 'Ride Ht %', aux.ride_ht ?? 50, 0, 100));
            }
            if (t === 'pan') {
                frag.appendChild(auxSliderRow(aux.ns, 'spd', 'Speed %', aux.spd ?? 50, 0, 100));
                frag.appendChild(auxDirectionButtons(aux.ns));
            }
            if (t === 'continuous') {
                frag.appendChild(auxSliderRow(aux.ns, 'spd_fwd', 'Fwd Speed %', aux.spd_fwd ?? 50, 0, 100));
                frag.appendChild(auxSliderRow(aux.ns, 'spd_rev', 'Rev Speed %', aux.spd_rev ?? 50, 0, 100));
                frag.appendChild(auxToggleRow(aux.ns, 'reverse', 'Invert Dir', aux.reverse));
                frag.appendChild(auxContinuousButtons(aux.ns));
            }
            if (t === 'relay') {
                const isMomentary = aux.momentary === 1;
                frag.appendChild(auxRelayTypeRow(aux.ns, isMomentary));
                frag.appendChild(auxRelayControl(aux.ns, aux.state, isMomentary));
            }

            return frag;
        }

        function auxNsToSlot(ns) {
            // "srv_aux_04" → 4
            const m = ns.match(/srv_aux_(\d+)/);
            return m ? parseInt(m[1]) : 0;
        }

        function escapeHtml(s) {
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function auxSliderRow(ns, key, label, currentVal, min, max) {
            const slot = auxNsToSlot(ns);
            const id = `aux-${ns.replace('_','')}-${key}`;
            const row = document.createElement('div');
            row.className = 'mb-2';
            row.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <small class="text-muted">${label}</small>
                    <span id="${id}-val" style="font-size:0.75rem;color:#c8a800;">${currentVal}</span>
                </div>
                <input type="range" class="form-range" id="${id}" min="${min}" max="${max}" value="${currentVal}"
                       ${isBleConnected() ? '' : 'disabled'}>`;
            const rangeEl = row.querySelector(`#${id}`);
            const valEl   = row.querySelector(`#${id}-val`);
            let debounce = null;
            rangeEl.addEventListener('input', () => {
                valEl.textContent = rangeEl.value;
                clearTimeout(debounce);
                debounce = setTimeout(async () => {
                    if (!isBleConnected()) return;
                    try { await bleManager.writeValue(auxServoKey(slot, key), parseInt(rangeEl.value)); }
                    catch (e) { toast.error('Save failed: ' + e.message); }
                }, 400);
            });
            return row;
        }

        function auxToggleRow(ns, key, label, currentVal) {
            const slot = auxNsToSlot(ns);
            const id = `aux-${ns}-${key}-toggle`;
            const row = document.createElement('div');
            row.className = 'mb-2 d-flex justify-content-between align-items-center';
            row.innerHTML = `
                <small class="text-muted">${label}</small>
                <div class="form-check form-switch m-0">
                    <input class="form-check-input" type="checkbox" id="${id}" ${currentVal ? 'checked' : ''} ${isBleConnected() ? '' : 'disabled'}>
                </div>`;
            row.querySelector(`#${id}`).addEventListener('change', async function () {
                if (!isBleConnected()) return;
                try { await bleManager.writeValue(auxServoKey(slot, key), this.checked ? 1 : 0); }
                catch (e) { toast.error('Save failed: ' + e.message); }
            });
            return row;
        }

        function auxContinuousButtons(ns) {
            const div = document.createElement('div');
            div.className = 'd-flex gap-2 mt-2';

            const makeBtn = (label, icon, speedFn) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn btn-sm btn-gold flex-fill';
                btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle;">${icon}</span> ${label}`;
                const sendSpeed = async (spd) => {
                    if (!isBleConnected()) return;
                    try { await bleManager.sendSystemCommand('aux_run', { namespace: ns, speed: spd }); }
                    catch (e) { /* silent */ }
                };
                btn.addEventListener('pointerdown', () => sendSpeed(speedFn()));
                btn.addEventListener('pointerup',   () => sendSpeed(0));
                btn.addEventListener('pointerleave',() => sendSpeed(0));
                return btn;
            };

            // Read current aux from registry for speed values
            const getAux = () => servoRegistry?.aux_servos?.find(a => a.ns === ns);
            div.appendChild(makeBtn('Fwd',  'arrow_forward', () =>  (getAux()?.spd_fwd ?? 50)));
            div.appendChild(makeBtn('Stop', 'stop',          () =>  0));
            div.appendChild(makeBtn('Rev',  'arrow_back',    () => -(getAux()?.spd_rev ?? 50)));
            return div;
        }

        function auxDirectionButtons(ns) {
            const div = document.createElement('div');
            div.className = 'd-flex gap-2 mt-2';
            const aux = servoRegistry?.aux_servos?.find(a => a.ns === ns) || {};
            const center = aux.trim ?? 1500;
            const minUs  = aux.min  ?? 1000;
            const maxUs  = aux.max  ?? 2000;
            const slot   = auxNsToSlot(ns);

            const makeBtn = (icon, val) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn btn-sm btn-gold flex-fill';
                btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle;">${icon}</span>`;
                btn.addEventListener('click', async () => {
                    if (!isBleConnected()) return;
                    try { await bleManager.writeValue(auxServoKey(slot, 'trim'), val); }
                    catch (e) { toast.error('Failed: ' + e.message); }
                });
                return btn;
            };

            div.appendChild(makeBtn('chevron_left', minUs));
            div.appendChild(makeBtn('home',         center));
            div.appendChild(makeBtn('chevron_right', maxUs));
            return div;
        }

        function auxRelayTypeRow(ns, isMomentary) {
            const slot = auxNsToSlot(ns);
            const id = `aux-${ns}-momentary`;
            const row = document.createElement('div');
            row.className = 'mb-2 d-flex justify-content-between align-items-center';
            row.innerHTML = `
                <small class="text-muted">Momentary (hold to activate)</small>
                <div class="form-check form-switch m-0">
                    <input class="form-check-input" type="checkbox" id="${id}" ${isMomentary ? 'checked' : ''} ${isBleConnected() ? '' : 'disabled'}>
                </div>`;
            row.querySelector(`#${id}`).addEventListener('change', async function () {
                if (!isBleConnected()) return;
                try {
                    await bleManager.writeValue(auxServoKey(slot, 'momentary'), this.checked ? 1 : 0);
                    // Re-render relay control area
                    const cfg = await bleManager.readConfigScoped('settings');
                    if (cfg.servo_registry) {
                        servoRegistry = cfg.servo_registry;
                        renderAuxServoRegistry(servoRegistry);
                    }
                } catch (e) { toast.error('Save failed: ' + e.message); }
            });
            return row;
        }

        function auxRelayControl(ns, currentState, isMomentary) {
            const div = document.createElement('div');
            div.className = 'mt-2';

            if (isMomentary) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn btn-gold w-100';
                btn.style.cssText = 'font-size:1rem;padding:14px;';
                btn.textContent = 'Hold to Activate';
                btn.disabled = !isBleConnected();
                const send = async (v) => {
                    if (!isBleConnected()) return;
                    try { await bleManager.sendSystemCommand('aux_relay', { namespace: ns, state: v }); }
                    catch (e) { /* silent */ }
                };
                btn.addEventListener('pointerdown', () => send(1));
                btn.addEventListener('pointerup',   () => send(0));
                btn.addEventListener('pointerleave',() => send(0));
                div.appendChild(btn);
            } else {
                const slot = auxNsToSlot(ns);
                const isOn = currentState === 1;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `btn w-100 ${isOn ? 'btn-danger' : 'btn-secondary'}`;
                btn.style.cssText = 'font-size:1rem;padding:14px;';
                btn.innerHTML = `<span class="material-symbols-outlined" style="vertical-align:middle;">${isOn ? 'power' : 'power_off'}</span> ${isOn ? 'ON — Tap to turn OFF' : 'OFF — Tap to turn ON'}`;
                btn.disabled = !isBleConnected();
                btn.addEventListener('click', async () => {
                    if (!isBleConnected()) return;
                    const newState = isOn ? 0 : 1;
                    try {
                        await bleManager.writeValue(auxServoKey(slot, 'state'), newState);
                        const cfg = await bleManager.readConfigScoped('settings');
                        if (cfg.servo_registry) {
                            servoRegistry = cfg.servo_registry;
                            renderAuxServoRegistry(servoRegistry);
                        }
                    } catch (e) { toast.error('Failed: ' + e.message); }
                });
                div.appendChild(btn);
            }
            return div;
        }

        async function addAuxServoFlow() {
            if (!isBleConnected()) { toast.warning('Connect via Bluetooth to add aux servos'); return; }
            if (servoRegistry && servoRegistry.aux_count >= MAX_AUX_SERVOS) {
                toast.error('Maximum of 10 aux servos reached.');
                return;
            }

            // Step 1: get label + type via dialog
            const result = await showAddAuxServoDialog();
            if (!result) return;

            try {
                await bleManager.sendSystemCommand('add_aux_servo', {
                    type:  result.type,
                    label: result.label
                });
                // Re-fetch config to get the new servo in the registry
                const cfg = await bleManager.readConfigScoped('settings');
                bleManager.lastKnownSavedState = mergeConfigSnapshots(bleManager.lastKnownSavedState, cfg);
                if (cfg.servo_registry) {
                    servoRegistry = cfg.servo_registry;
                    renderAuxServoRegistry(servoRegistry);
                }
                toast.success(`Aux servo "${result.label}" added`);
            } catch (e) {
                toast.error('Failed to add aux servo: ' + e.message);
            }
        }

        function showAddAuxServoDialog() {
            return new Promise(resolve => {
                const existing = document.getElementById('add-aux-overlay');
                if (existing) existing.remove();
                const overlay = document.createElement('div');
                overlay.id = 'add-aux-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
                overlay.innerHTML = `
                  <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
                    <h5 style="margin:0 0 16px;">Add Aux Servo</h5>
                    <div class="mb-3">
                      <label style="font-size:0.875rem;color:#aaa;display:block;margin-bottom:6px;">Label (max 20 chars)</label>
                      <input id="aas-label" type="text" maxlength="20" placeholder="e.g. Winch"
                             style="width:100%;padding:10px;border-radius:8px;border:1px solid #555;background:#2a2a2a;color:#fff;box-sizing:border-box;">
                    </div>
                    <div class="mb-4">
                      <label style="font-size:0.875rem;color:#aaa;display:block;margin-bottom:6px;">Type</label>
                      <select id="aas-type" style="width:100%;padding:10px;border-radius:8px;border:1px solid #555;background:#2a2a2a;color:#fff;box-sizing:border-box;">
                        <option value="positional">Positional (angle & hold)</option>
                        <option value="continuous">Continuous (motor / winch)</option>
                        <option value="pan">Pan (camera / arm)</option>
                        <option value="relay">Relay (digital on/off)</option>
                      </select>
                    </div>
                    <div style="display:flex;gap:8px;">
                      <button id="aas-add"    style="flex:1;padding:10px;border:none;border-radius:8px;background:#c8a800;color:#000;font-weight:600;cursor:pointer;">Add</button>
                      <button id="aas-cancel" style="flex:1;padding:10px;border:none;border-radius:8px;background:#333;color:#aaa;border:1px solid #555;cursor:pointer;">Cancel</button>
                    </div>
                  </div>`;
                document.body.appendChild(overlay);
                overlay.querySelector('#aas-add').onclick = () => {
                    const label = overlay.querySelector('#aas-label').value.trim().substring(0, 20);
                    const type  = overlay.querySelector('#aas-type').value;
                    overlay.remove();
                    resolve({ label: label || 'Aux Servo', type });
                };
                overlay.querySelector('#aas-cancel').onclick = () => { overlay.remove(); resolve(null); };
                overlay.querySelector('#aas-label').addEventListener('keydown', e => {
                    if (e.key === 'Enter') overlay.querySelector('#aas-add').click();
                    if (e.key === 'Escape') overlay.querySelector('#aas-cancel').click();
                });
                overlay.querySelector('#aas-label').focus();
            });
        }

        async function confirmRemoveAuxServo(ns) {
            if (!isBleConnected()) { toast.warning('Connect via Bluetooth to remove aux servos'); return; }
            const aux = servoRegistry?.aux_servos?.find(a => a.ns === ns);
            const name = aux ? aux.label : ns;

            const confirmed = await new Promise(resolve => {
                const existing = document.getElementById('remove-aux-overlay');
                if (existing) existing.remove();
                const overlay = document.createElement('div');
                overlay.id = 'remove-aux-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
                overlay.innerHTML = `
                  <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
                    <h5 style="margin:0 0 12px;">Remove Aux Servo</h5>
                    <p style="color:#aaa;font-size:0.9rem;margin:0 0 20px;">Remove <strong style="color:#fff;">${escapeHtml(name)}</strong> (${escapeHtml(ns)})?<br>This cannot be undone.</p>
                    <div style="display:flex;gap:8px;">
                      <button id="ra-confirm" style="flex:1;padding:10px;border:none;border-radius:8px;background:#c0392b;color:#fff;font-weight:600;cursor:pointer;">Remove</button>
                      <button id="ra-cancel"  style="flex:1;padding:10px;border:none;border-radius:8px;background:#333;color:#aaa;border:1px solid #555;cursor:pointer;">Cancel</button>
                    </div>
                  </div>`;
                document.body.appendChild(overlay);
                overlay.querySelector('#ra-confirm').onclick = () => { overlay.remove(); resolve(true); };
                overlay.querySelector('#ra-cancel').onclick  = () => { overlay.remove(); resolve(false); };
            });

            if (!confirmed) return;

            try {
                await bleManager.sendSystemCommand('remove_aux_servo', { namespace: ns });
                const cfg = await bleManager.readConfigScoped('settings');
                bleManager.lastKnownSavedState = mergeConfigSnapshots(bleManager.lastKnownSavedState, cfg);
                if (cfg.servo_registry) {
                    servoRegistry = cfg.servo_registry;
                    renderAuxServoRegistry(servoRegistry);
                }
                toast.success('Aux servo removed');
            } catch (e) {
                toast.error('Failed to remove aux servo: ' + e.message);
            }
        }

        // Expose for HTML onclick
        window.addAuxServoFlow        = addAuxServoFlow;
        window.confirmRemoveAuxServo  = confirmRemoveAuxServo;

        // ==================== Phase 3: Driving Profiles ====================

        function updateDashboardActiveProfile() {
            const el = document.getElementById('activeDrivingProfileDisplay');
            if (!el) return;
            if (!isBleConnected()) {
                el.textContent = '--';
                return;
            }
            const p = drivingProfiles.find(x => x.index === activeDrivingProfileIndex);
            el.textContent = p ? p.name : '--';
        }

        function populateDrivingProfileSelector(profiles, activeIndex) {
            const container = document.getElementById('drvProfileList');
            if (!container) return;
            container.innerHTML = '';

            const kvReady = !!(bleManager && bleManager.supportsKvUpdates);
            if (!kvReady) {
                const msg = document.createElement('div');
                msg.className = 'text-muted text-center py-2';
                msg.style.fontSize = '0.875rem';
                msg.textContent = 'Driving profiles require firmware 2.0.0 or newer';
                container.appendChild(msg);
                const saveBtnLegacy = document.getElementById('saveNewProfileBtn');
                if (saveBtnLegacy) saveBtnLegacy.disabled = true;
                return;
            }

            if (!profiles || profiles.length === 0) {
                const msg = document.createElement('div');
                msg.className = 'text-muted text-center py-2';
                msg.style.fontSize = '0.875rem';
                msg.textContent = 'No profiles saved yet';
                container.appendChild(msg);
                return;
            }

            profiles.forEach(p => {
                const row = document.createElement('div');
                row.className = 'drv-profile-item d-flex align-items-center justify-content-between px-2 py-1';
                row.dataset.profileIndex = p.index;
                if (p.index === activeIndex) {
                    row.style.cssText = 'background:rgba(200,168,0,0.15);border-radius:6px;border:1px solid #c8a800;';
                }

                const nameBtn = document.createElement('button');
                nameBtn.type = 'button';
                nameBtn.className = 'btn btn-link p-0 text-start text-decoration-none flex-grow-1';
                nameBtn.style.cssText = 'color:' + (p.index === activeIndex ? '#c8a800' : '#fff') + ';font-size:0.9rem;';
                nameBtn.textContent = p.name;
                nameBtn.addEventListener('click', () => selectDrivingProfile(p.index));

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'btn btn-link p-0 ms-2';
                delBtn.style.cssText = 'color:#888;font-size:1rem;';
                delBtn.title = 'Delete profile';
                delBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1.1rem;vertical-align:middle;">delete</span>';
                delBtn.addEventListener('click', () => confirmDeleteDrivingProfile(p.index));

                row.appendChild(nameBtn);
                row.appendChild(delBtn);
                container.appendChild(row);
            });

            // Enable/disable "Save as New" button
            const saveBtn = document.getElementById('saveNewProfileBtn');
            if (saveBtn) saveBtn.disabled = !isBleConnected();
        }

        async function selectDrivingProfile(index) {
            if (!(bleManager && bleManager.supportsKvUpdates)) {
                toast.warning('Driving profiles require firmware 2.0.0 or newer');
                return;
            }
            if (!isBleConnected()) {
                toast.warning('Connect via Bluetooth to switch profiles');
                return;
            }
            try {
                await bleManager.sendSystemCommand('load_drv_profile', { index });
                activeDrivingProfileIndex = index;
                // Re-fetch config from device so all UI reflects the loaded profile
                const config = await bleManager.readConfigScoped('tuning');
                bleManager.lastKnownSavedState = mergeConfigSnapshots(bleManager.lastKnownSavedState, config);
                isLoadingTuningConfig = true;
                updateTuningSliders(config);
                updateServoSliders(config);
                isLoadingTuningConfig = false;
                clearPageDirty('tuning');
                clearPageDirty('servo');
                clearPageDirty('system');
                populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex);
                updateDashboardActiveProfile();
                toast.success('Profile loaded');
            } catch (e) {
                toast.error('Failed to load profile: ' + e.message);
            }
        }

        function showProfileNameDialog(existingName = '') {
            return new Promise(resolve => {
                const existing = document.getElementById('profile-name-overlay');
                if (existing) existing.remove();
                const overlay = document.createElement('div');
                overlay.id = 'profile-name-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
                overlay.innerHTML = `
                  <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
                    <h5 style="margin:0 0 12px;color:#fff;">Save Driving Profile</h5>
                    <p style="margin:0 0 12px;color:#aaa;font-size:0.875rem;">Enter a name for this profile (max 20 characters).</p>
                    <input id="pnd-name" type="text" maxlength="20" placeholder="e.g. Rock Crawl"
                           style="width:100%;padding:10px;border-radius:8px;border:1px solid #555;background:#2a2a2a;color:#fff;margin-bottom:16px;box-sizing:border-box;"
                           value="${existingName.replace(/"/g, '&quot;')}">
                    <div style="display:flex;gap:8px;">
                      <button id="pnd-save"   style="flex:1;padding:10px;border:none;border-radius:8px;background:#c8a800;color:#000;font-weight:600;cursor:pointer;">Save</button>
                      <button id="pnd-cancel" style="flex:1;padding:10px;border:none;border-radius:8px;background:#333;color:#aaa;border:1px solid #555;cursor:pointer;">Cancel</button>
                    </div>
                  </div>`;
                document.body.appendChild(overlay);
                const input = overlay.querySelector('#pnd-name');
                input.focus();
                const doSave = () => {
                    const name = input.value.trim().substring(0, 20);
                    overlay.remove();
                    resolve(name || null);
                };
                overlay.querySelector('#pnd-save').onclick = doSave;
                overlay.querySelector('#pnd-cancel').onclick = () => { overlay.remove(); resolve(null); };
                input.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') { overlay.remove(); resolve(null); } });
            });
        }

        function showProfileOverwriteDialog(profiles) {
            return new Promise(resolve => {
                const existing = document.getElementById('profile-overwrite-overlay');
                if (existing) existing.remove();
                const overlay = document.createElement('div');
                overlay.id = 'profile-overwrite-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';

                let listHtml = profiles.map(p =>
                    `<button class="po-slot" data-idx="${p.index}" style="display:block;width:100%;text-align:left;padding:10px 12px;margin-bottom:6px;border:1px solid #444;border-radius:8px;background:#2a2a2a;color:#fff;cursor:pointer;">
                       <strong>${p.name}</strong> <span style="color:#888;font-size:0.8rem;">(slot ${p.index})</span>
                     </button>`
                ).join('');

                overlay.innerHTML = `
                  <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:360px;width:100%;color:#fff;max-height:80vh;overflow-y:auto;">
                    <h5 style="margin:0 0 8px;color:#fff;">All Profile Slots Full</h5>
                    <p style="margin:0 0 16px;color:#aaa;font-size:0.875rem;">Choose an existing profile to overwrite:</p>
                    ${listHtml}
                    <button id="po-cancel" style="width:100%;padding:10px;border:none;border-radius:8px;background:#333;color:#aaa;border:1px solid #555;cursor:pointer;margin-top:4px;">Cancel</button>
                  </div>`;
                document.body.appendChild(overlay);
                overlay.querySelectorAll('.po-slot').forEach(btn => {
                    btn.onclick = () => { overlay.remove(); resolve(parseInt(btn.dataset.idx)); };
                });
                overlay.querySelector('#po-cancel').onclick = () => { overlay.remove(); resolve(null); };
            });
        }

        async function saveAsNewDrivingProfile() {
            if (!(bleManager && bleManager.supportsKvUpdates)) {
                toast.warning('Driving profiles require firmware 2.0.0 or newer');
                return;
            }
            if (!isBleConnected()) {
                toast.warning('Connect via Bluetooth to save profiles');
                return;
            }

            let targetSlot;
            let profileName;

            if (drivingProfiles.length >= MAX_DRIVING_PROFILES) {
                // All 10 slots full — ask user to pick one to overwrite
                targetSlot = await showProfileOverwriteDialog(drivingProfiles);
                if (targetSlot == null) return;
                const existing = drivingProfiles.find(p => p.index === targetSlot);
                profileName = await showProfileNameDialog(existing ? existing.name : '');
            } else {
                profileName = await showProfileNameDialog();
                if (!profileName) return;
                // Find next free slot
                const usedSlots = new Set(drivingProfiles.map(p => p.index));
                targetSlot = 0;
                while (usedSlots.has(targetSlot) && targetSlot < MAX_DRIVING_PROFILES) targetSlot++;
            }

            if (!profileName) return;

            try {
                await bleManager.sendSystemCommand('save_drv_profile', { index: targetSlot, name: profileName });
                activeDrivingProfileIndex = targetSlot;
                // Update local profiles list
                const existingIdx = drivingProfiles.findIndex(p => p.index === targetSlot);
                if (existingIdx >= 0) {
                    drivingProfiles[existingIdx].name = profileName;
                } else {
                    drivingProfiles.push({ index: targetSlot, name: profileName });
                    drivingProfiles.sort((a, b) => a.index - b.index);
                }
                populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex);
                updateDashboardActiveProfile();
                toast.success('Profile "' + profileName + '" saved');
            } catch (e) {
                toast.error('Failed to save profile: ' + e.message);
            }
        }

        async function confirmDeleteDrivingProfile(index) {
            if (!(bleManager && bleManager.supportsKvUpdates)) {
                toast.warning('Driving profiles require firmware 2.0.0 or newer');
                return;
            }
            const profile = drivingProfiles.find(p => p.index === index);
            if (!profile) return;

            if (drivingProfiles.length <= 1) {
                toast.warning('Cannot delete the last remaining profile.');
                return;
            }

            if (!isBleConnected()) {
                toast.warning('Connect via Bluetooth to delete profiles');
                return;
            }

            // Confirm dialog
            const confirmed = await new Promise(resolve => {
                const existing = document.getElementById('profile-delete-overlay');
                if (existing) existing.remove();
                const overlay = document.createElement('div');
                overlay.id = 'profile-delete-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
                overlay.innerHTML = `
                  <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
                    <h5 style="margin:0 0 12px;color:#fff;">Delete Profile</h5>
                    <p style="margin:0 0 20px;color:#aaa;font-size:0.9rem;">Delete profile <strong style="color:#fff;">${profile.name.replace(/</g, '&lt;')}</strong>?<br>This cannot be undone.</p>
                    <div style="display:flex;gap:8px;">
                      <button id="pd-delete" style="flex:1;padding:10px;border:none;border-radius:8px;background:#c0392b;color:#fff;font-weight:600;cursor:pointer;">Delete</button>
                      <button id="pd-cancel" style="flex:1;padding:10px;border:none;border-radius:8px;background:#333;color:#aaa;border:1px solid #555;cursor:pointer;">Cancel</button>
                    </div>
                  </div>`;
                document.body.appendChild(overlay);
                overlay.querySelector('#pd-delete').onclick = () => { overlay.remove(); resolve(true); };
                overlay.querySelector('#pd-cancel').onclick = () => { overlay.remove(); resolve(false); };
            });

            if (!confirmed) return;

            try {
                await bleManager.sendSystemCommand('delete_drv_profile', { index });
                drivingProfiles = drivingProfiles.filter(p => p.index !== index);
                if (activeDrivingProfileIndex === index && drivingProfiles.length > 0) {
                    activeDrivingProfileIndex = drivingProfiles[0].index;
                }
                populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex);
                updateDashboardActiveProfile();
                toast.success('Profile deleted');
            } catch (e) {
                toast.error('Failed to delete profile: ' + e.message);
            }
        }

        // Expose profile functions for HTML onclick / dev console
        window.selectDrivingProfile   = selectDrivingProfile;
        window.saveAsNewDrivingProfile = saveAsNewDrivingProfile;
        window.confirmDeleteDrivingProfile = confirmDeleteDrivingProfile;

        const MAX_DRIVING_PROFILES = 10;

        // ==================== Config Fetching ====================
        let hasShownInitialConfigToast = false;

        async function fetchConfigFromESP32(showToast = true, options = {}) {
            if (typeof showToast === 'object' && showToast !== null) {
                options = showToast;
                showToast = true;
            }

            const scope = options.scope || 'all';
            const applyNoVehiclePlaceholders = () => {
                hasLoadedConfigFromDevice = false;
                fullConfig = null;

                const placeholderMap = {
                    reactionSpeedBadge: '--',
                    rideHeightDisplay: '--',
                    dampingDisplay: '--',
                    stiffnessDisplay: '--',
                    frontRearBalanceDisplay: '--',
                    activeVehicleDisplay: '--',
                    activeDrivingProfileDisplay: '--',
                    activeLightingProfileDisplay: '--'
                };

                Object.entries(placeholderMap).forEach(([id, value]) => {
                    const el = document.getElementById(id);
                    if (el) el.textContent = value;
                });

                ['servoFLTrimDisplay', 'servoFRTrimDisplay', 'servoRLTrimDisplay', 'servoRRTrimDisplay'].forEach((id) => {
                    const el = document.getElementById(id);
                    if (el) el.textContent = '--';
                });
            };

            const applyLoadedConfig = (data) => {
                fullConfig = mergeConfigSnapshots(fullConfig, data);
                hasLoadedConfigFromDevice = true;

                // Update suspension settings display
                updateSuspensionSettings(data);

                // Load settings into Settings page
                loadSettingsFromConfig(data);

                // Update tuning sliders from config data
                updateTuningSliders(data);

                // Update servo sliders from config data
                updateServoSliders(data);

                // Phase 3: Update driving profile selector
                if (Array.isArray(data.drv_profiles)) {
                    drivingProfiles = data.drv_profiles;
                    activeDrivingProfileIndex = (data.act_drv_prof != null) ? data.act_drv_prof : 0;
                    populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex);
                    updateDashboardActiveProfile();
                }

                // Phase 4: Update servo registry
                if (data.servo_registry) {
                    servoRegistry = data.servo_registry;
                    renderReservedServoLabels(data);
                    renderAuxServoRegistry(servoRegistry);
                    const addBtn = document.getElementById('addAuxServoBtn');
                    if (addBtn) addBtn.disabled = (servoRegistry.aux_count >= MAX_AUX_SERVOS) || !isBleConnected();
                }

                // Phase 5: Lighting profile list + active profile hydration
                if (Array.isArray(data.lt_profiles)) {
                    lightingProfiles = data.lt_profiles;
                }
                if (data.act_lt_prof != null) {
                    activeLightingProfileIndex = Number(data.act_lt_prof);
                }
                if (data.active_lt_profile) {
                    hydrateLightGroupsFromActiveProfile(data.active_lt_profile);
                }
                populateLightingProfileSelector();

                if (data.warnings && data.warnings.servoTrimReset) {
                    const warningMessage = data.warnings.message
                        || 'Unexpected servo trim value was reset to 0. Check settings before driving.';
                    toast.warning(warningMessage, { duration: 10000 });
                }

                // Display config data in the Config Data card (Settings page)
                const configData = document.getElementById('configData');
                if (configData) configData.textContent = JSON.stringify(data, null, 2);

                // Display tuning data in the Tuning Configuration Data card (Tuning page)
                const tuningConfigData = document.getElementById('tuningConfigData');
                if (tuningConfigData) tuningConfigData.textContent = JSON.stringify(data, null, 2);

                if (scope === 'bootstrap') {
                    // Defer full tab hydration until the user opens a section.
                    if (data.act_drv_prof != null) {
                        activeDrivingProfileIndex = data.act_drv_prof;
                        updateDashboardActiveProfile();
                    }
                    if (data.act_lt_prof != null) {
                        activeLightingProfileIndex = Number(data.act_lt_prof);
                        updateDashboardActiveLightingProfile();
                    }
                }

                if (showToast && !hasShownInitialConfigToast && scope === 'bootstrap') {
                    toast.success('Configuration loaded from RCDCC module (Bluetooth LE)');
                    hasShownInitialConfigToast = true;
                }

                finishInitialCardLoading('config-loaded');
            };

            if (!isBleConnected()) {
                applyNoVehiclePlaceholders();
                const configData = document.getElementById('configData');
                if (configData) configData.textContent = 'Bluetooth LE not connected';
                const tuningConfigData = document.getElementById('tuningConfigData');
                if (tuningConfigData) tuningConfigData.textContent = 'Bluetooth LE not connected';
                if (showToast) {
                    toast.warning('Select a vehicle to begin.');
                }
                // Keep cards usable while disconnected: only the initial load should be masked.
                finishInitialCardLoading('ble-not-connected');
                return;
            }

            try {
                communicationMode = 'ble';
                const previousSavedState = bleManager?.lastKnownSavedState
                    ? JSON.parse(JSON.stringify(bleManager.lastKnownSavedState))
                    : null;
                const scopeMap = {
                    bootstrap: 'bootstrap',
                    tuning: 'tuning',
                    lights: 'lights',
                    settings: 'settings'
                };
                const requestedScope = scopeMap[scope] || 'bootstrap';
                const bleData = (typeof bleManager.readConfigScoped === 'function')
                    ? await bleManager.readConfigScoped(requestedScope)
                    : await bleManager.readConfig();
                let shouldClearDirtyOnSuccess = true;

                const canEvaluateDirtyState = requestedScope === 'bootstrap';
                const dirtyAndDifferent = canEvaluateDirtyState
                    && hasAnyDirtyPages()
                    && previousSavedState
                    && !configsEqual(bleData, previousSavedState);

                if (dirtyAndDifferent) {
                    const shouldReapply = confirm('The truck rebooted. Re-apply unsaved changes?');
                    if (shouldReapply) {
                        await reapplyDirtyPagesToDevice();
                        const refreshed = (typeof bleManager.readConfigScoped === 'function')
                            ? await bleManager.readConfigScoped(requestedScope)
                            : await bleManager.readConfig();
                        applyLoadedConfig(refreshed);
                        bleManager.lastKnownSavedState = mergeConfigSnapshots(bleManager.lastKnownSavedState, refreshed);
                        shouldClearDirtyOnSuccess = false;
                    } else {
                        applyLoadedConfig(bleData);
                        clearAllDirtyPages();
                        bleManager.lastKnownSavedState = mergeConfigSnapshots(bleManager.lastKnownSavedState, bleData);
                    }
                } else {
                    applyLoadedConfig(bleData);
                    bleManager.lastKnownSavedState = mergeConfigSnapshots(bleManager.lastKnownSavedState, bleData);
                }
                if (shouldClearDirtyOnSuccess) {
                    clearAllDirtyPages();
                }
                applyFeatureAvailabilityGate();
                updateDashboardVehicleName(getGarageVehicleNameById(bleManager?.deviceId));
            } catch (error) {
                console.error('Failed to fetch config:', error);
                const configData = document.getElementById('configData');
                if (configData) configData.textContent = `Error: ${error.message}`;
                const tuningConfigData = document.getElementById('tuningConfigData');
                if (tuningConfigData) tuningConfigData.textContent = `Error: ${error.message}`;
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

            // Phase 2: helper to emit a single KV write for a tuning param (v2+) or fall back to legacy save
            function tuningKvWrite(key, value, sliderName, legacyVal) {
                const canUseKv = !!(bleManager && typeof bleManager.writeValue === 'function' && bleManager.supportsKvUpdates);
                if (canUseKv) {
                    bleManager.writeValue(key, value).catch(e => console.error('KV write failed (' + sliderName + '):', e));
                } else {
                    saveTuningSliderValue(sliderName, legacyVal);
                }
            }

            const tuningSliderPendingSave = {
                rideHeight: false,
                damping: false,
                stiffness: false,
                reactionSpeed: false,
                balance: false,
                sensorRate: false
            };

            function commitTuningSliderSave(sliderKey) {
                if (!tuningSliderPendingSave[sliderKey]) return;
                tuningSliderPendingSave[sliderKey] = false;

                if (tuningSliderLocks[sliderKey]) return;

                const canUseKv = !!(bleManager && typeof bleManager.writeValue === 'function' && bleManager.supportsKvUpdates);
                const k = window.RCDCC_KEYS;

                if (sliderKey === 'rideHeight') {
                    const val = Math.round(tuningSliderValues.rideHeightOffset || 0);
                    if (canUseKv) {
                        bleManager.writeValue(k.SERVO_FL_RIDE_HT, val).catch(e => console.error('KV write rideHeight FL:', e));
                        bleManager.writeValue(k.SERVO_FR_RIDE_HT, val).catch(e => console.error('KV write rideHeight FR:', e));
                        bleManager.writeValue(k.SERVO_RL_RIDE_HT, val).catch(e => console.error('KV write rideHeight RL:', e));
                        bleManager.writeValue(k.SERVO_RR_RIDE_HT, val).catch(e => console.error('KV write rideHeight RR:', e));
                    } else {
                        saveTuningSliderValue('rideHeight', tuningSliderValues.rideHeightOffset);
                    }
                    return;
                }

                if (sliderKey === 'damping') {
                    tuningKvWrite(k.SUSPENSION_DAMPING, Math.round((tuningSliderValues.damping || 0) * 100), 'damping', tuningSliderValues.damping);
                    return;
                }

                if (sliderKey === 'stiffness') {
                    tuningKvWrite(k.SUSPENSION_STIFFNESS, Math.round((tuningSliderValues.stiffness || 0) * 50), 'stiffness', tuningSliderValues.stiffness);
                    return;
                }

                if (sliderKey === 'reactionSpeed') {
                    tuningKvWrite(k.SUSPENSION_REACT_SPD, Math.round((tuningSliderValues.reactionSpeed || 0) * 50), 'reactionSpeed', tuningSliderValues.reactionSpeed);
                    return;
                }

                if (sliderKey === 'balance') {
                    const mapped = Math.round(((tuningSliderValues.frontRearBalance || 0) / 100) * 200 - 100);
                    tuningKvWrite(k.SUSPENSION_FR_BAL, mapped, 'balance', tuningSliderValues.frontRearBalance);
                    return;
                }

                if (sliderKey === 'sensorRate') {
                    saveTuningSliderValue('sensorRate', tuningSliderValues.sampleRate);
                }
            }

            function attachReleaseSaveHandler(sliderElement, sliderKey) {
                if (!sliderElement || sliderElement.dataset.saveOnReleaseBound === 'true') return;
                sliderElement.dataset.saveOnReleaseBound = 'true';

                const onRelease = () => commitTuningSliderSave(sliderKey);
                sliderElement.addEventListener('pointerup', onRelease);
                sliderElement.addEventListener('pointercancel', onRelease);
                sliderElement.addEventListener('touchend', onRelease);
                sliderElement.addEventListener('mouseup', onRelease);
                sliderElement.addEventListener('keyup', onRelease);
            }

            function flushPendingTuningSaves() {
                Object.keys(tuningSliderPendingSave).forEach(commitTuningSliderSave);
            }

            if (!window.__tuningReleaseFlushBound) {
                window.__tuningReleaseFlushBound = true;
                ['pointerup', 'pointercancel', 'touchend', 'mouseup', 'keyup'].forEach((eventName) => {
                    document.addEventListener(eventName, flushPendingTuningSaves, true);
                });
                window.addEventListener('pagehide', flushPendingTuningSaves);
                document.addEventListener('visibilitychange', () => {
                    if (document.hidden) flushPendingTuningSaves();
                });
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
                        markPageDirty('tuning');
                        tuningSliderPendingSave.rideHeight = true;
                    }
                }
            });
            tuningSliderInstances.rideHeight = { element: rideHeightElement, instance: rideHeightInstance };
            updateTuningThumbLabel('sliderRideHeight', 50, 0);
            attachReleaseSaveHandler(rideHeightElement, 'rideHeight');

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
                    tuningSliderValues.damping = value[1];
                    updateTuningThumbLabel('sliderDamping', value[1], 1);
                    if (!isLoadingTuningConfig) {
                        markPageDirty('tuning');
                        tuningSliderPendingSave.damping = true;
                    }
                }
            });
            tuningSliderInstances.damping = { element: dampingElement, instance: dampingInstance };
            updateTuningThumbLabel('sliderDamping', 0.8, 1);
            attachReleaseSaveHandler(dampingElement, 'damping');

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
                        markPageDirty('tuning');
                        tuningSliderPendingSave.stiffness = true;
                    }
                }
            });
            tuningSliderInstances.stiffness = { element: stiffnessElement, instance: stiffnessInstance };
            updateTuningThumbLabel('sliderStiffness', 1.0, 1);
            attachReleaseSaveHandler(stiffnessElement, 'stiffness');

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
                        markPageDirty('tuning');
                        tuningSliderPendingSave.reactionSpeed = true;
                    }
                }
            });
            tuningSliderInstances.reactionSpeed = { element: reactionElement, instance: reactionInstance };
            updateTuningThumbLabel('sliderReactionSpeed', 1.0, 1);
            attachReleaseSaveHandler(reactionElement, 'reactionSpeed');

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
                        markPageDirty('tuning');
                        tuningSliderPendingSave.balance = true;
                    }
                }
            });
            tuningSliderInstances.balance = { element: balanceElement, instance: balanceInstance };
            updateTuningThumbLabel('sliderBalance', 50, 0);
            attachReleaseSaveHandler(balanceElement, 'balance');

            // Initialize Sensor Refresh Rate - Horizontal slider (5-50 Hz)
            // Note: sampleRate has no RCDCC_KEY; always uses legacy path on connected devices.
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
                        markPageDirty('tuning');
                        tuningSliderPendingSave.sensorRate = true;
                    }
                }
            });
            tuningSliderInstances.sensorRate = { element: sensorElement, instance: sensorInstance };
            updateTuningThumbLabel('sliderSensorRate', 25, 0);
            attachReleaseSaveHandler(sensorElement, 'sensorRate');
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
            frontLeft: { rangeElement: null, trimElement: null, rangeInstance: null, trimInstance: null, lastRangeValue: [10, 170], lastTrimValue: 0 },
            frontRight: { rangeElement: null, trimElement: null, rangeInstance: null, trimInstance: null, lastRangeValue: [10, 170], lastTrimValue: 0 },
            rearLeft: { rangeElement: null, trimElement: null, rangeInstance: null, trimInstance: null, lastRangeValue: [10, 170], lastTrimValue: 0 },
            rearRight: { rangeElement: null, trimElement: null, rangeInstance: null, trimInstance: null, lastRangeValue: [10, 170], lastTrimValue: 0 }
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

            // Degree → microsecond conversions (matching pushConfigPayload Phase 1 logic)
            const degToUs     = (d) => 1000 + Math.round((Number(d) || 0) / 180 * 1000);
            const trimDegToUs = (d) => 1500 + Math.round((Number(d) || 0) * (1000 / 180));

            // Phase 2: KV write helper for servo params with firmware gate
            function servoKvWrite(kvKey, kvValue, legacyServoName, legacyParam, legacyValue) {
                const canUseKv = !!(bleManager && typeof bleManager.writeValue === 'function' && bleManager.supportsKvUpdates);
                if (canUseKv) {
                    markPageDirty('servo');
                    bleManager.writeValue(kvKey, kvValue).catch(e => console.error('KV write servo failed:', e));
                } else {
                    saveServoParameter(legacyServoName, legacyParam, legacyValue);
                }
            }

            const servoPendingSave = {
                frontLeft: { range: false, trim: false },
                frontRight: { range: false, trim: false },
                rearLeft: { range: false, trim: false },
                rearRight: { range: false, trim: false }
            };

            function commitServoSliderSave(servoName, sliderType) {
                if (!servoPendingSave[servoName] || !servoPendingSave[servoName][sliderType]) return;
                servoPendingSave[servoName][sliderType] = false;

                if (sliderType === 'range' && servoRangeLocked) return;
                if (sliderType === 'trim' && servoTrimLocked) return;

                const sliderData = servoSliderInstances[servoName];
                const values = servoSliderValues[servoName];
                if (!sliderData || !values) return;

                if (sliderType === 'range') {
                    const nextRange = [Math.round(values.min), Math.round(values.max)];
                    const lastRange = sliderData.lastRangeValue || [10, 170];
                    if (nextRange[0] === lastRange[0] && nextRange[1] === lastRange[1]) return;

                    const keyMap = {
                        frontLeft: [window.RCDCC_KEYS.SERVO_FL_MIN, window.RCDCC_KEYS.SERVO_FL_MAX],
                        frontRight: [window.RCDCC_KEYS.SERVO_FR_MIN, window.RCDCC_KEYS.SERVO_FR_MAX],
                        rearLeft: [window.RCDCC_KEYS.SERVO_RL_MIN, window.RCDCC_KEYS.SERVO_RL_MAX],
                        rearRight: [window.RCDCC_KEYS.SERVO_RR_MIN, window.RCDCC_KEYS.SERVO_RR_MAX]
                    };
                    const canUseKv = !!(bleManager && typeof bleManager.writeValue === 'function' && bleManager.supportsKvUpdates);
                    if (canUseKv) {
                        markPageDirty('servo');
                        bleManager.writeValue(keyMap[servoName][0], degToUs(nextRange[0])).catch(e => console.error(`KV ${servoName} min:`, e));
                        bleManager.writeValue(keyMap[servoName][1], degToUs(nextRange[1])).catch(e => console.error(`KV ${servoName} max:`, e));
                    } else {
                        saveServoRange(servoName, nextRange[0], nextRange[1]);
                    }
                    sliderData.lastRangeValue = nextRange;
                    return;
                }

                const trimValue = Math.round(values.trim);
                if (trimValue === sliderData.lastTrimValue) return;

                const trimKeyMap = {
                    frontLeft: window.RCDCC_KEYS.SERVO_FL_TRIM,
                    frontRight: window.RCDCC_KEYS.SERVO_FR_TRIM,
                    rearLeft: window.RCDCC_KEYS.SERVO_RL_TRIM,
                    rearRight: window.RCDCC_KEYS.SERVO_RR_TRIM
                };
                servoKvWrite(trimKeyMap[servoName], trimDegToUs(trimValue), servoName, 'trim', trimValue);
                sliderData.lastTrimValue = trimValue;
            }

            function attachServoReleaseSaveHandler(sliderElement, servoName, sliderType) {
                if (!sliderElement) return;
                const flag = `saveOnRelease${servoName}${sliderType}`;
                if (sliderElement.dataset[flag] === 'true') return;
                sliderElement.dataset[flag] = 'true';

                const onRelease = () => commitServoSliderSave(servoName, sliderType);
                sliderElement.addEventListener('pointerup', onRelease);
                sliderElement.addEventListener('pointercancel', onRelease);
                sliderElement.addEventListener('touchend', onRelease);
                sliderElement.addEventListener('mouseup', onRelease);
                sliderElement.addEventListener('keyup', onRelease);
            }

            function flushPendingServoSaves() {
                Object.entries(servoPendingSave).forEach(([servoName, pending]) => {
                    if (pending.range) commitServoSliderSave(servoName, 'range');
                    if (pending.trim) commitServoSliderSave(servoName, 'trim');
                });
            }

            if (!window.__servoReleaseFlushBound) {
                window.__servoReleaseFlushBound = true;
                ['pointerup', 'pointercancel', 'touchend', 'mouseup', 'keyup'].forEach((eventName) => {
                    document.addEventListener(eventName, flushPendingServoSaves, true);
                });
                window.addEventListener('pagehide', flushPendingServoSaves);
                document.addEventListener('visibilitychange', () => {
                    if (document.hidden) flushPendingServoSaves();
                });
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
                        if (!isLoadingTuningConfig && !servoRangeLocked) {
                            servoSliderValues.frontLeft.min = Math.round(value[0]);
                            servoSliderValues.frontLeft.max = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.frontLeft.range = true;
                        }
                    }
                });
                servoSliderInstances.frontLeft.rangeElement = frontLeftElement;
                servoSliderInstances.frontLeft.rangeInstance = frontLeftInstance;
                updateThumbLabels('sliderFrontLeft', [defaultMin, defaultMax]);
                attachServoReleaseSaveHandler(frontLeftElement, 'frontLeft', 'range');
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
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            servoSliderValues.frontLeft.trim = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.frontLeft.trim = true;
                        }
                    }
                });
                servoSliderInstances.frontLeft.trimElement = frontLeftTrimElement;
                servoSliderInstances.frontLeft.trimInstance = frontLeftTrimInstance;
                updateTrimThumbLabel('sliderFrontLeftTrim', 0);
                attachServoReleaseSaveHandler(frontLeftTrimElement, 'frontLeft', 'trim');
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
                        if (!isLoadingTuningConfig && !servoRangeLocked) {
                            servoSliderValues.frontRight.min = Math.round(value[0]);
                            servoSliderValues.frontRight.max = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.frontRight.range = true;
                        }
                    }
                });
                servoSliderInstances.frontRight.rangeElement = frontRightElement;
                servoSliderInstances.frontRight.rangeInstance = frontRightInstance;
                updateThumbLabels('sliderFrontRight', [defaultMin, defaultMax]);
                attachServoReleaseSaveHandler(frontRightElement, 'frontRight', 'range');
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
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            servoSliderValues.frontRight.trim = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.frontRight.trim = true;
                        }
                    }
                });
                servoSliderInstances.frontRight.trimElement = frontRightTrimElement;
                servoSliderInstances.frontRight.trimInstance = frontRightTrimInstance;
                updateTrimThumbLabel('sliderFrontRightTrim', 0);
                attachServoReleaseSaveHandler(frontRightTrimElement, 'frontRight', 'trim');
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
                        if (!isLoadingTuningConfig && !servoRangeLocked) {
                            servoSliderValues.rearLeft.min = Math.round(value[0]);
                            servoSliderValues.rearLeft.max = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.rearLeft.range = true;
                        }
                    }
                });
                servoSliderInstances.rearLeft.rangeElement = rearLeftElement;
                servoSliderInstances.rearLeft.rangeInstance = rearLeftInstance;
                updateThumbLabels('sliderRearLeft', [defaultMin, defaultMax]);
                attachServoReleaseSaveHandler(rearLeftElement, 'rearLeft', 'range');
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
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            servoSliderValues.rearLeft.trim = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.rearLeft.trim = true;
                        }
                    }
                });
                servoSliderInstances.rearLeft.trimElement = rearLeftTrimElement;
                servoSliderInstances.rearLeft.trimInstance = rearLeftTrimInstance;
                updateTrimThumbLabel('sliderRearLeftTrim', 0);
                attachServoReleaseSaveHandler(rearLeftTrimElement, 'rearLeft', 'trim');
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
                        if (!isLoadingTuningConfig && !servoRangeLocked) {
                            servoSliderValues.rearRight.min = Math.round(value[0]);
                            servoSliderValues.rearRight.max = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.rearRight.range = true;
                        }
                    }
                });
                servoSliderInstances.rearRight.rangeElement = rearRightElement;
                servoSliderInstances.rearRight.rangeInstance = rearRightInstance;
                updateThumbLabels('sliderRearRight', [defaultMin, defaultMax]);
                attachServoReleaseSaveHandler(rearRightElement, 'rearRight', 'range');
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
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            servoSliderValues.rearRight.trim = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.rearRight.trim = true;
                        }
                    }
                });
                servoSliderInstances.rearRight.trimElement = rearRightTrimElement;
                servoSliderInstances.rearRight.trimInstance = rearRightTrimInstance;
                updateTrimThumbLabel('sliderRearRightTrim', 0);
                attachServoReleaseSaveHandler(rearRightTrimElement, 'rearRight', 'trim');
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
                    sliderData.lastTrimValue = Math.round(trimValue);
                    
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
            
            syncServoSettingsLockUI(iconElement);
        }
        
        function toggleServoRotationLock(iconElement) {
            // Play click sound
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));
            
            // Toggle the lock state
            servoRotationLocked = !servoRotationLocked;
            
            // Save to localStorage
            localStorage.setItem('servoRotationLocked', servoRotationLocked.toString());
            
            syncServoSettingsLockUI(iconElement);
        }

        function syncServoSettingsLockUI(iconElement = null) {
            const card = document.getElementById('servoSettingsCard');
            const lockIcon = iconElement || document.getElementById('servoSettingsLockIcon');
            if (card) {
                card.classList.toggle('trim-locked', servoTrimLocked);
                card.classList.toggle('rotation-locked', servoRotationLocked);
            }
            if (lockIcon) {
                const allLocked = servoTrimLocked && servoRotationLocked;
                lockIcon.textContent = allLocked ? 'lock' : 'lock_open_right';
                lockIcon.style.color = allLocked ? 'var(--lime-green)' : 'var(--high-impact-color)';
                lockIcon.title = allLocked ? 'Unlock trim and direction controls' : 'Lock trim and direction controls';
            }
        }

        function toggleServoSettingsLock(iconElement) {
            // Play click sound
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));

            const nextState = !(servoTrimLocked && servoRotationLocked);
            servoTrimLocked = nextState;
            servoRotationLocked = nextState;
            localStorage.setItem('servoTrimLocked', nextState.toString());
            localStorage.setItem('servoRotationLocked', nextState.toString());
            syncServoSettingsLockUI(iconElement);
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
                const isReversed = !!(servo && servo.reversed);
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
            // Phase 2: use writeValue() for KV firmware, legacy path otherwise
            const canUseKv = !!(bleManager && typeof bleManager.writeValue === 'function' && bleManager.supportsKvUpdates);
            if (canUseKv) {
                markPageDirty('system');
                bleManager.writeValue(window.RCDCC_KEYS.IMU_ORIENT, parseInt(value))
                    .catch(e => {
                        console.error('KV write IMU_ORIENT failed:', e);
                        toast.error('Failed to update orientation');
                        const select = document.getElementById('mpuOrientation');
                        if (select && fullConfig) select.value = fullConfig.mpuOrientation;
                    });
                return;
            }
            // Legacy path (firmware < 2.0)
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

            function renderServoReverseBadge(badgeEl, isReversed) {
                if (!badgeEl) return;
                const abbrev = badgeEl.id.replace('servo', '').replace('RevBadge', '');
                const cwBtn = document.getElementById(`servo${abbrev}CwBtn`);
                const ccwBtn = document.getElementById(`servo${abbrev}CcwBtn`);

                if (cwBtn && ccwBtn) {
                    cwBtn.classList.toggle('is-active', !isReversed);
                    ccwBtn.classList.toggle('is-active', isReversed);
                    return;
                }

                // Fallback for legacy single-badge layout.
                const icon = isReversed
                    ? '<span class="material-symbols-outlined rotate-ccw">rotate_left</span>'
                    : '<span class="material-symbols-outlined rotate-cw">rotate_right</span>';
                const text = isReversed ? 'CCW' : 'CW';
                badgeEl.innerHTML = icon + text;
            }
            
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
                    badge.addEventListener('click', function(event) {
                        console.log(`Badge clicked: ${abbrev}`);
                        // Don't allow clicks if servo rotation is locked
                        if (servoRotationLocked) {
                            console.log('Servo rotation is locked, ignoring click');
                            return;
                        }
                        // Toggle the checkbox state
                        if (checkbox) {
                            const targetButton = event.target.closest('.servo-direction-btn');
                            if (targetButton) {
                                checkbox.checked = targetButton.getAttribute('data-dir') === 'ccw';
                            } else {
                                checkbox.checked = !checkbox.checked;
                            }
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
                        renderServoReverseBadge(badge, this.checked);
                        // Phase 2: use writeValue() for KV firmware, legacy path otherwise
                        const canUseKv = !!(bleManager && typeof bleManager.writeValue === 'function' && bleManager.supportsKvUpdates);
                        if (canUseKv) {
                            markPageDirty('servo');
                            bleManager.writeValue(window.RCDCC_KEYS[`SERVO_${abbrev}_REVERSE`], this.checked ? 1 : 0)
                                .catch(e => console.error(`KV write ${abbrev}_REVERSE failed:`, e));
                        } else {
                            updateServoParam(key, 'reversed', this.checked);
                        }
                    });

                    // Ensure correct icon/text are visible on initial render.
                    renderServoReverseBadge(badge, checkbox.checked);
                }
            });

            const autoCalibrateBtn = document.getElementById('servoAutoCalibrateBtn');
            if (autoCalibrateBtn && !autoCalibrateBtn.dataset.bound) {
                autoCalibrateBtn.dataset.bound = '1';
                autoCalibrateBtn.addEventListener('click', function() {
                    handleAutoLevel(autoCalibrateBtn);
                });
            }
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
        
        // Update ESP32 IP address
        function updateEsp32Ip(newIp) {
            if (!newIp || newIp.trim() === '') {
                toast.error('IP address cannot be empty');
                return;
            }
            
            // Validate IP format (basic validation)
            const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
            if (!ipPattern.test(newIp)) {
                toast.error('Invalid IP address format');
                return;
            }
            
            // Save to localStorage
            localStorage.setItem('esp32Ip', newIp);
            
            toast.success('IP address saved. Reconnecting...');
            
            // Reload to apply the new IP
            setTimeout(() => {
                location.reload();
            }, 1000);
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

        // Save and apply connection settings
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
                    saveBtn.innerHTML = '<span class="material-symbols-outlined" >cloud_upload</span> Save & Apply';
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
                        saveBtn.innerHTML = '<span class="material-symbols-outlined" >cloud_upload</span> Save & Apply';
                    }
                });
        }

        // Initialize network settings controls
        function initNetworkSettings() {
            // Load current IP into input field
            // Smart default: if on a non-ESP32 network, default to AP mode (192.168.4.1)
            // Otherwise use whatever was saved
            let currentIp = localStorage.getItem('esp32Ip');
            if (!currentIp) {
                // If not saved, check if we're on an ESP32 network
                currentIp = window.location.hostname.startsWith('192.168.') 
                    ? window.location.hostname 
                    : '192.168.4.1'; // Default to AP mode for dev servers
            }
            
            const ipInput = document.getElementById('esp32IpAddress');
            if (ipInput) ipInput.value = currentIp;
            
            // Detect initial mode based on IP
            const isStandaloneMode = currentIp === '192.168.4.1';
            const standaloneSwitch = document.getElementById('modeStandalone');
            const homeSwitch = document.getElementById('modeHomeWifi');
            
            if (isStandaloneMode) {
                if (standaloneSwitch) standaloneSwitch.checked = true;
                if (homeSwitch) homeSwitch.checked = false;
                setStandaloneMode();
            } else {
                if (homeSwitch) homeSwitch.checked = true;
                if (standaloneSwitch) standaloneSwitch.checked = false;
                setHomeWifiMode();
            }
            
            // Handle Home WiFi toggle switch
            if (homeSwitch) {
                homeSwitch.addEventListener('change', function() {
                    if (this.checked) {
                        // Turn off standalone when home is turned on
                        if (standaloneSwitch) standaloneSwitch.checked = false;
                        setHomeWifiMode();
                    } else {
                        // If unchecked, turn on standalone
                        if (standaloneSwitch) standaloneSwitch.checked = true;
                        setStandaloneMode();
                    }
                });
            }
            
            // Handle Standalone toggle switch
            if (standaloneSwitch) {
                standaloneSwitch.addEventListener('change', function() {
                    if (this.checked) {
                        // Turn off home wifi when standalone is turned on
                        if (homeSwitch) homeSwitch.checked = false;
                        setStandaloneMode();
                    } else {
                        // If unchecked, turn on home wifi
                        if (homeSwitch) homeSwitch.checked = true;
                        setHomeWifiMode();
                    }
                });
            }
            
            // Test connection button
            const testBtn = document.getElementById('testConnectionBtn');
            if (testBtn) {
                testBtn.addEventListener('click', testEsp32Connection);
            }
            
            // Save & Apply button
            const saveBtn = document.getElementById('saveNetworkBtn');
            if (saveBtn) {
                saveBtn.addEventListener('click', saveAndApplyConnection);
            }
            
        }

        function setStandaloneMode() {
            const ipInput = document.getElementById('esp32IpAddress');
            const helpText = document.getElementById('ipHelpText');
            
            // Set IP to Stand Alone Mode default
            if (ipInput) {
                ipInput.value = '192.168.4.1';
                ipInput.readOnly = true;
                ipInput.classList.add('bg-light');
            }
            
            // Update help text
            if (helpText) {
                helpText.innerHTML = '<span class="material-symbols-outlined">info</span> Stand Alone Mode always uses 192.168.4.1 (click Save to apply)';
            }
        }

        function setHomeWifiMode() {
            const ipInput = document.getElementById('esp32IpAddress');
            const helpText = document.getElementById('ipHelpText');
            
            // Enable IP editing
            if (ipInput) {
                ipInput.readOnly = false;
                ipInput.classList.remove('bg-light');
            }
            
            // Update help text
            // if (helpText) {
            //     helpText.innerHTML = '<span class="material-symbols-outlined">info</span> Enter your network IP and click Save to apply';
            // }
            
            // If IP was on standalone, clear it so user enters their network IP
            if (ipInput && ipInput.value === '192.168.4.1') {
                ipInput.value = '';
                ipInput.placeholder = 'e.g., 192.168.1.100';
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
        
        // Initialize settings tabs
        function initSettingsTabs() {
            function dirtyPageForTab(tabName) {
                if (tabName === 'preferences' || tabName === 'debugging') return 'system';
                return tabName;
            }

            // Restore last active tab from localStorage
            const savedTabCandidate = localStorage.getItem('settings_active_tab') || 'preferences';
            const savedTab = document.querySelector(`.settings-tab[data-tab="${savedTabCandidate}"]`)
                ? savedTabCandidate
                : 'preferences';
            
            // Set up tab click handlers
            document.querySelectorAll('.settings-tab').forEach(tab => {
                tab.addEventListener('click', async function() {
                    const tabName = this.dataset.tab;
                    const currentTab = localStorage.getItem('settings_active_tab') || 'preferences';
                    const currentDirtyPage = dirtyPageForTab(currentTab);
                    const nextDirtyPage = dirtyPageForTab(tabName);

                    // Dirty guard for tab switching
                    if (currentTab !== tabName && isPageDirty(currentDirtyPage) && currentDirtyPage !== nextDirtyPage) {
                        const choice = await showDirtyConfirmDialog();
                        if (choice === 'cancel') return;
                        if (choice === 'save') {
                            await savePage(currentDirtyPage);
                            if (isPageDirty(currentDirtyPage)) return; // save failed, abort
                        } else if (choice === 'discard') {
                            await discardPage(currentDirtyPage);
                        }
                    }

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