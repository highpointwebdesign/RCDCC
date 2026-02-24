# GPS PWA Test Files

Minimal test files to verify GPS and PWA functionality on your phone.

## Files Created:
- `test-gps.html` - Main test page
- `test.webmanifest` - PWA manifest
- `test-sw.js` - Service worker

## How to Test:

### Step 1: Upload to ESP32
Upload these files to your ESP32's web server (SPIFFS/LittleFS) along with your existing files.

### Step 2: Access from Phone
1. Connect to ESP32's WiFi network
2. Open browser (Chrome/Edge recommended)
3. Navigate to: `http://192.168.87.32/test-gps.html`

### Step 3: Check Context
The page will show:
- **Protocol**: Should show `http:` (orange warning is OK)
- **Secure Context**: May show "No" for http://192.168.x.x
- **GPS Available**: Should show "✓ Yes"
- **Display Mode**: Will show "Browser" until installed

### Step 4: Test GPS
1. Tap "Request GPS Permission" button
2. Allow location access when prompted
3. Should see your coordinates appear
4. Tap "Get Current Location" to refresh

### Step 5: Install as PWA
1. Tap browser menu (⋮)
2. Select "Add to Home Screen" or "Install app"
3. Tap "Install"
4. Icon appears on home screen

### Step 6: Test Installed PWA
1. Tap the home screen icon
2. App opens without URL bar ✓
3. **Display Mode** should now show "PWA" ✓
4. Tap "Get Current Location"
5. GPS should work ✓

## What to Look For:

### ✅ Success Indicators:
- Protocol shows (even if orange)
- GPS Available shows "✓ Yes"
- Can click "Get Current Location" and see coordinates
- After installing, Display Mode shows "PWA"
- No URL bar when opened from home screen

### ❌ Failure Indicators:
- Protocol shows `file://` (red) - Wrong serving method
- GPS Available shows "✗ No" - Geolocation API blocked
- Permission denied errors - Context not secure enough
- Still shows URL bar after installing - Not properly installed

## Troubleshooting:

**If GPS doesn't work:**
- Check that you're accessing via `http://192.168.x.x` NOT `file://`
- Try using Chrome (best PWA support)
- Check browser console for errors (chrome://inspect)

**If PWA won't install:**
- Make sure all 3 files are uploaded to ESP32
- Clear browser cache and try again
- Some browsers require HTTPS for full PWA features

**If installed PWA shows URL bar:**
- Uninstall and reinstall
- Make sure you used "Install app" not just bookmark
- Check that manifest is loading correctly

## Expected Results:

On **HTTP (http://192.168.87.32)**:
- GPS should work (with possible warning)
- PWA should install
- May see "Not Secure" in browser
- **This is normal for local IPs**

The test proves:
1. Your ESP32 can serve PWA files ✓
2. GPS API is accessible ✓
3. PWA installation works ✓
4. You don't need HOPWEB ✓

Once this works, your full dashboard will work the same way!
