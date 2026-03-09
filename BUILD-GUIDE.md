# RCDCC Android APK Build Guide
## R/C Dynamic Chassis Control — Capacitor Native Build

---

## What's in this project

```
rcdcc-capacitor/
├── www/                          ← Your web app (served inside the APK)
│   ├── index.html                ← Modified: adds Capacitor bridge scripts
│   ├── js/
│   │   ├── bluetooth.js          ← REWRITTEN: Capacitor BLE (replaces Web Bluetooth)
│   │   ├── app.js                ← UNCHANGED
│   │   └── console.js            ← UNCHANGED
│   └── css/
│       └── app.css               ← UNCHANGED
├── android-setup/
│   └── AndroidManifest-permissions.xml   ← BLE permissions to verify/merge
├── capacitor.config.json         ← App ID: com.rcdcc.app
├── package.json                  ← Dependencies
└── BUILD-GUIDE.md                ← This file
```

**Files you still need to copy into `www/`** (from your original project):
- `www/css/bootstrap.min.css`
- `www/css/fonts.css`
- `www/js/bootstrap.bundle.min.js`
- `www/plugins/range-slider/` (entire folder)
- `brand-logo-text.png`, `brand-logo-image.png`
- `icon-192x192.png`, `icon-512x512.png`
- `site.webmanifest`

---

## Prerequisites

Install these once on your computer:

### 1. Node.js (v18 or newer)
Download from: https://nodejs.org
Verify: `node --version`

### 2. Java JDK 17
Download from: https://adoptium.net (Temurin JDK 17)
Verify: `java -version`

### 3. Android Studio
Download from: https://developer.android.com/studio
- During install, accept the SDK setup wizard
- Install Android SDK Platform 34 (Android 14)
- Install Android SDK Build-Tools

### 4. Set ANDROID_HOME environment variable
**Windows:**
```
setx ANDROID_HOME "%LOCALAPPDATA%\Android\Sdk"
setx PATH "%PATH%;%ANDROID_HOME%\tools;%ANDROID_HOME%\platform-tools"
```
**Mac/Linux:**
```bash
export ANDROID_HOME=$HOME/Library/Android/sdk   # Mac
export ANDROID_HOME=$HOME/Android/Sdk           # Linux
export PATH=$PATH:$ANDROID_HOME/tools:$ANDROID_HOME/platform-tools
```

---

## Build Steps

### Step 1: Copy your remaining assets
Copy these folders/files from your original PWA project into the `www/` folder:
- `css/bootstrap.min.css`
- `css/fonts.css`  
- `js/bootstrap.bundle.min.js`
- `plugins/` folder (range slider)
- All PNG image files
- `site.webmanifest`

### Step 2: Install dependencies
Open a terminal in the `rcdcc-capacitor/` folder and run:
```bash
npm install
```

### Step 3: Add the Android platform
```bash
npx cap add android
```
This creates an `android/` folder with a full Android Studio project.

### Step 4: Verify BLE permissions
Open `android/app/src/main/AndroidManifest.xml` and confirm the BLE
permissions listed in `android-setup/AndroidManifest-permissions.xml`
are all present. The Capacitor BLE plugin adds most automatically —
just verify nothing is missing.

### Step 5: Sync your web files into the Android project
```bash
npx cap sync android
```
Run this every time you change files in `www/`.

### Step 6: Open in Android Studio
```bash
npx cap open android
```

### Step 7: Build the APK in Android Studio
1. Wait for Gradle sync to complete (first time takes 5-10 min)
2. Menu: **Build → Build Bundle(s) / APK(s) → Build APK(s)**
3. APK will be at:
   `android/app/build/outputs/apk/debug/app-debug.apk`

### Step 8: Install on your Samsung S24 Ultra
**Option A — USB:**
```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

**Option B — Android Studio:**
Plug in phone via USB, enable Developer Options + USB Debugging,
then click the green ▶ Run button in Android Studio.

**Option C — File transfer:**
Copy the APK to your phone and open it
(Settings → Install unknown apps → allow your file manager)

---

## Enabling Developer Mode on Samsung S24 Ultra

1. Settings → About phone → Software information
2. Tap **Build number** 7 times
3. Settings → Developer options → Enable USB debugging

---

## How BLE reconnect works in the APK

Your `app.js` already has the reconnect timer logic (`startAutoReconnect`,
`attemptAutoReconnect`). In the APK:

- When the ESP32 goes out of range, the native BLE stack fires the
  disconnect callback immediately
- `app.js` starts a 5-second retry timer
- Each retry calls `bleManager.connectToKnownDevice()` which uses the
  stored device ID to reconnect silently — **no user picker needed**
- When back in range, it reconnects automatically ✅

**Note:** While the app is in the foreground, reconnect works perfectly.
Full background reconnect (screen off) requires a Foreground Service —
this is an advanced Android feature. For R/C use where you're actively
watching the phone, foreground-only reconnect is sufficient.

---

## Updating the app

When you change your web files:
```bash
npx cap sync android
```
Then rebuild the APK in Android Studio.

---

## Troubleshooting

**"BLUETOOTH_SCAN permission denied" on Android 12+**
→ The plugin handles runtime permission requests automatically on first connect.
  If denied, go to Settings → Apps → RCDCC → Permissions → Nearby devices → Allow.

**"No device found" when scanning**
→ Make sure ESP32 is powered on and advertising.
→ Try toggling Bluetooth off/on on the phone.

**Gradle sync fails**
→ Make sure ANDROID_HOME is set correctly.
→ In Android Studio: File → Invalidate Caches → Restart.

**App crashes on launch**
→ Check Android Studio Logcat (filter by "RCDCC" or "BleClient").
→ Most common cause: missing asset files in www/.

---

## Release / Signed APK (for distributing to others)

To build a release APK (required for Google Play, optional for personal use):
1. In Android Studio: Build → Generate Signed Bundle/APK
2. Create a keystore (save it somewhere safe — you need it for every update)
3. Fill in alias and passwords
4. Build → release APK

For personal side-loading, the debug APK from Step 7 works fine.
