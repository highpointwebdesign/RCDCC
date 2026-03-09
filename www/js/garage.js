// ====================================================================================
// Garage Manager — Vehicle storage and BLE connection management
// ====================================================================================
// Vehicles are stored in localStorage as an array of:
// { id: 'MAC', name: 'My TRX4', lastSeen: ISO string }
// ====================================================================================

const GarageManager = (() => {
    const STORAGE_KEY = 'rcdcc_garage_vehicles';
    let _selectedVehicleId = null;

    // -------------------------------------------------------------------------
    // Storage helpers
    // -------------------------------------------------------------------------
    function getVehicles() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
        } catch {
            return [];
        }
    }

    function saveVehicles(vehicles) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(vehicles));
    }

    function upsertVehicle(deviceId, name) {
        const vehicles = getVehicles();
        const existing = vehicles.find(v => v.id === deviceId);
        if (existing) {
            existing.lastSeen = new Date().toISOString();
            if (name && name !== existing.name) existing.name = name;
        } else {
            vehicles.push({
                id: deviceId,
                name: name || deviceId,
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
        if (v) v.name = newName;
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
            return;
        }

        if (empty) empty.style.display = 'none';

        // Sort by lastSeen descending
        vehicles.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

        list.innerHTML = vehicles.map(v => {
            const isConnected = window.bleManager && window.bleManager.deviceId === v.id && window.bleManager.isConnected;
            const connectedBadge = isConnected
                ? `<span class="badge" style="background-color: var(--lime-green); color: #000;">Connected</span>`
                : '';
            return `
            <div class="garage-card" data-vehicle-id="${v.id}" onclick="GarageManager.openDetail('${v.id}')">
                <div class="garage-card-icon">
                    <span class="material-symbols-outlined">directions_car</span>
                </div>
                <div class="garage-card-info">
                    <div class="garage-card-name">${v.name} ${connectedBadge}</div>
                    <div class="garage-card-mac">${v.id}</div>
                    <div class="garage-card-last">Last connected: ${formatLastSeen(v.lastSeen)}</div>
                </div>
                <div class="garage-card-arrow">
                    <span class="material-symbols-outlined">chevron_right</span>
                </div>
            </div>`;
        }).join('');
    }

    // -------------------------------------------------------------------------
    // Open vehicle detail modal
    // -------------------------------------------------------------------------
    function openDetail(deviceId) {
        const vehicles = getVehicles();
        const v = vehicles.find(v => v.id === deviceId);
        if (!v) return;

        _selectedVehicleId = deviceId;

        document.getElementById('garageDetailName').textContent = v.name;
        document.getElementById('garageDetailMac').textContent = v.id;
        document.getElementById('garageDetailLastSeen').textContent = formatLastSeen(v.lastSeen);
        document.getElementById('garageDetailRenameInput').value = v.name;

        const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('garageDetailModal'));
        modal.show();
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

        // Store as preferred so connectToKnownDevice picks it up
        localStorage.setItem('rcdccBlePreferredDeviceId', deviceId);
        window.bleManager.preferredDeviceId = deviceId;

        const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('garageDetailModal'));
        modal.hide();

        // Navigate to dashboard
        if (window.navigateToSection) navigateToSection('dashboard');

        // Attempt connection
        const connected = await window.bleManager.connectToKnownDevice();
        if (connected) {
            updateLastSeen(deviceId);
            if (window.toast) toast.success('Vehicle connected');
            if (window.updateConnectionStatus) updateConnectionStatus(true);
            if (window.updateConnectionMethodDisplay) updateConnectionMethodDisplay();
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

        // Detail modal — Save (rename)
        const saveBtn = document.getElementById('garageDetailSaveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const newName = document.getElementById('garageDetailRenameInput').value.trim();
                if (!newName) return;
                renameVehicle(_selectedVehicleId, newName);
                document.getElementById('garageDetailName').textContent = newName;
                if (window.toast) toast.success('Vehicle renamed');
            });
        }

        // Detail modal — Delete
        const deleteBtn = document.getElementById('garageDetailDeleteBtn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                if (!confirm('Remove this vehicle from your garage?')) return;
                deleteVehicle(_selectedVehicleId);
                const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('garageDetailModal'));
                modal.hide();
                _selectedVehicleId = null;
            });
        }

        // Detail modal — Connect
        const connectBtn = document.getElementById('garageDetailConnectBtn');
        if (connectBtn) {
            connectBtn.addEventListener('click', () => {
                if (_selectedVehicleId) connectToVehicle(_selectedVehicleId);
            });
        }

        // Auto-add vehicle after successful BLE connect (hook into disconnect callback)
        // This is called from app.js after a successful connectBLE()
        renderGarage();
    }

    // Public API
    return { init, renderGarage, upsertVehicle, updateLastSeen, openDetail, scanAndConnect };
})();

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => GarageManager.init());
