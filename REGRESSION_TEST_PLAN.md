## RCDCC Regression Test Plan (Suspension-Focused)

Date: 2026-04-13
Scope: Verify suspension-only workflows after lighting feature removal.

### 1. Environment And Preconditions
1. Android device connected with USB debugging enabled.
2. ESP32 connected on serial port and flashable.
3. App installed from latest deployment.
4. Firmware flashed from latest branch build.
5. Garage contains at least one known vehicle entry.

### 2. Build And Deploy Smoke
1. Run `npm run build` and confirm version increment + no hard errors.
2. Run `./deployFirmware.ps1` and confirm firmware build + upload success.
3. Run `./deployApp.ps1` and confirm Gradle build/install success.

Expected:
1. No build failures.
2. Firmware image uploads successfully.
3. App launches on target device.

### 3. Connection And Session Lifecycle
1. Launch app and connect to a truck.
2. Verify connection status transitions to connected.
3. Disconnect from truck.
4. Reconnect to same truck.
5. Reconnect to a different garage truck (if available).

Expected:
1. No crashes or stuck loading modal.
2. Dashboard updates vehicle/profile labels after connect.
3. Disconnect returns app to disconnected state cleanly.

### 4. Suspension Controls And Persistence
1. In tuning/suspension page, change core parameters (ride height, omega, zeta, range, deadband/hysteresis).
2. Save/apply changes.
3. Power-cycle or reconnect truck.
4. Fetch config again (re-enter page or reconnect flow).

Expected:
1. Parameter changes are applied to firmware behavior.
2. Values persist after reconnect.
3. No references to removed lighting settings appear in payload handling.

### 5. Servo Controls (Primary + Aux)
1. Adjust FL/FR/RL/RR calibration values.
2. Verify motion direction and limits reflect new values.
3. If aux servos are configured, test each type used in your setup.

Expected:
1. Servo commands are accepted and reflected in behavior.
2. No timeout or malformed-command errors in BLE path.

### 6. Garage Features
1. Create or rename a vehicle in garage.
2. Use quick navigation to tuning and FPV.
3. Run backup/export from garage.
4. Run import using a known-good backup file.
5. Delete a vehicle and confirm scoped data cleanup.

Expected:
1. Garage actions succeed without lighting-related schema errors.
2. Backup/import operate on garage/suspension-relevant data.

### 7. BLE Command And Config Read Stability
1. Trigger repeated config reads by navigating across sections.
2. Perform multiple rapid updates (sliders + toggles).
3. Observe logs for command failures.

Expected:
1. No command queue overflows in normal usage.
2. No missing-characteristic errors related to removed lighting channels.

### 8. Negative Tests
1. Attempt to invoke removed lighting behavior from old UI paths (if any stale button appears).
2. Import any older backup that previously included lighting content.

Expected:
1. App handles removed lighting functionality gracefully (no crash).
2. Unsupported fields are ignored safely.

### 9. Pass/Fail Criteria
1. PASS: All sections above complete without crash, freeze, or failed deploy.
2. FAIL: Any blocking build/deploy failure, runtime crash, or suspension control regression.

### 10. Execution Notes Template
1. Build SHA:
2. Firmware version:
3. App version:
4. Device model:
5. Tester:
6. Result summary:
7. Defects found:
