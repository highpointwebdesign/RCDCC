// ====================================================================================
// Garage Manager — Vehicle storage and BLE connection management
// ====================================================================================
// Vehicles are stored in localStorage as an array of:
// { id: 'MAC', bleName: 'RCDCC-ABC123', friendlyName: 'My TRX4', lastSeen: ISO string }
// ====================================================================================

const GarageManager = (() => {
    const STORAGE_KEY = 'rcdcc_garage_vehicles';
    const DRIVING_PROFILES_STORAGE_KEY = 'rcdcc_driving_profiles_v2';
    const LIGHT_GROUPS_STORAGE_KEY = 'lightGroups';
    const LIGHT_GROUPS_INITIALIZED_KEY = 'lightGroupsInitialized';
    const LIGHT_MASTER_STORAGE_KEY = 'lightsMasterEnabled';
    const TOTAL_LED_COUNT_KEY = 'totalLEDCount';
    const LIGHTING_PROFILES_STORAGE_KEY = 'rcdcc_lighting_profiles_v1';
    let _renameVehicleId = null;
    let _connectingVehicleId = null;
    let _connectErrorVehicleId = null;
    let _connectErrorTimer = null;
    let _autoReconnectVehicleId = null;
    let _autoReconnectPulseTimer = null;
    let _disconnectLongPressTimer = null;
    let _disconnectLongPressVehicleId = null;
    let _longPressTriggeredVehicleId = null;
    let _lastLongPressHintAtMs = 0;
    let _pressingVehicleId = null;
    let _connectedVehicleRssi = null;
    let _rssiPollTimer = null;
    let _rssiPollDeviceId = null;
    let _rssiPollInFlight = false;
    const LONG_PRESS_DISCONNECT_MS = 650;
    const MAX_LABEL_LENGTH = 12;

    function normalizeDeviceId(deviceId) {
        return String(deviceId || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
    }

    function deviceIdsEqual(a, b) {
        const left = normalizeDeviceId(a);
        const right = normalizeDeviceId(b);
        return !!left && !!right && left === right;
    }

    function isBleSessionActive() {
        const manager = window.bleManager;
        if (!manager) return false;
        if (typeof manager.getConnectionStatus === 'function') {
            return !!manager.getConnectionStatus();
        }
        return !!manager.isConnected;
    }

    function getActiveBleDeviceId() {
        if (!isBleSessionActive()) return null;

        const manager = window.bleManager;
        return manager?.deviceId
            || manager?.preferredDeviceId
            || localStorage.getItem('rcdccBlePreferredDeviceId')
            || null;
    }

    function timeAgo(isoString) {
        if (!isoString) return null;
        const past = new Date(isoString);
        if (isNaN(past)) return null;
        const diffMs = Date.now() - past.getTime();
        if (diffMs < 0) return null;
        const sec  = Math.floor(diffMs / 1000);
        const min  = Math.floor(sec  / 60);
        const hr   = Math.floor(min  / 60);
        const day  = Math.floor(hr   / 24);
        const mo   = Math.floor(day  / 30);
        const yr   = Math.floor(day  / 365);
        if (sec  <  60)  return `${sec}s ago`;
        if (min  <  60)  return `${min}m ago`;
        if (hr   <  24)  return `${hr}h ago`;
        if (day  <  30)  return `${day}d ago`;
        if (mo   <  12)  return `${mo}mo ago`;
        return `${yr}y ago`;
    }

    function sanitizeVehicleLabel(name, fallback = 'Vehicle') {
        const trimmed = String(name || '').trim();
        const resolved = trimmed || String(fallback || 'Vehicle').trim() || 'Vehicle';
        return resolved.slice(0, MAX_LABEL_LENGTH);
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function clearRssiPollTimer() {
        if (_rssiPollTimer) {
            clearTimeout(_rssiPollTimer);
            _rssiPollTimer = null;
        }
    }

    function stopRssiPolling() {
        clearRssiPollTimer();
        _rssiPollDeviceId = null;
        _rssiPollInFlight = false;
        _connectedVehicleRssi = null;
    }

    async function refreshConnectedVehicleRssi() {
        if (_rssiPollInFlight) return;
        if (!window.bleManager || !window.bleManager.isConnected || typeof window.bleManager.readRssi !== 'function') {
            _connectedVehicleRssi = null;
            return;
        }

        _rssiPollInFlight = true;
        try {
            const nextRssi = await window.bleManager.readRssi();
            if (Number.isFinite(nextRssi) && nextRssi !== _connectedVehicleRssi) {
                _connectedVehicleRssi = nextRssi;
                renderGarage();
            }
        } catch (error) {
            console.warn('Garage RSSI read failed:', error?.message || error);
        } finally {
            _rssiPollInFlight = false;
        }
    }

    function getSignalStrengthPresentation(rssi) {
        const value = Number(rssi);
        if (!Number.isFinite(value)) {
            return {
                icon: 'network_check',
                label: 'Signal ...',
                toneClass: 'garage-card-signal-pending'
            };
        }

        if (value >= -55) {
            return {
                icon: 'signal_cellular_4_bar',
                label: 'Signal Excellent',
                toneClass: 'garage-card-signal-excellent'
            };
        }

        if (value >= -85) {
            return {
                icon: 'signal_cellular_3_bar',
                label: 'Signal Good',
                toneClass: 'garage-card-signal-good'
            };
        }

        if (value >= -95) {
            return {
                icon: 'signal_cellular_2_bar',
                label: 'Signal Fair',
                toneClass: 'garage-card-signal-fair'
            };
        }

        return {
            icon: 'signal_cellular_1_bar',
            label: 'Signal Poor',
            toneClass: 'garage-card-signal-poor'
        };
    }

    function ensureRssiPollingState() {
        const activeDeviceId = getActiveBleDeviceId();

        if (!activeDeviceId) {
            stopRssiPolling();
            return;
        }

        if (_rssiPollDeviceId && deviceIdsEqual(_rssiPollDeviceId, activeDeviceId)) {
            return;
        }

        clearRssiPollTimer();
        _rssiPollDeviceId = activeDeviceId;
        _connectedVehicleRssi = null;

        const scheduleNextPoll = () => {
            clearRssiPollTimer();
            _rssiPollTimer = setTimeout(async () => {
                if (!_rssiPollDeviceId || !window.bleManager || !window.bleManager.isConnected) {
                    stopRssiPolling();
                    renderGarage();
                    return;
                }

                await refreshConnectedVehicleRssi();
                scheduleNextPoll();
            }, 4000);
        };

        refreshConnectedVehicleRssi().finally(scheduleNextPoll);
    }

    // -------------------------------------------------------------------------
    // Storage helpers
    // -------------------------------------------------------------------------
    function getVehicles() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
            return raw
                .filter(v => v && v.id)
                .map(v => {
                    const bleName = String(v.bleName || v.deviceName || v.id || '').trim() || v.id;
                    const friendlyName = sanitizeVehicleLabel(v.friendlyName || v.name || bleName || v.id, bleName);
                    return {
                        id: v.id,
                        bleName,
                        friendlyName,
                        // Keep legacy "name" in sync for backward compatibility.
                        name: friendlyName,
                        lastSeen: v.lastSeen || null
                    };
                });
        } catch {
            return [];
        }
    }

    function saveVehicles(vehicles) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(vehicles.map(v => ({
            id: v.id,
            bleName: v.bleName || v.id,
            friendlyName: v.friendlyName || v.bleName || v.id,
            // Keep legacy "name" key populated for older readers.
            name: v.friendlyName || v.bleName || v.id,
            lastSeen: v.lastSeen || null
        }))));
    }

    function buildExportPayload() {
        let lightGroups = [];
        let lightingProfiles = { profiles: [], activeIndex: 0 };
        try {
            const parsed = JSON.parse(localStorage.getItem(LIGHT_GROUPS_STORAGE_KEY) || '[]');
            lightGroups = Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            lightGroups = [];
        }

        try {
            const parsedLightingProfiles = JSON.parse(localStorage.getItem(LIGHTING_PROFILES_STORAGE_KEY) || '{"profiles":[],"activeIndex":0}');
            lightingProfiles = (parsedLightingProfiles && Array.isArray(parsedLightingProfiles.profiles))
                ? parsedLightingProfiles
                : { profiles: [], activeIndex: 0 };
        } catch (_) {
            lightingProfiles = { profiles: [], activeIndex: 0 };
        }

        return {
            schema: 'rcdcc-garage-lighting-export-v2',
            exportedAt: new Date().toISOString(),
            garageVehicles: getVehicles(),
            lightGroups,
            lightingProfiles
        };
    }

    function downloadTextFile(filename, content) {
        const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
    }

    function toBase64Utf8(text) {
        return btoa(unescape(encodeURIComponent(String(text || ''))));
    }

    async function exportViaNativeShare(filename, content) {
        const plugins = window.Capacitor?.Plugins;
        const Filesystem = plugins?.Filesystem;
        const Share = plugins?.Share;
        if (!Filesystem || !Share) return false;

        const directory = Filesystem?.Directory?.Cache || 'CACHE';
        const path = `exports/${filename}`;
        await Filesystem.writeFile({
            path,
            data: toBase64Utf8(content),
            directory,
            recursive: true
        });
        const uriResult = await Filesystem.getUri({ path, directory });
        await Share.share({
            title: 'Export Garage + Light Groups',
            text: 'Choose where to save/share the export file.',
            url: uriResult.uri,
            dialogTitle: 'Save or share export file'
        });
        return true;
    }

    async function exportViaSavePicker(filename, content) {
        if (typeof window.showSaveFilePicker !== 'function') return false;
        const fileHandle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{
                description: 'JSON Files',
                accept: { 'application/json': ['.json'] }
            }]
        });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return true;
    }

    function formatExportFilename() {
        const now = new Date();
        const two = (n) => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
        return `rcdcc_garage_lightgroups_${stamp}.json`;
    }

    async function exportGarageAndLightGroups() {
        try {
            const payload = buildExportPayload();
            const json = JSON.stringify(payload, null, 2);
            const filename = formatExportFilename();
            const isNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());

            if (isNative && await exportViaNativeShare(filename, json)) {
                if (window.toast) toast.success('Export ready. Choose destination in the share/save dialog.');
                localStorage.setItem('rcdcc_last_backup_at', new Date().toISOString());
                updateLastBackupTimestampUI();
                return;
            }

            if (await exportViaSavePicker(filename, json)) {
                if (window.toast) toast.success('Garage and light groups exported');
                localStorage.setItem('rcdcc_last_backup_at', new Date().toISOString());
                updateLastBackupTimestampUI();
                return;
            }

            downloadTextFile(filename, json);
            if (window.toast) toast.success('Garage and light groups exported to your default Downloads location');
            localStorage.setItem('rcdcc_last_backup_at', new Date().toISOString());
            updateLastBackupTimestampUI();
        } catch (error) {
            console.error('Export failed:', error);
            if (window.toast) toast.error(`Export failed: ${String(error?.message || error)}`);
        }
    }

    function updateLastBackupTimestampUI() {
        const el = document.getElementById('lastBackupTimestamp');
        if (!el) return;
        const raw = localStorage.getItem('rcdcc_last_backup_at');
        if (!raw) { el.textContent = ''; return; }
        try {
            const d = new Date(raw);
            el.textContent = `Last backup: ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
        } catch (_) {
            el.textContent = '';
        }
    }

    function normalizeImportedGarageVehicles(sourceVehicles) {
        if (!Array.isArray(sourceVehicles)) return [];

        const normalized = sourceVehicles
            .filter(v => v && v.id)
            .map(v => {
                const id = String(v.id || '').trim();
                if (!id) return null;
                const bleName = String(v.bleName || v.deviceName || id).trim() || id;
                const friendlyName = sanitizeVehicleLabel(v.friendlyName || v.name || bleName, bleName);
                return {
                    id,
                    bleName,
                    friendlyName,
                    name: friendlyName,
                    lastSeen: v.lastSeen || null
                };
            })
            .filter(Boolean);

        const deduped = [];
        normalized.forEach(v => {
            if (deduped.some(x => deviceIdsEqual(x.id, v.id))) return;
            deduped.push(v);
        });

        return deduped.slice(0, MAX_GARAGE_VEHICLES);
    }

    function normalizeImportedLightGroups(sourceLightGroups) {
        if (!Array.isArray(sourceLightGroups)) return [];
        return sourceLightGroups
            .filter(group => group && typeof group === 'object')
            .map(group => ({ ...group }));
    }

    async function importGarageAndLightGroupsFromFile(file) {
        if (!file) return;

        try {
            const rawText = await file.text();
            const parsed = JSON.parse(rawText);

            const garageSource = Array.isArray(parsed?.garageVehicles)
                ? parsed.garageVehicles
                : (Array.isArray(parsed?.garage) ? parsed.garage : []);
            const lightGroupSource = Array.isArray(parsed?.lightGroups)
                ? parsed.lightGroups
                : [];
            const lightingProfilesSource = (parsed?.lightingProfiles && Array.isArray(parsed.lightingProfiles.profiles))
                ? parsed.lightingProfiles
                : null;

            if (!garageSource.length && !lightGroupSource.length && !lightingProfilesSource) {
                throw new Error('No garage vehicles, light groups, or lighting profiles found in file');
            }

            const importedVehicles = normalizeImportedGarageVehicles(garageSource);
            const importedLightGroups = normalizeImportedLightGroups(lightGroupSource);

            saveVehicles(importedVehicles);

            if (lightGroupSource.length) {
                localStorage.setItem(LIGHT_GROUPS_STORAGE_KEY, JSON.stringify(importedLightGroups));
                localStorage.setItem(LIGHT_GROUPS_INITIALIZED_KEY, 'true');
                if (typeof window.reloadLightGroupsFromStorage === 'function') {
                    await window.reloadLightGroupsFromStorage();
                }
            }

            if (lightingProfilesSource) {
                localStorage.setItem(LIGHTING_PROFILES_STORAGE_KEY, JSON.stringify({
                    profiles: lightingProfilesSource.profiles,
                    activeIndex: Number(lightingProfilesSource.activeIndex) || 0
                }));
                if (typeof window.reloadLightingProfilesFromStorage === 'function') {
                    await window.reloadLightingProfilesFromStorage();
                }
            }

            renderGarage();

            if (window.toast) {
                const importedLightingProfileCount = lightingProfilesSource ? lightingProfilesSource.profiles.length : 0;
                toast.success(`Import complete: ${importedVehicles.length} vehicles, ${importedLightGroups.length} light groups, ${importedLightingProfileCount} lighting profiles`);
            }
        } catch (error) {
            console.error('Import failed:', error);
            if (window.toast) toast.error(`Import failed: ${String(error?.message || error)}`);
        }
    }

    function bindGarageTransferButtons() {
        const exportBtn = document.getElementById('garageExportBtn');
        const importBtn = document.getElementById('garageImportBtn');
        const importInput = document.getElementById('garageImportInput');

        if (exportBtn) {
            exportBtn.addEventListener('click', exportGarageAndLightGroups);
        }

        if (importBtn && importInput) {
            importBtn.addEventListener('click', () => importInput.click());
            importInput.addEventListener('change', async (event) => {
                const selectedFile = event.target?.files?.[0] || null;
                await importGarageAndLightGroupsFromFile(selectedFile);
                importInput.value = '';
            });
        }

        updateLastBackupTimestampUI();
    }

    const MAX_GARAGE_VEHICLES = 20;

    function upsertVehicle(deviceId, bleName) {
        const vehicles = getVehicles();
        const existing = vehicles.find(v => v.id === deviceId);
        const normalizedBleName = String(bleName || deviceId || '').trim() || deviceId;

        if (!existing && vehicles.length >= MAX_GARAGE_VEHICLES) {
            if (window.toast) toast.error(`Garage is full (${MAX_GARAGE_VEHICLES} vehicles max). Remove one to add another.`);
            return;
        }

        if (existing) {
            const previousBleName = existing.bleName || existing.id;
            const hadCustomFriendly = !!existing.friendlyName && existing.friendlyName !== previousBleName;

            existing.bleName = normalizedBleName;
            // Only auto-sync friendly name if the user has not customized it.
            if (!hadCustomFriendly) {
                existing.friendlyName = sanitizeVehicleLabel(normalizedBleName, normalizedBleName);
            }
            existing.name = existing.friendlyName;
            existing.lastSeen = new Date().toISOString();
        } else {
            vehicles.push({
                id: deviceId,
                bleName: normalizedBleName,
                friendlyName: sanitizeVehicleLabel(normalizedBleName, normalizedBleName),
                name: sanitizeVehicleLabel(normalizedBleName, normalizedBleName),
                lastSeen: new Date().toISOString()
            });
        }
        saveVehicles(vehicles);
        renderGarage();
    }

    function deleteVehicle(deviceId) {
        if (isVehicleConnected(deviceId) && window.bleManager) {
            window.bleManager.disconnect();
        }

        if (typeof window.purgeVehicleLocalData === 'function') {
            window.purgeVehicleLocalData(deviceId);
        } else {
            const scopedSuffix = normalizeDeviceId(deviceId);
            if (scopedSuffix) {
                [
                    DRIVING_PROFILES_STORAGE_KEY,
                    LIGHTING_PROFILES_STORAGE_KEY,
                    LIGHT_GROUPS_STORAGE_KEY,
                    LIGHT_GROUPS_INITIALIZED_KEY,
                    LIGHT_MASTER_STORAGE_KEY,
                    TOTAL_LED_COUNT_KEY
                ].forEach((baseKey) => localStorage.removeItem(`${baseKey}::${scopedSuffix}`));
            }
        }

        const vehicles = getVehicles().filter(v => v.id !== deviceId);
        saveVehicles(vehicles);
        renderGarage();

        if (vehicles.length === 0 && typeof window.updateConnectionStatus === 'function') {
            window.updateConnectionStatus(false);
        }
    }

    function renameVehicle(deviceId, newName) {
        const vehicles = getVehicles();
        const v = vehicles.find(v => v.id === deviceId);
        if (v) {
            const safeName = sanitizeVehicleLabel(newName, v.bleName || v.id);
            v.friendlyName = safeName;
            v.name = safeName;
        }
        saveVehicles(vehicles);
        renderGarage();

        // If the renamed truck is currently connected, refresh the dashboard badge immediately.
        if (v && window.bleManager && window.bleManager.isConnected && deviceIdsEqual(window.bleManager.deviceId, deviceId)
            && typeof window.updateDashboardVehicleName === 'function') {
            window.updateDashboardVehicleName(v.friendlyName);
        }
    }

    function updateLastSeen(deviceId) {
        const vehicles = getVehicles();
        const v = vehicles.find(v => v.id === deviceId);
        if (v) {
            v.lastSeen = new Date().toISOString();
            saveVehicles(vehicles);
            renderGarage();
        }
    }

    // -------------------------------------------------------------------------
    // Render garage vehicle list
    // -------------------------------------------------------------------------
    function renderGarage() {
        const list = document.getElementById('garageVehicleList');
        const empty = document.getElementById('garageEmptyState');
        if (!list) return;

        ensureRssiPollingState();

        const vehicles = getVehicles();

        if (vehicles.length === 0) {
            list.innerHTML = '';
            if (empty) empty.style.display = 'block';
            return;
        }

        if (empty) empty.style.display = 'none';

        const hasAnyActiveConnection = isBleSessionActive();
        const activeDeviceId = getActiveBleDeviceId();
        if (activeDeviceId && _connectingVehicleId && deviceIdsEqual(_connectingVehicleId, activeDeviceId)) {
            _connectingVehicleId = null;
        }

        // Sort alphabetically by friendly name (case-insensitive)
        vehicles.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName, undefined, { sensitivity: 'base' }));

        list.innerHTML = vehicles.map(v => {
            const isConnected = !!(hasAnyActiveConnection && activeDeviceId && deviceIdsEqual(activeDeviceId, v.id));
            const hasPendingConnectionForCard = deviceIdsEqual(_connectingVehicleId, v.id) || deviceIdsEqual(_autoReconnectVehicleId, v.id);
            const isConnecting = !hasAnyActiveConnection && !isConnected && hasPendingConnectionForCard;
            const isError = deviceIdsEqual(_connectErrorVehicleId, v.id);
            const safeLabel = escapeHtml(v.friendlyName);
            const interactionHint = isConnected ? 'Long press to disconnect' : 'Tap to connect';
            const accessibilityLabel = isConnected
                ? `Disconnect ${safeLabel}`
                : `Connect ${safeLabel}`;
            const cardIcon = isConnecting ? 'modeling' : 'bluetooth_drive';
            const iconClass = isConnecting ? 'material-symbols-outlined pulsating' : 'material-symbols-outlined';
            const lastConnectedStr = isConnected ? null : timeAgo(v.lastSeen);
            const signalPresentation = isConnected ? getSignalStrengthPresentation(_connectedVehicleRssi) : null;
            const signalStrengthMarkup = isConnected
                ? `<div class="garage-card-signal ${signalPresentation.toneClass}"><span class="material-symbols-outlined garage-card-signal-icon">${signalPresentation.icon}</span><span>${signalPresentation.label}</span></div>`
                : '';
            return `
            <div class="garage-card ${isConnected ? 'connected' : ''} ${isConnecting ? 'connecting' : ''} ${isError ? 'connect-error' : ''}" data-vehicle-id="${v.id}" role="button" tabindex="0" aria-label="${accessibilityLabel}" onclick="GarageManager.handleCardTap('${v.id}')" onkeydown="GarageManager.handleCardKeydown(event, '${v.id}')" onpointerdown="GarageManager.handleCardPointerDown(event, '${v.id}')" onpointerup="GarageManager.handleCardPointerUp(event)" onpointerleave="GarageManager.handleCardPointerCancel()" onpointercancel="GarageManager.handleCardPointerCancel()">
                <div class="garage-card-top">
                    <div class="garage-card-main">
                        <div class="garage-card-icon" aria-hidden="true">
                            <span class="${iconClass}">${cardIcon}</span>
                        </div>
                        <div class="garage-card-name" title="${safeLabel}">${safeLabel}</div>
                    </div>
                    <div class="garage-card-overflow dropdown" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                        <button type="button" class="garage-card-overflow-btn dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Vehicle options" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                            <span class="material-symbols-outlined">more_vert</span>
                        </button>
                        <ul class="dropdown-menu dropdown-menu-end garage-card-menu" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                            ${isConnected
                                ? `<li>
                                    <button type="button" class="dropdown-item" onclick="event.stopPropagation(); GarageManager.disconnectConnectedVehicle()" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                                        Disconnect
                                    </button>
                                </li>`
                                : `<li>
                                    <button type="button" class="dropdown-item" onclick="event.stopPropagation(); GarageManager.toggleVehicleConnection('${v.id}')" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                                        Connect
                                    </button>
                                </li>`
                            }
                            <!-- <li><hr class="dropdown-divider"></li> -->
                            <li>
                                <button type="button" class="dropdown-item" onclick="event.stopPropagation(); GarageManager.openVehicleSection('${v.id}', 'tuning')" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                                    Tuning
                                </button>
                            </li>
                            <!-- <li>
                                <button type="button" class="dropdown-item" onclick="event.stopPropagation(); GarageManager.openVehicleSection('${v.id}', 'lights')" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                                    Lights
                                </button>
                            </li> -->
                           <!-- <li>
                                <button type="button" class="dropdown-item" onclick="event.stopPropagation(); GarageManager.openVehicleSection('${v.id}', 'fpv')" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                                    FPV
                                </button>
                            </li> -->
                            <!-- <li><hr class="dropdown-divider"></li> -->
                            <li>
                                <button type="button" class="dropdown-item" onclick="event.stopPropagation(); GarageManager.openRenameModal('${v.id}')" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                                    Rename
                                </button>
                            </li>
                            <li>
                                <button type="button" class="dropdown-item text-danger" onclick="event.stopPropagation(); GarageManager.confirmDeleteVehicle('${v.id}')" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                                    Delete
                                </button>
                            </li>
                            <li>
                                <button type="button" class="dropdown-item" onclick="event.stopPropagation(); GarageManager.openVehicleAbout('${v.id}')" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                                    About
                                </button>
                            </li>
                        </ul>
                    </div>
                </div>
                <div class="garage-card-meta">
                    <div class="garage-card-hint">${interactionHint}</div>
                    ${signalStrengthMarkup}
                    ${lastConnectedStr ? `<div class="garage-card-last-seen">Last connected: ${lastConnectedStr}</div>` : ''}
                </div>
            </div>`;
        }).join('');
    }

    function isVehicleConnected(deviceId) {
        return !!deviceIdsEqual(getActiveBleDeviceId(), deviceId);
    }

    function clearDisconnectLongPressState() {
        if (_disconnectLongPressTimer) {
            clearTimeout(_disconnectLongPressTimer);
            _disconnectLongPressTimer = null;
        }
        _disconnectLongPressVehicleId = null;
        setCardPressingState(null);
    }

    function clearAutoReconnectPulseTimer() {
        if (_autoReconnectPulseTimer) {
            clearTimeout(_autoReconnectPulseTimer);
            _autoReconnectPulseTimer = null;
        }
    }

    function setAutoReconnectState(active, deviceId = null, delayMs = 0) {
        clearAutoReconnectPulseTimer();

        if (!active || !deviceId) {
            _autoReconnectVehicleId = null;
            renderGarage();
            return;
        }

        const pulseDelay = Math.max(0, Number(delayMs) || 0);
        if (pulseDelay === 0) {
            _autoReconnectVehicleId = deviceId;
            renderGarage();
            return;
        }

        _autoReconnectVehicleId = null;
        renderGarage();
        _autoReconnectPulseTimer = setTimeout(() => {
            _autoReconnectPulseTimer = null;
            _autoReconnectVehicleId = deviceId;
            renderGarage();
        }, pulseDelay);
    }

    function setCardPressingState(deviceId) {
        if (_pressingVehicleId && _pressingVehicleId !== deviceId) {
            const prevCard = document.querySelector(`.garage-card[data-vehicle-id="${_pressingVehicleId}"]`);
            if (prevCard) prevCard.classList.remove('disconnect-pressing');
        }

        _pressingVehicleId = deviceId || null;

        if (_pressingVehicleId) {
            const activeCard = document.querySelector(`.garage-card[data-vehicle-id="${_pressingVehicleId}"]`);
            if (activeCard) activeCard.classList.add('disconnect-pressing');
        }
    }

    function handleCardTap(deviceId) {
        if (_longPressTriggeredVehicleId === deviceId) {
            _longPressTriggeredVehicleId = null;
            return;
        }

        if (!isVehicleConnected(deviceId)) {
            toggleVehicleConnection(deviceId);
            return;
        }

        const now = Date.now();
        if (now - _lastLongPressHintAtMs > 1800) {
            _lastLongPressHintAtMs = now;
            if (window.toast) toast.warning('Long press to disconnect');
        }
    }

    function handleCardPointerDown(event, deviceId) {
        if (!isVehicleConnected(deviceId)) return;
        if (event && event.button !== undefined && event.button !== 0) return;

        clearDisconnectLongPressState();
        setCardPressingState(deviceId);
        _disconnectLongPressVehicleId = deviceId;
        _disconnectLongPressTimer = setTimeout(async () => {
            _disconnectLongPressTimer = null;
            if (!isVehicleConnected(deviceId)) return;
            _longPressTriggeredVehicleId = deviceId;
            setCardPressingState(null);
            if (window.disconnectBLE) {
                await window.disconnectBLE(true);
            }
            renderGarage();
        }, LONG_PRESS_DISCONNECT_MS);
    }

    function handleCardPointerUp(_event) {
        clearDisconnectLongPressState();
    }

    function handleCardPointerCancel() {
        clearDisconnectLongPressState();
    }

    function handleCardKeydown(event, deviceId) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        handleCardTap(deviceId);
    }

    // -------------------------------------------------------------------------
    // Scan and connect — uses existing bleManager
    // -------------------------------------------------------------------------
    async function scanAndConnect() {
        if (!window.bleManager) {
            if (window.toast) toast.error('Bluetooth manager not available');
            return;
        }
        try {
            const btn = document.getElementById('garageScanBtn');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="material-symbols-outlined">bluetooth_searching</span>';
            }

            const result = await window.connectBLE();

            if (result && window.bleManager.deviceId) {
                const deviceId = window.bleManager.deviceId;
                const deviceName = window.bleManager.deviceName || deviceId;
                upsertVehicle(deviceId, deviceName);
                renderGarage();
            }
        } catch (e) {
            console.error('Garage scan error:', e);
        } finally {
            const btn = document.getElementById('garageScanBtn');
            if (btn) {
                btn.disabled = false;
                    btn.innerHTML = '<span class="garage-add-icon-combo" aria-hidden="true"><span class="material-symbols-outlined garage-add-icon-car">directions_car</span><span class="material-symbols-outlined garage-add-icon-plus">add</span></span>';
            }
        }
    }

    // -------------------------------------------------------------------------
    // Connect to a specific known vehicle by ID
    // -------------------------------------------------------------------------
    async function connectToVehicle(deviceId) {
        if (!window.bleManager) return;

        setAutoReconnectState(false);

        const vehicles = getVehicles();
        const vehicle = vehicles.find(v => v.id === deviceId);

        // Attempt connection via app orchestration so full Phase 7 flow runs.
        const connected = window.connectBLEToVehicle
            ? await window.connectBLEToVehicle(deviceId, vehicle?.friendlyName || null)
            : await window.bleManager.connectToKnownDevice();

        if (connected) {
            if (deviceIdsEqual(_connectingVehicleId, deviceId)) {
                _connectingVehicleId = null;
            }

            updateLastSeen(deviceId);
            if (window.updateConnectionStatus) updateConnectionStatus(true);
            if (window.updateConnectionMethodDisplay) updateConnectionMethodDisplay();
            if (typeof window.refreshDashboardCurrentSettingsCard === 'function') {
                window.refreshDashboardCurrentSettingsCard(vehicle?.friendlyName || null);
            }

            // Run a follow-up refresh once the connection settles so tuning/servo UI hydrates reliably.
            if (typeof window.refreshConfigAfterConnection === 'function') {
                setTimeout(() => {
                    if (isVehicleConnected(deviceId)) {
                        window.refreshConfigAfterConnection('garage-card-select');
                    }
                }, 450);
            }

            renderGarage();
            return true;
        } else {
            if (window.toast) toast.error('Could not connect — make sure vehicle is powered on');
            return false;
        }
    }

    function openRenameModal(deviceId) {
        const vehicle = getVehicles().find(v => v.id === deviceId);
        if (!vehicle) return;

        _renameVehicleId = deviceId;

        const currentNameEl = document.getElementById('garageRenameCurrentName');
        const deviceIdEl = document.getElementById('garageRenameDeviceId');
        const inputEl = document.getElementById('garageRenameInput');
        const modalEl = document.getElementById('garageRenameModal');

        if (currentNameEl) currentNameEl.textContent = vehicle.friendlyName;
        if (deviceIdEl) deviceIdEl.textContent = `MAC ID: ${vehicle.id}`;
        if (inputEl) inputEl.value = vehicle.friendlyName;

        if (!modalEl) return;

        if (window.bootstrap && window.bootstrap.Modal) {
            const modal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
            modal.show();
            return;
        }

        const fallbackName = prompt('Rename vehicle', vehicle.friendlyName);
        if (fallbackName && fallbackName.trim()) {
            renameVehicle(deviceId, fallbackName.trim());
            if (window.toast) toast.success('Vehicle renamed');
        }
    }

    function bindRenameModal() {
        const saveBtn = document.getElementById('garageRenameSaveBtn');
        const inputEl = document.getElementById('garageRenameInput');
        const modalEl = document.getElementById('garageRenameModal');

        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                if (!_renameVehicleId) return;
                const newName = (inputEl?.value || '').trim();
                if (!newName) {
                    if (window.toast) toast.warning('Please enter a vehicle name');
                    return;
                }

                renameVehicle(_renameVehicleId, newName);

                if (modalEl && window.bootstrap && window.bootstrap.Modal) {
                    const modal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
                    modal.hide();
                }

                if (window.toast) toast.success('Vehicle renamed');
            });
        }

        if (inputEl) {
            inputEl.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    if (saveBtn) saveBtn.click();
                }
            });
        }

        if (modalEl) {
            modalEl.addEventListener('hidden.bs.modal', () => {
                _renameVehicleId = null;
            });
        }
    }

    async function toggleVehicleConnection(deviceId) {
        const alreadyConnected = isVehicleConnected(deviceId);
        if (alreadyConnected) {
            if (window.disconnectBLE) {
                await window.disconnectBLE(true);
                renderGarage();
            }
            return;
        }

        setAutoReconnectState(false);

        _connectErrorVehicleId = null;
        if (_connectErrorTimer) {
            clearTimeout(_connectErrorTimer);
            _connectErrorTimer = null;
        }

        _connectingVehicleId = deviceId;
        renderGarage();

        const connected = await connectToVehicle(deviceId);
        _connectingVehicleId = null;

        if (!connected) {
            _connectErrorVehicleId = deviceId;
            _connectErrorTimer = setTimeout(() => {
                _connectErrorVehicleId = null;
                _connectErrorTimer = null;
                renderGarage();
            }, 2000);
        }

        renderGarage();
    }

    function confirmDeleteVehicle(deviceId) {
        const vehicle = getVehicles().find(v => v.id === deviceId);
        if (!vehicle) return;

        const existing = document.getElementById('garage-delete-overlay');
        if (existing) existing.remove();

        const safeName = vehicle.friendlyName.replace(/</g, '&lt;');
        const overlay = document.createElement('div');
        overlay.id = 'garage-delete-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        overlay.innerHTML = `
          <div style="background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:24px;max-width:340px;width:100%;color:#fff;">
            <h5 style="margin:0 0 12px;color:#fff;">Remove Vehicle</h5>
            <p style="margin:0 0 20px;color:#aaa;font-size:0.9rem;">Remove <strong style="color:#fff;">${safeName}</strong> from your garage? This cannot be undone.</p>
            <div style="display:flex;gap:8px;">
                            <button id="gd-cancel" style="flex:1;padding:10px;border:1px solid #555;border-radius:8px;background:#333;color:#aaa;cursor:pointer;">Cancel</button>
                            <button id="gd-delete" style="flex:1;padding:10px;border:none;border-radius:8px;background:#c0392b;color:#fff;font-weight:600;cursor:pointer;">Delete</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);

        overlay.querySelector('#gd-cancel').onclick = () => overlay.remove();
        overlay.querySelector('#gd-delete').onclick = () => {
            overlay.remove();
            deleteVehicle(deviceId);
        };
    }

    async function openVehicleSection(deviceId, sectionId) {
        if (!['tuning', 'lights', 'fpv'].includes(sectionId)) return;

        const connected = isVehicleConnected(deviceId) || await connectToVehicle(deviceId);
        if (!connected) return;

        if (typeof window.navigateToSection === 'function') {
            await window.navigateToSection(sectionId);
        }
    }

    async function openVehicleAbout(deviceId) {
        const vehicles = getVehicles();
        const vehicle = vehicles.find(v => v.id === deviceId);
        if (!vehicle) return;

        const connected = isVehicleConnected(deviceId) || await connectToVehicle(deviceId);
        if (!connected) return;

        const nameEl = document.getElementById('garageVehicleAboutName');
        const macEl = document.getElementById('garageVehicleAboutMac');
        const fwEl = document.getElementById('garageVehicleAboutFirmware');
        const titleTextEl = document.getElementById('garageVehicleAboutTitleText');
        const modalEl = document.getElementById('garageVehicleAboutModal');
        if (!modalEl) return;

        const vehicleName = vehicle.friendlyName || vehicle.bleName || 'Vehicle';
        if (nameEl) nameEl.textContent = vehicleName;
        if (titleTextEl) titleTextEl.textContent = `About ${vehicleName}`;
        if (macEl) macEl.textContent = deviceId;
        if (fwEl) fwEl.textContent = 'Loading...';

        try {
            const data = await window.bleManager.readConfigScoped('bootstrap');
            const fw = data?.fw_version || data?.version || data?.firmwareVersion || data?.system?.fw_version || 'Not available';
            if (fwEl) fwEl.textContent = fw;
        } catch (error) {
            if (fwEl) fwEl.textContent = 'Connection error';
            console.warn('Vehicle about firmware fetch failed:', error?.message || error);
        }

        if (window.bootstrap && window.bootstrap.Modal) {
            const modal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
            modal.show();
        }
    }

    // -------------------------------------------------------------------------
    // Init — wire up buttons
    // -------------------------------------------------------------------------
    async function disconnectConnectedVehicle() {
        if (window.disconnectBLE) {
            await window.disconnectBLE(true);
        }
        renderGarage();
    }

    function init() {
        // Scan button
        const scanBtn = document.getElementById('garageScanBtn');
        if (scanBtn) scanBtn.addEventListener('click', scanAndConnect);

        bindRenameModal();
        bindGarageTransferButtons();

        // Auto-add vehicle after successful BLE connect (hook into disconnect callback)
        // This is called from app.js after a successful connectBLE()
        renderGarage();
    }

    // Public API
    return { init, renderGarage, upsertVehicle, updateLastSeen, scanAndConnect, openRenameModal, toggleVehicleConnection, confirmDeleteVehicle, openVehicleSection, openVehicleAbout, handleCardKeydown, handleCardTap, handleCardPointerDown, handleCardPointerUp, handleCardPointerCancel, setAutoReconnectState, disconnectConnectedVehicle };
})();

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => GarageManager.init());
