// ====================================================================================
// Garage Manager — Vehicle storage and BLE connection management
// ====================================================================================
// Vehicles are stored in localStorage as an array of:
// { id: 'MAC', bleName: 'RCDCC-ABC123', friendlyName: 'My TRX4', lastSeen: ISO string }
// ====================================================================================

const GarageManager = (() => {
    const STORAGE_KEY = 'rcdcc_garage_vehicles';
    let _renameVehicleId = null;
    let _connectingVehicleId = null;
    let _connectErrorVehicleId = null;
    let _connectErrorTimer = null;
    let _disconnectLongPressTimer = null;
    let _disconnectLongPressVehicleId = null;
    let _longPressTriggeredVehicleId = null;
    let _lastLongPressHintAtMs = 0;
    let _pressingVehicleId = null;
    const LONG_PRESS_DISCONNECT_MS = 650;
    const MAX_LABEL_LENGTH = 12;

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
        const vehicles = getVehicles().filter(v => v.id !== deviceId);
        saveVehicles(vehicles);
        renderGarage();
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

        const vehicles = getVehicles();

        if (vehicles.length === 0) {
            list.innerHTML = '';
            if (empty) empty.style.display = 'block';
            return;
        }

        if (empty) empty.style.display = 'none';

        // Sort by lastSeen descending
        vehicles.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

        list.innerHTML = vehicles.map(v => {
            const isConnected = window.bleManager && window.bleManager.deviceId === v.id && window.bleManager.isConnected;
            const isConnecting = _connectingVehicleId === v.id;
            const isError = _connectErrorVehicleId === v.id;
            const safeLabel = escapeHtml(v.friendlyName);
            const interactionHint = isConnected ? 'Long press to disconnect' : 'Tap to connect';
            const accessibilityLabel = isConnected
                ? `Disconnect ${safeLabel}`
                : `Connect ${safeLabel}`;
            return `
            <div class="garage-card ${isConnected ? 'connected' : ''} ${isConnecting ? 'connecting' : ''} ${isError ? 'connect-error' : ''}" data-vehicle-id="${v.id}" role="button" tabindex="0" aria-label="${accessibilityLabel}" onclick="GarageManager.handleCardTap('${v.id}')" onkeydown="GarageManager.handleCardKeydown(event, '${v.id}')" onpointerdown="GarageManager.handleCardPointerDown(event, '${v.id}')" onpointerup="GarageManager.handleCardPointerUp(event)" onpointerleave="GarageManager.handleCardPointerCancel()" onpointercancel="GarageManager.handleCardPointerCancel()">
                <div class="garage-card-top">
                    <div class="garage-card-icon" aria-hidden="true">
                        <span class="material-symbols-outlined">directions_car</span>
                    </div>
                    <div class="garage-card-overflow dropdown" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                        <button type="button" class="garage-card-overflow-btn dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Vehicle options" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
                            <span class="material-symbols-outlined">more_vert</span>
                        </button>
                        <ul class="dropdown-menu dropdown-menu-end garage-card-menu" onclick="event.stopPropagation()" onpointerdown="event.stopPropagation()" onpointerup="event.stopPropagation()">
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
                        </ul>
                    </div>
                </div>
                <div class="garage-card-info">
                    <div class="garage-card-name" title="${safeLabel}">${safeLabel}</div>
                    <div class="garage-card-hint">${interactionHint}</div>
                </div>
            </div>`;
        }).join('');
    }

    function isVehicleConnected(deviceId) {
        return !!(window.bleManager && window.bleManager.deviceId === deviceId && window.bleManager.isConnected);
    }

    function clearDisconnectLongPressState() {
        if (_disconnectLongPressTimer) {
            clearTimeout(_disconnectLongPressTimer);
            _disconnectLongPressTimer = null;
        }
        _disconnectLongPressVehicleId = null;
        setCardPressingState(null);
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

        const vehicles = getVehicles();
        const vehicle = vehicles.find(v => v.id === deviceId);

        // Attempt connection via app orchestration so full Phase 7 flow runs.
        const connected = window.connectBLEToVehicle
            ? await window.connectBLEToVehicle(deviceId, vehicle?.friendlyName || null)
            : await window.bleManager.connectToKnownDevice();

        if (connected) {
            updateLastSeen(deviceId);
            if (window.updateConnectionStatus) updateConnectionStatus(true);
            if (window.updateConnectionMethodDisplay) updateConnectionMethodDisplay();
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
        const alreadyConnected = !!(window.bleManager && window.bleManager.deviceId === deviceId && window.bleManager.isConnected);
        if (alreadyConnected) {
            if (window.disconnectBLE) {
                await window.disconnectBLE(true);
                renderGarage();
            }
            return;
        }

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
        if (!confirm(`Remove ${vehicle.friendlyName} from your garage?`)) return;
        deleteVehicle(deviceId);
    }

    // -------------------------------------------------------------------------
    // Init — wire up buttons
    // -------------------------------------------------------------------------
    function init() {
        // Scan button
        const scanBtn = document.getElementById('garageScanBtn');
        if (scanBtn) scanBtn.addEventListener('click', scanAndConnect);

        bindRenameModal();

        // Auto-add vehicle after successful BLE connect (hook into disconnect callback)
        // This is called from app.js after a successful connectBLE()
        renderGarage();
    }

    // Public API
    return { init, renderGarage, upsertVehicle, updateLastSeen, scanAndConnect, openRenameModal, toggleVehicleConnection, confirmDeleteVehicle, handleCardKeydown, handleCardTap, handleCardPointerDown, handleCardPointerUp, handleCardPointerCancel };
})();

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => GarageManager.init());
