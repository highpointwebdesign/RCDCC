// ==================== Simple 5-LED Blue Test ====================
window.simpleLedTestOn = async function() {
    const statusEl = document.getElementById('simpleLedTestStatus');
    if (!bleManager || !bleManager.isConnected) {
        if (statusEl) statusEl.textContent = 'Not connected.';
        return;
    }
    try {
        await bleManager.sendSystemCommand('leds_simple_onoff', { on: true });
        if (statusEl) statusEl.textContent = 'LEDs 0-4 ON (Blue)';
    } catch (e) {
        if (statusEl) statusEl.textContent = 'Send failed: ' + (e?.message || e);
    }
};

window.simpleLedTestOff = async function() {
    const statusEl = document.getElementById('simpleLedTestStatus');
    if (!bleManager || !bleManager.isConnected) {
        if (statusEl) statusEl.textContent = 'Not connected.';
        return;
    }
    try {
        await bleManager.sendSystemCommand('leds_simple_onoff', { on: false });
        if (statusEl) statusEl.textContent = 'LEDs 0-4 OFF';
    } catch (e) {
        if (statusEl) statusEl.textContent = 'Send failed: ' + (e?.message || e);
    }
};
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
        const APP_VERSION = '1.1.557';
        const BUILD_DATE = '2026-03-29';
        
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
        let bleSyncInProgress = false;
        let bleSyncInternalWritesAllowed = false;
        let garageSyncModalInstance = null;
        const AUTO_PERSIST_SAVE_DELAY_MS = 1500;
        let autoPersistSaveTimer = null;
        const GARAGE_STORAGE_KEY = 'rcdcc_garage_vehicles';
        const DEBUG_MODE_STORAGE_KEY = 'settings_debug_mode_enabled';
        const VEHICLE_QUICK_SECTIONS = ['tuning', 'fpv'];
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

        function getDashboardQuickNavPlaceholderMarkup(type) {
            if (type === 'vehicle') {
                return '<span class="dashboard-quick-nav-placeholder-icon" aria-hidden="true">--</span>';
            }
            if (type === 'driving') {
                return '<span class="dashboard-quick-nav-placeholder-icon" aria-hidden="true">--</span>';
            }
            return '<span class="dashboard-quick-nav-placeholder-icon" aria-hidden="true">--</span>';
        }

        function setDashboardQuickNavDisplay(elementId, connectedLabel, placeholderType) {
            const el = document.getElementById(elementId);
            if (!el) return;

            if (!isBleConnected()) {
                el.innerHTML = getDashboardQuickNavPlaceholderMarkup(placeholderType);
                el.classList.add('dashboard-quick-nav-placeholder');
                el.setAttribute('aria-label', 'Not connected');
                return;
            }

            el.textContent = connectedLabel || '--';
            el.classList.remove('dashboard-quick-nav-placeholder');
            el.setAttribute('aria-label', connectedLabel || '--');
        }

        function updateDashboardVehicleName(name = null) {
            if (!isBleConnected()) {
                setDashboardQuickNavDisplay('activeVehicleDisplay', null, 'vehicle');
                updateVehicleQuickNav();
                return;
            }
            // Always prefer the garage custom label, fall back to passed name then BLE device name.
            const garageLabel = getGarageVehicleNameById(bleManager?.deviceId);
            setDashboardQuickNavDisplay('activeVehicleDisplay', garageLabel || (name && String(name).trim()) || bleManager?.deviceName || 'RCDCC Truck', 'vehicle');
            updateVehicleQuickNav();
        }

        function refreshDashboardCurrentSettingsCard(vehicleName = null) {
            if (!isBleConnected()) {
                clearDashboardActiveStatus();
                return;
            }

            updateDashboardVehicleName(vehicleName);
            updateDashboardActiveProfile();
            updateDashboardActiveLightingProfile();

            if (fullConfig && typeof fullConfig === 'object') {
                updateSuspensionSettings(fullConfig);
            }
        }

        function getActiveDrivingProfileConfigSnapshot() {
            const profile = (typeof getActiveDrivingProfile === 'function') ? getActiveDrivingProfile() : null;
            if (!profile || !profile.tuning) {
                return captureCurrentTuningValues();
            }
            return { ...profile.tuning };
        }

        function notifyBasicLightsStatus(message, type = 'info', options = {}) {
            if (window.toast && typeof window.toast[type] === 'function') {
                window.toast[type](message, options);
                return;
            }

            if (window.toast && typeof window.toast.show === 'function') {
                window.toast.show(message, type, options);
            }
        }

        function scheduleAutoPersistSave(reason = 'kv-update') {
            if (autoPersistSaveTimer) {
                clearTimeout(autoPersistSaveTimer);
                autoPersistSaveTimer = null;
            }

            autoPersistSaveTimer = setTimeout(async () => {
                autoPersistSaveTimer = null;
                if (!isBleConnected()) return;
                if (!bleManager || typeof bleManager.sendSaveCommandWithTimeout !== 'function') return;
                if (bleSyncInProgress) return;

                try {
                    await bleManager.sendSaveCommandWithTimeout(2500);
                    console.log(`Auto-persist save completed (${reason})`);
                } catch (error) {
                    console.warn(`Auto-persist save failed (${reason}):`, error?.message || error);
                }
            }, AUTO_PERSIST_SAVE_DELAY_MS);
        }

        window.refreshDashboardCurrentSettingsCard = refreshDashboardCurrentSettingsCard;

        function getGarageSyncModal() {
            const modalEl = document.getElementById('garageSyncModal');
            if (!modalEl || !window.bootstrap || !bootstrap.Modal) return null;
            if (!garageSyncModalInstance) {
                garageSyncModalInstance = bootstrap.Modal.getOrCreateInstance(modalEl, {
                    backdrop: 'static',
                    keyboard: false
                });
            }
            return { modalEl, modal: garageSyncModalInstance };
        }

        function updateGarageSyncProgress(percent = 0, statusText = 'Please wait while we sync your truck data...') {
            const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
            const progressWrap = document.querySelector('#garageSyncModal .progress');
            const progressBar = document.getElementById('garageSyncProgressBar');
            const statusEl = document.getElementById('garageSyncStatusText');
            if (progressWrap) progressWrap.setAttribute('aria-valuenow', String(safePercent));
            if (progressBar) {
                progressBar.style.width = `${safePercent}%`;
                progressBar.textContent = `${safePercent}%`;
                progressBar.setAttribute('aria-valuenow', String(safePercent));
            }
            if (statusEl && statusText) {
                statusEl.textContent = statusText;
            }
        }

        function showGarageSyncModal(vehicleName = null) {
            const handle = getGarageSyncModal();
            if (!handle) return;
            updateGarageSyncProgress(1, 'Connecting to vehicle...');
            handle.modal.show();
        }

        function hideGarageSyncModal(options = {}) {
            const { force = false } = options;
            const handle = getGarageSyncModal();
            if (!handle) return;
            handle.modal.hide();

            // Fallback: force cleanup if Bootstrap transition state gets stuck.
            setTimeout(() => {
                const modalEl = handle.modalEl;
                if (!modalEl || (!force && !modalEl.classList.contains('show'))) return;

                modalEl.classList.remove('show');
                modalEl.style.display = 'none';
                modalEl.removeAttribute('aria-modal');
                modalEl.setAttribute('aria-hidden', 'true');

                document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
                document.body.classList.remove('modal-open');
                document.body.style.removeProperty('padding-right');
            }, 320);
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
            setDashboardQuickNavDisplay('activeDrivingProfileDisplay', null, 'driving');
            setDashboardQuickNavDisplay('activeLightingProfileDisplay', null, 'lighting');
            updateDashboardVehicleName(null);

            // Reset suspension settings card
            const suspensionIds = ['rideHeightDisplay', 'dampingDisplay', 'stiffnessDisplay', 'frontRearBalanceDisplay'];
            suspensionIds.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = '--';
            });
            const badge = document.getElementById('reactionSpeedBadge');
            if (badge) badge.textContent = '--';

            // Reset roll/pitch/GPS card
            const sensorIds = ['rollPitchRollValue', 'rollPitchPitchValue', 'latitude', 'longitude', 'elevation', 'accuracy'];
            sensorIds.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = '--';
            });
        }

        function getPreferredReconnectDeviceId() {
            if (bleManager?.preferredDeviceId) return bleManager.preferredDeviceId;
            const persisted = localStorage.getItem('rcdccBlePreferredDeviceId');
            if (persisted) return persisted;
            if (bleManager?.deviceId) return bleManager.deviceId;
            return null;
        }

        function normalizeVehicleStorageId(deviceId) {
            return String(deviceId || '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '');
        }

        function getActiveVehicleStorageId() {
            return normalizeVehicleStorageId(bleManager?.deviceId || getPreferredReconnectDeviceId() || '');
        }

        function getVehicleScopedStorageKey(baseKey, deviceId = null) {
            const scopedId = normalizeVehicleStorageId(deviceId || getActiveVehicleStorageId());
            return scopedId ? `${baseKey}::${scopedId}` : baseKey;
        }

        function readVehicleScopedStorage(baseKey, options = {}) {
            const { deviceId = null, migrateLegacy = true } = options;
            const scopedKey = getVehicleScopedStorageKey(baseKey, deviceId);
            const scopedValue = localStorage.getItem(scopedKey);
            if (scopedValue !== null) return scopedValue;

            if (migrateLegacy && scopedKey !== baseKey) {
                const migrationMarkerKey = `${baseKey}::legacy_migrated_once`;
                if (localStorage.getItem(migrationMarkerKey) === 'true') {
                    return null;
                }
                const legacyValue = localStorage.getItem(baseKey);
                if (legacyValue !== null) {
                    localStorage.setItem(scopedKey, legacyValue);
                    localStorage.setItem(migrationMarkerKey, 'true');
                    return legacyValue;
                }
            }

            return null;
        }

        function writeVehicleScopedStorage(baseKey, value, deviceId = null) {
            const scopedKey = getVehicleScopedStorageKey(baseKey, deviceId);
            localStorage.setItem(scopedKey, value);
        }

        function removeVehicleScopedStorage(baseKey, deviceId = null) {
            const scopedKey = getVehicleScopedStorageKey(baseKey, deviceId);
            localStorage.removeItem(scopedKey);
        }

        function syncGarageReconnectPulse(active, delayMs = 0) {
            if (!window.GarageManager || typeof window.GarageManager.setAutoReconnectState !== 'function') return;
            const targetDeviceId = getPreferredReconnectDeviceId();
            window.GarageManager.setAutoReconnectState(!!active, targetDeviceId, delayMs);
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
                'saveNewLightingProfileBtn',
                'ltProfileUpdateBtn',
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
            updateDashboardBleUI(isBleConnected());
        }

        function updateDashboardBleUI(connected) {
            const rollPitchBody = document.getElementById('rollPitchRollValue')?.closest('.card-body');
            const settingsBody = document.getElementById('reactionSpeedBadge')?.closest('.card-body');
            [rollPitchBody, settingsBody].forEach(body => {
                if (!body) return;
                body.classList.toggle('ble-data-off', !connected);
            });
            const masterBtn = document.getElementById('lightsToggleDashboard');
            if (masterBtn) {
                masterBtn.classList.toggle('ble-data-off', !connected);
                masterBtn.setAttribute('aria-disabled', connected ? 'false' : 'true');
            }
            const masterBtnLg = document.getElementById('lightsToggleLightGroups');
            if (masterBtnLg) {
                masterBtnLg.classList.toggle('ble-data-off', !connected);
                masterBtnLg.setAttribute('aria-disabled', connected ? 'false' : 'true');
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

            if (bleSyncInProgress && !bleSyncInternalWritesAllowed) {
                throw new Error('Bluetooth sync in progress. Please wait.');
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
                scheduleAutoPersistSave('config-write');
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
                scheduleAutoPersistSave('kv-batch');
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
            if (!lightsWriteGateEnabled) {
                const msg = '[Lights] pushLightsPayload BLOCKED: master gate closed';
                console.warn(msg);
                appendToSettingsConsoleCard(msg, 'warn');
                return { status: 'blocked' };
            }
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
        const DIRTY_PAGE_LABELS = {
            tuning: 'Suspension',
            servo: 'Trim / Rotation',
            system: 'Hardware Configuration'
        };

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

            // Hardware Configuration Save button lives on the system card but should
            // enable for both system and servo hardware edits.
            if (pageKey === 'system' || pageKey === 'servo') {
                const hardwareSaveBtn = document.getElementById('system-save-btn');
                if (hardwareSaveBtn) {
                    const hardwareDirty = isPageDirty('system') || isPageDirty('servo');
                    hardwareSaveBtn.disabled = !hardwareDirty;
                    hardwareSaveBtn.classList.toggle('btn-gold', hardwareDirty);
                    hardwareSaveBtn.classList.toggle('btn-secondary', !hardwareDirty);
                }
            }

            if ((pageKey === 'tuning' || pageKey === 'servo') && typeof syncDrivingProfileActionButtons === 'function') {
                syncDrivingProfileActionButtons();
            }
        }

                function showDirtyConfirmDialog(dirtyPageKeys = []) {
            return new Promise((resolve) => {
                const existing = document.getElementById('dirty-confirm-overlay');
                if (existing) existing.remove();
                                const keys = Array.isArray(dirtyPageKeys) ? dirtyPageKeys.filter(Boolean) : [];
                                const labels = keys.map((k) => DIRTY_PAGE_LABELS[k] || k);
                                const details = labels.length
                                        ? `<div style="margin:0 0 14px;color:#bbb;font-size:0.82rem;line-height:1.5;"><strong>Unsaved:</strong> ${labels.join(', ')}</div>`
                                        : '';
                const overlay = document.createElement('div');
                overlay.id = 'dirty-confirm-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
                overlay.innerHTML = `
                  <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
                    <h5 style="margin:0 0 12px;color:#fff;">Unsaved Changes</h5>
                    <p style="margin:0 0 20px;color:#aaa;font-size:0.9rem;">You have unsaved changes. Save before leaving?</p>
                                        ${details}
                    <div style="display:flex;gap:8px;">
                      <button id="ddc-cancel"  style="flex:1;padding:10px;border:none;border-radius:8px;background:#222;color:#aaa;border:1px solid #555;cursor:pointer;">Cancel</button>
                                            <button id="ddc-discard" style="flex:1;padding:10px;border:none;border-radius:8px;background:#555;color:#fff;cursor:pointer;">Discard</button>
                                            <button id="ddc-save"    style="flex:1;padding:10px;border:none;border-radius:8px;background:#c8a800;color:#000;font-weight:600;cursor:pointer;">Save</button>
                    </div>
                  </div>`;
                document.body.appendChild(overlay);
                overlay.querySelector('#ddc-save').onclick    = () => { overlay.remove(); resolve('save'); };
                overlay.querySelector('#ddc-discard').onclick = () => { overlay.remove(); resolve('discard'); };
                overlay.querySelector('#ddc-cancel').onclick  = () => { overlay.remove(); resolve('cancel'); };
            });
        }

        async function resolveDirtyPagesForChoice(pageKeys, choice) {
            const keys = Array.from(new Set((pageKeys || []).filter((k) => isPageDirty(k))));
            if (!keys.length) return true;

            if (choice === 'save') {
                const remainingKeys = new Set(keys);
                if (keys.includes('system')) {
                    await savePage('system');
                    if (isPageDirty('system') || isPageDirty('servo')) return false;
                    remainingKeys.delete('system');
                    // system save persists hardware (system + servo)
                    remainingKeys.delete('servo');
                }

                for (const key of remainingKeys) {
                    await savePage(key);
                    if (isPageDirty(key)) return false;
                }
                return true;
            }

            if (choice === 'discard') {
                for (const key of keys) {
                    try {
                        await discardPage(key);
                    } catch (error) {
                        console.warn('Discard failed, continuing navigation:', error?.message || error);
                        clearPageDirty(key);
                    }
                }
                return true;
            }

            return false;
        }

                function showSimpleNoticeDialog(title, message, okLabel = 'OK', overlayId = 'simple-notice-overlay') {
                        return new Promise((resolve) => {
                                const existing = document.getElementById(overlayId);
                                if (existing) existing.remove();
                                const overlay = document.createElement('div');
                                overlay.id = overlayId;
                                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
                                overlay.innerHTML = `
                                    <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
                                        <h5 style="margin:0 0 12px;color:#fff;">${String(title || 'Notice').replace(/</g, '&lt;')}</h5>
                                        <p style="margin:0 0 20px;color:#aaa;font-size:0.9rem;">${String(message || '').replace(/</g, '&lt;')}</p>
                                        <button id="snd-ok" style="width:100%;padding:10px;border:none;border-radius:8px;background:#c8a800;color:#000;font-weight:600;cursor:pointer;">${String(okLabel || 'OK').replace(/</g, '&lt;')}</button>
                                    </div>`;
                                document.body.appendChild(overlay);
                                overlay.querySelector('#snd-ok').onclick = () => { overlay.remove(); resolve(true); };
                        });
                }

                function showActionConfirmDialog(title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', overlayId = 'action-confirm-overlay') {
                        return new Promise((resolve) => {
                                const existing = document.getElementById(overlayId);
                                if (existing) existing.remove();
                                const overlay = document.createElement('div');
                                overlay.id = overlayId;
                                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
                                overlay.innerHTML = `
                                    <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
                                        <h5 style="margin:0 0 12px;color:#fff;">${String(title || 'Confirm').replace(/</g, '&lt;')}</h5>
                                        <p style="margin:0 0 20px;color:#aaa;font-size:0.9rem;">${String(message || '').replace(/</g, '&lt;')}</p>
                                        <div style="display:flex;gap:8px;">
                                            <button id="acd-cancel" style="flex:1;padding:10px;border:none;border-radius:8px;background:#333;color:#aaa;border:1px solid #555;cursor:pointer;">${String(cancelLabel || 'Cancel').replace(/</g, '&lt;')}</button>
                                            <button id="acd-confirm" style="flex:1;padding:10px;border:none;border-radius:8px;background:#c0392b;color:#fff;font-weight:600;cursor:pointer;">${String(confirmLabel || 'Confirm').replace(/</g, '&lt;')}</button>
                                        </div>
                                    </div>`;
                                document.body.appendChild(overlay);
                                overlay.querySelector('#acd-cancel').onclick = () => { overlay.remove(); resolve(false); };
                                overlay.querySelector('#acd-confirm').onclick = () => { overlay.remove(); resolve(true); };
                        });
                }

                function isDebugModeEnabled() {
                        return localStorage.getItem(DEBUG_MODE_STORAGE_KEY) === 'true';
                }

                function applyDebugModeVisibility() {
                        const debugTabButton = document.querySelector('.settings-tab[data-tab="debugging"]');
                        const debugPane = document.getElementById('tab-debugging');
                        const debugEnabled = isDebugModeEnabled();

                        if (debugTabButton) debugTabButton.style.display = debugEnabled ? '' : 'none';
                        if (debugPane) debugPane.style.display = debugEnabled ? '' : 'none';

                        if (!debugEnabled) {
                                const activeTab = localStorage.getItem('settings_active_tab') || 'preferences';
                                if (activeTab === 'debugging') {
                                        localStorage.setItem('settings_active_tab', 'preferences');
                                        const prefBtn = document.querySelector('.settings-tab[data-tab="preferences"]');
                                        if (prefBtn) prefBtn.click();
                                }
                        }
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
                if (pageKey === 'system') {
                    // Hardware config Save persists both servo + system state.
                    clearPageDirty('servo');
                }
                // App-owned model: use local state as the post-save baseline.
                bleManager.lastKnownSavedState = mergeConfigSnapshots(bleManager.lastKnownSavedState, fullConfig || {});

                if (pageKey === 'tuning') {
                    const tuningSnapshot = {
                        rideHeightOffset: tuningSliderValues.rideHeightOffset,
                        damping: tuningSliderValues.damping,
                        stiffness: tuningSliderValues.stiffness,
                        reactionSpeed: tuningSliderValues.reactionSpeed,
                        frontRearBalance: tuningSliderValues.frontRearBalance,
                        sampleRate: tuningSliderValues.sampleRate
                    };
                    fullConfig = mergeConfigSnapshots(fullConfig, tuningSnapshot);
                    updateSuspensionSettings(tuningSnapshot);
                }

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

        async function runPostConnectFlow(connectionLabel = null, showToast = true, options = {}) {
            bleSyncInProgress = true;
            bleSyncInternalWritesAllowed = true;
            communicationMode = 'ble';
            hasEverBleConnection = true;
            stopAutoReconnect();
            stopHeartbeat();
            const showSyncModal = !!options.showSyncModal;

            if (showSyncModal) {
                const preconnectVehicleName = connectionLabel
                    || getGarageVehicleNameById(bleManager?.deviceId)
                    || bleManager?.deviceName
                    || null;
                showGarageSyncModal(preconnectVehicleName);
            }

            try {
                const connectedDeviceId = bleManager?.deviceId;
                if (connectedDeviceId) {
                    localStorage.setItem('rcdccBlePreferredDeviceId', connectedDeviceId);
                    bleManager.preferredDeviceId = connectedDeviceId;

                    // Ensure picker-based connects are represented in Garage before label resolution.
                    if (window.GarageManager && typeof window.GarageManager.upsertVehicle === 'function') {
                        const connectedDeviceName = bleManager?.deviceName || connectedDeviceId;
                        window.GarageManager.upsertVehicle(connectedDeviceId, connectedDeviceName);
                    }
                }

                // Refresh local per-vehicle state so each truck gets isolated profiles/groups.
                const restoredDriving = loadLocalDrivingProfiles();
                drivingProfiles = Array.isArray(restoredDriving.profiles) ? restoredDriving.profiles : [];
                activeDrivingProfileIndex = Number(restoredDriving.activeIndex) || 0;
                populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex);
                syncDrivingProfileActionButtons();

                const localProfileSnapshot = getActiveDrivingProfileConfigSnapshot();
                if (localProfileSnapshot) {
                    fullConfig = mergeConfigSnapshots(fullConfig, localProfileSnapshot);
                    updateSuspensionSettings(localProfileSnapshot);
                    updateTuningSliders(localProfileSnapshot);
                }

                const restoredLighting = loadLocalLightingProfiles();
                lightingProfiles = Array.isArray(restoredLighting.profiles) ? restoredLighting.profiles : [];
                activeLightingProfileIndex = Number(restoredLighting.activeIndex) || 0;
                populateLightingProfileSelector();
                syncLightingProfileActionButtons();

                await loadLightGroups();
                // Core/basic mode: always start with master lights OFF on connect.
                //  setMasterLightsEnabled(false, false);
                lightingGroupsDirty = false;
                syncLightingProfileActionButtons();
                updateTotalLEDCountLabel();

                updateConnectionStatus(true);
                updateConnectionMethodDisplay();

                resetSectionDataState();
                await fetchConfigFromESP32(false, {
                    scope: 'bootstrap',
                    onProgress: showSyncModal
                        ? ({ percent, done, total, stage }) => {
                            updateGarageSyncProgress(percent, 'Syncing data...');
                        }
                        : null
                });
                if (bleManager && bleManager.schemaCompatible === false) {
                    toast.error('Connected, but this truck firmware is not compatible with this app build.');
                    return;
                }
                applyFeatureAvailabilityGate();

                // Core/basic mode: enforce OFF state after connect before any manual user toggle.
                // await setMasterLightsEnabled(false, true);
                lastPushedLightsColorOrder = null;

                // Update basic lights test card status
                notifyBasicLightsStatus('Connected — tap Master to test LEDs directly.', 'success');

                const vehicleName = connectionLabel
                    || getGarageVehicleNameById(bleManager?.deviceId)
                    || bleManager?.deviceName
                    || 'RCDCC Truck (app.js:832)';
                refreshDashboardCurrentSettingsCard(vehicleName);

                if (showToast) {
                    toast.success(`Connected to ${vehicleName}`);
                }
            } finally {
                if (showSyncModal) {
                    updateGarageSyncProgress(100, 'Finalizing...');
                    await delayMs(220);
                    hideGarageSyncModal({ force: true });
                }
                bleSyncInternalWritesAllowed = false;
                bleSyncInProgress = false;
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

                await runPostConnectFlow(vehicleName, true, { showSyncModal: true });
                return true;
            } catch (error) {
                console.error('connectBLEToVehicle failed:', error);
                hideGarageSyncModal();
                toast.error('Could not connect - make sure vehicle is powered on');
                setHeaderSearching(false);
                return false;
            }
        }

        async function disconnectBLE(markManual = true) {
            if (!bleManager) return;
            bleSyncInProgress = false;
            bleSyncInternalWritesAllowed = false;
            lightsWriteGateEnabled = false; // Reset gate on disconnect
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
            lightingGroupsDirty = false;
            syncLightingProfileActionButtons();
            updateTotalLEDCountLabel();
            // Refresh garage UI so Connected badges and button labels update.
            if (window.GarageManager && typeof window.GarageManager.renderGarage === 'function') {
                window.GarageManager.renderGarage();
            }
            // Reset basic lights test UI
            _resetBasicLightsUI();
            notifyBasicLightsStatus('Waiting for connection…', 'info');
        }

        function purgeVehicleLocalData(deviceId) {
            if (!deviceId) return;

            [
                DRIVING_PROFILES_STORAGE_KEY,
                LIGHTING_PROFILES_STORAGE_KEY,
                LIGHT_GROUPS_STORAGE_KEY,
                LIGHT_GROUPS_INITIALIZED_KEY,
                LIGHT_MASTER_STORAGE_KEY,
                TOTAL_LED_COUNT_KEY
            ].forEach((baseKey) => removeVehicleScopedStorage(baseKey, deviceId));

            if (normalizeVehicleStorageId(getPreferredReconnectDeviceId()) === normalizeVehicleStorageId(deviceId)) {
                localStorage.removeItem('rcdccBlePreferredDeviceId');
                if (bleManager) bleManager.preferredDeviceId = null;
            }
        }

        window.purgeVehicleLocalData = purgeVehicleLocalData;

        function updateTotalLEDCountLabel() {
            const el = document.getElementById('totalLEDCountVehicleLabel');
            if (!el) return;
            const vehicleName = (isBleConnected() && bleManager?.deviceId)
                ? (getGarageVehicleNameById(bleManager.deviceId) || bleManager?.deviceName || null)
                : null;
            el.textContent = vehicleName ? ` — ${vehicleName}` : '';
        }

        function toggleGarageHelpCard() {
            const cardBody = document.getElementById('garageHelpCardBody');
            const chevron = document.getElementById('garageHelpChevron');
            if (!cardBody || !chevron) return;
            const isCollapsed = cardBody.style.display === 'none';
            cardBody.style.display = isCollapsed ? '' : 'none';
            chevron.textContent = isCollapsed ? 'keyboard_arrow_down' : 'keyboard_arrow_right';
            localStorage.setItem('garageHelpCardCollapsed', isCollapsed ? 'false' : 'true');
        }
        window.toggleGarageHelpCard = toggleGarageHelpCard;

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
        // Profiles are stored locally in localStorage — no firmware round-trips needed.
        // Each profile: { index, name, tuning: {...} }
        const DRIVING_PROFILES_STORAGE_KEY = 'rcdcc_driving_profiles_v2';

        function loadLocalDrivingProfiles() {
            try {
                const raw = readVehicleScopedStorage(DRIVING_PROFILES_STORAGE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed.profiles)) return parsed;
                }
            } catch (e) { /* corrupt storage — start fresh */ }
            return { profiles: [], activeIndex: 0 };
        }

        function saveLocalDrivingProfiles() {
            writeVehicleScopedStorage(DRIVING_PROFILES_STORAGE_KEY, JSON.stringify({
                profiles: drivingProfiles,
                activeIndex: activeDrivingProfileIndex
            }));
        }

        function getActiveDrivingProfile() {
            const active = drivingProfiles.find((profile) => Number(profile.index) === Number(activeDrivingProfileIndex));
            if (active) return active;
            if (!drivingProfiles.length) return null;

            activeDrivingProfileIndex = Number(drivingProfiles[0].index);
            saveLocalDrivingProfiles();
            return drivingProfiles[0];
        }

        function captureCurrentTuningValues() {
            return {
                rideHeightOffset: tuningSliderValues.rideHeightOffset ?? 50,
                damping: tuningSliderValues.damping ?? 0.8,
                stiffness: tuningSliderValues.stiffness ?? 1.0,
                reactionSpeed: tuningSliderValues.reactionSpeed ?? 1.0,
                frontRearBalance: tuningSliderValues.frontRearBalance ?? 50,
                sampleRate: tuningSliderValues.sampleRate ?? 25
            };
        }

        // Bootstrap drivingProfiles from localStorage immediately
        const _storedProfileData = loadLocalDrivingProfiles();
        let drivingProfiles = _storedProfileData.profiles;
        let activeDrivingProfileIndex = Number(_storedProfileData.activeIndex) || 0;
        let drivingProfileBusy = false;
        let drivingProfilesLocked = localStorage.getItem('drivingProfilesLocked') === 'true';
        let drivingProfileLastLoadedAt = 0;

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

                if (type === 'error' || type === 'warning') {
                    appendToSettingsConsoleCard(message, type === 'warning' ? 'warn' : 'error');
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
            },
            
            error(message, options) {
                this.show(message, 'error', options);
            },
            
            warning(message, options) {
                this.show(message, 'warning', options);
            },
            
            info(message, options) {
                this.show(message, 'info', options);
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

        const GPS_POLL_INTERVAL_MS = 60000;
        const TRAIL_SESSION_STORAGE_KEY = 'trailSessionState';
        let gpsPollIntervalId = null;
        let trailSessionTimerId = null;
        let trailBgWatcherId = null;
        const trailSessionState = {
            isRunning: false,
            elapsedMs: 0,
            startedAtMs: 0,
            distanceMiles: 0,
            elevationGainFt: 0,
            elevationLossFt: 0,
            maxElevationFt: null,
            lastSample: null
        };

        function persistTrailSessionState() {
            const snapshot = {
                isRunning: !!trailSessionState.isRunning,
                elapsedMs: Math.max(0, Number(trailSessionState.elapsedMs) || 0),
                startedAtMs: Math.max(0, Number(trailSessionState.startedAtMs) || 0),
                distanceMiles: Math.max(0, Number(trailSessionState.distanceMiles) || 0),
                elevationGainFt: Math.max(0, Number(trailSessionState.elevationGainFt) || 0),
                elevationLossFt: Math.max(0, Number(trailSessionState.elevationLossFt) || 0),
                maxElevationFt: Number.isFinite(Number(trailSessionState.maxElevationFt))
                    ? Number(trailSessionState.maxElevationFt)
                    : null,
                lastSample: trailSessionState.lastSample
                    ? {
                        latitude: Number(trailSessionState.lastSample.latitude),
                        longitude: Number(trailSessionState.lastSample.longitude),
                        altitudeFeet: Number.isFinite(Number(trailSessionState.lastSample.altitudeFeet))
                            ? Number(trailSessionState.lastSample.altitudeFeet)
                            : null,
                        timestampMs: Math.max(0, Number(trailSessionState.lastSample.timestampMs) || 0)
                    }
                    : null
            };

            writeVehicleScopedStorage(TRAIL_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
        }

        function restoreTrailSessionState() {
            const raw = readVehicleScopedStorage(TRAIL_SESSION_STORAGE_KEY, { migrateLegacy: false });
            if (!raw) return;

            try {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object') return;

                trailSessionState.isRunning = !!parsed.isRunning;
                trailSessionState.elapsedMs = Math.max(0, Number(parsed.elapsedMs) || 0);
                trailSessionState.startedAtMs = Math.max(0, Number(parsed.startedAtMs) || 0);
                trailSessionState.distanceMiles = Math.max(0, Number(parsed.distanceMiles) || 0);
                trailSessionState.elevationGainFt = Math.max(0, Number(parsed.elevationGainFt) || 0);
                trailSessionState.elevationLossFt = Math.max(0, Number(parsed.elevationLossFt) || 0);
                trailSessionState.maxElevationFt = Number.isFinite(Number(parsed.maxElevationFt))
                    ? Number(parsed.maxElevationFt)
                    : null;

                const restoredSample = parsed.lastSample && typeof parsed.lastSample === 'object'
                    ? {
                        latitude: Number(parsed.lastSample.latitude),
                        longitude: Number(parsed.lastSample.longitude),
                        altitudeFeet: Number.isFinite(Number(parsed.lastSample.altitudeFeet))
                            ? Number(parsed.lastSample.altitudeFeet)
                            : null,
                        timestampMs: Math.max(0, Number(parsed.lastSample.timestampMs) || 0)
                    }
                    : null;

                trailSessionState.lastSample = (restoredSample
                    && Number.isFinite(restoredSample.latitude)
                    && Number.isFinite(restoredSample.longitude))
                    ? restoredSample
                    : null;

                if (trailSessionState.isRunning && trailSessionState.startedAtMs <= 0) {
                    trailSessionState.startedAtMs = Date.now();
                }
            } catch (error) {
                console.warn('Failed to restore trail session state:', error?.message || error);
            }
        }

        function formatTrailDuration(totalMs) {
            const safeMs = Math.max(0, Number(totalMs) || 0);
            const totalSeconds = Math.floor(safeMs / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }

        function getTrailSessionElapsedMs() {
            const runningElapsed = trailSessionState.isRunning
                ? Math.max(0, Date.now() - trailSessionState.startedAtMs)
                : 0;
            return Math.max(0, trailSessionState.elapsedMs + runningElapsed);
        }

        function formatTrailDistance(miles) {
            return `${Math.max(0, Number(miles) || 0).toFixed(1)} mi`;
        }

        function formatTrailFeet(feet, options = {}) {
            const value = Math.max(0, Number(feet) || 0);
            const rounded = Math.round(value).toLocaleString();
            if (options.signed === true) {
                return `${options.positivePrefix || '+'}${rounded} ft`;
            }
            return `${rounded} ft`;
        }

        function updateTrailSessionStatsDisplay() {
            const distanceEl = document.getElementById('trailDistanceValue');
            const gainEl = document.getElementById('trailElevGainValue');
            const lossEl = document.getElementById('trailElevLossValue');
            const avgSpeedEl = document.getElementById('trailAvgSpeedValue');
            const maxElevationEl = document.getElementById('trailMaxElevationValue');

            const elapsedMs = getTrailSessionElapsedMs();
            const elapsedHours = elapsedMs / 3600000;
            const avgSpeed = elapsedHours > 0
                ? trailSessionState.distanceMiles / elapsedHours
                : 0;

            if (distanceEl) distanceEl.textContent = formatTrailDistance(trailSessionState.distanceMiles);
            if (gainEl) gainEl.textContent = formatTrailFeet(trailSessionState.elevationGainFt, { signed: true, positivePrefix: '+' });
            if (lossEl) lossEl.textContent = formatTrailFeet(trailSessionState.elevationLossFt, { signed: true, positivePrefix: '-' });
            if (avgSpeedEl) avgSpeedEl.textContent = `${Math.max(0, avgSpeed).toFixed(1)} mph`;
            if (maxElevationEl) {
                maxElevationEl.textContent = Number.isFinite(trailSessionState.maxElevationFt)
                    ? formatTrailFeet(trailSessionState.maxElevationFt)
                    : '--';
            }
        }

        function updateTrailSessionDurationDisplay() {
            const durationEl = document.getElementById('trailDurationValue');
            if (!durationEl) return;
            durationEl.textContent = formatTrailDuration(getTrailSessionElapsedMs());
        }

        function updateTrailSessionDisplay() {
            updateTrailSessionDurationDisplay();
            updateTrailSessionStatsDisplay();
        }

        function recordTrailSessionGpsSample(latitude, longitude, altitudeMeters) {
            if (!trailSessionState.isRunning) return;

            const lat = Number(latitude);
            const lon = Number(longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

            const altitudeFeet = Number.isFinite(Number(altitudeMeters))
                ? (Number(altitudeMeters) * 3.28084)
                : null;

            const sample = {
                latitude: lat,
                longitude: lon,
                altitudeFeet,
                timestampMs: Date.now()
            };

            const prev = trailSessionState.lastSample;
            if (prev) {
                const distanceDelta = haversineDistance(prev.latitude, prev.longitude, sample.latitude, sample.longitude);
                if (Number.isFinite(distanceDelta) && distanceDelta > 0) {
                    trailSessionState.distanceMiles += distanceDelta;
                }

                if (Number.isFinite(prev.altitudeFeet) && Number.isFinite(sample.altitudeFeet)) {
                    const elevationDelta = sample.altitudeFeet - prev.altitudeFeet;
                    if (elevationDelta > 0) {
                        trailSessionState.elevationGainFt += elevationDelta;
                    } else if (elevationDelta < 0) {
                        trailSessionState.elevationLossFt += Math.abs(elevationDelta);
                    }
                }
            }

            if (Number.isFinite(sample.altitudeFeet)) {
                trailSessionState.maxElevationFt = Number.isFinite(trailSessionState.maxElevationFt)
                    ? Math.max(trailSessionState.maxElevationFt, sample.altitudeFeet)
                    : sample.altitudeFeet;
            }

            trailSessionState.lastSample = sample;
            updateTrailSessionDisplay();
            persistTrailSessionState();
        }

        // --- Background GPS tracking (screen-off support) -----------------------

        function getBgGeoPlugin() {
            return (window.Capacitor &&
                window.Capacitor.Plugins &&
                window.Capacitor.Plugins.BackgroundGeolocation) || null;
        }

        async function startTrailBgTracking() {
            const BgGeo = getBgGeoPlugin();
            if (!BgGeo) {
                // Fallback: browser / dev environment — use one-shot GPS poll
                captureGPSCoordinates();
                return;
            }
            // Remove any stale watcher from a previous session
            if (trailBgWatcherId !== null) {
                try { await BgGeo.removeWatcher({ id: trailBgWatcherId }); } catch (_) {}
                trailBgWatcherId = null;
            }
            try {
                trailBgWatcherId = await BgGeo.addWatcher(
                    {
                        backgroundMessage: 'Trail session is actively tracking your route.',
                        backgroundTitle: 'RCDCC Trail Tracker',
                        requestPermissions: true,
                        stale: false,
                        distanceFilter: 5  // metres — avoid noise from GPS jitter
                    },
                    (location, error) => {
                        if (error) {
                            console.warn('BgGeo error:', error.message);
                            return;
                        }
                        if (location) {
                            recordTrailSessionGpsSample(
                                location.latitude,
                                location.longitude,
                                location.altitude
                            );
                        }
                    }
                );
            } catch (err) {
                console.warn('startTrailBgTracking failed:', err);
                // Fallback so distance still accumulates via regular poll
                captureGPSCoordinates();
            }
        }

        async function stopTrailBgTracking() {
            const BgGeo = getBgGeoPlugin();
            if (trailBgWatcherId !== null && BgGeo) {
                try { await BgGeo.removeWatcher({ id: trailBgWatcherId }); } catch (_) {}
                trailBgWatcherId = null;
            }
        }

        // -------------------------------------------------------------------------

        function syncTrailSessionButtons() {
            const startBtn = document.getElementById('trailSessionStartBtn');
            const stopBtn = document.getElementById('trailSessionStopBtn');

            if (startBtn) {
                startBtn.disabled = trailSessionState.isRunning;
                startBtn.setAttribute('aria-disabled', trailSessionState.isRunning ? 'true' : 'false');
            }
            if (stopBtn) {
                stopBtn.disabled = !trailSessionState.isRunning;
                stopBtn.setAttribute('aria-disabled', trailSessionState.isRunning ? 'false' : 'true');
            }
        }

        function startTrailSession() {
            if (trailSessionState.isRunning) return;
            trailSessionState.isRunning = true;
            trailSessionState.startedAtMs = Date.now();
            trailSessionState.lastSample = null;

            if (trailSessionTimerId) clearInterval(trailSessionTimerId);
            trailSessionTimerId = setInterval(() => {
                updateTrailSessionDisplay();
                persistTrailSessionState();
            }, 1000);

            startTrailBgTracking();
            updateTrailSessionDisplay();
            syncTrailSessionButtons();
            persistTrailSessionState();
        }

        function stopTrailSession() {
            if (!trailSessionState.isRunning) return;

            trailSessionState.elapsedMs += Math.max(0, Date.now() - trailSessionState.startedAtMs);
            trailSessionState.startedAtMs = 0;
            trailSessionState.isRunning = false;
            trailSessionState.lastSample = null;

            if (trailSessionTimerId) {
                clearInterval(trailSessionTimerId);
                trailSessionTimerId = null;
            }

            stopTrailBgTracking();
            updateTrailSessionDisplay();
            syncTrailSessionButtons();
            persistTrailSessionState();
        }

        function resetTrailSession() {
            trailSessionState.elapsedMs = 0;
            trailSessionState.startedAtMs = 0;
            trailSessionState.isRunning = false;
            trailSessionState.distanceMiles = 0;
            trailSessionState.elevationGainFt = 0;
            trailSessionState.elevationLossFt = 0;
            trailSessionState.maxElevationFt = null;
            trailSessionState.lastSample = null;

            if (trailSessionTimerId) {
                clearInterval(trailSessionTimerId);
                trailSessionTimerId = null;
            }

            stopTrailBgTracking();
            updateTrailSessionDisplay();
            syncTrailSessionButtons();
            persistTrailSessionState();
        }

        function bindTrailSessionControls() {
            const startBtn = document.getElementById('trailSessionStartBtn');
            const stopBtn = document.getElementById('trailSessionStopBtn');
            const resetBtn = document.getElementById('trailSessionResetBtn');

            if (startBtn && startBtn.dataset.bound !== 'true') {
                startBtn.dataset.bound = 'true';
                startBtn.addEventListener('click', startTrailSession);
            }
            if (stopBtn && stopBtn.dataset.bound !== 'true') {
                stopBtn.dataset.bound = 'true';
                stopBtn.addEventListener('click', stopTrailSession);
            }
            if (resetBtn && resetBtn.dataset.bound !== 'true') {
                resetBtn.dataset.bound = 'true';
                resetBtn.addEventListener('click', resetTrailSession);
            }

            restoreTrailSessionState();

            if (trailSessionState.isRunning) {
                if (trailSessionTimerId) clearInterval(trailSessionTimerId);
                trailSessionTimerId = setInterval(() => {
                    updateTrailSessionDisplay();
                    persistTrailSessionState();
                }, 1000);
                // Re-attach background location watcher on restore
                startTrailBgTracking();
            }

            updateTrailSessionDisplay();
            syncTrailSessionButtons();
            persistTrailSessionState();
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
                const latEl = document.getElementById('latitude');
                const lonEl = document.getElementById('longitude');
                const accEl = document.getElementById('accuracy');
                const altEl = document.getElementById('elevation');
                if (latEl) latEl.textContent = '--';
                if (lonEl) lonEl.textContent = '--';
                if (accEl) accEl.textContent = '--';
                if (altEl) altEl.textContent = '--';
                return;
            }

            navigator.geolocation.getCurrentPosition(
                position => {
                    const latNum = Number(position.coords.latitude);
                    const lonNum = Number(position.coords.longitude);
                    const lat = latNum.toFixed(6);
                    const lon = lonNum.toFixed(6);
                    const accMeters = position.coords.accuracy.toFixed(1);
                    const accFeet = (accMeters * 3.28084).toFixed(1);
                    const altitudeMeters = Number(position.coords.altitude);
                    const hasAltitude = Number.isFinite(altitudeMeters);
                    const altFeet = hasAltitude ? (altitudeMeters * 3.28084).toFixed(1) : null;
                    
                    const latEl = document.getElementById('latitude');
                    const lonEl = document.getElementById('longitude');
                    const accEl = document.getElementById('accuracy');
                    const altEl = document.getElementById('elevation');
                    
                    if (latEl) latEl.textContent = lat + '°';
                    if (lonEl) lonEl.textContent = lon + '°';
                    if (accEl) accEl.textContent = '±' + accFeet + ' ft';
                    if (altEl) altEl.textContent = hasAltitude ? (altFeet + ' ft') : '--';

                    recordTrailSessionGpsSample(latNum, lonNum, altitudeMeters);
                    
                    console.log(`GPS captured: Lat ${lat}, Lon ${lon}, Acc ±${accFeet}ft, Alt ${hasAltitude ? `${altFeet}ft` : 'N/A'}`);
                },
                error => {
                    console.warn('GPS capture failed:', error.message);
                    const latEl = document.getElementById('latitude');
                    const lonEl = document.getElementById('longitude');
                    const accEl = document.getElementById('accuracy');
                    const altEl = document.getElementById('elevation');
                    if (latEl) latEl.innerHTML = '<span class="material-symbols-outlined">sync</span>';
                    if (lonEl) lonEl.innerHTML = '<span class="material-symbols-outlined">sync</span>';
                    if (accEl) accEl.innerHTML = '<span class="material-symbols-outlined">sync</span>';
                    if (altEl) altEl.innerHTML = '<span class="material-symbols-outlined">sync</span>';
                },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
            );
        }

        function startGpsPolling() {
            if (gpsPollIntervalId) {
                clearInterval(gpsPollIntervalId);
            }
            gpsPollIntervalId = setInterval(() => {
                captureGPSCoordinates();
            }, GPS_POLL_INTERVAL_MS);
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
        let autoLevelCancelRequested = false;

        function requestAutoLevelCancel() {
            autoLevelCancelRequested = true;
            setBubbleLevelStatus('Canceling auto-calibrate...');
        }

        function ensureAutoLevelNotCancelled() {
            if (autoLevelCancelRequested) {
                const err = new Error('Auto calibrate canceled');
                err.code = 'AUTOLEVEL_CANCELLED';
                throw err;
            }
        }

        async function autoLevelDelay(ms) {
            const stepMs = 100;
            let remaining = Math.max(0, Number(ms) || 0);
            while (remaining > 0) {
                ensureAutoLevelNotCancelled();
                const chunk = Math.min(stepMs, remaining);
                await delay(chunk);
                remaining -= chunk;
            }
        }

        function getServoReverseFromUi(servo) {
            const servoAbbrevMap = {
                frontLeft: 'FL',
                frontRight: 'FR',
                rearLeft: 'RL',
                rearRight: 'RR'
            };
            const abbrev = servoAbbrevMap[servo];
            if (!abbrev) return false;
            return !!document.getElementById(`servo${abbrev}Reversed`)?.checked;
        }

        function buildAutoCalibrateServoConfigFromUi() {
            return {
                servos: {
                    frontLeft: {
                        min: Number(servoSliderValues?.frontLeft?.min) || 10,
                        max: Number(servoSliderValues?.frontLeft?.max) || 170,
                        trim: Number(servoSliderValues?.frontLeft?.trim) || 0,
                        reversed: getServoReverseFromUi('frontLeft')
                    },
                    frontRight: {
                        min: Number(servoSliderValues?.frontRight?.min) || 10,
                        max: Number(servoSliderValues?.frontRight?.max) || 170,
                        trim: Number(servoSliderValues?.frontRight?.trim) || 0,
                        reversed: getServoReverseFromUi('frontRight')
                    },
                    rearLeft: {
                        min: Number(servoSliderValues?.rearLeft?.min) || 10,
                        max: Number(servoSliderValues?.rearLeft?.max) || 170,
                        trim: Number(servoSliderValues?.rearLeft?.trim) || 0,
                        reversed: getServoReverseFromUi('rearLeft')
                    },
                    rearRight: {
                        min: Number(servoSliderValues?.rearRight?.min) || 10,
                        max: Number(servoSliderValues?.rearRight?.max) || 170,
                        trim: Number(servoSliderValues?.rearRight?.trim) || 0,
                        reversed: getServoReverseFromUi('rearRight')
                    }
                }
            };
        }
        
        function initBubbleLevelContainer() {
            const containerElement = document.getElementById('autoLevelProgressContainer');
            if (!containerElement) return;

            let cancelBtn = document.getElementById('autoLevelCancelBtn');
            if (!cancelBtn) {
                const bubbleCard = containerElement.querySelector('.bubble-level-card');
                if (bubbleCard) {
                    cancelBtn = document.createElement('button');
                    cancelBtn.type = 'button';
                    cancelBtn.id = 'autoLevelCancelBtn';
                    cancelBtn.className = 'btn btn-outline-secondary btn-sm mt-2';
                    cancelBtn.textContent = 'Abort Calibration';
                    cancelBtn.style.display = 'none';
                    bubbleCard.appendChild(cancelBtn);
                }
            }
            if (cancelBtn && !cancelBtn.dataset.bound) {
                cancelBtn.dataset.bound = '1';
                cancelBtn.addEventListener('click', requestAutoLevelCancel);
            }

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
            
            if (!fullConfig || typeof fullConfig !== 'object') fullConfig = {};
            if (!fullConfig.servos || typeof fullConfig.servos !== 'object') fullConfig.servos = {};
            if (!fullConfig.servos[servo] || typeof fullConfig.servos[servo] !== 'object') fullConfig.servos[servo] = {};
            fullConfig.servos[servo].trim = value;
            if (servoSliderValues && servoSliderValues[servo]) {
                servoSliderValues[servo].trim = Math.round(value);
            }
            
            // Update UI slider - use config values for calculation
            const servoAbbrevMap = {
                'frontLeft': 'FL',
                'frontRight': 'FR',
                'rearLeft': 'RL',
                'rearRight': 'RR'
            };
            const abbrev = servoAbbrevMap[servo];
            
            if (abbrev) {
                const trimSliderId = `servo${abbrev}TrimSlider`;
                
                if (rSliders[trimSliderId]) {
                    const trimOffset = value;
                    
                    // Update slider and keep thumb label as the visible trim value.
                    console.log(`Updating ${servo} trim slider: offset=${trimOffset}`);
                    setRSliderValue(trimSliderId, formatSliderValue(trimOffset), { silent: true });
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
            
            if (!fullConfig || typeof fullConfig !== 'object') fullConfig = {};
            if (!fullConfig.servos || typeof fullConfig.servos !== 'object') fullConfig.servos = {};
            if (!fullConfig.servos[servo] || typeof fullConfig.servos[servo] !== 'object') fullConfig.servos[servo] = {};
            fullConfig.servos[servo].reversed = value;
            
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
                const cwBtn = document.getElementById(`servo${abbrev}CwBtn`);
                const ccwBtn = document.getElementById(`servo${abbrev}CcwBtn`);
                if (cwBtn && ccwBtn) {
                    cwBtn.classList.toggle('is-active', !value);
                    ccwBtn.classList.toggle('is-active', !!value);
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

            if (!isBleConnected()) {
                toast.warning('Connect to a vehicle before running Auto Calibrate');
                return;
            }

            // Show UI immediately so the tap feels responsive
            openBubbleLevelContainer();
            setBubbleLevelStatus('Loading configuration...');

            // Ensure servo config is available. If not already loaded, fetch tuning scope on demand.
            if (!fullConfig || !fullConfig.servos) {
                fullConfig = mergeConfigSnapshots(fullConfig, buildAutoCalibrateServoConfigFromUi());
            }

            if (!fullConfig || !fullConfig.servos || !Object.keys(fullConfig.servos || {}).length) {
                console.warn('Auto Calibrate proceeding with live UI servo state because vehicle config read was unavailable.');
                fullConfig = mergeConfigSnapshots(fullConfig, buildAutoCalibrateServoConfigFromUi());
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
            autoLevelCancelRequested = false;

            const cancelBtn = document.getElementById('autoLevelCancelBtn');
            if (cancelBtn) {
                cancelBtn.disabled = false;
                cancelBtn.style.display = '';
            }
            
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
            
            // Initialize servo state from config (fall back to neutral if missing)
            servos.forEach(servo => {
                if (fullConfig.servos[servo]) {
                    const configuredTrim = fullConfig.servos[servo].trim;
                    servoState[servo] = {
                        trim: Number.isFinite(configuredTrim) ? configuredTrim : 0,
                        reversed: fullConfig.servos[servo].reversed || false
                    };
                } else {
                    const uiTrim = Number(servoSliderValues?.[servo]?.trim);
                    servoState[servo] = {
                        trim: Number.isFinite(uiTrim) ? uiTrim : 0,
                        reversed: false
                    };
                }
            });
            
            try {
                // ==================== Phase 0: Reset trims to neutral (center) if requested ====================
                if (resetTrims) {
                    console.log('Phase 0: Starting trim reset to neutral...');
                    setBubbleLevelStatus('Resetting trims to neutral...');
                    
                    for (const servo of servos) {
                        ensureAutoLevelNotCancelled();
                        // Neutral trim offset is always 0
                        const center = 0;
                        console.log(`Phase 0: Resetting ${servo} to neutral (trim=${center})`);
                        
                        // Send API call to update servo trim
                        await updateServoTrim(servo, center);
                        servoState[servo].trim = center;
                        
                        // Wait 1500ms total (servo movement 1000ms + SPIFFS save 500ms happen concurrently)
                        await autoLevelDelay(1500);
                    }
                    
                    console.log('Phase 0: Trim reset complete, refreshing from local app state...');
                    setBubbleLevelStatus('Neutral position set. Confirming data saved correctly...');
                    
                    // App-owned model: trust local UI snapshot after successful writes.
                    fullConfig = mergeConfigSnapshots(fullConfig, buildAutoCalibrateServoConfigFromUi());
                    servos.forEach(servo => {
                        if (fullConfig?.servos?.[servo]) {
                            servoState[servo].trim = fullConfig.servos[servo].trim || 0;
                        }
                    });
                    console.log('Phase 0: Config refreshed from local app state.');
                    
                    setBubbleLevelStatus('Neutral confirmed. Let chassis settle...');
                    await autoLevelDelay(SENSOR_SETTLE_MS);
                }
                

                // ==================== Phase A: Servo Direction Verification (Pitch-Only) ====================
                autoLevelPhaseA = true; // Enable smooth bubble animation
                setBubbleLevelStatus('Verifying servo directions...');
                await autoLevelDelay(SENSOR_SETTLE_MS);
                
                // Expected pitch change when moving +10° (front up = +pitch)
                const servoExpectedPitch = {
                    frontLeft: 'positive',
                    frontRight: 'positive',
                    rearLeft: 'negative',
                    rearRight: 'negative'
                };
                
                const needsReversal = {};
                let movementDetected = false;
                
                // FIRST PASS: Test all servos to detect which ones need reversal
                for (const servo of servos) {
                    ensureAutoLevelNotCancelled();
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
                    if (Math.abs(pitchChange) >= 0.5) {
                        movementDetected = true;
                    }
                    
                    // Check if direction is correct (threshold avoids noise)
                    const expected = servoExpectedPitch[servo];
                    const isCorrectDirection = (expected === 'positive' && pitchChange > 1) ||
                                               (expected === 'negative' && pitchChange < -1);
                    
                    needsReversal[servo] = !isCorrectDirection;
                    console.log(`Phase A: ${servo} pitch change: ${pitchChange.toFixed(2)}°. ${isCorrectDirection ? 'CORRECT' : 'NEEDS REVERSAL'}`);
                    
                    // Return to neutral
                    await updateServoTrim(servo, initialTrim);
                    servoState[servo].trim = initialTrim;
                    await autoLevelDelay(SENSOR_SETTLE_MS);
                }

                if (!movementDetected) {
                    throw new Error('No servo movement detected. Stopping for safety.');
                }
                
                // SECOND PASS: Apply reversals and verify they work
                for (const servo of servos) {
                    ensureAutoLevelNotCancelled();
                    if (needsReversal[servo]) {
                        const servoLabel = servoLabelMap[servo] || servo;
                        const newReversedState = !servoState[servo].reversed;
                        
                        setBubbleLevelStatus(`Fixing ${servoLabel} direction...`);
                        await updateServoReversed(servo, newReversedState);
                        servoState[servo].reversed = newReversedState;
                        await autoLevelDelay(500); // Let reversal setting take effect
                        
                        // Verify the reversal fixed the direction
                        setBubbleLevelStatus(`Verifying ${servoLabel}...`);
                        const initialTrim = servoState[servo].trim;
                        const testTrim = initialTrim + TEST_MOVEMENT;
                        
                        const baselineSensor = await getSensorData();
                        const baselinePitch = baselineSensor.pitch;
                        
                        await updateServoTrim(servo, testTrim);
                        servoState[servo].trim = testTrim;
                        await autoLevelDelay(SENSOR_SETTLE_MS);
                        
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
                        await autoLevelDelay(SENSOR_SETTLE_MS);
                    }
                }
                
                autoLevelPhaseA = false; // Disable smooth animation, re-enable snapping
                
                // ==================== Phase B: Iterative leveling ====================
                setBubbleLevelStatus('Starting auto-level...');
                await autoLevelDelay(SENSOR_SETTLE_MS);
                
                let levelAchieved = false;
                
                for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
                    ensureAutoLevelNotCancelled();
                    setBubbleLevelStatus(`Attempting to auto level... (${iteration}/${MAX_ITERATIONS})`);
                    
                    // Read current orientation
                    const sensor = await getSensorData();
                    const roll = sensor.roll;
                    const pitch = sensor.pitch;
                    
                    // Check if level achieved
                    if (Math.abs(roll) < LEVEL_TOLERANCE && Math.abs(pitch) < LEVEL_TOLERANCE) {
                        setBubbleLevelStatus('Level achieved!');
                        levelAchieved = true;
                        await autoLevelDelay(2000);
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
                        ensureAutoLevelNotCancelled();
                        const currentTrim = servoState[servo].trim;
                        const newTrim = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, currentTrim + deltas[servo]));
                        const roundedTrim = Math.round(newTrim);
                        
                        if (roundedTrim !== currentTrim) {
                            await updateServoTrim(servo, roundedTrim);
                            servoState[servo].trim = roundedTrim;
                        }
                    }
                    
                    await autoLevelDelay(SENSOR_SETTLE_MS);
                }
                
                if (!levelAchieved) {
                    setBubbleLevelStatus('Vehicle is too unlevel for auto level to correct');
                    // Persistent failure toast - stays until clicked (duration: 0)
                    toast.error('Auto level failed - the vehicle is too unlevel for auto level to correct. Please ensure it is on a relatively flat surface and try again.', { duration: 0 });
                    await autoLevelDelay(3000);
                } else {
                    // Auto Calibrate values are foundational calibration values; persist immediately to NVS.
                    setBubbleLevelStatus('Saving calibration to NVS...');
                    if (!bleManager || typeof bleManager.sendSaveCommandWithTimeout !== 'function') {
                        throw new Error('Save command unavailable; calibration was not persisted to NVS');
                    }
                    await bleManager.sendSaveCommandWithTimeout(5000);
                }
                
                // Close bubble level
                closeBubbleLevelContainer();
                
                if (levelAchieved) {
                    // Show success toast (auto-dismisses after 4 seconds)
                    toast.success('Vehicle leveled successfully and calibration was saved to NVS.', { duration: 4000 });
                }
                
            } catch (error) {
                console.error('Auto-leveling failed:', error);
                setBubbleLevelStatus('Error occurred.');
                
                // Close bubble level and show status toast
                closeBubbleLevelContainer();
                if (error && error.code === 'AUTOLEVEL_CANCELLED') {
                    toast.info('Auto Calibrate canceled');
                } else {
                    toast.error(`Auto-level error: ${error.message}`, { duration: 0 });
                }
            } finally {
                // Restore button state
                button.classList.remove('active');
                button.disabled = false;
                if (setLevelBtn) setLevelBtn.disabled = false;
                autoLevelCancelRequested = false;

                const cancelBtnFinal = document.getElementById('autoLevelCancelBtn');
                if (cancelBtnFinal) {
                    cancelBtnFinal.disabled = true;
                    cancelBtnFinal.style.display = 'none';
                }
                
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
                    if (typeof setDrivingProfileBusy === 'function') {
                        setDrivingProfileBusy(false);
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
                const target = e.target;
                if (target && target.closest && target.closest('input[type="range"]')) {
                    return;
                }
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

            const debugModeToggle = document.getElementById('enableDebugMode');
            if (debugModeToggle) {
                debugModeToggle.checked = isDebugModeEnabled();
                applyDebugModeVisibility();
                debugModeToggle.addEventListener('change', function() {
                    localStorage.setItem(DEBUG_MODE_STORAGE_KEY, this.checked ? 'true' : 'false');
                    applyDebugModeVisibility();
                    toast.info(`Debug mode ${this.checked ? 'enabled' : 'disabled'}`);
                });
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

            // Initialize GPS coordinates and keep phone location fresh.
            captureGPSCoordinates();
            startGpsPolling();

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
                lightsGuideChevron.textContent = 'keyboard_arrow_down';
                lightsGuideChevron.classList.toggle('is-collapsed', lightsGuideCollapsed);
            }

            syncCardCollapseState('tuningParametersCard', 'tuningParametersChevron', 'tuningParametersCardCollapsed');
            syncCardCollapseState('mpuOrientationCard', 'mpuOrientationChevron', 'mpuOrientationCardCollapsed');
            syncCardCollapseState('servoRangeCard', 'servoRangeChevron', 'servoRangeCardCollapsed');
            syncCardCollapseState('servoSettingsCard', 'servoSettingsChevron', 'servoSettingsCardCollapsed');
            syncCardCollapseState('rcdccConfigurationCard', 'rcdccConfigurationChevron', 'rcdccConfigurationCardCollapsed');
            syncCardCollapseState('basicLedConfigurationCard', 'basicLedConfigurationChevron', 'basicLedConfigurationCardCollapsed');
            syncCardCollapseState('basicLedAllocationCard', 'basicLedAllocationChevron', 'basicLedAllocationCardCollapsed');
            syncCardCollapseState('basicLedFxOutputCard', 'basicLedFxOutputChevron', 'basicLedFxOutputCardCollapsed');
            syncCardCollapseState('basicActiveLedAllocationCard', 'basicActiveLedAllocationChevron', 'basicActiveLedAllocationCardCollapsed');
            syncCardCollapseState('manageLightGroupsCard', 'manageLightGroupsChevron', 'manageLightGroupsCardCollapsed');
            syncCardCollapseState('dashboardHelpCard', 'dashboardHelpChevron', 'dashboardHelpCardCollapsed');

            syncDrivingProfilesCardUI();
            syncLightingProfilesCardUI();
            syncLightingControlCardUI();
            syncManageLightGroupsLockUI();
            
            // Restore servo range lock state from localStorage
            servoRangeLocked = localStorage.getItem('servoRangeLocked') === 'true';
            const servoRangeLockIcon = document.getElementById('servoRangeLockIcon');
            const servoRangeCard = document.getElementById('servoRangeCard');
            if (servoRangeLockIcon && servoRangeCard) {
                servoRangeCard.classList.toggle('slider-locked', servoRangeLocked);
                servoRangeLockIcon.textContent = servoRangeLocked ? 'lock' : 'lock_open_right';
                servoRangeLockIcon.style.color = servoRangeLocked ? 'var(--lime-green)' : 'var(--high-impact-color)'; // Lime green if locked, yellow if unlocked
            } else if (servoRangeCard) {
                servoRangeLocked = false;
                localStorage.setItem('servoRangeLocked', 'false');
                servoRangeCard.classList.remove('slider-locked');
            }
            
            // Restore servo settings lock state from localStorage.
            // Older builds stored trim and direction separately; the UI now uses one combined lock.
            const savedServoTrimLock = localStorage.getItem('servoTrimLocked') === 'true';
            const savedServoRotationLock = localStorage.getItem('servoRotationLocked') === 'true';
            const servoSettingsLocked = savedServoTrimLock || savedServoRotationLock;
            if (document.getElementById('servoSettingsLockIcon')) {
                servoTrimLocked = servoSettingsLocked;
                servoRotationLocked = servoSettingsLocked;
                localStorage.setItem('servoTrimLocked', servoSettingsLocked.toString());
                localStorage.setItem('servoRotationLocked', servoSettingsLocked.toString());
            } else {
                servoTrimLocked = false;
                servoRotationLocked = false;
                localStorage.setItem('servoTrimLocked', 'false');
                localStorage.setItem('servoRotationLocked', 'false');
            }
            syncServoSettingsLockUI();

            rcdccConfigurationLocked = localStorage.getItem('rcdccConfigurationLocked') === 'true';
            syncRcdccConfigurationLockUI();

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

            const backToTopBtn = document.getElementById('backToTopBtn');
            function updateBackToTopVisibility() {
                if (!backToTopBtn) return;
                backToTopBtn.style.display = window.scrollY > 320 ? 'flex' : 'none';
            }
            
            window.addEventListener('scroll', updateHeaderScroll, { passive: true });
            window.addEventListener('scroll', updateBackToTopVisibility, { passive: true });
            updateBackToTopVisibility();

            if (backToTopBtn) {
                backToTopBtn.addEventListener('click', () => {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                });
            }

            // Page navigation - footer nav buttons
            document.querySelectorAll('.footer-nav button').forEach(btn => {
                btn.addEventListener('click', async function() {
                    const target = this.dataset.target;
                    if (target) {
                        await navigateToSection(target, {
                            toastOnVehicleRedirect: VEHICLE_CONNECTION_REQUIRED_SECTIONS.includes(target)
                        });
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

            bindDashboardCurrentSettingsQuickNav();
            
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

            bindTrailSessionControls();

            // ==================== Light Hierarchy Controls ====================
            const lightsToggle = document.getElementById('lightsToggle');
            const lightsToggleDashboard = document.getElementById('lightsToggleDashboard');
            const lightsToggleLightGroups = document.getElementById('lightsToggleLightGroups');

            bindMasterLightSwitch(lightsToggle);
            bindMasterLightSwitch(lightsToggleDashboard);
            bindMasterLightSwitch(lightsToggleLightGroups);
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

            const runLedColorDiagnosticBtn = document.getElementById('runLedColorDiagnosticBtn');
            if (runLedColorDiagnosticBtn) {
                runLedColorDiagnosticBtn.addEventListener('click', function() {
                    runLedColorDiagnosticSequence();
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

        function syncFooterNavActiveState(sectionId = null) {
            const resolvedSection = sectionId
                || document.querySelector('.page-section.active')?.id
                || localStorage.getItem('currentPage')
                || 'dashboard';

            document.querySelectorAll('.footer-nav button').forEach((button) => {
                const isActive = button.dataset.target === resolvedSection;
                button.classList.toggle('active', isActive);
                button.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });
        }

        let ledColorDiagnosticInFlight = false;

        function setLedColorDiagnosticPreview(colorName = null) {
            const previewEl = document.getElementById('ledColorDiagnosticPreview');
            const labelEl = document.getElementById('ledColorDiagnosticColorLabel');
            if (!previewEl && !labelEl) return;

            const palette = {
                red: '#ff3b30',
                green: '#34c759',
                blue: '#0a84ff',
                yellow: '#ffd60a'
            };

            if (!colorName || !palette[colorName]) {
                if (previewEl) {
                    previewEl.style.backgroundColor = '#111';
                    previewEl.style.boxShadow = '0 0 0 rgba(0,0,0,0)';
                }
                if (labelEl) {
                    labelEl.textContent = 'Preview: idle';
                    labelEl.style.color = '#9ca3af';
                }
                return;
            }

            const colorHex = palette[colorName];
            if (previewEl) {
                previewEl.style.backgroundColor = colorHex;
                previewEl.style.boxShadow = `0 0 14px ${colorHex}`;
            }
            if (labelEl) {
                labelEl.textContent = `Preview: ${colorName.toUpperCase()}`;
                labelEl.style.color = colorHex;
            }
        }

        async function runLedColorDiagnosticSequence() {
            if (ledColorDiagnosticInFlight) return;

            const triggerBtn = document.getElementById('runLedColorDiagnosticBtn');
            const statusEl = document.getElementById('ledColorDiagnosticStatus');

            if (!isBleConnected()) {
                toast.warning('Connect to Bluetooth before running LED color diagnostic.');
                if (statusEl) statusEl.textContent = 'Not connected';
                return;
            }

            const setStatus = (text, tone = 'muted') => {
                if (!statusEl) return;
                statusEl.textContent = text;
                statusEl.style.color = tone === 'error' ? '#f87171'
                    : tone === 'ok' ? '#4ade80'
                    : tone === 'busy' ? '#fbbf24'
                    : '#9ca3af';
            };

            ledColorDiagnosticInFlight = true;
            if (triggerBtn) {
                triggerBtn.disabled = true;
                triggerBtn.setAttribute('aria-disabled', 'true');
            }

            const sequence = ['red', 'green', 'blue', 'yellow'];
            const holdMs = 1000;

            try {
                setStatus('Running: red -> green -> blue -> yellow', 'busy');
                for (const color of sequence) {
                    setLedColorDiagnosticPreview(color);
                    setStatus(`Testing ${color.toUpperCase()}...`, 'busy');
                    await pushSystemCommand('flash', { color, count: 1, onMs: holdMs, offMs: 0 });
                    await delay(holdMs);
                }
                setStatus('Complete', 'ok');
                toast.success('LED color diagnostic completed');
            } catch (error) {
                console.error('LED color diagnostic failed:', error);
                setStatus('Failed (see console)', 'error');
                toast.error(`LED color diagnostic failed: ${error?.message || error}`);
            } finally {
                setLedColorDiagnosticPreview(null);
                ledColorDiagnosticInFlight = false;
                if (triggerBtn) {
                    triggerBtn.disabled = false;
                    triggerBtn.setAttribute('aria-disabled', 'false');
                }
            }
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
        async function navigateToSection(sectionId, options = {}) {
            const requestedSection = String(sectionId || 'dashboard');
            const requiresBle = VEHICLE_CONNECTION_REQUIRED_SECTIONS.includes(requestedSection);
            if (requiresBle && !isBleConnected() && options.toastOnVehicleRedirect === true) {
                toast.info(options.vehicleRedirectMessage || 'Please connect to a vehicle first.');
            }
            const targetSection = (requiresBle && !isBleConnected()) ? 'garage' : requestedSection;

            // Dirty guard: check page being navigated away from
            const currentSection = localStorage.getItem('currentPage') || 'dashboard';
            if (currentSection !== targetSection) {
                const activeDirtyKeys = ['tuning', 'servo', 'system'].filter((k) => isPageDirty(k));
                if (activeDirtyKeys.length) {
                    const choice = await showDirtyConfirmDialog(activeDirtyKeys);
                    if (choice === 'cancel') return;
                    const resolved = await resolveDirtyPagesForChoice(activeDirtyKeys, choice);
                    if (!resolved) return;
                }

                if (currentSection === 'lights' && lightingGroupsDirty) {
                    const choice = await showDirtyConfirmDialog(['lights']);
                    if (choice === 'cancel') return;
                    if (choice === 'save') {
                        await updateActiveLightingProfile();
                        if (lightingGroupsDirty) return;
                    } else if (choice === 'discard') {
                        try {
                            await discardLightingProfileChanges();
                        } catch (error) {
                            console.warn('Lighting discard failed, continuing navigation:', error?.message || error);
                            lightingGroupsDirty = false;
                            syncLightingProfileActionButtons();
                        }
                    }
                }
            }

            syncFooterNavActiveState(targetSection);
            
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

            if (targetSection === 'tuning' && isBleConnected()) {
                const profileList = document.getElementById('drvProfileList');
                const willLoadTuningSection = !sectionDataLoaded.tuning || !!sectionLoadPromises.tuning;
                if (willLoadTuningSection && profileList && profileList.children.length <= 1 && drivingProfiles.length === 0) {
                    profileList.innerHTML = '<div class="text-muted text-center py-2" style="font-size:0.875rem;">Loading profiles...</div>';
                }
            }

            if (SECTION_LOAD_KEYS.includes(targetSection)) {
                ensureSectionDataLoaded(targetSection).catch((error) => {
                    console.warn(`Lazy load failed for ${targetSection}:`, error?.message || error);
                    if (targetSection === 'tuning') {
                        populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex);
                    }
                });
            }

            syncFooterNavActiveState(section?.id || targetSection);
            updateVehicleQuickNav(targetSection);
        }

        async function handleDashboardVehicleBadgeNav(event) {
            event?.preventDefault?.();
            if (!isBleConnected()) {
                toast.info('Connect to a vehicle first. Opening Garage.');
            }
            await navigateToSection('garage');
        }

        async function handleDashboardProfileBadgeNav(event, targetSection) {
            event?.preventDefault?.();
            if (!isBleConnected()) {
                toast.info('Connect to a vehicle first. Opening Garage.');
                await navigateToSection('garage');
                return;
            }
            await navigateToSection(targetSection);
        }

        function showDashboardDrivingProfilePicker() {
            const selectableProfiles = drivingProfiles.filter((profile) => Number(profile.index) !== Number(activeDrivingProfileIndex) && profile.tuning);
            if (selectableProfiles.length === 0) {
                toast.info('No alternate driving profiles available.');
                return Promise.resolve(null);
            }

            return new Promise((resolve) => {
                const existing = document.getElementById('dashboard-driving-profile-picker');
                if (existing) existing.remove();

                const overlay = document.createElement('div');
                overlay.id = 'dashboard-driving-profile-picker';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:calc(24px + env(safe-area-inset-top, 0px)) 20px 20px;';

                const optionsHtml = selectableProfiles.map((profile) => `
                    <button class="dashboard-profile-picker-option" data-profile-index="${profile.index}" style="display:block;width:100%;text-align:left;padding:12px 14px;margin-bottom:8px;border:1px solid #444;border-radius:10px;background:#2a2a2a;color:#fff;cursor:pointer;">
                        <strong style="display:block;font-size:0.95rem;">${String(profile.name || 'Unnamed Profile').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</strong>
                        <span style="display:block;color:#aaa;font-size:0.8rem;margin-top:4px;">Tap to apply this profile</span>
                    </button>`).join('');

                const activeProfile = getActiveDrivingProfile();
                const activeName = activeProfile?.name || '--';

                overlay.innerHTML = `
                  <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:360px;width:100%;color:#fff;max-height:80vh;overflow-y:auto;box-sizing:border-box;">
                    <h5 style="margin:0 0 8px;color:#f9c21b;"><span class="material-symbols-outlined" aria-hidden="true">sync</span> Switch Driving Profile</h5>
                    <p style="margin:0 0 16px;color:#aaa;font-size:0.875rem;">Current profile: <strong style="color:#fff;">${String(activeName).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</strong></p>
                    ${optionsHtml}
                    <button id="dashboard-profile-picker-cancel" style="width:100%;padding:10px;border:none;border-radius:8px;background:#333;color:#aaa;border:1px solid #555;cursor:pointer;margin-top:4px;">Cancel</button>
                  </div>`;

                const cleanup = (selectedIndex = null) => {
                    document.removeEventListener('keydown', handleKeyDown);
                    overlay.remove();
                    resolve(selectedIndex);
                };

                const handleKeyDown = (event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        cleanup(null);
                    }
                };

                overlay.addEventListener('click', (event) => {
                    if (event.target === overlay) {
                        cleanup(null);
                    }
                });

                document.addEventListener('keydown', handleKeyDown);
                document.body.appendChild(overlay);

                overlay.querySelectorAll('.dashboard-profile-picker-option').forEach((button) => {
                    button.addEventListener('click', () => cleanup(Number(button.dataset.profileIndex)));
                });

                const cancelBtn = overlay.querySelector('#dashboard-profile-picker-cancel');
                if (cancelBtn) cancelBtn.addEventListener('click', () => cleanup(null));

                const firstOption = overlay.querySelector('.dashboard-profile-picker-option');
                if (firstOption) firstOption.focus();
            });
        }

        async function handleDashboardDrivingProfilePickerNav(event) {
            event?.preventDefault?.();
            if (!isBleConnected()) {
                toast.info('Connect to a vehicle first. Opening Garage.');
                await navigateToSection('garage');
                return;
            }

            const selectedIndex = await showDashboardDrivingProfilePicker();
            if (selectedIndex == null) return;

            await selectDrivingProfile(selectedIndex);
        }

        function bindDashboardCurrentSettingsQuickNav() {
            const bindNavBadge = (elementId, handler) => {
                const el = document.getElementById(elementId);
                if (!el || el.dataset.quickNavBound === '1') return;

                el.dataset.quickNavBound = '1';
                el.style.cursor = 'pointer';
                el.setAttribute('role', 'button');
                el.setAttribute('tabindex', '0');

                el.addEventListener('click', handler);
                el.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handler(event);
                    }
                });
            };

            bindNavBadge('activeVehicleDisplay', handleDashboardVehicleBadgeNav);
            bindNavBadge('activeDrivingProfileDisplay', handleDashboardDrivingProfilePickerNav);
            bindNavBadge('activeLightingProfileDisplay', (event) => handleDashboardProfileBadgeNav(event, 'lights'));
        }

        window.navigateToSection = navigateToSection;

        // ==================== Light Groups Management ====================
        const LIGHT_GROUPS_STORAGE_KEY = 'lightGroups';
        const LIGHT_MASTER_STORAGE_KEY = 'lightsMasterEnabled';
        const TOTAL_LED_COUNT_KEY = 'totalLEDCount';
        const LIGHT_COLOR_ORDER_KEY = 'lightColorOrder';
        const LIGHT_GROUPS_INITIALIZED_KEY = 'lightGroupsInitialized';
        const LIGHT_GROUP_PRESET_SECTION_STATE_KEY = 'lightGroupPresetSectionState';
        const LIGHT_GROUP_DEFAULT_PATTERN = 'solid';
        const LIGHT_GROUP_CYCLE_INTERVAL_SECONDS = 30;
        const MAX_LIGHT_GROUP_NAME_LENGTH = 12;
        const LIGHTS_ENGINE_MAX_GROUPS = 15;
        const MAX_LIGHTS_TOTAL_LEDS = 30;
        const MAX_LIGHT_GROUP_LEDS = 15;
        const BASIC_LIGHTING_TEST_LED_COUNT = 9;
        const BASIC_LIGHTING_TEST_COLOR = '#0000ff';
        const LIGHT_GROUP_EXTRA_PATTERNS = ['solid', 'glitter', 'police'];
        const LIGHTS_ENGINE_EFFECTS = new Set(['solid', 'glitter', 'police']);
        const FACTORY_COLOR_PRESETS = [
            '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff',
            '#007FFF', '#ff8800', '#8800ff', '#ffe0a0', '#ffffff'
        ];
        const LIGHT_COLOR_ORDER_OPTIONS = new Set(['grb', 'rgb', 'rbg', 'gbr', 'brg', 'bgr']);
        const DEFAULT_LIGHT_COLOR_ORDER = 'grb';

        function normalizeLightGroupName(name) {
            return String(name || '').trim().slice(0, MAX_LIGHT_GROUP_NAME_LENGTH);
        }

        function normalizeLightColorOrder(value) {
            const normalized = String(value || '').trim().toLowerCase();
            return LIGHT_COLOR_ORDER_OPTIONS.has(normalized) ? normalized : DEFAULT_LIGHT_COLOR_ORDER;
        }

        // Phase 5: Lighting profiles stored in localStorage (mirrors driving profile architecture)
        // The ESP32 receives individual light group commands — it has no knowledge of profiles.
        const LIGHTING_PROFILES_STORAGE_KEY = 'rcdcc_lighting_profiles_v1';
        const MAX_LIGHTING_PROFILES = 5;

        function loadLocalLightingProfiles() {
            try {
                const raw = readVehicleScopedStorage(LIGHTING_PROFILES_STORAGE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed.profiles)) return parsed;
                }
            } catch (e) { /* ignore */ }
            return { profiles: [], activeIndex: 0 };
        }

        function saveLocalLightingProfiles() {
            writeVehicleScopedStorage(LIGHTING_PROFILES_STORAGE_KEY, JSON.stringify({
                profiles: lightingProfiles,
                activeIndex: activeLightingProfileIndex
            }));
        }

        const _storedLightingData = loadLocalLightingProfiles();
        let lightingProfiles = _storedLightingData.profiles;
        let activeLightingProfileIndex = Number(_storedLightingData.activeIndex) || 0;
        let lightingProfileBusy = false;
        let lightingProfilesLocked = localStorage.getItem('lightingProfilesLocked') === 'true';
        let lightingControlLocked = localStorage.getItem('lightingControlLocked') === 'true';
        let manageLightGroupsLocked = localStorage.getItem('manageLightGroupsLocked') === 'true';
        let lightStripConfigLocked = localStorage.getItem('lightStripConfigLocked') === 'true';
        let lightingGroupsDirty = false;
        
        // Predefined light groups (initialized on first load)
        const PREDEFINED_LIGHT_GROUPS = [
            { name: 'Brake Lights', indices: [], brightness: 255, color: '#ff0000', color2: '#000000', pattern: 'solid', enabled: false, isPredefined: true },
            { name: 'Emergency/Police Lights', indices: [], brightness: 255, color: '#ff0000', color2: '#0000ff', pattern: 'flash_sparkle', enabled: false, isPredefined: true },
            { name: 'Hazard Lights', indices: [], brightness: 255, color: '#ffa500', color2: '#000000', pattern: 'blink', enabled: false, isPredefined: true },
            { name: 'Headlights', indices: [], brightness: 255, color: '#ffffff', color2: '#000000', pattern: 'solid', enabled: false, isPredefined: true },
            { name: 'Reverse Lights', indices: [], brightness: 255, color: '#ffffff', color2: '#000000', pattern: 'solid', enabled: false, isPredefined: true },
            { name: 'Taillights', indices: [], brightness: 128, color: '#ff0000', color2: '#000000', pattern: 'solid', enabled: false, isPredefined: true },
            { name: 'Turn Signals Left', indices: [], brightness: 255, color: '#ffa500', color2: '#000000', pattern: 'blink', enabled: false, isPredefined: true },
            { name: 'Turn Signals Right', indices: [], brightness: 255, color: '#ffa500', color2: '#000000', pattern: 'blink', enabled: false, isPredefined: true }
        ];
        let lightGroups = [];
        let currentColor2 = '#000000'; // Second color for dual-color patterns
        let lightGroupsStateBeforeModal = null;
        let masterStateBeforeModal = false;
        let lightGroupModalSaved = false;
        let masterLightToggleInFlight = false;
        // Start at max so the first sync clears any stale groups on firmware.
        let lastPushedLightGroupCount = LIGHTS_ENGINE_MAX_GROUPS;
        let lastPushedLightGroupSignatures = Array(LIGHTS_ENGINE_MAX_GROUPS).fill('');
        let lastPushedLightsColorOrder = null;
        let lastPushedLightsMasterEnabled = null;
        let lightsWriteGateEnabled = false; // Hard gate: prevents ALL lights content writes when master is OFF.
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

        function normalizeLedIndices(indicesLike) {
            if (!Array.isArray(indicesLike)) return [];

            const normalized = indicesLike
                .map(value => Number(value))
                .filter(value => Number.isFinite(value) && value >= 0 && value < MAX_LIGHTS_TOTAL_LEDS)
                .map(value => Math.trunc(value));

            return Array.from(new Set(normalized)).sort((a, b) => a - b).slice(0, MAX_LIGHT_GROUP_LEDS);
        }

        function normalizeLightGroup(group) {
            const source = group && typeof group === 'object' ? group : {};
            const { leds, ...rest } = source;
            const indexSource = Array.isArray(rest.indices) ? rest.indices : leds;
            const normalizedPattern = LIGHTS_ENGINE_EFFECTS.has(String(rest.pattern || '').toLowerCase())
                ? String(rest.pattern).toLowerCase()
                : LIGHT_GROUP_DEFAULT_PATTERN;
            const normalizedIntensity = Number.isFinite(Number(rest.intensity))
                ? Math.max(0, Math.min(255, Math.round(Number(rest.intensity))))
                : 128; // Default mid-range intensity
            const normalizedSpeed = Number.isFinite(Number(rest.speed))
                ? Math.max(0, Math.min(255, Math.round(Number(rest.speed))))
                : 128; // Default mid-range speed

            return {
                ...rest,
                pattern: normalizedPattern,
                intensity: normalizedIntensity,
                speed: normalizedSpeed,
                indices: normalizeLedIndices(indexSource).slice(0, MAX_LIGHT_GROUP_LEDS),
                enabled: !!rest.enabled
            };
        }

        function getLightGroupPayloadSignature(payload) {
            if (!payload || typeof payload !== 'object') return '';

            return JSON.stringify({
                group: Number(payload.group),
                name: String(payload.name || ''),
                enabled: !!payload.enabled,
                color: String(payload.color || ''),
                color2: String(payload.color2 || ''),
                brightness: Number(payload.brightness) || 0,
                effect: String(payload.effect || ''),
                speed: Number(payload.speed) || 0,
                intensity: Number(payload.intensity) || 0,
                leds: normalizeLedIndices(payload.leds)
            });
        }

        function applyFactoryPreset(target, color) {
            const normalizedTarget = target === 'secondary' ? 'secondary' : 'primary';
            setLightGroupColor(String(color || '#000000'), normalizedTarget);
        }

        function getLightGroupPresetSectionState() {
            try {
                const parsed = JSON.parse(localStorage.getItem(LIGHT_GROUP_PRESET_SECTION_STATE_KEY) || '{}');
                return {
                    primary: parsed.primary !== false,
                    secondary: parsed.secondary !== false
                };
            } catch (error) {
                return { primary: true, secondary: true };
            }
        }

        function setLightGroupPresetSectionState(nextState) {
            localStorage.setItem(LIGHT_GROUP_PRESET_SECTION_STATE_KEY, JSON.stringify({
                primary: nextState.primary !== false,
                secondary: nextState.secondary !== false
            }));
        }

        function applyLightGroupPresetSectionState(target, isExpanded) {
            const normalizedTarget = target === 'secondary' ? 'secondary' : 'primary';
            const body = document.getElementById(`${normalizedTarget}PresetBody`);
            const chevron = document.getElementById(`${normalizedTarget}PresetChevron`);
            const toggle = document.getElementById(`${normalizedTarget}PresetToggle`);
            if (!body || !chevron || !toggle) return;

            body.classList.toggle('collapsed', !isExpanded);
            chevron.textContent = isExpanded ? 'expand_less' : 'expand_more';
            toggle.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        }

        function initializeLightGroupPresetSections() {
            const state = getLightGroupPresetSectionState();
            applyLightGroupPresetSectionState('primary', state.primary);
            applyLightGroupPresetSectionState('secondary', state.secondary);
        }

        function toggleLightGroupPresetSection(target) {
            const normalizedTarget = target === 'secondary' ? 'secondary' : 'primary';
            const state = getLightGroupPresetSectionState();
            const nextExpanded = !state[normalizedTarget];
            const nextState = {
                ...state,
                [normalizedTarget]: nextExpanded
            };

            applyLightGroupPresetSectionState(normalizedTarget, nextExpanded);
            setLightGroupPresetSectionState(nextState);
        }

        function renderFactoryPresetGrid(containerId, target) {
            const container = document.getElementById(containerId);
            if (!container) return;

            container.innerHTML = '';
            FACTORY_COLOR_PRESETS.forEach((color) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'factory-preset-swatch';
                button.style.backgroundColor = color;
                button.title = `Set ${target} color to ${color.toUpperCase()}`;
                button.addEventListener('click', () => applyFactoryPreset(target, color));
                container.appendChild(button);
            });
        }

        function renderFactoryPresets() {
            renderFactoryPresetGrid('primaryFactoryPresets', 'primary');
            renderFactoryPresetGrid('secondaryFactoryPresets', 'secondary');
            initializeLightGroupPresetSections();
        }

        window.applyFactoryPreset = applyFactoryPreset;
        window.toggleLightGroupPresetSection = toggleLightGroupPresetSection;

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
            const initialized = readVehicleScopedStorage(LIGHT_GROUPS_INITIALIZED_KEY);
            const stored = readVehicleScopedStorage(LIGHT_GROUPS_STORAGE_KEY);

            if (!initialized) {
                lightGroups = JSON.parse(JSON.stringify(PREDEFINED_LIGHT_GROUPS));
                writeVehicleScopedStorage(LIGHT_GROUPS_INITIALIZED_KEY, 'true');
            } else {
                lightGroups = stored ? JSON.parse(stored) : [];
            }

            lightGroups = lightGroups.map(normalizeLightGroup).slice(0, LIGHTS_ENGINE_MAX_GROUPS);

            ensureLightGroupIds();
            refreshTotalLEDInputFromStorage();
            refreshLightColorOrderInputFromStorage();

            saveLightGroups(false);
            renderLightGroupsList();
        }

        window.reloadLightGroupsFromStorage = async function() {
            await loadLightGroups();
            if (isBleConnected() && lightsWriteGateEnabled) {
                applyLightsHierarchyToHardware();
            }
        };

        window.reloadLightingProfilesFromStorage = async function() {
            const restored = loadLocalLightingProfiles();
            lightingProfiles = Array.isArray(restored.profiles) ? restored.profiles : [];
            activeLightingProfileIndex = Number(restored.activeIndex) || 0;
            populateLightingProfileSelector();
            updateDashboardActiveLightingProfile();
            syncLightingProfileActionButtons();
        };

        function updateDashboardActiveLightingProfile() {
            if (!isBleConnected()) {
                setDashboardQuickNavDisplay('activeLightingProfileDisplay', null, 'lighting');
                return;
            }
            const hit = lightingProfiles.find(p => Number(p.index) === Number(activeLightingProfileIndex));
            setDashboardQuickNavDisplay('activeLightingProfileDisplay', hit ? (hit.name || `Profile ${hit.index}`) : '--', 'lighting');
        }

        function getVehicleScopedTotalLEDCount() {
            const saved = parseInt(readVehicleScopedStorage(TOTAL_LED_COUNT_KEY), 10);
            return Number.isInteger(saved) && saved >= 1 && saved <= MAX_LIGHTS_TOTAL_LEDS
                ? saved
                : Math.min(20, MAX_LIGHTS_TOTAL_LEDS);
        }

        function getVehicleScopedLightColorOrder() {
            return normalizeLightColorOrder(readVehicleScopedStorage(LIGHT_COLOR_ORDER_KEY));
        }

        function refreshTotalLEDInputFromStorage() {
            const totalLEDInput = document.getElementById('totalLEDCount');
            if (!totalLEDInput) return;
            totalLEDInput.value = getVehicleScopedTotalLEDCount();
        }

        function refreshLightColorOrderInputFromStorage() {
            const colorOrderInput = document.getElementById('lightColorOrder');
            if (!colorOrderInput) return;
            colorOrderInput.value = getVehicleScopedLightColorOrder();
        }

        function syncLightingProfileActionButtons() {
            const saveBtn = document.getElementById('saveNewLightingProfileBtn');
            if (saveBtn) saveBtn.disabled = lightingProfileBusy || lightingProfilesLocked || !isBleConnected();
            const updateBtn = document.getElementById('ltProfileUpdateBtn');
            if (!updateBtn) return;
            const activeProfile = lightingProfiles.find(p => Number(p.index) === Number(activeLightingProfileIndex));
            const showUpdate = !!activeProfile && lightingGroupsDirty;
            updateBtn.classList.toggle('profile-update-needs-save', showUpdate);
            updateBtn.disabled = !showUpdate || lightingProfileBusy || lightingProfilesLocked || !isBleConnected();
        }

        function syncLightingProfilesCardUI() {
            const card = document.getElementById('lightingProfilesCard');
            const body = document.getElementById('lightingProfilesCardBody');
            const lockIcon = document.getElementById('lightingProfilesLockIcon');
            const chevron = document.getElementById('lightingProfilesChevron');
            const isCollapsed = localStorage.getItem('lightingProfilesCardCollapsed') === 'true';

            if (card) card.classList.toggle('profile-card-locked', lightingProfilesLocked);
            if (body) body.style.display = isCollapsed ? 'none' : 'block';
            if (chevron) {
                chevron.textContent = 'keyboard_arrow_down';
                chevron.classList.toggle('is-collapsed', isCollapsed);
                chevron.title = isCollapsed ? 'Expand lighting profiles' : 'Collapse lighting profiles';
            }
            if (lockIcon) {
                lockIcon.textContent = lightingProfilesLocked ? 'lock' : 'lock_open_right';
                lockIcon.style.color = lightingProfilesLocked ? 'var(--lime-green)' : 'var(--high-impact-color)';
                lockIcon.title = lightingProfilesLocked ? 'Unlock lighting profiles' : 'Lock lighting profiles to prevent changes';
            }
        }

        function syncLightingControlCardUI() {
            const card = document.getElementById('basicLightsTestCard');
            const body = document.getElementById('basicLightsTestCardBody') || card?.querySelector('.card-body');
            const lockIcon = document.getElementById('lightingControlLockIcon');
            const chevron = document.getElementById('lightingControlChevron');
            const isCollapsed = localStorage.getItem('lightingControlCardCollapsed') === 'true';

            if (card) card.classList.toggle('profile-card-locked', lightingControlLocked);
            if (body) {
                body.style.display = isCollapsed ? 'none' : 'block';

                const controls = body.querySelectorAll('input, select, textarea, button');
                controls.forEach(control => {
                    control.disabled = lightingControlLocked;
                    control.setAttribute('aria-disabled', lightingControlLocked ? 'true' : 'false');
                });
            }
            if (chevron) {
                chevron.textContent = 'keyboard_arrow_down';
                chevron.classList.toggle('is-collapsed', isCollapsed);
                chevron.title = isCollapsed ? 'Expand lighting controls' : 'Collapse lighting controls';
            }
            if (lockIcon) {
                lockIcon.textContent = lightingControlLocked ? 'lock' : 'lock_open_right';
                lockIcon.style.color = lightingControlLocked ? 'var(--lime-green)' : 'var(--high-impact-color)';
                lockIcon.title = lightingControlLocked ? 'Unlock lighting controls' : 'Lock lighting controls to prevent changes';
            }
        }

        function toggleLightingProfilesLock() {
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));
            lightingProfilesLocked = !lightingProfilesLocked;
            localStorage.setItem('lightingProfilesLocked', lightingProfilesLocked.toString());
            syncLightingProfilesCardUI();
            populateLightingProfileSelector();
        }

        function toggleLightingProfilesCard() {
            const isCollapsed = localStorage.getItem('lightingProfilesCardCollapsed') === 'true';
            localStorage.setItem('lightingProfilesCardCollapsed', isCollapsed ? 'false' : 'true');
            syncLightingProfilesCardUI();
        }

        function toggleLightingControlLock() {
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));
            lightingControlLocked = !lightingControlLocked;
            localStorage.setItem('lightingControlLocked', lightingControlLocked.toString());
            syncLightingControlCardUI();
        }

        function toggleLightingControlCard() {
            const isCollapsed = localStorage.getItem('lightingControlCardCollapsed') === 'true';
            localStorage.setItem('lightingControlCardCollapsed', isCollapsed ? 'false' : 'true');
            syncLightingControlCardUI();
        }

        function syncManageLightGroupsLockUI() {
            const card = document.getElementById('manageLightGroupsCard');
            const lockIcon = document.getElementById('manageLightGroupsLockIcon');
            const masterToggle = document.getElementById('lightsToggleLightGroups');
            const addGroupBtn = document.getElementById('addLightGroupBtn');
            const totalLedInput = document.getElementById('totalLEDCount');
            const colorOrderInput = document.getElementById('lightColorOrder');
            const controlsLocked = manageLightGroupsLocked || !isBleConnected();

            if (card) card.classList.toggle('profile-card-locked', manageLightGroupsLocked);
            if (lockIcon) {
                lockIcon.textContent = manageLightGroupsLocked ? 'lock' : 'lock_open_right';
                lockIcon.style.color = manageLightGroupsLocked ? 'var(--lime-green)' : 'var(--high-impact-color)';
                lockIcon.title = manageLightGroupsLocked
                    ? 'Unlock light group controls'
                    : 'Lock light group controls';
            }
            if (masterToggle) {
                masterToggle.disabled = controlsLocked;
                masterToggle.setAttribute('aria-disabled', controlsLocked ? 'true' : 'false');
            }
            if (addGroupBtn) {
                addGroupBtn.disabled = controlsLocked;
                addGroupBtn.setAttribute('aria-disabled', controlsLocked ? 'true' : 'false');
            }
            if (totalLedInput) {
                totalLedInput.disabled = controlsLocked;
                totalLedInput.setAttribute('aria-disabled', controlsLocked ? 'true' : 'false');
            }
            if (colorOrderInput) {
                colorOrderInput.disabled = controlsLocked;
                colorOrderInput.setAttribute('aria-disabled', controlsLocked ? 'true' : 'false');
            }
        }

        function toggleManageLightGroupsLock() {
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));
            manageLightGroupsLocked = !manageLightGroupsLocked;
            localStorage.setItem('manageLightGroupsLocked', manageLightGroupsLocked.toString());
            syncManageLightGroupsLockUI();
            renderLightGroupsList();
        }

        function syncLightStripConfigLockUI() {
            const card = document.getElementById('lightStripConfigCard');
            const lockIcon = document.getElementById('lightStripConfigLockIcon');
            const totalLedInput = document.getElementById('totalLEDCount');
            const colorOrderInput = document.getElementById('lightColorOrder');
            const controlsLocked = manageLightGroupsLocked;

            if (card) card.classList.toggle('profile-card-locked', lightStripConfigLocked);
            if (lockIcon) {
                lockIcon.textContent = lightStripConfigLocked ? 'lock' : 'lock_open_right';
                lockIcon.style.color = lightStripConfigLocked ? 'var(--lime-green)' : 'var(--high-impact-color)';
                lockIcon.title = lightStripConfigLocked
                    ? 'Unlock light strip configuration'
                    : 'Lock light strip configuration';
            }
            if (totalLedInput) {
                totalLedInput.disabled = controlsLocked;
                totalLedInput.setAttribute('aria-disabled', controlsLocked ? 'true' : 'false');
            }
            if (colorOrderInput) {
                colorOrderInput.disabled = controlsLocked;
                colorOrderInput.setAttribute('aria-disabled', controlsLocked ? 'true' : 'false');
            }
        }

        function toggleLightStripConfigLock() {
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));
            // Light Strip Config card removed; function now does nothing.
        }

        function populateLightingProfileSelector() {
            const container = document.getElementById('ltProfileList');
            if (!container) return;
            container.innerHTML = '';

            if (!lightingProfiles || lightingProfiles.length === 0) {
                const msg = document.createElement('div');
                msg.className = 'text-muted text-center py-2';
                msg.style.fontSize = '0.875rem';
                msg.textContent = 'No profiles saved yet';
                container.appendChild(msg);
                syncLightingProfileActionButtons();
                syncLightingProfilesCardUI();
                return;
            }

            lightingProfiles.forEach(p => {
                const row = document.createElement('div');
                row.className = 'drv-profile-item d-flex align-items-center justify-content-between px-2 py-1';
                row.dataset.profileIndex = p.index;
                const isActive = Number(p.index) === Number(activeLightingProfileIndex);
                if (isActive) {
                    row.style.cssText = 'background:rgba(200,168,0,0.15);border-radius:6px;border:1px solid #c8a800;';
                }

                const nameWrap = document.createElement('div');
                nameWrap.className = 'd-flex align-items-center flex-grow-1';

                const activeDotSlot = document.createElement('span');
                activeDotSlot.setAttribute('aria-hidden', 'true');
                activeDotSlot.style.cssText = 'display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;flex:0 0 10px;background:' + (isActive ? 'var(--lime-green)' : 'transparent') + ';';

                const nameBtn = document.createElement('button');
                nameBtn.type = 'button';
                nameBtn.className = 'btn btn-link p-0 text-start text-decoration-none flex-grow-1';
                nameBtn.style.cssText = 'color:' + (isActive ? '#c8a800' : '#fff') + ';font-size:0.9rem;';
                nameBtn.textContent = p.name;
                nameBtn.disabled = lightingProfileBusy || lightingProfilesLocked;
                nameBtn.addEventListener('click', () => selectLightingProfile(p.index));

                nameWrap.appendChild(activeDotSlot);
                nameWrap.appendChild(nameBtn);

                const metaWrap = document.createElement('div');
                metaWrap.className = 'd-flex align-items-center gap-2';
                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'btn btn-link p-0 ms-2';
                delBtn.style.cssText = 'color:#888;font-size:1rem;';
                delBtn.title = 'Delete profile';
                delBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1.1rem;vertical-align:middle;">delete</span>';
                delBtn.disabled = lightingProfileBusy || lightingProfilesLocked;
                delBtn.addEventListener('click', () => confirmDeleteLightingProfile(p.index));

                row.appendChild(nameWrap);
                row.appendChild(metaWrap);
                row.appendChild(delBtn);
                container.appendChild(row);
            });
            syncLightingProfileActionButtons();
            syncLightingProfilesCardUI();
            updateDashboardActiveLightingProfile();
        }

        function hydrateLightGroupsFromActiveProfile(profileData) {
            if (!profileData) return;
            const groups = Array.isArray(profileData.groups) ? profileData.groups : [];
            lightGroups = groups.map(g => ({
                id: createLightGroupId(),
                name: g.name || `Group ${g.id}`,
                indices: normalizeLedIndices(Array.isArray(g.indices) ? g.indices : g.leds),
                brightness: Math.round((Number(g.brightness ?? 100) * 255) / 100),
                color: (g.color_primary || '#ffffff').toLowerCase(),
                color2: (g.color_secondary || '#000000').toLowerCase(),
                pattern: (g.effect || 'solid').toLowerCase(),
                effect_speed: Number(g.effect_speed ?? 50),
                effect_intensity: Number(g.effect_intensity ?? 100),
                enabled: !!g.enabled
            }));
            saveLightGroups(false);
            applyLightsHierarchyToHardware();
        }

        async function selectLightingProfile(index) {
            if (lightingProfilesLocked) {
                toast.warning('Lighting profiles are locked. Unlock to make changes.');
                return;
            }
            const profile = lightingProfiles.find(p => Number(p.index) === Number(index));
            if (!profile) { toast.warning('Lighting profile not found'); return; }
            if (!profile.groups) {
                toast.warning(`"${profile.name}" has no saved groups yet. Update the profile first.`);
                return;
            }
            activeLightingProfileIndex = Number(index);
            saveLocalLightingProfiles();
            populateLightingProfileSelector();
            updateDashboardActiveLightingProfile();
            lightGroups = JSON.parse(JSON.stringify(profile.groups)).map(normalizeLightGroup);
            ensureLightGroupIds();
            saveLightGroups(false);
            renderLightGroupsList();
            lightingGroupsDirty = false;
            syncLightingProfileActionButtons();
            if (isBleConnected()) {
                try {
                    await pushAllLightGroupsToESP32(lightGroups);
                    await pushSystemCommand('lights_master', { enabled: getMasterLightsEnabled() });
                    toast.success(`Loaded lighting profile "${profile.name}"`);
                } catch (e) {
                    toast.warning(`Profile set locally. Push failed: ${e.message}`);
                }
            } else {
                toast.success(`Profile "${profile.name}" loaded. Connect to apply to truck.`);
            }
        }

        async function saveAsNewLightingProfile() {
            if (lightingProfilesLocked) {
                toast.warning('Lighting profiles are locked. Unlock to make changes.');
                return;
            }
            let targetSlot, profileName;
            if (lightingProfiles.length >= MAX_LIGHTING_PROFILES) {
                targetSlot = await showProfileOverwriteDialog(lightingProfiles);
                if (targetSlot == null) return;
                const existing = lightingProfiles.find(p => Number(p.index) === Number(targetSlot));
                profileName = await showProfileNameDialog(existing ? existing.name : '');
            } else {
                profileName = await showProfileNameDialog();
                if (!profileName) return;
                const usedSlots = new Set(lightingProfiles.map(p => Number(p.index)));
                targetSlot = 0;
                while (usedSlots.has(targetSlot) && targetSlot < MAX_LIGHTING_PROFILES) targetSlot++;
            }
            if (!profileName) return;
            const snapshot = {
                index: Number(targetSlot),
                name: profileName,
                groups: JSON.parse(JSON.stringify(lightGroups))
            };
            const existingIdx = lightingProfiles.findIndex(p => Number(p.index) === Number(targetSlot));
            if (existingIdx >= 0) {
                lightingProfiles[existingIdx] = snapshot;
            } else {
                lightingProfiles.push(snapshot);
                lightingProfiles.sort((a, b) => Number(a.index) - Number(b.index));
            }
            activeLightingProfileIndex = Number(targetSlot);
            saveLocalLightingProfiles();
            populateLightingProfileSelector();
            updateDashboardActiveLightingProfile();
            lightingGroupsDirty = false;
            syncLightingProfileActionButtons();
            toast.success(`Saved lighting profile "${profileName}"`);
        }

        async function updateActiveLightingProfile() {
            if (lightingProfilesLocked) {
                toast.warning('Lighting profiles are locked. Unlock to make changes.');
                return;
            }
            const active = lightingProfiles.find(p => Number(p.index) === Number(activeLightingProfileIndex));
            if (!active) { toast.warning('No active lighting profile selected. Save a profile first.'); return; }
            const idx = lightingProfiles.findIndex(p => Number(p.index) === Number(activeLightingProfileIndex));
            lightingProfiles[idx] = {
                ...active,
                groups: JSON.parse(JSON.stringify(lightGroups))
            };
            saveLocalLightingProfiles();
            lightingGroupsDirty = false;
            syncLightingProfileActionButtons();
            toast.success(`Updated lighting profile "${active.name}"`);
        }

        async function discardLightingProfileChanges() {
            const active = lightingProfiles.find(p => Number(p.index) === Number(activeLightingProfileIndex));
            if (active && Array.isArray(active.groups)) {
                lightGroups = JSON.parse(JSON.stringify(active.groups)).map(normalizeLightGroup);
                ensureLightGroupIds();
                saveLightGroups(false);
                renderLightGroupsList();
                if (isBleConnected()) {
                    try {
                        await pushAllLightGroupsToESP32(lightGroups);
                        await pushSystemCommand('lights_master', { enabled: getMasterLightsEnabled() });
                    } catch (error) {
                        console.warn('Failed to apply discarded lighting snapshot to hardware:', error?.message || error);
                    }
                }
            }
            lightingGroupsDirty = false;
            syncLightingProfileActionButtons();
        }

        async function confirmDeleteLightingProfile(index) {
            if (lightingProfilesLocked) {
                toast.warning('Lighting profiles are locked. Unlock to make changes.');
                return;
            }
            const profile = lightingProfiles.find(p => Number(p.index) === Number(index));
            if (!profile) return;
            if (lightingProfiles.length <= 1) {
                toast.warning('Cannot delete the last remaining lighting profile.');
                return;
            }
            const confirmed = await new Promise(resolve => {
                const existing = document.getElementById('lt-profile-delete-overlay');
                if (existing) existing.remove();
                const overlay = document.createElement('div');
                overlay.id = 'lt-profile-delete-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
                overlay.innerHTML = `
                  <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
                    <h5 style="margin:0 0 12px;color:#fff;">Delete Lighting Profile</h5>
                    <p style="margin:0 0 20px;color:#aaa;font-size:0.9rem;">Delete <strong style="color:#fff;">${profile.name.replace(/</g, '&lt;')}</strong>? This cannot be undone.</p>
                    <div style="display:flex;gap:8px;">
                                            <button id="ltd-cancel" style="flex:1;padding:10px;border:none;border-radius:8px;background:#333;color:#aaa;border:1px solid #555;cursor:pointer;">Cancel</button>
                                            <button id="ltd-delete" style="flex:1;padding:10px;border:none;border-radius:8px;background:#c0392b;color:#fff;font-weight:600;cursor:pointer;">Delete</button>
                    </div>
                  </div>`;
                document.body.appendChild(overlay);
                overlay.querySelector('#ltd-delete').onclick = () => { overlay.remove(); resolve(true); };
                overlay.querySelector('#ltd-cancel').onclick = () => { overlay.remove(); resolve(false); };
            });
            if (!confirmed) return;
            const wasActive = Number(activeLightingProfileIndex) === Number(index);
            lightingProfiles = lightingProfiles.filter(p => Number(p.index) !== Number(index));
            if (wasActive || !lightingProfiles.some(p => Number(p.index) === Number(activeLightingProfileIndex))) {
                activeLightingProfileIndex = Number(lightingProfiles[0].index);
            }
            saveLocalLightingProfiles();
            populateLightingProfileSelector();
            updateDashboardActiveLightingProfile();
            toast.success('Lighting profile deleted');
        }

        window.selectLightingProfile = selectLightingProfile;
        window.saveAsNewLightingProfile = saveAsNewLightingProfile;
        window.updateActiveLightingProfile = updateActiveLightingProfile;
        window.confirmDeleteLightingProfile = confirmDeleteLightingProfile;

        function saveLightGroups(pushToHardware = true) {
            ensureLightGroupIds();
            writeVehicleScopedStorage(LIGHT_GROUPS_STORAGE_KEY, JSON.stringify(lightGroups));
            renderLightGroupsList();

            if (pushToHardware) {
                lightingGroupsDirty = true;
                syncLightingProfileActionButtons();
                applyLightsHierarchyToHardware();
            }
        }

        function getMasterLightsEnabled() {
            return readVehicleScopedStorage(LIGHT_MASTER_STORAGE_KEY, { migrateLegacy: false }) === 'true';
        }

        function buildBasicMasterTestGroupPayload() {
            const leds = Array.from({ length: BASIC_LIGHTING_TEST_LED_COUNT }, (_, i) => i);
            return {
                group: 0,
                name: 'Master Test Blue',
                enabled: true,
                color: BASIC_LIGHTING_TEST_COLOR,
                color2: '#000000',
                brightness: 100,
                effect: 'solid',
                speed: 128,
                intensity: 128,
                leds
            };
        }

        function setMasterLightsEnabled(isEnabled, applyNow = true) {
            // HARD GATE: Set electrical gate SYNCHRONOUSLY before any async BLE work.
            // This prevents any lights writes from being processed while master is OFF.
            lightsWriteGateEnabled = !!isEnabled;
            writeVehicleScopedStorage(LIGHT_MASTER_STORAGE_KEY, isEnabled ? 'true' : 'false');
            syncMasterLightSwitches(isEnabled);
            
            const statusMsg = `[Lights] Master ${isEnabled ? 'ON' : 'OFF'} requested (applyNow=${applyNow}, gate=${lightsWriteGateEnabled})`;
            console.log(statusMsg);
            appendToSettingsConsoleCard(statusMsg, isEnabled ? 'info' : 'warn');
            
            if (applyNow) {
                if (!isEnabled) {
                    // Basic, deterministic OFF path: disable output and clear runtime groups.
                    return Promise.resolve(pushSystemCommand('lights_master', { enabled: false }))
                    .then(() => {
                        appendToSettingsConsoleCard('[Lights] lights_master false submitted', 'info');
                        return pushSystemCommand('lights_clear_all', {});
                    })
                    .then(() => {
                        appendToSettingsConsoleCard('[Lights] lights_clear_all submitted', 'info');
                        lastPushedLightsMasterEnabled = false;
                        lastPushedLightGroupCount = 0;
                        lastPushedLightGroupSignatures = Array(LIGHTS_ENGINE_MAX_GROUPS).fill('');
                    })
                    .catch(error => {
                        const msg = `[Lights] Master OFF failed: ${String(error?.message || error)}`;
                        console.error(msg, error);
                        appendToSettingsConsoleCard(msg, 'error');
                        toast.error('Failed to apply master light switch state.');
                    });
                }

                // ON path for core testing: single known blue group on LEDs 0-10.
                // Gate is already true from above; group write will be allowed.
                return Promise.resolve(pushSystemCommand('lights_master', { enabled: true }))
                .then(() => {
                    appendToSettingsConsoleCard('[Lights] lights_master true submitted', 'info');
                    return pushLightsPayload(buildBasicMasterTestGroupPayload());
                })
                .then(() => {
                    appendToSettingsConsoleCard('[Lights] Blue test group (LEDs 0-8) submitted', 'info');
                    lastPushedLightsMasterEnabled = true;
                    lastPushedLightGroupCount = 1;
                    lastPushedLightGroupSignatures = Array(LIGHTS_ENGINE_MAX_GROUPS).fill('');
                })
                .catch(error => {
                    const msg = `[Lights] Master ON failed: ${String(error?.message || error)}`;
                    console.error(msg, error);
                    appendToSettingsConsoleCard(msg, 'error');
                    toast.error('Failed to apply master light switch state.');
                });
            }
            return Promise.resolve();
        }

        // ==================== Basic Lights Test (STAGE 1) ====================
        // Sends lights_basic directly to firmware, bypassing LightsEngine,
        // pushSystemCommand gates, and the master write gate entirely.
        // Purpose: diagnose whether the BLE → firmware → NeoPixel chain works.

        let _basicLightsMasterOn = false;
        let _basicLightsColor = '#0000ff';
        let _basicLightsBri = 100;

        async function _sendBasicLights() {
            if (!bleManager || !bleManager.isConnected) {
                notifyBasicLightsStatus('Not connected.', 'warning');
                return;
            }
            const hex = (_basicLightsColor || '#0000ff').replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16) || 0;
            const g = parseInt(hex.substring(2, 4), 16) || 0;
            const b = parseInt(hex.substring(4, 6), 16) || 0;
            try {
                // Get color order from dropdown
                let colorOrder = 'grb';
                const colorOrderInput = document.getElementById('lightColorOrder');
                if (colorOrderInput && colorOrderInput.value) {
                    colorOrder = colorOrderInput.value;
                }
                await bleManager.sendSystemCommand('lights_color_order', { order: colorOrder });
                await bleManager.sendSystemCommand('lights_basic', {
                    on:  _basicLightsMasterOn,
                    r, g, b,
                    bri: Number(_basicLightsBri)
                });
                const msg = _basicLightsMasterOn
                    ? `Sent ON — ${colorOrder}(${r},${g},${b}) @ ${_basicLightsBri}%`
                    : 'Sent OFF';
                notifyBasicLightsStatus(msg, 'success');
                console.log('[BasicLights]', msg);
            } catch (e) {
                const msg = `Send failed: ${e?.message || e}`;
                notifyBasicLightsStatus(msg, 'error', { duration: 5000 });
                console.error('[BasicLights]', msg);
            }
        }

        window.basicLightsToggle = async function(btn) {
            _basicLightsMasterOn = !_basicLightsMasterOn;
            btn.setAttribute('aria-pressed', _basicLightsMasterOn ? 'true' : 'false');
            const icon = btn.querySelector('.material-symbols-outlined');
            if (icon) icon.textContent = _basicLightsMasterOn ? 'lightbulb' : 'light_off';
            btn.classList.toggle('btn-warning', _basicLightsMasterOn);
            btn.classList.toggle('btn-outline-secondary', !_basicLightsMasterOn);
            await _sendBasicLights();
        };

        window.basicLightsColorChange = async function(value) {
            _basicLightsColor = value;
            const swatch = document.getElementById('basicLightsColorSwatch');
            if (swatch) swatch.style.background = value;
            if (_basicLightsMasterOn) await _sendBasicLights();
        };

        window.basicLightsBriChange = async function(value) {
            _basicLightsBri = Number(value);
            const label = document.getElementById('basicLightsBriLabel');
            if (label) label.textContent = `${value}%`;
            if (_basicLightsMasterOn) await _sendBasicLights();
        };

        window.basicLightsDiagStart = async function() {
            if (!bleManager || !bleManager.isConnected) {
                notifyBasicLightsStatus('Not connected.', 'warning');
                return;
            }
            try {
                _basicLightsMasterOn = false;
                await bleManager.sendSystemCommand('lights_color_order', { order: 'rgb' });
                await bleManager.sendSystemCommand('lights_diag', { on: true, intervalMs: 500 });
                notifyBasicLightsStatus('Diag running: RED -> GREEN -> BLUE -> WHITE -> OFF', 'info');
                console.log('[BasicLights] Diag cycle started');
            } catch (e) {
                const msg = `Diag start failed: ${e?.message || e}`;
                notifyBasicLightsStatus(msg, 'error', { duration: 5000 });
                console.error('[BasicLights]', msg);
            }
        };

        window.basicLightsDiagStop = async function() {
            if (!bleManager || !bleManager.isConnected) {
                notifyBasicLightsStatus('Not connected.', 'warning');
                return;
            }
            try {
                await bleManager.sendSystemCommand('lights_diag', { on: false });
                await bleManager.sendSystemCommand('lights_basic', { on: false, r: 0, g: 0, b: 0, bri: 0 });
                notifyBasicLightsStatus('Diag stopped. Strip held OFF.', 'success');
                console.log('[BasicLights] Diag cycle stopped');
            } catch (e) {
                const msg = `Diag stop failed: ${e?.message || e}`;
                notifyBasicLightsStatus(msg, 'error', { duration: 5000 });
                console.error('[BasicLights]', msg);
            }
        };

        function _resetBasicLightsUI() {
            _basicLightsMasterOn = false;
            const btn = document.getElementById('basicLightsMasterToggle');
            if (btn) {
                btn.setAttribute('aria-pressed', 'false');
                btn.classList.remove('btn-warning');
                btn.classList.add('btn-outline-secondary');
                const icon = btn.querySelector('.material-symbols-outlined');
                if (icon) icon.textContent = 'light_off';
            }
            _basicScenarioStripEnabled = false;
            _syncBasicScenarioButtons();
            if (bleManager && bleManager.isConnected) {
                bleManager.sendSystemCommand('lights_diag', { on: false }).catch(() => {});
            }
        }

        // ==================== Basic Lights Test — Per-LED Grid ====================

        const BASIC_LED_GRID_COUNT = 9;
        const _basicLedColors = Array(BASIC_LED_GRID_COUNT).fill('#ffffff');
        let _basicLedGridSelected = 0;

        function _renderBasicLedGrid() {
            const grid = document.getElementById('basicLedGrid');
            if (!grid) return;
            grid.innerHTML = '';
            for (let i = 0; i < BASIC_LED_GRID_COUNT; i++) {
                const cell = document.createElement('div');
                const isSelected = i === _basicLedGridSelected;
                cell.style.cssText = [
                    'aspect-ratio:1/1',
                    'border-radius:6px',
                    'cursor:pointer',
                    'position:relative',
                    'min-height:28px',
                    `background:${_basicLedColors[i]}`,
                    `border:2px solid ${isSelected ? '#f9b233' : '#3e455a'}`,
                    isSelected ? 'box-shadow:0 0 0 2px rgba(249,178,51,0.35)' : ''
                ].join(';');
                cell.title = `LED ${i}`;
                cell.onclick = (function(idx) { return function() { _basicLedGridSelectLed(idx); }; })(i);
                const lbl = document.createElement('span');
                lbl.textContent = i;
                lbl.style.cssText = 'position:absolute;bottom:2px;right:4px;font-size:10px;font-weight:bold;color:#111;text-shadow:0 0 2px rgba(255,255,255,0.8);';
                cell.appendChild(lbl);
                grid.appendChild(cell);
            }
        }

        function _basicLedGridSelectLed(index) {
            _basicLedGridSelected = index;
            const picker = document.getElementById('basicLedGridColorPicker');
            if (picker) picker.value = _basicLedColors[index];
            const swatch = document.getElementById('basicLedGridColorSwatch');
            if (swatch) swatch.style.background = _basicLedColors[index];
            const label = document.getElementById('basicLedGridSelectedLabel');
            if (label) label.textContent = `LED ${index} selected`;
            _renderBasicLedGrid();
        }

        window.basicLedGridPickerChange = function(value) {
            _basicLedColors[_basicLedGridSelected] = value;
            const swatch = document.getElementById('basicLedGridColorSwatch');
            if (swatch) swatch.style.background = value;
            _renderBasicLedGrid();
        };

        window.basicLedGridApplyAll = function() {
            const picker = document.getElementById('basicLedGridColorPicker');
            const color = picker ? picker.value : '#ffffff';
            for (let i = 0; i < BASIC_LED_GRID_COUNT; i++) _basicLedColors[i] = color;
            _renderBasicLedGrid();
        };

        window.basicLedGridSend = async function() {
            if (!bleManager || !bleManager.isConnected) {
                notifyBasicLightsStatus('Not connected.', 'warning');
                return;
            }
            try {
                // Open the app-side gate and enable master output on device
                lightsWriteGateEnabled = true;
                await bleManager.sendSystemCommand('lights_master', { enabled: true });
                // Small delay to let firmware process
                await new Promise(r => setTimeout(r, 50));
                // Send each LED as its own group slot so they coexist on the strip
                for (let i = 0; i < BASIC_LED_GRID_COUNT; i++) {
                    const hex = (_basicLedColors[i] || '#ffffff').replace('#', '');
                    const r = parseInt(hex.substring(0, 2), 16) || 0;
                    const g = parseInt(hex.substring(2, 4), 16) || 0;
                    const b = parseInt(hex.substring(4, 6), 16) || 0;
                    await pushLightsPayload({
                        group: i,
                        name: `LED${i}`,
                        enabled: true,
                        color: _basicLedColors[i],
                        color2: '#000000',
                        brightness: 100,
                        effect: 'solid',
                        speed: 128,
                        intensity: 128,
                        leds: [i]
                    });
                    // Small delay between groups to avoid overwhelming the firmware
                    if (i < BASIC_LED_GRID_COUNT - 1) {
                        await new Promise(r => setTimeout(r, 20));
                    }
                }
                notifyBasicLightsStatus(`Per-LED colors applied to strip (${BASIC_LED_GRID_COUNT} LEDs).`, 'success');
            } catch (e) {
                const msg = `Per-LED send failed: ${e?.message || e}`;
                notifyBasicLightsStatus(msg, 'error', { duration: 5000 });
                console.error('[BasicLights]', msg);
            }
        };

        // ==================== Basic Lights Test — Two-Group Test ====================

        let _basicGroupAColor = '#ff0000';
        let _basicGroupBColor = '#0000ff';

        function _parseGroupLedIndices(inputId) {
            const input = document.getElementById(inputId);
            if (!input || !input.value.trim()) return [];
            return input.value.split(',')
                .map(s => parseInt(s.trim(), 10))
                .filter(n => Number.isFinite(n) && n >= 0 && n < MAX_LIGHTS_TOTAL_LEDS);
        }

        window.basicGroupAColorChange = function(value) {
            _basicGroupAColor = value;
            const swatch = document.getElementById('basicGroupAColorSwatch');
            if (swatch) swatch.style.background = value;
        };

        window.basicGroupBColorChange = function(value) {
            _basicGroupBColor = value;
            const swatch = document.getElementById('basicGroupBColorSwatch');
            if (swatch) swatch.style.background = value;
        };

        window.basicGroupsSend = async function() {
            if (!bleManager || !bleManager.isConnected) {
                notifyBasicLightsStatus('Not connected.', 'warning');
                return;
            }
            const ledsA = _parseGroupLedIndices('basicGroupALeds');
            const ledsB = _parseGroupLedIndices('basicGroupBLeds');
            if (!ledsA.length && !ledsB.length) {
                notifyBasicLightsStatus('No valid LED indices in either group.', 'warning');
                return;
            }
            // Overlap check — warn but don't block
            const setA = new Set(ledsA);
            const overlap = ledsB.filter(n => setA.has(n));
            if (overlap.length > 0) {
                console.warn('[BasicGroups] Overlapping LED indices detected:', overlap);
                appendToSettingsConsoleCard(`[Lights] Warning: overlapping LEDs between groups: ${overlap.join(', ')}`, 'warn');
            }
            try {
                // Open the app-side gate and enable master output on device
                lightsWriteGateEnabled = true;
                await bleManager.sendSystemCommand('lights_master', { enabled: true });
                if (ledsA.length) {
                    await pushLightsPayload({
                        group: 0, name: 'Group A', enabled: true,
                        color: _basicGroupAColor, color2: '#000000',
                        brightness: 100, effect: 'solid', speed: 128, intensity: 128,
                        leds: ledsA
                    });
                }
                if (ledsB.length) {
                    await pushLightsPayload({
                        group: 1, name: 'Group B', enabled: true,
                        color: _basicGroupBColor, color2: '#000000',
                        brightness: 100, effect: 'solid', speed: 128, intensity: 128,
                        leds: ledsB
                    });
                }
                const msg = `Groups sent — A: [${ledsA}] ${_basicGroupAColor}  B: [${ledsB}] ${_basicGroupBColor}${overlap.length ? ' ⚠ overlap' : ''}`;
                notifyBasicLightsStatus(msg, overlap.length ? 'warning' : 'success');
                appendToSettingsConsoleCard('[Lights] ' + msg, overlap.length ? 'warn' : 'info');
            } catch (e) {
                const msg = `Groups send failed: ${e?.message || e}`;
                notifyBasicLightsStatus(msg, 'error', { duration: 5000 });
                console.error('[BasicLights]', msg);
            }
        };

        window.basicGroupsClear = async function() {
            if (!bleManager || !bleManager.isConnected) {
                notifyBasicLightsStatus('Not connected.', 'warning');
                return;
            }
            try {
                await bleManager.sendSystemCommand('lights_master', { enabled: false });
                await bleManager.sendSystemCommand('lights_clear_all', {});
                _basicScenarioStripEnabled = false;
                _syncBasicScenarioButtons();
                notifyBasicLightsStatus('Groups cleared. Strip off.', 'success');
            } catch (e) {
                notifyBasicLightsStatus(`Clear failed: ${e?.message || e}`, 'error', { duration: 5000 });
            }
        };

        // ==================== Basic Lights Test — Step 4 Real Scenarios ====================

        var _basicScenarioStripEnabled = false;
        const BASIC_SCENARIO_CONFIG_KEY = 'basicScenarioConfigV1';
        const BASIC_SCENARIO_BRIGHTNESS_MAX = 255;
        const BASIC_SCENARIO_DEFAULT_LED_COUNT = 9;
        var _basicScenarioConfig = null;
        var _basicLedMapModalInstance = null;
        var _basicScenarioGroupModalInstance = null;
        var _basicScenarioGroupEditMode = null;
        var _basicScenarioBrightnessSliderInstance = null;
        var _basicScenarioBrightnessSyncing = false;
        var _basicScenarioBrightnessCurrent = 100;
        var _basicScenarioFxIntensitySliderInstance = null;
        var _basicScenarioFxIntensitySyncing = false;
        var _basicScenarioFxIntensityCurrent = 128;
        var _basicScenarioLedCountSliderInstance = null;
        var _basicScenarioLedCountSyncing = false;
        var _basicScenarioLedCountCurrent = 9;
        var _basicScenarioBrightnessApplyTimer = null;
        var _basicLedMapActiveScenario = 'brake';
        var _basicLedMapDraftAssignment = {}; // { ledIndex: mode }
        var _basicLedMapDraftColors = {};     // { mode: hex }

        const _BASIC_SCENARIO_PRESET_DEFS = [
            { mode: 'brake',      label: 'Brake',      keys: ['brake'] },
            { mode: 'hazards',    label: 'Hazards',    keys: ['hazards'] },
            { mode: 'headlights', label: 'Headlights', keys: ['headlights'] },
            { mode: 'turn_left',  label: 'Turn Left',  keys: ['turn_left'] },
            { mode: 'turn_right', label: 'Turn Right', keys: ['turn_right'] },
            { mode: 'reverse',    label: 'Reverse',    keys: ['reverse'] },
        ];

        function _getBasicScenarioCardDefs(configLike = null) {
            const source = configLike && typeof configLike === 'object' ? configLike : _basicScenarioConfig;
            if (source && Array.isArray(source.cards) && source.cards.length) return source.cards;
            return _BASIC_SCENARIO_PRESET_DEFS;
        }

        function _getBasicScenarioCardByMode(mode, configLike = null) {
            return _getBasicScenarioCardDefs(configLike).find(card => card.mode === mode) || null;
        }

        function _getBasicScenarioDisplayName(mode, configLike = null) {
            const cfg = configLike && typeof configLike === 'object' ? configLike : (_basicScenarioConfig || {});
            const card = _getBasicScenarioCardByMode(mode, cfg);
            if (!card) return String(mode || 'Group');
            return (cfg.customNames && cfg.customNames[mode]) || card.label;
        }

        function _sanitizeBasicScenarioGroupLabel(value, fallback = 'Group') {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            if (!text) return String(fallback || 'Group');
            return text.slice(0, 24);
        }

        function _makeBasicScenarioModeFromLabel(label, existing = new Set()) {
            const base = String(label || 'group')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '') || 'group';
            let mode = base;
            let i = 2;
            while (existing.has(mode)) {
                mode = `${base}_${i}`;
                i++;
            }
            return mode;
        }

        function _basicScenarioMaxGroupCount(configLike = null) {
            const cfg = configLike && typeof configLike === 'object' ? configLike : (_basicScenarioConfig || _getDefaultBasicScenarioConfig());
            const ledCount = _resolveBasicScenarioLedCount(cfg.ledCount);
            return Math.max(1, ledCount);
        }

        function _basicScenarioPercentToBrightness(percent) {
            const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
            return Math.round((safePercent / 100) * BASIC_SCENARIO_BRIGHTNESS_MAX);
        }

        function _basicScenarioBrightnessToPercent(brightness) {
            const safeBrightness = Math.max(0, Math.min(BASIC_SCENARIO_BRIGHTNESS_MAX, Math.round(Number(brightness) || 0)));
            return Math.round((safeBrightness / BASIC_SCENARIO_BRIGHTNESS_MAX) * 100);
        }

        function _syncBasicScenarioBrightnessUI(percent) {
            const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
            _basicScenarioBrightnessCurrent = safePercent;
            if (_basicScenarioBrightnessSliderInstance) {
                _basicScenarioBrightnessSyncing = true;
                _basicScenarioBrightnessSliderInstance.value = safePercent;
                _basicScenarioBrightnessSyncing = false;
            }
            const label = document.getElementById('basicScenarioBrightnessLabel');
            if (label) label.textContent = `${safePercent}%`;
        }

        function _resolveBasicScenarioLedCount(value) {
            const parsed = Math.floor(Number(value));
            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_LIGHTS_TOTAL_LEDS) return parsed;
            return BASIC_SCENARIO_DEFAULT_LED_COUNT;
        }

        function _sanitizeBasicScenarioColorOrder(value, fallback = 'rgb') {
            const v = String(value || '').trim().toLowerCase();
            if (['rgb', 'grb', 'rbg', 'gbr', 'brg', 'bgr'].includes(v)) return v;
            return fallback;
        }

        function _syncBasicScenarioCountAndColorOrderUI(config) {
            const colorOrderEl = document.getElementById('basicScenarioColorOrder');
            const safeCount = _resolveBasicScenarioLedCount(config?.ledCount);
            const safeOrder = _sanitizeBasicScenarioColorOrder(config?.colorOrder, 'rgb');
            _basicScenarioLedCountCurrent = safeCount;
            const label = document.getElementById('basicScenarioLedCountLabel');
            if (label) label.textContent = String(safeCount);
            if (_basicScenarioLedCountSliderInstance && typeof _basicScenarioLedCountSliderInstance.value === 'function') {
                _basicScenarioLedCountSyncing = true;
                _basicScenarioLedCountSliderInstance.value([0, safeCount]);
                _basicScenarioLedCountSyncing = false;
            }
            if (colorOrderEl) colorOrderEl.value = safeOrder;
        }

        function _trimBasicScenarioCardsToLimit(configLike) {
            const config = configLike && typeof configLike === 'object'
                ? configLike
                : (_basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig()));
            const cards = Array.isArray(config.cards) ? config.cards.slice() : _BASIC_SCENARIO_PRESET_DEFS.slice();
            const maxCards = _basicScenarioMaxGroupCount(config);
            if (cards.length <= maxCards) return config;

            const keptCards = cards.slice(0, maxCards);
            const keptModes = new Set(keptCards.map(card => card.mode));
            const trimmedAssignment = {};
            Object.entries(config.assignment || {}).forEach(([k, mode]) => {
                if (keptModes.has(mode)) trimmedAssignment[k] = mode;
            });

            const trimmedColors = {};
            const trimmedNames = {};
            keptCards.forEach(card => {
                if (config.colors && config.colors[card.mode]) trimmedColors[card.mode] = config.colors[card.mode];
                if (config.customNames && config.customNames[card.mode]) trimmedNames[card.mode] = config.customNames[card.mode];
            });

            return Object.assign({}, config, {
                cards: keptCards,
                assignment: trimmedAssignment,
                colors: trimmedColors,
                customNames: trimmedNames
            });
        }

        function _sanitizeBasicScenarioFx(value, fallback = 'solid') {
            const v = String(value || '').trim().toLowerCase();
            return (v === 'glitter' || v === 'solid') ? v : fallback;
        }

        function _syncBasicScenarioFxUI(config) {
            const fx = _sanitizeBasicScenarioFx(config?.fx, 'solid');
            const intensity = Math.max(0, Math.min(255, Math.round(Number(config?.fxIntensity) || 0)));
            const glitterColor = _sanitizeBasicScenarioHexColor(config?.glitterColor, '#f5f5f5');

            const fxSelect = document.getElementById('basicScenarioFx');
            const intensityRow = document.getElementById('basicScenarioFxIntensityRow');
            const intensitySlider = document.getElementById('basicScenarioFxIntensity');
            const intensityLabel = document.getElementById('basicScenarioFxIntensityLabel');
            const glitterRow = document.getElementById('basicScenarioGlitterColorRow');
            const glitterPicker = document.getElementById('basicScenarioGlitterColor');

            if (fxSelect) fxSelect.value = fx;
            if (intensityRow) intensityRow.style.display = fx === 'glitter' ? '' : 'none';
            _basicScenarioFxIntensityCurrent = intensity;
            if (_basicScenarioFxIntensitySliderInstance) {
                _basicScenarioFxIntensitySyncing = true;
                _basicScenarioFxIntensitySliderInstance.value = intensity;
                _basicScenarioFxIntensitySyncing = false;
            }
            if (intensityLabel) intensityLabel.textContent = String(intensity);
            if (glitterPicker) glitterPicker.value = glitterColor;
            if (glitterRow) glitterRow.style.display = fx === 'glitter' ? '' : 'none';
        }

        function _basicScenarioIndicesToCompactString(indices) {
            const values = Array.from(new Set((Array.isArray(indices) ? indices : [])
                .map(v => parseInt(v, 10))
                .filter(v => Number.isFinite(v) && v >= 0)
            )).sort((a, b) => a - b);
            if (!values.length) return '';

            const ranges = [];
            let start = values[0];
            let prev = values[0];
            for (let i = 1; i < values.length; i++) {
                const curr = values[i];
                if (curr === prev + 1) {
                    prev = curr;
                    continue;
                }
                ranges.push(start === prev ? String(start) : `${start}-${prev}`);
                start = curr;
                prev = curr;
            }
            ranges.push(start === prev ? String(start) : `${start}-${prev}`);
            return ranges.join(',');
        }

        function _sanitizeBasicScenarioHexColor(value, fallback) {
            const v = String(value || '').trim().toLowerCase();
            if (/^#[0-9a-f]{6}$/.test(v)) return v;
            return String(fallback || '#ffffff').toLowerCase();
        }

        function _parseBasicScenarioLedList(value, maxExclusive, fallback = []) {
            const parsed = parseLEDIndices(String(value || ''))
                .filter(n => Number.isFinite(n) && n >= 0 && n < maxExclusive);
            if (parsed.length > 0) return Array.from(new Set(parsed)).sort((a, b) => a - b);
            return Array.from(new Set((Array.isArray(fallback) ? fallback : [])
                .filter(n => Number.isFinite(n) && n >= 0 && n < maxExclusive)
            )).sort((a, b) => a - b);
        }

        function _basicScenarioLedBuckets(overrideLedCount = null) {
            const total = _resolveBasicScenarioLedCount(
                overrideLedCount ?? _basicScenarioConfig?.ledCount ?? BASIC_SCENARIO_DEFAULT_LED_COUNT
            );
            const splitA = Math.max(1, Math.ceil(total / 3));
            const splitB = Math.max(splitA + 1, Math.ceil((2 * total) / 3));
            const left = [];
            const center = [];
            const right = [];
            const rear = [];

            for (let i = 0; i < total; i++) {
                if (i < splitA) left.push(i);
                else if (i < splitB) center.push(i);
                else right.push(i);
                if (i >= Math.floor(total / 2)) rear.push(i);
            }

            return { total, left, center, right, rear };
        }

        function _getDefaultBasicScenarioConfig() {
            const buckets = _basicScenarioLedBuckets(BASIC_SCENARIO_DEFAULT_LED_COUNT);
            // Non-overlapping defaults: brake=rear, turn_left=left, turn_right=right, reverse=center
            // hazards starts empty so the user assigns deliberately
            const assignment = {};
            const addGroup = (mode, indices) => indices.forEach(i => { if (!(i in assignment)) assignment[i] = mode; });
            addGroup('brake',      buckets.rear.length   ? buckets.rear   : []);
            addGroup('turn_left',  buckets.left);
            addGroup('turn_right', buckets.right);
            addGroup('headlights', buckets.right);
            addGroup('reverse',    buckets.center);
            return {
                cards: _BASIC_SCENARIO_PRESET_DEFS.map(card => ({ mode: card.mode, label: card.label })),
                ledCount: BASIC_SCENARIO_DEFAULT_LED_COUNT,
                colorOrder: 'rgb',
                brightnessPercent: 100,
                assignment,
                colors: {
                    brake:      '#ff0000',
                    hazards:    '#ff8c00',
                    headlights: '#f5f5f5',
                    turn_left:  '#ff8c00',
                    turn_right: '#ff8c00',
                    reverse:    '#ffffff'
                },
                customNames: {},
                fx: 'solid',
                fxIntensity: 128,
                glitterColor: '#ffffff'
            };
        }

        function _normalizeBasicScenarioConfig(rawConfig) {
            const defaults = _getDefaultBasicScenarioConfig();
            const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
            const ledCount = _resolveBasicScenarioLedCount(raw.ledCount ?? defaults.ledCount);
            const colorOrder = _sanitizeBasicScenarioColorOrder(raw.colorOrder ?? defaults.colorOrder, defaults.colorOrder);
            const total = ledCount;
            const maxCards = Math.max(1, ledCount);
            const cardsSource = Array.isArray(raw.cards)
                ? raw.cards
                : defaults.cards;
            const cards = [];
            const seenModes = new Set();
            cardsSource.forEach((entry, idx) => {
                const label = _sanitizeBasicScenarioGroupLabel(entry?.label, `Group ${idx + 1}`);
                const desiredMode = String(entry?.mode || '').trim().toLowerCase();
                const mode = desiredMode && /^[a-z0-9_]+$/.test(desiredMode) && !seenModes.has(desiredMode)
                    ? desiredMode
                    : _makeBasicScenarioModeFromLabel(label, seenModes);
                if (seenModes.has(mode)) return;
                seenModes.add(mode);
                cards.push({ mode, label, keys: [mode] });
            });
            if (!cards.length && !Array.isArray(raw.cards)) {
                defaults.cards.forEach((card, idx) => {
                    if (cards.length >= maxCards) return;
                    cards.push({ mode: card.mode, label: card.label, keys: [card.mode] });
                });
            }
            if (cards.length > maxCards) cards.length = maxCards;
            const validModes = new Set(cards.map(c => c.mode));

            // Build assignment map — support both new format (raw.assignment) and old
            // per-scenario format (raw.brake.leds, raw.turn_left.leds, ...)
            const assignment = {};
            if (raw.assignment && typeof raw.assignment === 'object') {
                Object.entries(raw.assignment).forEach(([k, v]) => {
                    const idx = parseInt(k, 10);
                    if (Number.isFinite(idx) && idx >= 0 && idx < total && validModes.has(v)) {
                        assignment[idx] = v;
                    }
                });
            } else {
                // Migrate from old per-scenario format; first-listed scenario wins on overlap
                cards.map(card => card.mode).forEach(mode => {
                    const entry = raw[mode];
                    if (entry && Array.isArray(entry.leds)) {
                        entry.leds.forEach(idx => {
                            if (Number.isFinite(idx) && idx >= 0 && idx < total && !(idx in assignment)) {
                                assignment[idx] = mode;
                            }
                        });
                    }
                });
            }

            // Colors — prefer new raw.colors, fall back to old per-scenario color values
            const rawColors = raw.colors && typeof raw.colors === 'object' ? raw.colors : {};
            const colors = {};
            cards.forEach(card => {
                const mode = card.mode;
                const candidate = rawColors[mode] || raw[mode]?.color || defaults.colors[mode];
                colors[mode] = _sanitizeBasicScenarioHexColor(candidate, defaults.colors[mode]);
            });

            // Custom names — stored in localStorage
            const customNames = {};
            if (raw.customNames && typeof raw.customNames === 'object') {
                cards.forEach(card => {
                    const value = raw.customNames[card.mode];
                    if (typeof value === 'string' && value.trim()) {
                        customNames[card.mode] = _sanitizeBasicScenarioGroupLabel(value, card.label);
                    }
                });
            }

            const fx = _sanitizeBasicScenarioFx(raw.fx, defaults.fx);
            const fxIntensity = Math.max(0, Math.min(255, Math.round(Number(raw.fxIntensity ?? defaults.fxIntensity) || defaults.fxIntensity)));
            const glitterColor = _sanitizeBasicScenarioHexColor(raw.glitterColor, defaults.glitterColor);

            return {
                cards,
                ledCount,
                colorOrder,
                brightnessPercent: Math.max(0, Math.min(100, Math.round(
                    Number(raw.brightnessPercent ?? _basicScenarioBrightnessToPercent(
                        raw.brightness ?? _basicScenarioPercentToBrightness(defaults.brightnessPercent)
                    )) || defaults.brightnessPercent
                ))),
                assignment,
                colors,
                customNames,
                fx,
                fxIntensity,
                glitterColor
            };
        }

        function _readBasicScenarioConfigFromUI() {
            const current = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            const ledCount = _resolveBasicScenarioLedCount(_basicScenarioLedCountCurrent ?? current.ledCount);
            const colorOrder = _sanitizeBasicScenarioColorOrder(document.getElementById('basicScenarioColorOrder')?.value, current.colorOrder || 'rgb');
            const brightnessPercent = Math.max(0, Math.min(100, Math.round(
                Number(_basicScenarioBrightnessCurrent ?? document.getElementById('basicScenarioBrightness')?.value) || current.brightnessPercent
            )));
            const fx = _sanitizeBasicScenarioFx(document.getElementById('basicScenarioFx')?.value, current.fx || 'solid');
            const fxIntensity = Math.max(0, Math.min(255, Math.round(
                Number(_basicScenarioFxIntensityCurrent ?? document.getElementById('basicScenarioFxIntensity')?.value) || Number(current.fxIntensity) || 128
            )));
            const glitterColor = _sanitizeBasicScenarioHexColor(
                document.getElementById('basicScenarioGlitterColor')?.value,
                current.glitterColor || '#f5f5f5'
            );
            return Object.assign({}, current, { ledCount, colorOrder, brightnessPercent, fx, fxIntensity, glitterColor });
        }

        function _writeBasicScenarioConfigToUI(config) {
            _syncBasicScenarioCountAndColorOrderUI(config);
            _syncBasicScenarioBrightnessUI(config.brightnessPercent);
            _syncBasicScenarioFxUI(config);
            renderBasicScenarioList();
        }

        function _saveBasicScenarioConfig(config) {
            writeVehicleScopedStorage(BASIC_SCENARIO_CONFIG_KEY, JSON.stringify(config));
        }

        function renderBasicScenarioList() {
            const container = document.getElementById('basicScenarioList');
            if (!container) return;
            const config = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            const cards = _getBasicScenarioCardDefs(config);
            container.innerHTML = '';

            cards.forEach(card => {
                const item = document.createElement('div');
                item.className = 'basic-scenario-card-wrap';
                item.setAttribute('data-scenario-card', card.mode);

                const color = config.colors?.[card.mode] || '#888';
                const ledCount = Object.entries(config.assignment || {}).filter(([, m]) => m === card.mode).length;
                const displayName = _getBasicScenarioDisplayName(card.mode, config);

                item.innerHTML = `
                    <div class="basic-scenario-card" data-basic-scenario-mode="${card.mode}">
                    <div class="light-group-info">
                        <div class="light-group-name-row">
                            <div class="light-group-name">${displayName}</div>
                            <button type="button" class="light-group-details-toggle basic-scenario-inline-edit" title="Edit ${displayName}" onclick="event.stopPropagation(); basicOpenScenarioGroupModal('${card.mode}')">
                                <span class="material-symbols-outlined">edit</span>
                            </button>
                        </div>
                    </div>
                    <div class="light-group-controls">
                        <div class="basic-scenario-color-count-wrap" title="${displayName} assigned LEDs">
                            <span class="light-group-color-input basic-scenario-color-chip" style="background:${color};border-color:${color};"></span>
                            <span class="basic-scenario-color-count">${ledCount}</span>
                        </div>
                    </div>
                    </div>
                `;

                container.appendChild(item);
            });

            _syncBasicScenarioStripSwitch();
            syncLightingControlCardUI();
        }

        // ==================== LED Strip Map Modal ====================

        function _isColorDark(hex) {
            const h = (hex || '#000').replace('#', '');
            const r = parseInt(h.substring(0, 2), 16) || 0;
            const g = parseInt(h.substring(2, 4), 16) || 0;
            const b = parseInt(h.substring(4, 6), 16) || 0;
            return (r * 299 + g * 587 + b * 114) / 1000 < 140;
        }

        function _renderLedMapPalette() {
            const palette = document.getElementById('basicLedMapPalette');
            if (!palette) return;
            palette.innerHTML = '';
            const cards = _getBasicScenarioCardDefs();

            // "Clear" (unassign) pill
            const clearPill = document.createElement('button');
            clearPill.type = 'button';
            clearPill.className = 'basic-led-map-pill' + (_basicLedMapActiveScenario === null ? ' is-active' : '');
            clearPill.title = 'Tap LEDs to unassign them';
            clearPill.innerHTML = `<span class="basic-led-map-pill-swatch" style="background:#e5e7eb;border-color:#9ca3af;"></span><span class="basic-led-map-pill-name">Clear</span>`;
            clearPill.onclick = () => {
                _basicLedMapActiveScenario = null;
                _renderLedMapPalette();
                _renderLedMapGrid();
            };
            palette.appendChild(clearPill);

            cards.forEach(card => {
                const color = _basicLedMapDraftColors[card.mode] || '#888';
                const count = Object.values(_basicLedMapDraftAssignment).filter(m => m === card.mode).length;
                const isActive = _basicLedMapActiveScenario === card.mode;
                const displayName = _getBasicScenarioDisplayName(card.mode);
                const reverseIcon = card.reverse
                    ? '<span class="material-symbols-outlined basic-led-map-mode-icon basic-led-map-mode-icon--reverse">ac_unit</span> '
                    : '';

                const pill = document.createElement('button');
                pill.type = 'button';
                pill.className = 'basic-led-map-pill' + (isActive ? ' is-active' : '');
                pill.innerHTML = `<span class="basic-led-map-pill-swatch" style="background:${color};border-color:${color};"></span><span class="basic-led-map-pill-name">${reverseIcon}${displayName} <span class="basic-led-map-pill-count">${count}</span></span>`;
                pill.onclick = () => {
                    _basicLedMapActiveScenario = card.mode;
                    _renderLedMapPalette();
                    _renderLedMapGrid();
                };
                palette.appendChild(pill);
            });

            _syncLedMapSelectedColorInput();
        }

        function _syncLedMapSelectedColorInput() {
            const colorInput = document.getElementById('basicLedMapSelectedColor');
            const labelEl = document.getElementById('basicLedMapSelectedColorLabel');
            if (!colorInput) return;

            if (_basicLedMapActiveScenario === null) {
                colorInput.disabled = true;
                colorInput.value = '#e5e7eb';
                if (labelEl) labelEl.textContent = 'Clear mode selected';
                return;
            }

            const displayName = _getBasicScenarioDisplayName(_basicLedMapActiveScenario);
            const color = _basicLedMapDraftColors[_basicLedMapActiveScenario] || '#f5f5f5';
            colorInput.disabled = false;
            colorInput.value = color;
            if (labelEl) labelEl.textContent = displayName;
        }

        function _renderLedMapGrid() {
            const grid = document.getElementById('basicLedMapGrid');
            const metaEl = document.getElementById('basicLedMapMeta');
            if (!grid) return;

            const total = _basicScenarioLedBuckets().total;
            if (metaEl) {
                const assigned = Object.keys(_basicLedMapDraftAssignment)
                    .filter(k => { const i = parseInt(k, 10); return Number.isFinite(i) && i >= 0 && i < total && _basicLedMapDraftAssignment[k]; })
                    .length;
                const activeLabel = _basicLedMapActiveScenario
                    ? _getBasicScenarioDisplayName(_basicLedMapActiveScenario)
                    : 'Clear';
                metaEl.textContent = `${total} LEDs · ${assigned} assigned · ${total - assigned} free — painting: ${activeLabel}`;
            }

            grid.innerHTML = '';
            const cols = total > 15 ? 10 : total > 8 ? 9 : total;
            grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

            for (let i = 0; i < total; i++) {
                const mode = _basicLedMapDraftAssignment[i];
                const color = mode ? (_basicLedMapDraftColors[mode] || '#888') : null;
                const displayIndex = i + 1;

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'basic-led-map-chip' + (mode ? ' is-assigned' : ' is-unassigned');
                btn.title = mode ? `LED ${displayIndex} → ${_getBasicScenarioDisplayName(mode)}` : `LED ${displayIndex} (unassigned)`;
                btn.textContent = String(displayIndex);
                if (color) {
                    btn.style.backgroundColor = color;
                    btn.style.borderColor = color;
                    btn.style.color = _isColorDark(color) ? '#fff' : '#111';
                }
                btn.onclick = () => {
                    if (_basicLedMapActiveScenario === null) {
                        delete _basicLedMapDraftAssignment[i];
                    } else if (mode === _basicLedMapActiveScenario) {
                        delete _basicLedMapDraftAssignment[i];
                    } else {
                        _basicLedMapDraftAssignment[i] = _basicLedMapActiveScenario;
                    }
                    _renderLedMapPalette();
                    _renderLedMapGrid();
                };
                grid.appendChild(btn);
            }
        }

        window.basicOpenLedMapModal = function(preSelectMode) {
            const modal = document.getElementById('basicLedMapModal');
            if (!modal) return;

            const config = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            const cards = _getBasicScenarioCardDefs(config);
            _basicLedMapDraftAssignment = Object.assign({}, config.assignment || {});
            _basicLedMapDraftColors = Object.assign({}, config.colors || {});

            // Ensure every scenario has a color in the draft
            const defaults = _getDefaultBasicScenarioConfig();
            cards.forEach(card => {
                if (!_basicLedMapDraftColors[card.mode]) {
                    _basicLedMapDraftColors[card.mode] = defaults.colors[card.mode] || '#f5f5f5';
                }
            });

            _basicLedMapActiveScenario = cards.some(c => c.mode === preSelectMode)
                ? preSelectMode
                : (cards[0]?.mode || null);

            _renderLedMapPalette();
            _renderLedMapGrid();

            if (window.bootstrap && bootstrap.Modal) {
                _basicLedMapModalInstance = bootstrap.Modal.getOrCreateInstance(modal);
                _basicLedMapModalInstance.show();
            }
        };

        window.basicCloseLedMapModal = function() {
            if (_basicLedMapModalInstance) _basicLedMapModalInstance.hide();
        };

        window.basicLedMapSelectedColorChange = function(value) {
            if (_basicLedMapActiveScenario === null) return;
            _basicLedMapDraftColors[_basicLedMapActiveScenario] = _sanitizeBasicScenarioHexColor(
                value,
                _basicLedMapDraftColors[_basicLedMapActiveScenario] || '#f5f5f5'
            );
            _renderLedMapPalette();
            _renderLedMapGrid();
        };

        window.basicLedMapClearScenario = function() {
            if (_basicLedMapActiveScenario === null) return;
            Object.keys(_basicLedMapDraftAssignment).forEach(k => {
                if (_basicLedMapDraftAssignment[k] === _basicLedMapActiveScenario) delete _basicLedMapDraftAssignment[k];
            });
            _renderLedMapPalette();
            _renderLedMapGrid();
        };

        window.basicLedMapClearAll = function() {
            _basicLedMapDraftAssignment = {};
            _renderLedMapPalette();
            _renderLedMapGrid();
        };

        window.basicLedMapSave = async function() {
            const config = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            config.assignment = Object.assign({}, _basicLedMapDraftAssignment);
            config.colors = Object.assign({}, _basicLedMapDraftColors);
            _basicScenarioConfig = _normalizeBasicScenarioConfig(config);
            _saveBasicScenarioConfig(_basicScenarioConfig);
            renderBasicScenarioList();
            basicCloseLedMapModal();
            if (!_basicScenarioStripEnabled) {
                notifyBasicLightsStatus('LED strip map saved.', 'success');
                return;
            }

            if (!bleManager || !bleManager.isConnected) {
                notifyBasicLightsStatus('LED strip map saved. Connect BLE to apply output.', 'warning');
                return;
            }

            try {
                const result = await _applyBasicScenarioOutput();
                notifyBasicLightsStatus(
                    result.groups.length
                        ? `LED strip map saved and applied. Configured groups: ${result.labels.join(', ')}.`
                        : 'LED strip map saved, but no valid LEDs are assigned.',
                    result.groups.length ? 'success' : 'warning'
                );
            } catch (e) {
                notifyBasicLightsStatus(`LED strip map saved, but apply failed: ${e?.message || e}`, 'error', { duration: 5000 });
            }
        };

        window.basicScenarioSetColor = async function(mode, value) {
            if (!_getBasicScenarioCardByMode(mode)) return;

            const config = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            const nextColor = _sanitizeBasicScenarioHexColor(value, config.colors?.[mode] || '#ffffff');
            config.colors = Object.assign({}, config.colors || {}, { [mode]: nextColor });

            _basicScenarioConfig = _normalizeBasicScenarioConfig(config);
            _saveBasicScenarioConfig(_basicScenarioConfig);
            renderBasicScenarioList();

            if (!_basicScenarioStripEnabled) {
                notifyBasicLightsStatus(`${_getBasicScenarioDisplayName(mode)} color updated.`, 'success');
                return;
            }

            if (!bleManager || !bleManager.isConnected) {
                notifyBasicLightsStatus(`${_getBasicScenarioDisplayName(mode)} color saved. Connect BLE to apply output.`, 'warning');
                return;
            }

            try {
                const result = await _applyBasicScenarioOutput();
                notifyBasicLightsStatus(
                    result.groups.length
                        ? `${_getBasicScenarioDisplayName(mode)} color applied. Configured groups: ${result.labels.join(', ')}.`
                        : `${_getBasicScenarioDisplayName(mode)} color saved.`,
                    result.groups.length ? 'success' : 'info'
                );
            } catch (e) {
                notifyBasicLightsStatus(`Color apply failed: ${e?.message || e}`, 'error', { duration: 5000 });
            }
        };

        window.basicOpenScenarioGroupModal = function(mode = null) {
            const modal = document.getElementById('basicScenarioGroupModal');
            const input = document.getElementById('basicScenarioGroupNameInput');
            const title = document.getElementById('basicScenarioGroupModalTitle');
            const deleteBtn = document.getElementById('basicScenarioGroupDeleteBtn');
            if (!modal || !input || !title || !deleteBtn) return;

            const config = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            const cards = _getBasicScenarioCardDefs(config);
            const card = mode ? cards.find(c => c.mode === mode) : null;

            if (mode && !card) return;

            _basicScenarioGroupEditMode = card ? card.mode : null;
            title.textContent = card ? 'Edit Group' : 'Add Group';
            input.value = card ? _getBasicScenarioDisplayName(card.mode, config) : '';
            input.placeholder = card ? card.label : 'New group name';
            deleteBtn.style.display = card ? '' : 'none';

            if (window.bootstrap && bootstrap.Modal) {
                _basicScenarioGroupModalInstance = bootstrap.Modal.getOrCreateInstance(modal);
                _basicScenarioGroupModalInstance.show();
            }
        };

        window.basicScenarioGroupSave = function() {
            const input = document.getElementById('basicScenarioGroupNameInput');
            if (!input) return;

            const config = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            const cards = _getBasicScenarioCardDefs(config).slice();
            const providedName = _sanitizeBasicScenarioGroupLabel(input.value, 'Group');
            const maxGroups = _basicScenarioMaxGroupCount(config);

            if (_basicScenarioGroupEditMode) {
                const card = cards.find(c => c.mode === _basicScenarioGroupEditMode);
                if (!card) return;
                const nextNames = Object.assign({}, config.customNames || {});
                nextNames[card.mode] = providedName;
                _basicScenarioConfig = _normalizeBasicScenarioConfig(Object.assign({}, config, { customNames: nextNames }));
                _saveBasicScenarioConfig(_basicScenarioConfig);
                renderBasicScenarioList();
                notifyBasicLightsStatus(`Group renamed to ${providedName}.`, 'success');
            } else {
                if (cards.length >= maxGroups) {
                    notifyBasicLightsStatus(`Max groups reached (${maxGroups}) for current LED count.`, 'warning');
                    return;
                }
                const existingModes = new Set(cards.map(c => c.mode));
                const mode = _makeBasicScenarioModeFromLabel(providedName, existingModes);
                const nextCards = cards.concat([{ mode, label: providedName, keys: [mode] }]);
                const nextColors = Object.assign({}, config.colors || {}, { [mode]: '#f5f5f5' });
                const nextNames = Object.assign({}, config.customNames || {}, { [mode]: providedName });
                _basicScenarioConfig = _normalizeBasicScenarioConfig(Object.assign({}, config, {
                    cards: nextCards,
                    colors: nextColors,
                    customNames: nextNames
                }));
                _saveBasicScenarioConfig(_basicScenarioConfig);
                renderBasicScenarioList();
                notifyBasicLightsStatus(`Added group ${providedName}.`, 'success');
            }

            if (_basicScenarioGroupModalInstance) _basicScenarioGroupModalInstance.hide();
        };

        window.basicScenarioGroupDelete = async function() {
            const config = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            const cards = _getBasicScenarioCardDefs(config);
            const mode = _basicScenarioGroupEditMode;
            const card = cards.find(c => c.mode === mode);
            if (!card) return;

            const confirmed = await showActionConfirmDialog(
                'Delete Group',
                `Delete ${_getBasicScenarioDisplayName(mode, config)}? Assigned LEDs will become unassigned.`,
                'Delete',
                'Cancel',
                'basic-scenario-group-delete-overlay'
            );
            if (!confirmed) return;

            const nextCards = cards.filter(c => c.mode !== mode);
            const nextAssignment = {};
            Object.entries(config.assignment || {}).forEach(([k, v]) => {
                if (v !== mode) nextAssignment[k] = v;
            });
            const nextColors = Object.assign({}, config.colors || {});
            delete nextColors[mode];
            const nextNames = Object.assign({}, config.customNames || {});
            delete nextNames[mode];

            _basicScenarioConfig = _normalizeBasicScenarioConfig(Object.assign({}, config, {
                cards: nextCards,
                assignment: nextAssignment,
                colors: nextColors,
                customNames: nextNames
            }));
            _saveBasicScenarioConfig(_basicScenarioConfig);
            renderBasicScenarioList();
            if (_basicScenarioGroupModalInstance) _basicScenarioGroupModalInstance.hide();
            notifyBasicLightsStatus(`Deleted group ${_getBasicScenarioDisplayName(mode, config)}. Its LEDs are now available.`, 'success');
        };

        window.basicScenarioBrightnessChange = function(value) {
            const safe = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
            _basicScenarioBrightnessCurrent = safe;
            _syncBasicScenarioBrightnessUI(safe);
            if (_basicScenarioBrightnessSyncing) return;
            basicScenarioConfigChanged();
            _queueBasicScenarioBrightnessApply();
        };

        function _queueBasicScenarioBrightnessApply() {
            if (!_basicScenarioStripEnabled) return;
            if (!bleManager || !bleManager.isConnected) return;

            if (_basicScenarioBrightnessApplyTimer) {
                clearTimeout(_basicScenarioBrightnessApplyTimer);
            }

            _basicScenarioBrightnessApplyTimer = setTimeout(async () => {
                _basicScenarioBrightnessApplyTimer = null;

                try {
                    const result = await _applyBasicScenarioOutput();
                    notifyBasicLightsStatus(
                        result.groups.length
                            ? `LED brightness applied. Configured scenarios: ${result.labels.join(', ')}.`
                            : 'LED brightness updated, but no valid LEDs are assigned to any Step 4 scenario.',
                        result.groups.length ? 'success' : 'warning'
                    );
                } catch (e) {
                    notifyBasicLightsStatus(`LED brightness apply failed: ${e?.message || e}`, 'error', { duration: 5000 });
                }
            }, 150);
        }

        window.basicScenarioLedCountChange = function(value) {
            const safe = _resolveBasicScenarioLedCount(value);
            _basicScenarioLedCountCurrent = safe;
            const label = document.getElementById('basicScenarioLedCountLabel');
            if (label) label.textContent = String(safe);
            if (_basicScenarioLedCountSliderInstance && typeof _basicScenarioLedCountSliderInstance.value === 'function' && !_basicScenarioLedCountSyncing) {
                _basicScenarioLedCountSyncing = true;
                _basicScenarioLedCountSliderInstance.value([0, safe]);
                _basicScenarioLedCountSyncing = false;
            }
            _basicScenarioConfig = _normalizeBasicScenarioConfig(_readBasicScenarioConfigFromUI());
            _writeBasicScenarioConfigToUI(_basicScenarioConfig);
            _saveBasicScenarioConfig(_basicScenarioConfig);
            notifyBasicLightsStatus(`LED count set to ${safe}. Max groups is now ${_basicScenarioMaxGroupCount(_basicScenarioConfig)}.`, 'info');
        };

        window.basicScenarioColorOrderChange = function(value) {
            const input = document.getElementById('basicScenarioColorOrder');
            const safe = _sanitizeBasicScenarioColorOrder(value, 'rgb');
            if (input) input.value = safe;
            basicScenarioConfigChanged();
        };

        window.basicScenarioFxChange = function(value) {
            const current = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            const next = Object.assign({}, current, { fx: _sanitizeBasicScenarioFx(value, current.fx || 'solid') });
            _basicScenarioConfig = _normalizeBasicScenarioConfig(next);
            _syncBasicScenarioFxUI(_basicScenarioConfig);
            basicScenarioConfigChanged();
        };

        window.basicScenarioFxIntensityChange = function(value) {
            const label = document.getElementById('basicScenarioFxIntensityLabel');
            const safe = Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
            _basicScenarioFxIntensityCurrent = safe;
            if (_basicScenarioFxIntensitySliderInstance && !_basicScenarioFxIntensitySyncing) {
                _basicScenarioFxIntensitySyncing = true;
                _basicScenarioFxIntensitySliderInstance.value = safe;
                _basicScenarioFxIntensitySyncing = false;
            }
            if (label) label.textContent = String(safe);
            basicScenarioConfigChanged();
        };

        window.basicScenarioGlitterColorChange = function(value) {
            const picker = document.getElementById('basicScenarioGlitterColor');
            if (picker) picker.value = _sanitizeBasicScenarioHexColor(value, '#f5f5f5');
            basicScenarioConfigChanged();
        };

        function _loadBasicScenarioConfig() {
            const defaults = _getDefaultBasicScenarioConfig();
            try {
                const raw = readVehicleScopedStorage(BASIC_SCENARIO_CONFIG_KEY, { migrateLegacy: true });
                if (!raw) return _normalizeBasicScenarioConfig(defaults);
                return _normalizeBasicScenarioConfig(JSON.parse(raw));
            } catch (_) {
                return _normalizeBasicScenarioConfig(defaults);
            }
        }

        window.basicScenarioConfigChanged = function() {
            _basicScenarioConfig = _normalizeBasicScenarioConfig(_readBasicScenarioConfigFromUI());
            _writeBasicScenarioConfigToUI(_basicScenarioConfig);
            _saveBasicScenarioConfig(_basicScenarioConfig);
            notifyBasicLightsStatus(`Scenario mapping updated. LEDs ${_basicScenarioConfig.ledCount}, groups ${_getBasicScenarioCardDefs(_basicScenarioConfig).length}/${_basicScenarioMaxGroupCount(_basicScenarioConfig)}, pattern ${String(_basicScenarioConfig.colorOrder || 'rgb').toUpperCase()}, brightness ${_basicScenarioConfig.brightnessPercent}% (${_basicScenarioPercentToBrightness(_basicScenarioConfig.brightnessPercent)} max). FX ${_basicScenarioConfig.fx}, intensity ${_basicScenarioConfig.fxIntensity}.`, 'info');
        };

        window.basicScenarioConfigResetDefaults = async function() {
            const confirmed = await showActionConfirmDialog(
                'Reset Step 4 Defaults',
                'Reset Step 4 mapping, colors, brightness, and FX to defaults?',
                'Reset',
                'Cancel',
                'basic-scenario-reset-defaults-overlay'
            );
            if (!confirmed) return;

            _basicScenarioConfig = _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            _writeBasicScenarioConfigToUI(_basicScenarioConfig);
            _saveBasicScenarioConfig(_basicScenarioConfig);
            notifyBasicLightsStatus('Scenario mapping reset to defaults.', 'success');
        };

        function _buildBasicScenarioGroups(mode) {
            const config = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            const brightness = _basicScenarioPercentToBrightness(config.brightnessPercent);
            const color = config.colors?.[mode] || '#ffffff';
            const effect = _sanitizeBasicScenarioFx(config.fx, 'solid');
            const intensity = Math.max(0, Math.min(255, Math.round(Number(config.fxIntensity) || 128)));
            const glitterColor = _sanitizeBasicScenarioHexColor(config.glitterColor, '#f5f5f5');
            const assignment = config.assignment || {};
            const cards = _getBasicScenarioCardDefs(config);
            const cardIndex = Math.max(0, cards.findIndex(card => card.mode === mode));
            const slot = cardIndex % LIGHTS_ENGINE_MAX_GROUPS;
            const leds = Object.entries(assignment)
                .filter(([, m]) => m === mode)
                .map(([k]) => parseInt(k, 10))
                .filter(n => Number.isFinite(n))
                .sort((a, b) => a - b);
            return [{
                group: slot,
                name: _getBasicScenarioDisplayName(mode, config),
                color,
                color2: effect === 'glitter' ? glitterColor : '#000000',
                effect,
                intensity,
                brightness,
                leds
            }];
        }

        function _syncBasicScenarioButtons() {
            renderBasicScenarioList();
        }

        function _syncBasicScenarioStripSwitch() {
            const buttonEl = document.getElementById('basicScenarioStripSwitch');
            if (!buttonEl) return;
            const isOn = !!_basicScenarioStripEnabled;
            buttonEl.setAttribute('aria-pressed', isOn ? 'true' : 'false');
            buttonEl.classList.toggle('is-on', isOn);
            buttonEl.textContent = isOn ? 'LIGHTS ON' : 'LIGHTS OFF';
        }

        function _buildActiveBasicScenarioGroups() {
            const allGroups = [];
            _getBasicScenarioCardDefs().forEach(card => {
                const groups = _buildBasicScenarioGroups(card.mode);
                for (let i = 0; i < groups.length; i++) allGroups.push(groups[i]);
            });
            return allGroups;
        }

        function _activeScenarioModeLabels() {
            const config = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            const assignment = config.assignment || {};
            return _getBasicScenarioCardDefs(config)
                .filter(card => Object.values(assignment).some(mode => mode === card.mode))
                .map(card => _getBasicScenarioDisplayName(card.mode, config));
        }

        function _selectedScenarioModeLabels() {
            return _activeScenarioModeLabels();
        }

        async function _clearScenarioOutput() {
            lightsWriteGateEnabled = true;
            await bleManager.sendSystemCommand('lights_master', { enabled: false });
            await new Promise(r => setTimeout(r, 25));
            await bleManager.sendSystemCommand('lights_clear_all', {});
            await new Promise(r => setTimeout(r, 25));
        }

        async function _applyBasicScenarioOutput() {
            const config = _basicScenarioConfig || _normalizeBasicScenarioConfig(_getDefaultBasicScenarioConfig());
            const groups = _buildActiveBasicScenarioGroups().filter(group => Array.isArray(group.leds) && group.leds.length > 0);

            await _clearScenarioOutput();
            if (!_basicScenarioStripEnabled || !groups.length) {
                return { groups: [], labels: _selectedScenarioModeLabels() };
            }

            await bleManager.sendSystemCommand('lights_color_order', { order: _sanitizeBasicScenarioColorOrder(config.colorOrder, 'rgb') });
            await new Promise(r => setTimeout(r, 20));
            await bleManager.sendSystemCommand('lights_master', { enabled: true });
            await new Promise(r => setTimeout(r, 35));

            for (let i = 0; i < groups.length; i++) {
                const group = groups[i];
                await pushLightsPayload({
                    group: group.group,
                    name: group.name,
                    enabled: true,
                    color: group.color,
                    color2: group.color2 || '#000000',
                    brightness: Math.max(0, Math.min(BASIC_SCENARIO_BRIGHTNESS_MAX, Math.round(Number(group.brightness) || 0))),
                    effect: group.effect || 'solid',
                    speed: 128,
                    intensity: Math.max(0, Math.min(255, Math.round(Number(group.intensity) || 128))),
                    leds: group.leds
                });
            }

            return { groups, labels: _selectedScenarioModeLabels() };
        }

        function _basicScenarioSelectionStatus(labels) {
            if (!labels.length) return 'No Step 4 scenarios have assigned LEDs.';
            return `Configured scenarios: ${labels.join(', ')}.`;
        }

        window.basicScenarioStripToggle = async function(forceEnabled) {
            const nextEnabled = typeof forceEnabled === 'boolean' ? forceEnabled : !_basicScenarioStripEnabled;
            const labels = _selectedScenarioModeLabels();

            if (nextEnabled && (!bleManager || !bleManager.isConnected)) {
                _basicScenarioStripEnabled = false;
                _syncBasicScenarioButtons();
                notifyBasicLightsStatus(`${_basicScenarioSelectionStatus(labels)} Not connected.`, 'warning');
                return;
            }

            try {
                _basicScenarioStripEnabled = nextEnabled;
                const result = await _applyBasicScenarioOutput();
                _syncBasicScenarioButtons();

                if (!_basicScenarioStripEnabled) {
                    notifyBasicLightsStatus(`${_basicScenarioSelectionStatus(labels)} Strip output off.`, 'info');
                    return;
                }

                notifyBasicLightsStatus(
                    result.groups.length
                        ? `Strip on. Configured scenarios: ${result.labels.join(', ')}.`
                        : 'Strip on, but no valid LEDs are assigned to any Step 4 scenario.',
                    result.groups.length ? 'success' : 'warning'
                );
            } catch (e) {
                _basicScenarioStripEnabled = false;
                _syncBasicScenarioButtons();
                const msg = `Scenario strip toggle failed: ${e?.message || e}`;
                notifyBasicLightsStatus(msg, 'error', { duration: 5000 });
                console.error('[BasicLights]', msg);
            }
        };

        // Initialise the LED grid on page load
        (function _initBasicLedGrid() {
            _renderBasicLedGrid();
            _basicScenarioConfig = _loadBasicScenarioConfig();

            const ledCountSliderElement = document.getElementById('basicScenarioLedCount');
            if (ledCountSliderElement && typeof rangeSlider === 'function') {
                _basicScenarioLedCountSliderInstance = rangeSlider(ledCountSliderElement, {
                    value: [0, _basicScenarioConfig.ledCount],
                    min: 9,
                    max: 30,
                    step: 1,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        if (_basicScenarioLedCountSyncing) return;
                        const safe = Math.max(9, Math.min(30, Math.round(Number(value[1]) || 9)));
                        basicScenarioLedCountChange(safe);
                    }
                });
            }

            const brightnessSliderElement = document.getElementById('basicScenarioBrightness');
            if (brightnessSliderElement) {
                brightnessSliderElement.value = _basicScenarioConfig.brightnessPercent;
                brightnessSliderElement.addEventListener('input', function() {
                    if (_basicScenarioBrightnessSyncing) return;
                    const safe = Math.max(0, Math.min(100, Math.round(Number(this.value) || 0)));
                    _basicScenarioBrightnessCurrent = safe;
                    const label = document.getElementById('basicScenarioBrightnessLabel');
                    if (label) label.textContent = `${safe}%`;
                    basicScenarioConfigChanged();
                    _queueBasicScenarioBrightnessApply();
                });
                _basicScenarioBrightnessSliderInstance = brightnessSliderElement;
            }

            const fxIntensitySliderElement = document.getElementById('basicScenarioFxIntensity');
            if (fxIntensitySliderElement) {
                fxIntensitySliderElement.value = _basicScenarioConfig.fxIntensity;
                fxIntensitySliderElement.addEventListener('input', function() {
                    if (_basicScenarioFxIntensitySyncing) return;
                    const safe = Math.max(0, Math.min(255, Math.round(Number(this.value) || 0)));
                    _basicScenarioFxIntensityCurrent = safe;
                    const label = document.getElementById('basicScenarioFxIntensityLabel');
                    if (label) label.textContent = String(safe);
                    basicScenarioConfigChanged();
                });
                _basicScenarioFxIntensitySliderInstance = fxIntensitySliderElement;
            }

            _writeBasicScenarioConfigToUI(_basicScenarioConfig);
            _syncBasicScenarioStripSwitch();

            const ledMapModal = document.getElementById('basicLedMapModal');
            if (ledMapModal && window.bootstrap && bootstrap.Modal) {
                _basicLedMapModalInstance = bootstrap.Modal.getOrCreateInstance(ledMapModal);
            }

            const scenarioGroupModal = document.getElementById('basicScenarioGroupModal');
            if (scenarioGroupModal && window.bootstrap && bootstrap.Modal) {
                _basicScenarioGroupModalInstance = bootstrap.Modal.getOrCreateInstance(scenarioGroupModal);
            }
        })();

        // ==================== Master Light Switch ====================

        function syncMasterLightSwitches(isEnabled) {
            const masterToggle = document.getElementById('lightsToggle');
            const dashboardToggle = document.getElementById('lightsToggleDashboard');
            const lightGroupsToggle = document.getElementById('lightsToggleLightGroups');
            [masterToggle, dashboardToggle, lightGroupsToggle].forEach(toggleBtn => {
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
            toggleElement.addEventListener('click', async function() {
                try {
                    if (!isBleConnected()) {
                        const msg = 'Connect to a vehicle first to control lights.';
                        toast.warning(msg);
                        appendToSettingsConsoleCard(msg, 'warn');
                        return;
                    }
                    if (masterLightToggleInFlight) {
                        appendToSettingsConsoleCard('Master light switch busy, please wait.', 'warn');
                        return;
                    }
                    masterLightToggleInFlight = true;
                    // await setMasterLightsEnabled(!getMasterLightsEnabled(), true);
                } catch (error) {
                    const msg = `Master switch click failed: ${String(error?.message || error)}`;
                    console.error(msg, error);
                    appendToSettingsConsoleCard(msg, 'error');
                    toast.error('Master light switch failed. Check Debug logs.');
                } finally {
                    masterLightToggleInFlight = false;
                }
            });
        }

        function getPatternMode(patternName) {
            const value = (patternName || '').toLowerCase();
            if (!value) return 1;
            if (value === 'blink' || value === 'strobe' || value === 'police') return 2;
            if (value === 'breathe' || value === 'fade' || value === 'heartbeat') return 3;
            if (value === 'running' || value === 'larson') return 4;
            if (value === 'twinkle' || value === 'sparkle' || value === 'flash_sparkle' || value === 'glitter' || value === 'solid_glitter') return 5;
            if (value === 'flicker' || value === 'fire_flicker') return 6;
            return 1; // solid default
        }

        function getPatternBlinkRate(patternName) {
            const value = (patternName || '').toLowerCase();
            if (value === 'strobe') return 80;
            if (value === 'blink') return 220;
            if (value === 'police') return 220;
            if (value === 'flicker' || value === 'fire_flicker' || value === 'sparkle' || value === 'glitter' || value === 'solid_glitter' || value === 'flash_sparkle') return 120;
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

        function normalizeEffectNameForEngine(patternName) {
            const value = String(patternName || LIGHT_GROUP_DEFAULT_PATTERN).trim().toLowerCase();
            return LIGHTS_ENGINE_EFFECTS.has(value) ? value : LIGHT_GROUP_DEFAULT_PATTERN;
        }

        function toHexColor(colorValue, fallback = '#000000') {
            const value = String(colorValue || fallback).trim().toLowerCase();
            if (/^#[0-9a-f]{6}$/.test(value)) return value;
            if (/^[0-9a-f]{6}$/.test(value)) return `#${value}`;
            return fallback;
        }

        function buildFirmwareGroupPayload(group, groupIndex) {
            const normalized = normalizeLightGroup(group);
            const rawBrightness = Number(normalized.brightness);
            const brightness255 = Number.isFinite(rawBrightness)
                ? Math.max(0, Math.min(255, rawBrightness))
                : 255;
            const brightness100 = Math.round((brightness255 * 100) / 255);

            return {
                group: Number(groupIndex),
                name: normalizeLightGroupName(normalized.name || `Group ${groupIndex + 1}`),
                enabled: !!normalized.enabled,
                color: toHexColor(normalized.color, '#ffffff'),
                color2: toHexColor(normalized.color2, '#000000'),
                brightness: Math.max(0, Math.min(100, brightness100)),
                effect: normalizeEffectNameForEngine(normalized.pattern),
                speed: Number(normalized.speed ?? 128),
                intensity: Number(normalized.intensity ?? 128),
                leds: normalizeLedIndices(normalized.indices)
            };
        }

        async function pushLightGroupToESP32(groupIndex, groupsSource = null) {
            if (!isBleConnected()) return;
            const groups = Array.isArray(groupsSource) ? groupsSource : lightGroups;
            const index = Number(groupIndex);
            if (!Number.isInteger(index) || index < 0 || index >= LIGHTS_ENGINE_MAX_GROUPS) return;

            const sourceGroup = groups[index];
            const payload = sourceGroup
                ? buildFirmwareGroupPayload(sourceGroup, index)
                : {
                    group: index,
                    name: `Group ${index + 1}`,
                    enabled: false,
                    color: '#ffffff',
                    color2: '#000000',
                    brightness: 100,
                    effect: 'solid',
                    speed: 128,
                    leds: []
                };

            const signature = getLightGroupPayloadSignature(payload);
            if (lastPushedLightGroupSignatures[index] === signature) return;

            await pushLightsPayload(payload);
            lastPushedLightGroupSignatures[index] = signature;
        }

        async function pushAllLightGroupsToESP32(groupsSource = null) {
            if (!isBleConnected()) return;

            const groups = Array.isArray(groupsSource)
                ? groupsSource.map(normalizeLightGroup)
                : lightGroups.map(normalizeLightGroup);
            const desiredCount = Math.min(groups.length, LIGHTS_ENGINE_MAX_GROUPS);
            const previousCount = Math.min(lastPushedLightGroupCount, LIGHTS_ENGINE_MAX_GROUPS);

            for (let i = 0; i < desiredCount; i++) {
                await pushLightGroupToESP32(i, groups);
            }

            // Only clear trailing firmware slots when group count shrinks.
            for (let i = desiredCount; i < previousCount; i++) {
                await pushLightGroupToESP32(i, groups);
            }

            lastPushedLightGroupCount = desiredCount;
        }

        window.pushLightGroupToESP32 = pushLightGroupToESP32;

        function getFirmwareLightsPayload(groups, masterEnabled) {
            const groupList = Array.isArray(groups) ? groups : [];
            const normalizedGroups = groupList.map(normalizeLightGroup);
            const active = masterEnabled
                ? normalizedGroups.filter(group => {
                    if (!group.enabled) return false;
                    return normalizeLedIndices(group.indices).length > 0;
                })
                : [];

            // Build new format with full light groups array
            const lightGroupsArray = active.map(group => {
                const pattern = group.pattern || LIGHT_GROUP_DEFAULT_PATTERN;
                const mode = getPatternMode(pattern);
                const blinkRate = getPatternBlinkRate(pattern);
                const rawBrightness = Number(group.brightness);
                const brightness = Number.isFinite(rawBrightness)
                    ? Math.max(0, Math.min(255, rawBrightness))
                    : 255;

                // Convert hex colors to firmware format (remove #)
                const colorStr = (group.color || '#ff0000').replace('#', '');
                const color2Str = (group.color2 || '#000000').replace('#', '');

                return {
                    name: group.name || 'Unnamed Group',
                    enabled: !!group.enabled,
                    brightness,
                    speed: Number(group.speed ?? 128),
                    color: colorStr,
                    color2: color2Str,
                    indices: normalizeLedIndices(group.indices),
                    mode,
                    blinkRate,
                    pattern
                };
            });

            // Reverse order so top priority (index 0) processes last and wins LED conflicts
            return {
                lightGroupsArray: lightGroupsArray.reverse()
            };
        }

        async function applyLightsHierarchyToHardware(override = null) {
            if (!isBleConnected()) {
                // Startup and offline states can update local light groups before BLE is connected.
                console.debug('[Lights] Skipping hardware sync: BLE not connected');
                return;
            }

            if (!lightsWriteGateEnabled) {
                console.debug('[Lights] applyLightsHierarchyToHardware: master gate closed, skipping');
                return;
            }

            try {
                const masterEnabled = override?.masterEnabled ?? getMasterLightsEnabled();
                const colorOrder = getVehicleScopedLightColorOrder();
                const sourceGroupsRaw = Array.isArray(override?.groups)
                    ? override.groups
                    : (Array.isArray(lightGroups) ? lightGroups : []);
                const sourceGroups = sourceGroupsRaw.map(normalizeLightGroup);
                const finalMaster = masterEnabled || !!override?.forceMasterOn;
                console.log('[Lights] Source groups:', sourceGroups.map(g => ({
                    name: g.name || 'Unnamed Group',
                    enabled: !!g.enabled,
                    indices: Array.isArray(g.indices) ? g.indices.length : 0
                })));

                if (lastPushedLightsColorOrder !== colorOrder) {
                    await pushSystemCommand('lights_color_order', { order: colorOrder });
                    lastPushedLightsColorOrder = colorOrder;
                }

                await pushAllLightGroupsToESP32(sourceGroups);

                if (lastPushedLightsMasterEnabled !== !!finalMaster) {
                    await pushSystemCommand('lights_master', { enabled: !!finalMaster });
                    lastPushedLightsMasterEnabled = !!finalMaster;
                }
            } catch (error) {
                console.error('Failed to apply hierarchy lights payload:', error);
                appendToSettingsConsoleCard(`Lights payload build failed: ${String(error?.message || error)}`, 'error');
            }
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
            //setMasterLightsEnabled(masterStateBeforeModal, false);
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
                    
                    const assignedIndices = normalizeLedIndices(
                        Array.isArray(group.indices) ? group.indices : group.leds
                    );
                    const ledCount = assignedIndices.length;
                    const ledDisplay = ledCount > 0 ? formatLedRanges(assignedIndices) : '--';
                    const brightnessPercent = group.brightness !== undefined ?
                        Math.round(group.brightness * 100 / 255) : 100;
                    const color = group.color || '#ff0000';
                    const color2 = group.color2 || '#000000';
                    const pattern = group.pattern || LIGHT_GROUP_DEFAULT_PATTERN;
                    const patternDisplay = (pattern === 'Cycle' || pattern === 'Cycle Favorites')
                        ? `${pattern} (${LIGHT_GROUP_CYCLE_INTERVAL_SECONDS}s)`
                        : pattern;
                    const isConfigured = ledCount > 0;
                    const detailsExpanded = expandedLightGroupIds.has(group.id);
                    const hasSecondaryColor = color2 !== '#000000' && color2 !== '#00000000';
                    const warningIcon = !isConfigured
                        ? '<button type="button" class="light-group-warning-btn" aria-label="No LEDs assigned" data-bs-toggle="popover" data-bs-trigger="click" data-bs-placement="top" data-bs-content="No LED lights assigned."><span class="material-symbols-outlined light-group-warning-icon" aria-hidden="true">warning</span></button>'
                        : '';
                    
                    item.innerHTML = `
                        <div class="light-group-leading-controls" aria-label="Reorder group">
                            <button type="button" class="light-group-order-btn" aria-label="Move group up" title="Move up" onclick="moveLightGroup(${index}, -1)" ${(index === 0 || manageLightGroupsLocked || !isBleConnected()) ? 'disabled' : ''}>
                                <span class="material-symbols-outlined">keyboard_arrow_up</span>
                            </button>
                            <button type="button" class="light-group-order-btn" aria-label="Move group down" title="Move down" onclick="moveLightGroup(${index}, 1)" ${(index === lightGroups.length - 1 || manageLightGroupsLocked || !isBleConnected()) ? 'disabled' : ''}>
                                <span class="material-symbols-outlined">keyboard_arrow_down</span>
                            </button>
                        </div>
                        <div class="light-group-info">
                            <div class="light-group-name-row">
                                <div class="light-group-name">${group.name}${warningIcon}</div>
                            </div>
                            <div class="light-group-meta-row">
                                <div class="form-check form-switch m-0 light-group-enabled-toggle-wrap" title="Toggle this light group on or off">
                                    <input class="form-check-input light-group-enabled-toggle" type="checkbox" ${group.enabled ? 'checked' : ''} ${(manageLightGroupsLocked || !isBleConnected()) ? 'disabled' : ''} aria-label="Toggle ${group.name} on or off">
                                </div>
                                <div class="light-group-swatch-row" aria-label="Group colors">
                                    <span class="light-group-swatch" style="background-color: ${color};" title="Primary color"></span>
                                    ${hasSecondaryColor ? `<span class="light-group-swatch" style="background-color: ${color2};" title="Secondary color"></span>` : ''}
                                </div>
                            </div>
                            <div class="light-group-details ${detailsExpanded ? 'expanded' : ''}">
                                <div class="-small">LED Assignment: ${ledDisplay}</div>
                                <div class="-small">Pattern: ${patternDisplay}</div>
                                <div class="-small">Brightness: ${brightnessPercent}%</div>
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
                                        <button type="button" class="dropdown-item" ${(manageLightGroupsLocked || !isBleConnected()) ? 'disabled' : ''} onclick="event.stopPropagation(); editLightGroup(${index})" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">Edit</button>
                                    </li>
                                    <li>
                                        <button type="button" class="dropdown-item text-danger" ${(manageLightGroupsLocked || !isBleConnected()) ? 'disabled' : ''} onclick="event.stopPropagation(); deleteLightGroup(${index})" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">Delete</button>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    `;

                    const enabledInput = item.querySelector('.light-group-enabled-toggle');
                    if (enabledInput) {
                        enabledInput.addEventListener('change', () => {
                            if (!isBleConnected()) {
                                enabledInput.checked = !enabledInput.checked;
                                toast.warning('Connect to Bluetooth before editing light groups.');
                                return;
                            }
                            if (manageLightGroupsLocked) {
                                enabledInput.checked = !enabledInput.checked;
                                toast.warning('Manage Light Groups is locked. Unlock to make changes.');
                                return;
                            }
                            lightGroups[index].enabled = enabledInput.checked;
                            saveLightGroups(false);
                            lightingGroupsDirty = true;
                            syncLightingProfileActionButtons();
                            pushLightGroupToESP32(index).catch(error => {
                                console.error('Failed to push single light group toggle:', error);
                            });
                        });
                    }

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
            if (!isBleConnected()) {
                toast.warning('Connect to Bluetooth before editing light groups.');
                return;
            }
            if (manageLightGroupsLocked) {
                toast.warning('Manage Light Groups is locked. Unlock to make changes.');
                return;
            }
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
        let currentIntensity = 128; // Default mid-range intensity (0-255)
        let currentSpeed = 128; // Default mid-range effect speed (0-255)
        let lightGroupBrightnessSliderInstance = null;
        let lightGroupIntensitySliderInstance = null;
        let lightGroupSpeedSliderInstance = null;

        function updateLightGroupBrightnessThumbLabel(value) {
            const sliderElement = document.querySelector('#lightGroupBrightnessSlider');
            if (!sliderElement) return;
            const thumb = sliderElement.querySelector('.range-slider__thumb[data-upper]');
            if (thumb) {
                thumb.textContent = '';
            }
        }

        function updateLightGroupIntensityThumbLabel(value) {
            const sliderElement = document.querySelector('#lightGroupIntensitySlider');
            if (!sliderElement) return;
            const thumb = sliderElement.querySelector('.range-slider__thumb[data-upper]');
            if (thumb) {
                thumb.textContent = '';
            }
        }

        function updateLightGroupSpeedThumbLabel(value) {
            const sliderElement = document.querySelector('#lightGroupSpeedSlider');
            if (!sliderElement) return;
            const thumb = sliderElement.querySelector('.range-slider__thumb[data-upper]');
            if (thumb) {
                thumb.textContent = '';
            }
        }

        // Pattern metadata: which patterns need dual colors
        const PATTERN_METADATA = {
            solid:   { needsDualColor: false, hasIntensity: false, hasSpeed: false, secondaryLabel: null },
            glitter: { needsDualColor: true,  hasIntensity: true,  hasSpeed: false, secondaryLabel: 'Glitter Color' },
            police:  { needsDualColor: true,  hasIntensity: false, hasSpeed: true,  secondaryLabel: 'Alternating Color' }
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
                option.textContent = patternName;
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
            const colorRow = document.getElementById('lightGroupColorRow');
            const intensityContainer = document.getElementById('lightGroupIntensityContainer');
            const speedContainer = document.getElementById('lightGroupSpeedContainer');
            const secondaryLabel = document.getElementById('secondaryColorLabel');
            
            if (!secondaryColorContainer) return;

            const metadata = PATTERN_METADATA[pattern];
            const needsDualColor = metadata?.needsDualColor ?? false;
            const hasIntensity = metadata?.hasIntensity ?? false;
            const hasSpeed = metadata?.hasSpeed ?? false;

            // Update dynamic secondary color label
            if (secondaryLabel) {
                secondaryLabel.textContent = metadata?.secondaryLabel || 'Secondary Color';
            }

            if (needsDualColor) {
                secondaryColorContainer.style.display = 'block';
                if (colorRow) colorRow.classList.remove('single-color');
            } else {
                secondaryColorContainer.style.display = 'none';
                if (colorRow) colorRow.classList.add('single-color');
            }

            // Toggle intensity visibility based on pattern support
            if (intensityContainer) {
                intensityContainer.style.display = hasIntensity ? 'block' : 'none';
            }

            if (speedContainer) {
                speedContainer.style.display = hasSpeed ? 'block' : 'none';
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
            if (colorHex) colorHex.value = currentColor.toUpperCase();
            if (colorPicker2) colorPicker2.value = currentColor2;
            if (colorHex2) colorHex2.value = currentColor2.toUpperCase();
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
            const totalLEDCount = parseInt(document.getElementById('totalLEDCount').value) || 20;
            
            if (index !== null) {
                // Edit mode
                const group = lightGroups[index];
                titleSpan.textContent = 'Edit';
                nameInput.value = group.name;
                const groupIndices = Array.isArray(group.indices) ? group.indices : (Array.isArray(group.leds) ? group.leds : []);
                groupIndices.forEach(idx => currentSelectedLEDs.add(idx));
                
                // Set brightness (convert 0-255 to 0-100 percentage)
                const brightnessPercent = group.brightness !== undefined ? 
                    Math.round(group.brightness * 100 / 255) : 80;
                currentBrightness = brightnessPercent;
                if (lightGroupBrightnessSliderInstance) {
                    lightGroupBrightnessSliderInstance.value([0, brightnessPercent]);
                }
                updateLightGroupBrightnessThumbLabel(brightnessPercent);
                brightnessValue.textContent = brightnessPercent + '%';

                // Set intensity (0-255 range)
                const intensity = group.intensity !== undefined ? group.intensity : 128;
                currentIntensity = intensity;
                const intensityValue = document.getElementById('lightGroupIntensityValue');
                if (lightGroupIntensitySliderInstance) {
                    lightGroupIntensitySliderInstance.value([0, intensity]);
                }
                updateLightGroupIntensityThumbLabel(intensity);
                if (intensityValue) {
                    intensityValue.textContent = String(intensity);
                }

                // Set speed (0-255 range)
                const speed = group.speed !== undefined ? group.speed : 128;
                currentSpeed = speed;
                const speedValue = document.getElementById('lightGroupSpeedValue');
                if (lightGroupSpeedSliderInstance) {
                    lightGroupSpeedSliderInstance.value([0, speed]);
                }
                updateLightGroupSpeedThumbLabel(speed);
                if (speedValue) {
                    speedValue.textContent = String(speed);
                }

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
                colorHex.value = color.toUpperCase();
                
                const colorPicker2 = document.getElementById('lightGroupColorPicker2');
                const colorHex2 = document.getElementById('lightGroupColorHex2');
                if (colorPicker2) colorPicker2.value = color2;
                if (colorHex2) colorHex2.value = color2.toUpperCase();
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
                
                currentIntensity = 128;
                const intensityValue = document.getElementById('lightGroupIntensityValue');
                if (lightGroupIntensitySliderInstance) {
                    lightGroupIntensitySliderInstance.value([0, 128]);
                }
                updateLightGroupIntensityThumbLabel(128);
                if (intensityValue) {
                    intensityValue.textContent = '128';
                }

                currentSpeed = 128;
                const speedValue = document.getElementById('lightGroupSpeedValue');
                if (lightGroupSpeedSliderInstance) {
                    lightGroupSpeedSliderInstance.value([0, 128]);
                }
                updateLightGroupSpeedThumbLabel(128);
                if (speedValue) {
                    speedValue.textContent = '128';
                }
                
                currentPattern = LIGHT_GROUP_DEFAULT_PATTERN;
                populateLightGroupPatternOptions(LIGHT_GROUP_DEFAULT_PATTERN);
                if (patternSelect) {
                    patternSelect.value = LIGHT_GROUP_DEFAULT_PATTERN;
                }
                currentColor = '#ff0000';
                currentColor2 = '#000000';
                colorPicker.value = '#ff0000';
                colorHex.value = '#FF0000';
                
                const colorPicker2 = document.getElementById('lightGroupColorPicker2');
                const colorHex2 = document.getElementById('lightGroupColorHex2');
                if (colorPicker2) colorPicker2.value = '#000000';
                if (colorHex2) colorHex2.value = '#000000';
            }
            
            renderLedGrid(totalLEDCount);

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
            if (!isBleConnected()) {
                toast.warning('Connect to Bluetooth before editing light groups.');
                return;
            }
            if (manageLightGroupsLocked) {
                toast.warning('Manage Light Groups is locked. Unlock to make changes.');
                return;
            }
            openLightGroupModal(null);
        }

        function editLightGroup(index) {
            if (!isBleConnected()) {
                toast.warning('Connect to Bluetooth before editing light groups.');
                return;
            }
            if (manageLightGroupsLocked) {
                toast.warning('Manage Light Groups is locked. Unlock to make changes.');
                return;
            }
            openLightGroupModal(index);
        }

        function getLedGridColumns() {
            const isPortraitMobile = window.matchMedia('(orientation: portrait) and (max-width: 600px)').matches;
            return isPortraitMobile ? 5 : 10;
        }

        function renderLedGrid(totalCount = 20) {
            const gridContainer = document.getElementById('ledGrid');
            gridContainer.innerHTML = '';
            gridContainer.style.display = 'grid';
            gridContainer.style.gridTemplateColumns = `repeat(${getLedGridColumns()}, 1fr)`;
            gridContainer.style.gap = '0.5rem';
            
            const maxLEDs = Math.min(totalCount, MAX_LIGHTS_TOTAL_LEDS);
            
            for (let i = 0; i < maxLEDs; i++) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'led-grid-button';
                button.textContent = String(i + 1); // Human-friendly display (1-based)
                button.setAttribute('aria-label', `LED ${i + 1}`);
                button.title = `LED ${i + 1}`;
                
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
            
            attemptAutoPreviewFromModal();
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
                    const displayStart = rangeStart + 1;
                    const displayEnd = rangeEnd + 1;
                    ranges.push(rangeStart === rangeEnd ? 
                        String(displayStart) : 
                        `${displayStart}-${displayEnd}`);
                    rangeStart = indices[i];
                    rangeEnd = indices[i];
                }
            }
            const displayStart = rangeStart + 1;
            const displayEnd = rangeEnd + 1;
            ranges.push(rangeStart === rangeEnd ? 
                String(displayStart) : 
                `${displayStart}-${displayEnd}`);
            
            return ranges.join(', ');
        }

        function getLightGroupDraftFromModal() {
            const nameInput = document.getElementById('lightGroupNameInput');
            const patternSelect = document.getElementById('lightGroupPatternSelect');
            const name = nameInput ? normalizeLightGroupName(nameInput.value) : 'Preview Group';
            const selectedPattern = (patternSelect && patternSelect.value) ? patternSelect.value : LIGHT_GROUP_DEFAULT_PATTERN;

            return {
                name: name || 'Preview Group',
                indices: Array.from(currentSelectedLEDs).sort((a, b) => a - b),
                brightness: Math.round(currentBrightness * 255 / 100),
                color: currentColor,
                color2: currentColor2,
                pattern: selectedPattern,
                speed: currentSpeed,
                cycleIntervalSeconds: (selectedPattern === 'Cycle' || selectedPattern === 'Cycle Favorites') ? LIGHT_GROUP_CYCLE_INTERVAL_SECONDS : undefined,
                enabled: true
            };
        }

        function canAutoPreviewGroup(draftGroup) {
            return draftGroup.indices.length > 0;
        }

        function testLightGroupFromModal(showValidationErrors = false) {
            const draftGroup = getLightGroupDraftFromModal();

            if (!canAutoPreviewGroup(draftGroup)) {
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

        async function saveLightGroupFromModal() {
            if (!isBleConnected()) {
                toast.warning('Connect to Bluetooth before editing light groups.');
                return;
            }
            const nameInput = document.getElementById('lightGroupNameInput');
            const name = normalizeLightGroupName(nameInput?.value);
            if (nameInput) nameInput.value = name;
            
            if (!name) {
                await showSimpleNoticeDialog(
                    'Missing Group Name',
                    'Please enter a light group name before saving.',
                    'OK',
                    'light-group-name-required-overlay'
                );
                nameInput.focus();
                return;
            }
            
            const indices = Array.from(currentSelectedLEDs).sort((a, b) => a - b);
            const patternSelect = document.getElementById('lightGroupPatternSelect');
            const selectedPattern = (patternSelect && patternSelect.value) ? patternSelect.value : LIGHT_GROUP_DEFAULT_PATTERN;

            if (indices.length > MAX_LIGHT_GROUP_LEDS) {
                await showSimpleNoticeDialog(
                    'Too Many LEDs In Group',
                    `Each light group can include up to ${MAX_LIGHT_GROUP_LEDS} LEDs. Please reduce the selection and try again.`,
                    'OK',
                    'light-group-led-limit-overlay'
                );
                return;
            }
            
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
                    intensity: currentIntensity,
                    speed: currentSpeed,
                    cycleIntervalSeconds,
                    enabled: wasEnabled
                };
                saveLightGroups(false);
                lightingGroupsDirty = true;
                syncLightingProfileActionButtons();
                if (isBleConnected()) {
                    await pushLightGroupToESP32(currentEditingGroupIndex);
                }
                window.toast.success(`Light group "${name}" updated!`);
            } else {
                if (lightGroups.length >= LIGHTS_ENGINE_MAX_GROUPS) {
                    await showSimpleNoticeDialog(
                        'Group Limit Reached',
                        `You can create up to ${LIGHTS_ENGINE_MAX_GROUPS} light groups per vehicle.`,
                        'OK',
                        'light-group-limit-overlay'
                    );
                    return;
                }

                // Create new group disabled by default so save does not force it on.
                lightGroups.push({
                    id: createLightGroupId(),
                    name: name,
                    indices: indices,
                    brightness: brightness255,
                    color: currentColor,
                    color2: currentColor2,
                    pattern: selectedPattern,
                    intensity: currentIntensity,
                    speed: currentSpeed,
                    cycleIntervalSeconds,
                    enabled: false
                });
                saveLightGroups(false);
                lightingGroupsDirty = true;
                syncLightingProfileActionButtons();
                if (isBleConnected()) {
                    await pushLightGroupToESP32(lightGroups.length - 1);
                }
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
            currentIntensity = 128;
            currentSpeed = 128;
        }

        function setLightGroupColor(color, target = 'primary') {
            if (target === 'secondary') {
                currentColor2 = color;
                const colorPicker2 = document.getElementById('lightGroupColorPicker2');
                const colorHex2 = document.getElementById('lightGroupColorHex2');
                if (colorPicker2) colorPicker2.value = color;
                if (colorHex2) colorHex2.value = color.toUpperCase();
            } else {
                currentColor = color;
                const colorPicker = document.getElementById('lightGroupColorPicker');
                const colorHex = document.getElementById('lightGroupColorHex');
                if (colorPicker) colorPicker.value = color;
                if (colorHex) colorHex.value = color.toUpperCase();
            }

            attemptAutoPreviewFromModal();
        }

        function deleteLightGroup(index) {
            if (!isBleConnected()) {
                toast.warning('Connect to Bluetooth before editing light groups.');
                return;
            }
            if (manageLightGroupsLocked) {
                toast.warning('Manage Light Groups is locked. Unlock to make changes.');
                return;
            }
            const group = lightGroups[index];
            if (!group) return;

            const existing = document.getElementById('lg-delete-overlay');
            if (existing) existing.remove();

            const safeName = group.name.replace(/</g, '&lt;');
            const subtext = lightGroups.length === 1
                ? 'This is your last light group. You can create new ones anytime.'
                : 'This cannot be undone.';

            const overlay = document.createElement('div');
            overlay.id = 'lg-delete-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
            overlay.innerHTML = `
              <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
                <h5 style="margin:0 0 12px;color:#fff;">Delete Light Group</h5>
                <p style="margin:0 0 20px;color:#aaa;font-size:0.9rem;">Delete <strong style="color:#fff;">${safeName}</strong>? ${subtext}</p>
                <div style="display:flex;gap:8px;">
                                    <button id="lgd-cancel" style="flex:1;padding:10px;border:1px solid #555;border-radius:8px;background:#333;color:#aaa;cursor:pointer;">Cancel</button>
                                    <button id="lgd-delete" style="flex:1;padding:10px;border:none;border-radius:8px;background:#c0392b;color:#fff;font-weight:600;cursor:pointer;">Delete</button>
                </div>
              </div>`;
            document.body.appendChild(overlay);

            overlay.querySelector('#lgd-cancel').onclick = () => overlay.remove();
            overlay.querySelector('#lgd-delete').onclick = () => {
                overlay.remove();
                lightGroups.splice(index, 1);
                if (group.id) expandedLightGroupIds.delete(group.id);
                saveLightGroups();
                window.toast.success('Light group deleted');
            };
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

            const ltSaveBtn2 = document.getElementById('saveNewLightingProfileBtn');
            const ltUpdateBtn2 = document.getElementById('ltProfileUpdateBtn');
            if (ltSaveBtn2) ltSaveBtn2.addEventListener('click', saveAsNewLightingProfile);
            if (ltUpdateBtn2) ltUpdateBtn2.addEventListener('click', updateActiveLightingProfile);
            
            const totalLEDInput = document.getElementById('totalLEDCount');
            if (totalLEDInput) {
                // Load saved value
                refreshTotalLEDInputFromStorage();
                
                // Save on change
                totalLEDInput.addEventListener('change', function() {
                    if (manageLightGroupsLocked || lightStripConfigLocked) {
                        this.value = getVehicleScopedTotalLEDCount();
                        toast.warning('Light controls are locked. Unlock to make changes.');
                        return;
                    }
                    const value = parseInt(this.value);
                    if (value >= 1 && value <= MAX_LIGHTS_TOTAL_LEDS) {
                        writeVehicleScopedStorage(TOTAL_LED_COUNT_KEY, String(value));
                        lightingGroupsDirty = true;
                        syncLightingProfileActionButtons();
                        window.toast.success(`Total LED count set to ${value}`);
                    } else {
                        alert(`Please enter a value between 1 and ${MAX_LIGHTS_TOTAL_LEDS}`);
                        this.value = getVehicleScopedTotalLEDCount();
                    }
                });
            }

            const lightColorOrderInput = document.getElementById('lightColorOrder');
            if (lightColorOrderInput) {
                refreshLightColorOrderInputFromStorage();

                lightColorOrderInput.addEventListener('change', async function() {
                    if (manageLightGroupsLocked || lightStripConfigLocked) {
                        this.value = getVehicleScopedLightColorOrder();
                        toast.warning('Light controls are locked. Unlock to make changes.');
                        return;
                    }

                    const order = normalizeLightColorOrder(this.value);
                    this.value = order;
                    writeVehicleScopedStorage(LIGHT_COLOR_ORDER_KEY, order);
                    lightingGroupsDirty = true;
                    syncLightingProfileActionButtons();

                    if (isBleConnected()) {
                        try {
                            await pushSystemCommand('lights_color_order', { order });
                        } catch (error) {
                            console.warn('Failed to push light color order to firmware:', error?.message || error);
                        }
                    }

                    window.toast.success(`LED color order set to ${order.toUpperCase()}`);
                });
            }
            
            const brightnessValue = document.getElementById('lightGroupBrightnessValue');
            const brightnessSliderElement = document.querySelector('#lightGroupBrightnessSlider');
            if (brightnessSliderElement && brightnessValue) {
                lightGroupBrightnessSliderInstance = rangeSlider(brightnessSliderElement, {
                    value: [0, 80],     //initial slider thumb positions. First value (0) is the lower thumb. Second value (80) is the upper thumb (the one you actually move)
                    min: 0,
                    max: 100,
                    step: 5,
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

            // Initialize intensity slider
            const intensityValue = document.getElementById('lightGroupIntensityValue');
            const intensitySliderElement = document.querySelector('#lightGroupIntensitySlider');
            if (intensitySliderElement && intensityValue) {
                lightGroupIntensitySliderInstance = rangeSlider(intensitySliderElement, {
                    value: [0, 128],    //initial slider thumb positions. First value (0) is the lower thumb. Second value (128) is the upper thumb (the one you actually move)
                    min: 0,
                    max: 255,
                    step: 5,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        const intensity = Array.isArray(value) ? parseInt(value[1], 10) : parseInt(value, 10);
                        if (Number.isNaN(intensity)) return;
                        currentIntensity = intensity;
                        intensityValue.textContent = String(intensity);
                        updateLightGroupIntensityThumbLabel(intensity);
                        attemptAutoPreviewFromModal();
                    }
                });
                updateLightGroupIntensityThumbLabel(128);
            }

            // Initialize speed slider
            const speedValue = document.getElementById('lightGroupSpeedValue');
            const speedSliderElement = document.querySelector('#lightGroupSpeedSlider');
            if (speedSliderElement && speedValue) {
                lightGroupSpeedSliderInstance = rangeSlider(speedSliderElement, {
                    value: [0, 128],
                    min: 0,
                    max: 255,
                    step: 1,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        const speed = Array.isArray(value) ? parseInt(value[1], 10) : parseInt(value, 10);
                        if (Number.isNaN(speed)) return;
                        currentSpeed = speed;
                        speedValue.textContent = String(speed);
                        updateLightGroupSpeedThumbLabel(speed);
                        attemptAutoPreviewFromModal();
                    }
                });
                updateLightGroupSpeedThumbLabel(128);
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

            // Color picker event listeners
            const colorPicker = document.getElementById('lightGroupColorPicker');
            const colorHex = document.getElementById('lightGroupColorHex');
            if (colorPicker && colorHex) {
                colorPicker.addEventListener('input', function() {
                    currentColor = this.value;
                    colorHex.value = this.value.toUpperCase();
                    attemptAutoPreviewFromModal();
                });
                colorHex.addEventListener('input', function() {
                    const raw = this.value.trim();
                    const hex = raw.startsWith('#') ? raw : '#' + raw;
                    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
                        currentColor = hex.toLowerCase();
                        colorPicker.value = currentColor;
                        attemptAutoPreviewFromModal();
                    }
                });
            }
            
            // Second color picker event listeners
            const colorPicker2 = document.getElementById('lightGroupColorPicker2');
            const colorHex2 = document.getElementById('lightGroupColorHex2');
            if (colorPicker2 && colorHex2) {
                colorPicker2.addEventListener('input', function() {
                    currentColor2 = this.value;
                    colorHex2.value = this.value.toUpperCase();
                    attemptAutoPreviewFromModal();
                });
                colorHex2.addEventListener('input', function() {
                    const raw = this.value.trim();
                    const hex = raw.startsWith('#') ? raw : '#' + raw;
                    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
                        currentColor2 = hex.toLowerCase();
                        colorPicker2.value = currentColor2;
                        attemptAutoPreviewFromModal();
                    }
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

            const lightGroupCancelBtn = document.getElementById('lightGroupCancelBtn');
            const lightGroupCloseBtn = document.getElementById('lightGroupCloseBtn');
            if (lightGroupCloseBtn && lightGroupCancelBtn) {
                lightGroupCloseBtn.addEventListener('click', () => {
                    lightGroupCancelBtn.click();
                });
            }
            
            // Load light groups and color presets
            await loadLightGroups();
            renderFactoryPresets();
            // setMasterLightsEnabled(getMasterLightsEnabled(), false);
            applyLightsHierarchyToHardware();

            // Populate both profile selectors from localStorage on startup — no BLE needed.
            populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex);
            updateDashboardActiveProfile();
            populateLightingProfileSelector();
            updateDashboardActiveLightingProfile();
            ensureApplicationDataStorageHooks();
            refreshApplicationDataCard();
            
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
            const cameraIcon = document.getElementById('setLevelBtn');
            if (!icon) return;

            const bleConnected = !!(bleManager && bleManager.getConnectionStatus && bleManager.getConnectionStatus());

            // BLE state has priority for this header icon.
            if (bleConnected) {
                icon.classList.remove('connecting', 'disconnected');
                icon.textContent = 'bluetooth_connected';
                icon.style.color = 'var(--bluetooth-blue)';
                if (cameraIcon) {
                    cameraIcon.textContent = 'tools_level';
                    cameraIcon.style.color = 'var(--high-impact-color)';
                }
                const status = document.getElementById('telemetryStatus');
                if (status) status.textContent = 'Live';
                // Sync the garage card to connected state immediately.
                if (window.GarageManager && typeof window.GarageManager.renderGarage === 'function') {
                    window.GarageManager.renderGarage();
                }
                updateDashboardVehicleName(null);
                updateVehicleQuickNav();
                updateDashboardBleUI(true);
                return;
            }

            // BLE is disconnected, show muted icon
            icon.classList.remove('connecting');
            icon.classList.add('disconnected');
            icon.textContent = 'bluetooth_disabled';
            icon.style.color = 'var(--text-muted)';
            if (cameraIcon) {
                cameraIcon.textContent = 'graphic_eq_off';
                cameraIcon.style.color = 'var(--text-muted)';
            }
            const status = document.getElementById('telemetryStatus');
            if (status) status.textContent = 'Inactive';
            updateDashboardVehicleName(null);
            updateVehicleQuickNav();
            updateDashboardBleUI(false);
        }

        function setHeaderSearching(active) {
            // Always sync the garage card state regardless of BLE connection status.
            if (window.GarageManager && typeof window.GarageManager.setAutoReconnectState === 'function') {
                const targetId = active ? getPreferredReconnectDeviceId() : null;
                window.GarageManager.setAutoReconnectState(!!active, targetId, 0);
            }

            // Only update the header icon when not already fully connected.
            const icon = document.getElementById('wifiIcon');
            const cameraIcon = document.getElementById('setLevelBtn');
            if (!icon || isBleConnected()) return;
            if (active) {
                icon.classList.remove('disconnected');
                icon.classList.add('connecting');
                icon.textContent = 'bluetooth_searching';
                icon.style.color = 'var(--text-muted)';
                if (cameraIcon) {
                    cameraIcon.textContent = 'graphic_eq_off';
                    cameraIcon.style.color = 'var(--text-muted)';
                }
            } else {
                icon.classList.remove('connecting');
                icon.classList.add('disconnected');
                icon.textContent = 'bluetooth_disabled';
                icon.style.color = 'var(--text-muted)';
                if (cameraIcon) {
                    cameraIcon.textContent = 'graphic_eq_off';
                    cameraIcon.style.color = 'var(--text-muted)';
                }
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
            if (!isBleConnected()) {
                setDashboardQuickNavDisplay('activeDrivingProfileDisplay', null, 'driving');
                return;
            }
            const p = getActiveDrivingProfile();
            setDashboardQuickNavDisplay('activeDrivingProfileDisplay', p ? p.name : '--', 'driving');
        }

        function syncDashboardForDrivingProfile(profileSnapshot = null) {
            const snapshot = profileSnapshot || getActiveDrivingProfileConfigSnapshot();
            if (!snapshot) return;

            fullConfig = mergeConfigSnapshots(fullConfig, snapshot);
            const tuningConfig = snapshot.tuning ? snapshot.tuning : snapshot;
            updateSuspensionSettings(tuningConfig);

            if (isBleConnected()) {
                updateDashboardActiveProfile();
            }
        }

        async function applyDrivingProfileSelection(profile, options = {}) {
            const {
                pushToDevice = isBleConnected(),
                successMessage = null,
                disconnectedMessage = null,
                successStatus = null,
                disconnectedStatus = null,
                failureStatus = 'Status: push failed, values applied locally',
                useGarageSyncModalForSwitch = false
            } = options;

            const selectedProfileConfig = {
                ...profile.tuning
            };

            isLoadingTuningConfig = true;
            try {
                fullConfig = mergeConfigSnapshots(fullConfig, selectedProfileConfig);
                updateSuspensionSettings(profile.tuning);
                await new Promise(r => setTimeout(r, 50));
                clearPageDirty('tuning');
                clearPageDirty('system');
            } finally {
                isLoadingTuningConfig = false;
            }

            if (pushToDevice) {
                if (useGarageSyncModalForSwitch) {
                    showGarageSyncModal();
                    updateGarageSyncProgress(20, `Applying profile "${profile.name}"...`);
                }

                try {
                    await runDrivingProfileOperation('applying profile', async () => {
                        try {
                            await pushConfigPayload(selectedProfileConfig);
                            if (successMessage) toast.success(successMessage);
                            if (useGarageSyncModalForSwitch) {
                                updateGarageSyncProgress(100, `Profile "${profile.name}" applied`);
                            }
                        } catch (e) {
                            toast.warning(`Profile set locally. Push failed: ${e.message}`);
                            if (useGarageSyncModalForSwitch) {
                                updateGarageSyncProgress(100, 'Applied locally (device push failed)');
                            }
                        }
                    }, { suppressStatus: useGarageSyncModalForSwitch });
                } finally {
                    if (useGarageSyncModalForSwitch) {
                        await delayMs(220);
                        hideGarageSyncModal({ force: true });
                    }
                }
            } else {
                if (disconnectedMessage) toast.success(disconnectedMessage);

            }
        }

        function delayMs(ms) {
            return new Promise((resolve) => setTimeout(resolve, ms));
        }

        function withTimeout(promise, timeoutMs, label = 'Operation') {
            let timeoutId = null;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`${label} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            });

            return Promise.race([promise, timeoutPromise]).finally(() => {
                if (timeoutId) clearTimeout(timeoutId);
            });
        }

        function setDrivingProfileBusy(isBusy, context = '', options = {}) {
            drivingProfileBusy = !!isBusy;
            const saveBtn = document.getElementById('saveNewProfileBtn');
            if (saveBtn) {
                saveBtn.disabled = drivingProfileBusy || drivingProfilesLocked;
            }
            syncDrivingProfileActionButtons();
        }

        // Refresh profile UI from local state (profiles are stored in localStorage, not on device).
        function refreshDrivingProfilesFromDevice() {
            populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex);
            updateDashboardActiveProfile();
            syncDrivingProfileActionButtons();
            return { act_drv_prof: activeDrivingProfileIndex, drv_profiles: drivingProfiles };
        }

        function syncDrivingProfileActionButtons() {
            const saveBtn = document.getElementById('saveNewProfileBtn');
            if (saveBtn) {
                saveBtn.disabled = drivingProfileBusy || drivingProfilesLocked;
            }

            const updateBtn = document.getElementById('drvProfileUpdateBtn');
            if (!updateBtn) return;

            const activeProfile = getActiveDrivingProfile();
            const showUpdate = !!activeProfile && isPageDirty('tuning');
            updateBtn.classList.toggle('profile-update-needs-save', showUpdate);
            updateBtn.disabled = !showUpdate || drivingProfileBusy || drivingProfilesLocked;
        }

        function syncDrivingProfilesCardUI() {
            const card = document.getElementById('drivingProfilesCard');
            const body = document.getElementById('drivingProfilesCardBody');
            const lockIcon = document.getElementById('drivingProfilesLockIcon');
            const chevron = document.getElementById('drivingProfilesChevron');
            const isCollapsed = localStorage.getItem('drivingProfilesCardCollapsed') === 'true';

            if (card) card.classList.toggle('profile-card-locked', drivingProfilesLocked);
            if (body) body.style.display = isCollapsed ? 'none' : 'block';
            if (chevron) {
                chevron.textContent = isCollapsed ? 'keyboard_arrow_right' : 'keyboard_arrow_down';
                chevron.title = isCollapsed ? 'Expand driving profiles' : 'Collapse driving profiles';
            }
            if (lockIcon) {
                lockIcon.textContent = drivingProfilesLocked ? 'lock' : 'lock_open_right';
                lockIcon.style.color = drivingProfilesLocked ? 'var(--lime-green)' : 'var(--high-impact-color)';
                lockIcon.title = drivingProfilesLocked ? 'Unlock driving profiles' : 'Lock driving profiles to prevent changes';
            }
        }

        function toggleDrivingProfilesLock() {
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));
            drivingProfilesLocked = !drivingProfilesLocked;
            localStorage.setItem('drivingProfilesLocked', drivingProfilesLocked.toString());
            syncDrivingProfilesCardUI();
            populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex);
        }

        function toggleDrivingProfilesCard() {
            const isCollapsed = localStorage.getItem('drivingProfilesCardCollapsed') === 'true';
            localStorage.setItem('drivingProfilesCardCollapsed', isCollapsed ? 'false' : 'true');
            syncDrivingProfilesCardUI();
        }

        async function runDrivingProfileOperation(context, action, options = {}) {
            const { suppressStatus = false } = options;
            if (drivingProfileBusy) {
                toast.info('A profile action is already in progress');
                return null;
            }

            setDrivingProfileBusy(true, context, { suppressStatus });
            try {
                const timeoutMs = String(context || '').includes('loading') ? 12000 : 9000;
                return await withTimeout(Promise.resolve().then(() => action()), timeoutMs, `Profile ${context || 'operation'}`);
            } finally {
                setDrivingProfileBusy(false, '', { suppressStatus });
                populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex, { suppressStatus });
            }
        }

        function populateDrivingProfileSelector(profiles, activeIndex, options = {}) {
            const { suppressStatus = false } = options;
            const container = document.getElementById('drvProfileList');
            if (!container) return;
            container.innerHTML = '';

            if (!profiles || profiles.length === 0) {
                const msg = document.createElement('div');
                msg.className = 'text-muted text-center py-2';
                msg.style.fontSize = '0.875rem';
                msg.textContent = 'No profiles saved yet';
                container.appendChild(msg);
                syncDrivingProfilesCardUI();
                return;
            }

            profiles.forEach(p => {
                const row = document.createElement('div');
                row.className = 'drv-profile-item d-flex align-items-center justify-content-between px-2 py-1';
                row.dataset.profileIndex = p.index;
                const isActive = Number(p.index) === Number(activeIndex);
                if (isActive) {
                    row.style.cssText = 'background:rgba(200,168,0,0.15);border-radius:6px;border:1px solid #c8a800;';
                }

                const nameWrap = document.createElement('div');
                nameWrap.className = 'd-flex align-items-center flex-grow-1';

                const activeDotSlot = document.createElement('span');
                activeDotSlot.setAttribute('aria-hidden', 'true');
                activeDotSlot.style.cssText = 'display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;flex:0 0 10px;background:' + (isActive ? 'var(--lime-green)' : 'transparent') + ';';

                const nameBtn = document.createElement('button');
                nameBtn.type = 'button';
                nameBtn.className = 'btn btn-link p-0 text-start text-decoration-none flex-grow-1';
                nameBtn.style.cssText = 'color:' + (isActive ? '#c8a800' : '#fff') + ';font-size:0.9rem;';
                nameBtn.textContent = p.name;
                nameBtn.disabled = drivingProfileBusy || drivingProfilesLocked;
                nameBtn.addEventListener('click', () => selectDrivingProfile(p.index));

                nameWrap.appendChild(activeDotSlot);
                nameWrap.appendChild(nameBtn);

                const metaWrap = document.createElement('div');
                metaWrap.className = 'd-flex align-items-center gap-2';

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'btn btn-link p-0 ms-2';
                delBtn.style.cssText = 'color:#888;font-size:1rem;';
                delBtn.title = 'Delete profile';
                delBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1.1rem;vertical-align:middle;">delete</span>';
                delBtn.disabled = drivingProfileBusy || drivingProfilesLocked;
                delBtn.addEventListener('click', () => confirmDeleteDrivingProfile(p.index));
                metaWrap.appendChild(delBtn);

                row.appendChild(nameWrap);
                row.appendChild(metaWrap);
                container.appendChild(row);
            });

            // Enable/disable "Save as New" button
            const saveBtn = document.getElementById('saveNewProfileBtn');
            if (saveBtn) saveBtn.disabled = drivingProfileBusy || drivingProfilesLocked;
            syncDrivingProfileActionButtons();

            syncDrivingProfilesCardUI();
        }

        async function selectDrivingProfile(index) {
            if (drivingProfilesLocked) {
                toast.warning('Driving profiles are locked. Unlock to make changes.');
                return;
            }
            const profile = drivingProfiles.find(p => Number(p.index) === Number(index));
            if (!profile) {
                toast.warning('Profile not found');
                return;
            }
            if (!profile.tuning) {
                toast.warning(`"${profile.name}" has no saved values yet. Update the profile first.`);
                return;
            }

            // Update active index and persist immediately so UI reflects change even if BLE push fails.
            activeDrivingProfileIndex = index;
            saveLocalDrivingProfiles();
            populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex, { suppressStatus: true });
            syncDashboardForDrivingProfile(profile);

            await applyDrivingProfileSelection(profile, {
                successMessage: `Loaded profile "${profile.name}"`,
                disconnectedMessage: `Profile "${profile.name}" loaded. Connect to apply to truck.`,
                successStatus: `Status: applied "${profile.name}"`,
                disconnectedStatus: `Status: "${profile.name}" loaded (not connected)`,
                useGarageSyncModalForSwitch: true
            });
        }

        function showProfileNameDialog(existingName = '') {
            return new Promise(resolve => {
                const existing = document.getElementById('profile-name-overlay');
                if (existing) existing.remove();
                const overlay = document.createElement('div');
                overlay.id = 'profile-name-overlay';
                                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:calc(24px + env(safe-area-inset-top, 0px)) 20px 20px;';
                overlay.innerHTML = `
                  <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
                    <h5 style="margin:0 0 12px;color:#fff;">Save Driving Profile</h5>
                    <p style="margin:0 0 12px;color:#aaa;font-size:0.875rem;">Enter a name for this profile (max 20 characters).</p>
                    <input id="pnd-name" type="text" maxlength="20" placeholder="e.g. Rock Crawl"
                           style="width:100%;padding:10px;border-radius:8px;border:1px solid #555;background:#2a2a2a;color:#fff;margin-bottom:16px;box-sizing:border-box;"
                           value="${existingName.replace(/"/g, '&quot;')}">
                    <div style="display:flex;gap:8px;">
                      <button id="pnd-cancel" style="flex:1;padding:10px;border:none;border-radius:8px;background:#333;color:#aaa;border:1px solid #555;cursor:pointer;">Cancel</button>
                                            <button id="pnd-save"   style="flex:1;padding:10px;border:none;border-radius:8px;background:#c8a800;color:#000;font-weight:600;cursor:pointer;">Save</button>
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
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:calc(24px + env(safe-area-inset-top, 0px)) 20px 20px;';

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
            if (drivingProfilesLocked) {
                toast.warning('Driving profiles are locked. Unlock to make changes.');
                return;
            }
            let targetSlot;
            let profileName;

            if (drivingProfiles.length >= MAX_DRIVING_PROFILES) {
                // All slots full — ask user to pick one to overwrite
                targetSlot = await showProfileOverwriteDialog(drivingProfiles);
                if (targetSlot == null) return;
                const existing = drivingProfiles.find(p => p.index === targetSlot);
                profileName = await showProfileNameDialog(existing ? existing.name : '');
            } else {
                profileName = await showProfileNameDialog();
                if (!profileName) return;
                // Assign next sequential index
                const usedSlots = new Set(drivingProfiles.map(p => p.index));
                targetSlot = 0;
                while (usedSlots.has(targetSlot) && targetSlot < MAX_DRIVING_PROFILES) targetSlot++;
            }

            if (!profileName) return;

            const snapshot = captureCurrentTuningValues();
            const existingIdx = drivingProfiles.findIndex(p => Number(p.index) === Number(targetSlot));
            if (existingIdx >= 0) {
                drivingProfiles[existingIdx] = { index: targetSlot, name: profileName, tuning: snapshot };
            } else {
                drivingProfiles.push({ index: targetSlot, name: profileName, tuning: snapshot });
                drivingProfiles.sort((a, b) => a.index - b.index);
            }
            activeDrivingProfileIndex = targetSlot;
            saveLocalDrivingProfiles();
            clearPageDirty('tuning');
            populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex);
            syncDashboardForDrivingProfile({ tuning: snapshot });
            toast.success(`Saved profile "${profileName}"`);
        }

        async function updateActiveDrivingProfile() {
            if (drivingProfilesLocked) {
                toast.warning('Driving profiles are locked. Unlock to make changes.');
                return;
            }
            const active = getActiveDrivingProfile();
            if (!active) {
                toast.warning('No active profile selected. Save a profile first.');
                return;
            }

            const snapshot = captureCurrentTuningValues();
            const idx = drivingProfiles.indexOf(active);
            drivingProfiles[idx] = { ...active, tuning: snapshot };
            saveLocalDrivingProfiles();
            clearPageDirty('tuning');
            syncDashboardForDrivingProfile({ tuning: snapshot });
            toast.success(`Updated profile "${active.name}"`);
        }

        async function confirmDeleteDrivingProfile(index) {
            if (drivingProfilesLocked) {
                toast.warning('Driving profiles are locked. Unlock to make changes.');
                return;
            }
            const profile = drivingProfiles.find(p => Number(p.index) === Number(index));
            if (!profile) return;

            if (drivingProfiles.length <= 1) {
                toast.warning('Cannot delete the last profile.');
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
                                            <button id="pd-cancel" style="flex:1;padding:10px;border:none;border-radius:8px;background:#333;color:#aaa;border:1px solid #555;cursor:pointer;">Cancel</button>
                                            <button id="pd-delete" style="flex:1;padding:10px;border:none;border-radius:8px;background:#c0392b;color:#fff;font-weight:600;cursor:pointer;">Delete</button>
                    </div>
                  </div>`;
                document.body.appendChild(overlay);
                overlay.querySelector('#pd-delete').onclick = () => { overlay.remove(); resolve(true); };
                overlay.querySelector('#pd-cancel').onclick = () => { overlay.remove(); resolve(false); };
            });

            if (!confirmed) return;

            const wasActive = Number(activeDrivingProfileIndex) === Number(index);
            drivingProfiles = drivingProfiles.filter(p => Number(p.index) !== Number(index));
            let nextActiveProfile = null;
            if (wasActive || !drivingProfiles.some(p => p.index === activeDrivingProfileIndex)) {
                activeDrivingProfileIndex = drivingProfiles[0].index;
                nextActiveProfile = drivingProfiles.find(p => Number(p.index) === Number(activeDrivingProfileIndex)) || null;
            }
            saveLocalDrivingProfiles();
            populateDrivingProfileSelector(drivingProfiles, activeDrivingProfileIndex);

            if (nextActiveProfile) {
                syncDashboardForDrivingProfile(nextActiveProfile);
                await applyDrivingProfileSelection(nextActiveProfile, {
                    successMessage: `Profile deleted. Loaded profile "${nextActiveProfile.name}"`,
                    disconnectedMessage: `Profile deleted. "${nextActiveProfile.name}" is now active. Connect to apply to truck.`,
                    successStatus: `Status: deleted profile, applied "${nextActiveProfile.name}"`,
                    disconnectedStatus: `Status: deleted profile, "${nextActiveProfile.name}" active (not connected)`,
                    failureStatus: 'Status: deleted profile, replacement applied locally only'
                });
            } else {
                updateDashboardActiveProfile();
                toast.success('Profile deleted');
            }
        }

        // Expose profile functions for HTML onclick / dev console
        window.selectDrivingProfile   = selectDrivingProfile;
        window.saveAsNewDrivingProfile = saveAsNewDrivingProfile;
        window.updateActiveDrivingProfile = updateActiveDrivingProfile;
        window.confirmDeleteDrivingProfile = confirmDeleteDrivingProfile;

        const MAX_DRIVING_PROFILES = 5;

        // ==================== Config Fetching ====================
        let hasShownInitialConfigToast = false;

        function buildLocalStorageSnapshot() {
            const snapshot = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;
                const rawValue = localStorage.getItem(key);
                if (rawValue == null) {
                    snapshot[key] = null;
                    continue;
                }
                try {
                    snapshot[key] = JSON.parse(rawValue);
                } catch (_) {
                    snapshot[key] = rawValue;
                }
            }
            const orderedSnapshot = {};
            Object.keys(snapshot).sort().forEach((key) => {
                orderedSnapshot[key] = snapshot[key];
            });
            return orderedSnapshot;
        }

        function refreshApplicationDataCard() {
            const appDataEl = document.getElementById('tuningConfigData');
            if (!appDataEl) return;
            appDataEl.textContent = JSON.stringify(buildLocalStorageSnapshot(), null, 2);
        }

        function ensureApplicationDataStorageHooks() {
            if (window.__rcdccStorageHooksInstalled) return;
            window.__rcdccStorageHooksInstalled = true;

            const dispatchStorageUpdate = () => {
                window.dispatchEvent(new Event('rcdcc:local-storage-updated'));
            };

            const nativeSetItem = localStorage.setItem.bind(localStorage);
            const nativeRemoveItem = localStorage.removeItem.bind(localStorage);
            const nativeClear = localStorage.clear.bind(localStorage);

            localStorage.setItem = function(key, value) {
                nativeSetItem(key, value);
                dispatchStorageUpdate();
            };

            localStorage.removeItem = function(key) {
                nativeRemoveItem(key);
                dispatchStorageUpdate();
            };

            localStorage.clear = function() {
                nativeClear();
                dispatchStorageUpdate();
            };

            window.addEventListener('storage', refreshApplicationDataCard);
            window.addEventListener('rcdcc:local-storage-updated', refreshApplicationDataCard);
        }

        async function fetchConfigFromESP32(showToast = true, options = {}) {
            if (typeof showToast === 'object' && showToast !== null) {
                options = showToast;
                showToast = true;
            }

            const scope = options.scope || 'all';
            const syncScopeLabel = (scope === 'bootstrap') ? 'startup' : scope;

            // Keep the More > data cards explicit during BLE chunk assembly.
            const configDataEl = document.getElementById('configData');
            if (configDataEl && isBleConnected()) {
                configDataEl.textContent = `Please wait - syncing ${syncScopeLabel} data from truck...`;
            }

            const appDataEl = document.getElementById('tuningConfigData');
            if (appDataEl && isBleConnected()) {
                appDataEl.textContent = 'Please wait - syncing and preparing local application data...';
            }

            const applyNoVehiclePlaceholders = () => {
                hasLoadedConfigFromDevice = false;
                fullConfig = null;

                const placeholderMap = {
                    reactionSpeedBadge: '--',
                    rideHeightDisplay: '--',
                    dampingDisplay: '--',
                    stiffnessDisplay: '--',
                    frontRearBalanceDisplay: '--'
                };

                Object.entries(placeholderMap).forEach(([id, value]) => {
                    const el = document.getElementById(id);
                    if (el) el.textContent = value;
                });

                clearDashboardActiveStatus();
            };

            const applyLoadedConfig = (data) => {
                fullConfig = mergeConfigSnapshots(fullConfig, data);
                hasLoadedConfigFromDevice = true;

                if (bleManager && typeof bleManager._updateFirmwareCapabilities === 'function') {
                    const hasFirmwareMetadata = !!(data && (data.fw_version || (data.system && data.system.fw_version)));
                    if (hasFirmwareMetadata) {
                        bleManager._updateFirmwareCapabilities(data);
                    }
                }

                // Load settings into Settings page
                loadSettingsFromConfig(data);

                const localProfileSnapshot = getActiveDrivingProfileConfigSnapshot();
                fullConfig = mergeConfigSnapshots(fullConfig, localProfileSnapshot);
                updateSuspensionSettings(localProfileSnapshot);
                updateTuningSliders(localProfileSnapshot);

                // Phase 3: Driving profiles are localStorage-only. Always refresh UI from local state.
                if (scope === 'tuning' || scope === 'bootstrap') {
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

                // Phase 5: Lighting profiles are localStorage-only.
                // Do NOT overwrite from ESP32 config — just refresh the UI.
                populateLightingProfileSelector();

                if (data.warnings && data.warnings.servoTrimReset) {
                    const warningMessage = data.warnings.message
                        || 'Unexpected servo trim value was reset to 0. Check settings before driving.';
                    toast.warning(warningMessage, { duration: 10000 });
                }

                // Display ESP32 payload in the RCDCC Data card.
                const configData = document.getElementById('configData');
                if (configData) configData.textContent = JSON.stringify(data, null, 2);

                // Display browser localStorage in the Application Data card.
                refreshApplicationDataCard();

                if (scope === 'bootstrap') {
                    // Defer full tab hydration until the user opens a section.
                    updateDashboardActiveProfile();
                    // Lighting profiles are localStorage-only — just refresh the display.
                    updateDashboardActiveLightingProfile();
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
                refreshApplicationDataCard();
                if (showToast) {
                    toast.warning('Select a vehicle to begin.');
                }
                // Keep cards usable while disconnected: only the initial load should be masked.
                finishInitialCardLoading('ble-not-connected');
                return;
            }

            try {
                communicationMode = 'ble';
                const scopeMap = {
                    bootstrap: 'bootstrap',
                    tuning: 'tuning',
                    lights: 'lights',
                    settings: 'settings'
                };
                const requestedScope = scopeMap[scope] || 'bootstrap';
                let bleData;
                if (requestedScope === 'lights'
                    && typeof bleManager.readLightsGroupIndex === 'function'
                    && typeof bleManager.readLightsGroupDetail === 'function') {
                    try {
                        const indexPayload = await bleManager.readLightsGroupIndex();
                        const activeMeta = indexPayload && indexPayload.active_lt_profile ? indexPayload.active_lt_profile : null;
                        if (!activeMeta || typeof activeMeta !== 'object') {
                            throw new Error('Missing active_lt_profile in lights index payload');
                        }

                        const groupCount = Math.max(0, Number(activeMeta.group_count) || 0);
                        const groups = [];
                        let cursor = 0;
                        let safety = 0;

                        while (cursor < groupCount && safety < 16) {
                            safety++;
                            const detailPayload = await bleManager.readLightsGroupDetail(cursor);
                            const done = !!detailPayload?.done;
                            const nextCursor = Number(detailPayload?.next_cursor);
                            const group = detailPayload?.group;
                            if (group && typeof group === 'object') {
                                groups.push(group);
                            }

                            if (Number.isFinite(nextCursor) && nextCursor > cursor) {
                                cursor = nextCursor;
                            } else {
                                cursor++;
                            }

                            if (done) break;
                        }

                        bleData = {
                            lt_profiles: Array.isArray(indexPayload.lt_profiles) ? indexPayload.lt_profiles : [],
                            lt_profile_count: Number(indexPayload.lt_profile_count) || 0,
                            act_lt_prof: Number(indexPayload.act_lt_prof) || 0,
                            active_lt_profile: {
                                index: Number(activeMeta.index) || 0,
                                name: String(activeMeta.name || 'Unnamed'),
                                master: !!activeMeta.master,
                                total_leds: Number(activeMeta.total_leds) || 0,
                                groups
                            }
                        };
                    } catch (lightsIncrementalError) {
                        console.warn('[Lights] Incremental fetch failed, falling back to scoped lights read:', lightsIncrementalError);
                        bleData = (typeof bleManager.readConfigScoped === 'function')
                            ? await bleManager.readConfigScoped(requestedScope, { onProgress: options.onProgress })
                            : await bleManager.readConfig();
                    }
                } else {
                    bleData = (typeof bleManager.readConfigScoped === 'function')
                        ? await bleManager.readConfigScoped(requestedScope, { onProgress: options.onProgress })
                        : await bleManager.readConfig();
                }
                let shouldClearDirtyOnSuccess = true;

                const dirtyAndDifferent = false;

                if (dirtyAndDifferent) {
                    const shouldReapply = confirm('The truck rebooted. Re-apply unsaved changes?');
                    if (shouldReapply) {
                        await reapplyDirtyPagesToDevice();
                        const refreshed = (typeof bleManager.readConfigScoped === 'function')
                            ? await bleManager.readConfigScoped(requestedScope, { onProgress: options.onProgress })
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
                refreshDashboardCurrentSettingsCard(getGarageVehicleNameById(bleManager?.deviceId));
            } catch (error) {
                console.error('Failed to fetch config:', error);
                const configData = document.getElementById('configData');
                if (configData) configData.textContent = `Error: ${error.message}`;
                refreshApplicationDataCard();
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
                if (display) display.textContent = `${config.rideHeightOffset.toFixed(0)}`;
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
                step: 1,
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
                    syncTuningStepperButtons();
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
                step: 0.1,
                thumbsDisabled: [true, false],
                rangeSlideDisabled: true,
                onInput: function(value, userInteraction) {
                    tuningSliderValues.damping = value[1];
                    updateTuningThumbLabel('sliderDamping', value[1], 1);
                    if (!isLoadingTuningConfig) {
                        markPageDirty('tuning');
                        tuningSliderPendingSave.damping = true;
                    }
                    syncTuningStepperButtons();
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
                step: 0.1,
                thumbsDisabled: [true, false],
                rangeSlideDisabled: true,
                onInput: function(value, userInteraction) {
                    tuningSliderValues.stiffness = value[1];
                    updateTuningThumbLabel('sliderStiffness', value[1], 1);
                    if (!isLoadingTuningConfig) {
                        markPageDirty('tuning');
                        tuningSliderPendingSave.stiffness = true;
                    }
                    syncTuningStepperButtons();
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
                step: 0.1,
                thumbsDisabled: [true, false],
                rangeSlideDisabled: true,
                onInput: function(value, userInteraction) {
                    tuningSliderValues.reactionSpeed = value[1];
                    updateTuningThumbLabel('sliderReactionSpeed', value[1], 1);
                    if (!isLoadingTuningConfig) {
                        markPageDirty('tuning');
                        tuningSliderPendingSave.reactionSpeed = true;
                    }
                    syncTuningStepperButtons();
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
                step: 1,
                thumbsDisabled: [true, false],
                rangeSlideDisabled: true,
                onInput: function(value, userInteraction) {
                    tuningSliderValues.frontRearBalance = Math.round(value[1]);
                    updateTuningThumbLabel('sliderBalance', tuningSliderValues.frontRearBalance, 0);
                    if (!isLoadingTuningConfig) {
                        markPageDirty('tuning');
                        tuningSliderPendingSave.balance = true;
                    }
                    syncTuningStepperButtons();
                }
            });
            tuningSliderInstances.balance = { element: balanceElement, instance: balanceInstance };
            updateTuningThumbLabel('sliderBalance', 50, 0);
            attachReleaseSaveHandler(balanceElement, 'balance');

            function setTuningSliderElementValue(sliderKey, minVal, newValue) {
                const store = tuningSliderInstances[sliderKey];
                if (!store || !store.element || !store.instance) return;

                const normalizedValue = normalizeTuningStepperValue(sliderKey, newValue);
                const inputs = store.element.querySelectorAll('input[type="range"]');
                if (inputs.length >= 2) {
                    inputs[0].value = minVal;
                    inputs[1].value = normalizedValue;
                }

                store.instance.value([minVal, normalizedValue]);
                store.element.dispatchEvent(new Event('input', { bubbles: true }));
            }

            function bindTuningStepperButtons() {
                document.querySelectorAll('.slider-stepper-control[data-slider-key]').forEach(control => {
                    if (control.dataset.bound === 'true') return;
                    control.dataset.bound = 'true';

                    const sliderKey = control.dataset.sliderKey;
                    const config = tuningStepperConfigs[sliderKey];
                    if (!config) return;

                    control.querySelectorAll('.slider-stepper-btn').forEach(button => {
                        button.addEventListener('click', () => {
                            if (tuningSliderLocks[sliderKey] || localStorage.getItem('tuningParametersLocked') === 'true') return;
                            const current = normalizeTuningStepperValue(sliderKey, getTuningStepperCurrentValue(sliderKey));
                            const nextValue = normalizeTuningStepperValue(sliderKey, current + (Number(button.dataset.direction) || 0) * config.step);
                            if (nextValue === current) return;
                            setTuningSliderElementValue(sliderKey, config.min, nextValue);
                            commitTuningSliderSave(sliderKey);
                            syncTuningStepperButtons();
                        });
                    });
                });
            }

            // Initialize Sensor Refresh Rate - Horizontal slider (5-50 Hz)
            // Note: sampleRate has no RCDCC_KEY; always uses legacy path on connected devices.
            let sensorElement = document.querySelector('#sliderSensorRate');
            const sensorInstance = rangeSlider(sensorElement, {
                value: [5, 25],
                min: 5,
                max: 50,
                step: 1,
                thumbsDisabled: [true, false],
                rangeSlideDisabled: true,
                onInput: function(value, userInteraction) {
                    tuningSliderValues.sampleRate = Math.round(value[1]);
                    updateTuningThumbLabel('sliderSensorRate', tuningSliderValues.sampleRate, 0);
                    if (!isLoadingTuningConfig) {
                        markPageDirty('tuning');
                        tuningSliderPendingSave.sensorRate = true;
                    }
                    syncTuningStepperButtons();
                }
            });
            tuningSliderInstances.sensorRate = { element: sensorElement, instance: sensorInstance };
            updateTuningThumbLabel('sliderSensorRate', 25, 0);
            attachReleaseSaveHandler(sensorElement, 'sensorRate');
            bindTuningStepperButtons();
            syncTuningStepperButtons();
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
        let rcdccConfigurationLocked = false;

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
            const SERVO_RANGE_MIN_GAP_DEG = 2;

            function normalizeServoRangePair(minValue, maxValue) {
                let nextMin = Math.round(Number(minValue) || 0);
                let nextMax = Math.round(Number(maxValue) || 0);

                nextMin = Math.max(0, Math.min(180, nextMin));
                nextMax = Math.max(0, Math.min(180, nextMax));

                if (nextMax - nextMin < SERVO_RANGE_MIN_GAP_DEG) {
                    if (nextMin + SERVO_RANGE_MIN_GAP_DEG <= 180) {
                        nextMax = nextMin + SERVO_RANGE_MIN_GAP_DEG;
                    } else {
                        nextMin = Math.max(0, 180 - SERVO_RANGE_MIN_GAP_DEG);
                        nextMax = 180;
                    }
                }

                return [nextMin, nextMax];
            }

            // Front Left Servo
            let frontLeftElement = document.querySelector('#sliderFrontLeft');
            if (frontLeftElement) {
                const frontLeftInstance = rangeSlider(frontLeftElement, {
                    value: [defaultMin, defaultMax],
                    min: 0,
                    max: 180,
                    step: 2,
                    onInput: function(value) {
                        const normalizedRange = normalizeServoRangePair(value[0], value[1]);
                        if (normalizedRange[0] !== Math.round(value[0]) || normalizedRange[1] !== Math.round(value[1])) {
                            frontLeftInstance.value(normalizedRange);
                            return;
                        }
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
                    step: 1,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        updateTrimThumbLabel('sliderFrontLeftTrim', value[1]);
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            servoSliderValues.frontLeft.trim = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.frontLeft.trim = true;
                        }
                        syncServoTrimStepperButtons();
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
                        const normalizedRange = normalizeServoRangePair(value[0], value[1]);
                        if (normalizedRange[0] !== Math.round(value[0]) || normalizedRange[1] !== Math.round(value[1])) {
                            frontRightInstance.value(normalizedRange);
                            return;
                        }
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
                    step: 1,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        updateTrimThumbLabel('sliderFrontRightTrim', value[1]);
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            servoSliderValues.frontRight.trim = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.frontRight.trim = true;
                        }
                        syncServoTrimStepperButtons();
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
                        const normalizedRange = normalizeServoRangePair(value[0], value[1]);
                        if (normalizedRange[0] !== Math.round(value[0]) || normalizedRange[1] !== Math.round(value[1])) {
                            rearLeftInstance.value(normalizedRange);
                            return;
                        }
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
                    step: 1,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        updateTrimThumbLabel('sliderRearLeftTrim', value[1]);
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            servoSliderValues.rearLeft.trim = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.rearLeft.trim = true;
                        }
                        syncServoTrimStepperButtons();
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
                        const normalizedRange = normalizeServoRangePair(value[0], value[1]);
                        if (normalizedRange[0] !== Math.round(value[0]) || normalizedRange[1] !== Math.round(value[1])) {
                            rearRightInstance.value(normalizedRange);
                            return;
                        }
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
                    step: 1,
                    thumbsDisabled: [true, false],
                    rangeSlideDisabled: true,
                    onInput: function(value) {
                        updateTrimThumbLabel('sliderRearRightTrim', value[1]);
                        if (!isLoadingTuningConfig && !servoTrimLocked) {
                            servoSliderValues.rearRight.trim = Math.round(value[1]);
                            markPageDirty('servo');
                            servoPendingSave.rearRight.trim = true;
                        }
                        syncServoTrimStepperButtons();
                    }
                });
                servoSliderInstances.rearRight.trimElement = rearRightTrimElement;
                servoSliderInstances.rearRight.trimInstance = rearRightTrimInstance;
                updateTrimThumbLabel('sliderRearRightTrim', 0);
                attachServoReleaseSaveHandler(rearRightTrimElement, 'rearRight', 'trim');
            }

            function setServoTrimSliderElementValue(servoName, newValue) {
                const sliderData = servoSliderInstances[servoName];
                if (!sliderData || !sliderData.trimInstance || !sliderData.trimElement) return;
                const normalizedValue = normalizeServoTrimStepperValue(servoName, newValue);
                sliderData.trimInstance.value([-20, normalizedValue]);
                sliderData.trimElement.dispatchEvent(new Event('input', { bubbles: true }));
            }

            function bindServoTrimStepperButtons() {
                document.querySelectorAll('.slider-stepper-control[data-servo-trim]').forEach(control => {
                    if (control.dataset.bound === 'true') return;
                    control.dataset.bound = 'true';

                    const servoName = control.dataset.servoTrim;
                    const config = servoTrimStepperConfigs[servoName];
                    if (!config) return;

                    control.querySelectorAll('.slider-stepper-btn').forEach(button => {
                        button.addEventListener('click', () => {
                            if (servoTrimLocked) return;
                            const current = normalizeServoTrimStepperValue(servoName, servoSliderValues?.[servoName]?.trim);
                            const nextValue = normalizeServoTrimStepperValue(servoName, current + (Number(button.dataset.direction) || 0) * config.step);
                            if (nextValue === current) return;
                            setServoTrimSliderElementValue(servoName, nextValue);
                            commitServoSliderSave(servoName, 'trim');
                            syncServoTrimStepperButtons();
                        });
                    });
                });
            }

            bindServoTrimStepperButtons();
            syncServoTrimStepperButtons();

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

        const tuningStepperConfigs = {
            rideHeight: { min: 0, max: 100, step: 1, decimals: 0, valueKey: 'rideHeightOffset' },
            damping: { min: 0.1, max: 2.0, step: 0.1, decimals: 1, valueKey: 'damping' },
            stiffness: { min: 0.5, max: 3.0, step: 0.1, decimals: 1, valueKey: 'stiffness' },
            reactionSpeed: { min: 0.1, max: 5.0, step: 0.1, decimals: 1, valueKey: 'reactionSpeed' },
            balance: { min: 0, max: 100, step: 1, decimals: 0, valueKey: 'frontRearBalance' },
            sensorRate: { min: 5, max: 50, step: 1, decimals: 0, valueKey: 'sampleRate' }
        };

        function getTuningStepperCurrentValue(sliderKey) {
            const config = tuningStepperConfigs[sliderKey];
            if (!config) return null;
            return tuningSliderValues[config.valueKey];
        }

        function normalizeTuningStepperValue(sliderKey, value) {
            const config = tuningStepperConfigs[sliderKey];
            if (!config) return value;
            const stepped = config.min + Math.round((Number(value) - config.min) / config.step) * config.step;
            const clamped = Math.max(config.min, Math.min(config.max, stepped));
            return config.decimals > 0 ? Number(clamped.toFixed(config.decimals)) : Math.round(clamped);
        }

        function syncTuningStepperButtons() {
            const tuningLocked = localStorage.getItem('tuningParametersLocked') === 'true';
            document.querySelectorAll('.slider-stepper-control[data-slider-key]').forEach(control => {
                const sliderKey = control.dataset.sliderKey;
                const config = tuningStepperConfigs[sliderKey];
                if (!config) return;
                const current = normalizeTuningStepperValue(sliderKey, getTuningStepperCurrentValue(sliderKey));
                control.querySelectorAll('.slider-stepper-btn').forEach(button => {
                    const direction = Number(button.dataset.direction) || 0;
                    const atMin = direction < 0 && current <= config.min;
                    const atMax = direction > 0 && current >= config.max;
                    button.disabled = tuningLocked || !!tuningSliderLocks[sliderKey] || atMin || atMax;
                });
            });
        }

        const servoTrimStepperConfigs = {
            frontLeft: { min: -20, max: 20, step: 1 },
            frontRight: { min: -20, max: 20, step: 1 },
            rearLeft: { min: -20, max: 20, step: 1 },
            rearRight: { min: -20, max: 20, step: 1 }
        };

        function normalizeServoTrimStepperValue(servoName, value) {
            const config = servoTrimStepperConfigs[servoName];
            if (!config) return Math.round(Number(value) || 0);
            const stepped = config.min + Math.round((Number(value) - config.min) / config.step) * config.step;
            return Math.max(config.min, Math.min(config.max, Math.round(stepped)));
        }

        function syncServoTrimStepperButtons() {
            document.querySelectorAll('.slider-stepper-control[data-servo-trim]').forEach(control => {
                const servoName = control.dataset.servoTrim;
                const config = servoTrimStepperConfigs[servoName];
                if (!config) return;
                const current = normalizeServoTrimStepperValue(servoName, servoSliderValues?.[servoName]?.trim);
                control.querySelectorAll('.slider-stepper-btn').forEach(button => {
                    const direction = Number(button.dataset.direction) || 0;
                    const atMin = direction < 0 && current <= config.min;
                    const atMax = direction > 0 && current >= config.max;
                    button.disabled = !!servoTrimLocked || atMin || atMax;
                });
            });
        }

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
            
            syncTuningStepperButtons();
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

            syncServoTrimStepperButtons();
            
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

            syncTuningStepperButtons();
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
                chevron.classList.remove('is-collapsed');
                localStorage.setItem('lightsGuideCardCollapsed', 'false');
            } else {
                cardBody.style.display = 'none';
                chevron.textContent = 'keyboard_arrow_down';
                chevron.classList.add('is-collapsed');
                localStorage.setItem('lightsGuideCardCollapsed', 'true');
            }
        }

        function syncCardCollapseState(cardId, chevronId, storageKey) {
            const card = document.getElementById(cardId);
            const chevron = document.getElementById(chevronId);
            if (!card || !chevron) return;

            const cardBody = card.querySelector('.card-body');
            if (!cardBody) return;

            const isCollapsed = localStorage.getItem(storageKey) === 'true';
            cardBody.style.display = isCollapsed ? 'none' : 'block';
            if (chevron.classList.contains('lights-collapse-chevron')) {
                chevron.textContent = 'keyboard_arrow_down';
                chevron.classList.toggle('is-collapsed', isCollapsed);
            } else {
                chevron.textContent = isCollapsed ? 'keyboard_arrow_right' : 'keyboard_arrow_down';
            }
        }

        function toggleCardCollapse(cardId, chevronId, storageKey) {
            const isCollapsed = localStorage.getItem(storageKey) === 'true';
            localStorage.setItem(storageKey, isCollapsed ? 'false' : 'true');
            syncCardCollapseState(cardId, chevronId, storageKey);
        }

        function syncRcdccConfigurationLockUI() {
            const card = document.getElementById('rcdccConfigurationCard');
            const lockIcon = document.getElementById('rcdccConfigurationLockIcon');
            const orientationSelect = document.getElementById('mpuOrientation');

            if (card) {
                card.classList.toggle('slider-locked', rcdccConfigurationLocked);
            }
            if (lockIcon) {
                lockIcon.textContent = rcdccConfigurationLocked ? 'lock' : 'lock_open_right';
                lockIcon.style.color = rcdccConfigurationLocked ? 'var(--lime-green)' : 'var(--high-impact-color)';
                lockIcon.title = rcdccConfigurationLocked
                    ? 'Unlock hardware configuration controls'
                    : 'Lock hardware configuration controls';
            }
            if (orientationSelect) {
                orientationSelect.disabled = rcdccConfigurationLocked;
            }
        }

        function toggleRcdccConfigurationLock() {
            const clickSound = new Audio('toasty/dist/sounds/info/1.mp3');
            clickSound.play().catch(e => console.log('Sound play failed:', e));

            rcdccConfigurationLocked = !rcdccConfigurationLocked;
            localStorage.setItem('rcdccConfigurationLocked', rcdccConfigurationLocked.toString());
            syncRcdccConfigurationLockUI();
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
            const autoCalibrateBtn = document.getElementById('servoAutoCalibrateBtn');
            const allLocked = servoTrimLocked && servoRotationLocked;
            if (card) {
                card.classList.toggle('trim-locked', servoTrimLocked);
                card.classList.toggle('rotation-locked', servoRotationLocked);
            }
            if (autoCalibrateBtn) {
                autoCalibrateBtn.disabled = allLocked;
                autoCalibrateBtn.setAttribute('aria-disabled', allLocked ? 'true' : 'false');
                autoCalibrateBtn.title = allLocked
                    ? 'Unlock Trim / Rotation to run Auto Calibrate'
                    : 'Run Auto Calibrate';
            }
            if (lockIcon) {
                lockIcon.textContent = allLocked ? 'lock' : 'lock_open_right';
                lockIcon.style.color = allLocked ? 'var(--lime-green)' : 'var(--high-impact-color)';
                lockIcon.title = allLocked ? 'Unlock trim and direction controls' : 'Lock trim and direction controls';
            }
            syncServoTrimStepperButtons();
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
            markPageDirty('system');
            // Phase 2: use writeValue() for KV firmware, legacy path otherwise
            const canUseKv = !!(bleManager && typeof bleManager.writeValue === 'function' && bleManager.supportsKvUpdates);
            if (canUseKv) {
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
                            const trimVal = Math.round(parseRSliderValue(value)[0] ?? 0);

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

            applyDebugModeVisibility();

            // Restore last active tab from localStorage
            const savedTabCandidate = localStorage.getItem('settings_active_tab') || 'preferences';
            const savedTabAllowed = savedTabCandidate !== 'debugging' || isDebugModeEnabled();
            const savedTab = document.querySelector(`.settings-tab[data-tab="${savedTabCandidate}"]`)
                && savedTabAllowed
                ? savedTabCandidate
                : 'preferences';
            
            // Set up tab click handlers
            document.querySelectorAll('.settings-tab').forEach(tab => {
                tab.addEventListener('click', async function() {
                    const tabName = this.dataset.tab;
                    if (tabName === 'debugging' && !isDebugModeEnabled()) return;
                    const currentTab = localStorage.getItem('settings_active_tab') || 'preferences';
                    const currentDirtyPage = dirtyPageForTab(currentTab);
                    const nextDirtyPage = dirtyPageForTab(tabName);

                    // Dirty guard for tab switching
                    const dirtySettingsPages = ['servo', 'system']
                        .filter((k) => isPageDirty(k))
                        .filter((k) => k !== nextDirtyPage);
                    if (currentTab !== tabName && currentDirtyPage !== nextDirtyPage && dirtySettingsPages.length) {
                        const choice = await showDirtyConfirmDialog(dirtySettingsPages);
                        if (choice === 'cancel') return;
                        const resolved = await resolveDirtyPagesForChoice(dirtySettingsPages, choice);
                        if (!resolved) return;
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