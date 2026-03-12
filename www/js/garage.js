// ====================================================================================
// Garage Manager — Vehicle storage and BLE connection management
// ====================================================================================
// Vehicles are stored in localStorage as an array of:
// { id: 'MAC', bleName: 'RCDCC-ABC123', friendlyName: 'My TRX4', lastSeen: ISO string }
// ====================================================================================

const GarageManager = (() => {
    const STORAGE_KEY = 'rcdcc_garage_vehicles';
    let _selectedVehicleId = null;

    function getSelectedVehicle() {
        if (!_selectedVehicleId) return null;
        return getVehicles().find(v => v.id === _selectedVehicleId) || null;
    }

    function renderSelectedVehicleDetails() {
        const panel = document.getElementById('garageDetailPanel');
        const nameEl = document.getElementById('garageDetailName');
        const macEl = document.getElementById('garageDetailMac');
        const lastSeenEl = document.getElementById('garageDetailLastSeen');
        const renameInput = document.getElementById('garageDetailRenameInput');
        const connectBtn = document.getElementById('garageDetailConnectBtn');
        const saveBtn = document.getElementById('garageDetailSaveBtn');
        const deleteBtn = document.getElementById('garageDetailDeleteBtn');

        const selected = getSelectedVehicle();
        const visible = !!selected;

        if (panel) panel.style.display = visible ? '' : 'none';
        if (!visible) {
            if (connectBtn) connectBtn.disabled = true;
            if (saveBtn) saveBtn.disabled = true;
            if (deleteBtn) deleteBtn.disabled = true;
            return;
        }

        if (nameEl) nameEl.textContent = selected.friendlyName;
        if (macEl) macEl.textContent = selected.id;
        if (lastSeenEl) lastSeenEl.textContent = `Last connected: ${formatLastSeen(selected.lastSeen)}`;
        if (renameInput) renameInput.value = selected.friendlyName;

        const connected = !!(window.bleManager && window.bleManager.deviceId === selected.id && window.bleManager.isConnected);
        if (connectBtn) {
            connectBtn.disabled = false;
            connectBtn.innerHTML = connected
                ? '<span class="material-symbols-outlined">link_off</span> Disconnect'
                : '<span class="material-symbols-outlined">link</span> Connect';
        }
        if (saveBtn) saveBtn.disabled = false;
        if (deleteBtn) deleteBtn.disabled = false;
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
                    const friendlyName = String(v.friendlyName || v.name || bleName || v.id || '').trim() || bleName;
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
                existing.friendlyName = normalizedBleName;
            }
            existing.name = existing.friendlyName;
            existing.lastSeen = new Date().toISOString();
        } else {
            vehicles.push({
                id: deviceId,
                bleName: normalizedBleName,
                friendlyName: normalizedBleName,
                name: normalizedBleName,
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
            v.friendlyName = newName;
            v.name = newName;
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
    // Format last seen date
    // -------------------------------------------------------------------------
    function formatLastSeen(isoString) {
        if (!isoString) return 'Never';
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString();
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
            _selectedVehicleId = null;
            renderSelectedVehicleDetails();
            return;
        }

        if (empty) empty.style.display = 'none';

        // Sort by lastSeen descending
        vehicles.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

        list.innerHTML = vehicles.map(v => {
            const isConnected = window.bleManager && window.bleManager.deviceId === v.id && window.bleManager.isConnected;
            const isSelected = _selectedVehicleId === v.id;
            const connectedBadge = isConnected
                ? `<span class="badge" style="background-color: var(--lime-green); color: #000;">Connected</span>`
                : '';
            return `
            <div class="garage-card ${isSelected ? 'selected' : ''}" data-vehicle-id="${v.id}" onclick="GarageManager.openDetail('${v.id}')">
                <div class="garage-card-icon">
                    <span class="material-symbols-outlined">directions_car</span>
                </div>
                <div class="garage-card-info">
                    <div class="garage-card-name">${v.friendlyName} ${connectedBadge}</div>
                    <div class="garage-card-mac">${v.id}</div>
                    <div class="garage-card-last">Last connected: ${formatLastSeen(v.lastSeen)}</div>
                </div>
                <div class="garage-card-arrow">
                    <span class="material-symbols-outlined">chevron_right</span>
                </div>
            </div>`;
        }).join('');

        if (!_selectedVehicleId || !vehicles.find(v => v.id === _selectedVehicleId)) {
            _selectedVehicleId = vehicles[0].id;
        }
        renderSelectedVehicleDetails();
    }

    // -------------------------------------------------------------------------
    // Select a vehicle on the Garage page
    // -------------------------------------------------------------------------
    function openDetail(deviceId) {
        _selectedVehicleId = deviceId;
        renderGarage();
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
                btn.innerHTML = '<span class="material-symbols-outlined">bluetooth_searching</span> Scanning...';
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
                btn.innerHTML = '<span class="material-symbols-outlined">bluetooth_searching</span> Scan &amp; Connect to Vehicle';
            }
        }
    }

    // -------------------------------------------------------------------------
    // Connect to a specific known vehicle by ID
    // -------------------------------------------------------------------------
    async function connectToVehicle(deviceId) {
        if (!window.bleManager) return;

        // Navigate to dashboard
        if (window.navigateToSection) window.navigateToSection('dashboard');

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
            renderSelectedVehicleDetails();
        } else {
            if (window.toast) toast.error('Could not connect — make sure vehicle is powered on');
        }
    }

    // -------------------------------------------------------------------------
    // Init — wire up buttons
    // -------------------------------------------------------------------------
    function init() {
        // Scan button
        const scanBtn = document.getElementById('garageScanBtn');
        if (scanBtn) scanBtn.addEventListener('click', scanAndConnect);

        // Detail panel — Save (rename)
        const saveBtn = document.getElementById('garageDetailSaveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                if (!_selectedVehicleId) return;
                const newName = document.getElementById('garageDetailRenameInput').value.trim();
                if (!newName) return;
                renameVehicle(_selectedVehicleId, newName);
                renderSelectedVehicleDetails();
                if (window.toast) toast.success('Vehicle renamed');
            });
        }

        // Detail panel — Delete
        const deleteBtn = document.getElementById('garageDetailDeleteBtn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                if (!_selectedVehicleId) return;
                if (!confirm('Remove this vehicle from your garage?')) return;
                const removedId = _selectedVehicleId;
                deleteVehicle(_selectedVehicleId);
                const remaining = getVehicles();
                _selectedVehicleId = remaining.length ? remaining.find(v => v.id !== removedId)?.id || remaining[0].id : null;
                renderGarage();
            });
        }

        // Detail panel — Connect / Disconnect
        const connectBtn = document.getElementById('garageDetailConnectBtn');
        if (connectBtn) {
            connectBtn.addEventListener('click', async () => {
                if (!_selectedVehicleId) return;
                const alreadyConnected = !!(window.bleManager && window.bleManager.deviceId === _selectedVehicleId && window.bleManager.isConnected);
                if (alreadyConnected) {
                    if (window.disconnectBLE) await window.disconnectBLE(true);
                    // Stay on Garage — no navigation. Re-render is handled inside disconnectBLE.
                } else {
                    connectToVehicle(_selectedVehicleId);
                }
            });
        }

        // Auto-add vehicle after successful BLE connect (hook into disconnect callback)
        // This is called from app.js after a successful connectBLE()
        renderGarage();
        renderSelectedVehicleDetails();
    }

    // Public API
    return { init, renderGarage, upsertVehicle, updateLastSeen, openDetail, scanAndConnect };
})();

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => GarageManager.init());
