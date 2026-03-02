# RCDCC - R/C Dynamic Chassis Control

Progressive Web App for real-time R/C suspension tuning, vehicle telemetry, and GPS tracking. Works with ESP32-based active suspension systems.

![RCDCC Dashboard](https://img.shields.io/badge/PWA-Ready-blue?style=flat-square) ![ESP32](https://img.shields.io/badge/ESP32-Compatible-green?style=flat-square)

## Features

### 🎯 Dashboard
- **Roll/Pitch Monitoring** - Real-time vehicle orientation display with direction indicators
- **GPS Tracking** - Latitude, longitude, altitude, and accuracy in feet
- **Suspension Settings** - Quick view of current tuning parameters
- **Connection Status** - WiFi connectivity, telemetry stream status, and protocol info

### ⚙️ Settings
- **Servo Configuration** - Range calibration (min/max pulse width), trim adjustments, rotation direction
- **Auto Level** - Automated leveling system with 3-phase servo direction verification
- **Gyro Configuration** - MPU6050 mounting orientation selection
- **Network Settings** - Switch between Home WiFi and Stand Alone Mode
- **Sound Settings** - Enable/disable notification sounds
- **Debugging** - Console output and configuration inspector

### 🔧 Suspension Tuning
- **Ride Height** - Adjust chassis height (-5mm to +5mm)
- **Damping** - Control shock absorption (0.0 to 1.0)
- **Stiffness** - Set spring rate (0.0 to 1.0)
- **Reaction Speed** - Adjust system response time (1 to 10)
- **Front/Rear Balance** - Weight distribution control (-50% to +50%)
- **Sensor Rate** - MPU6050 update frequency (10Hz to 100Hz)

### 💡 Light Control
- Headlights, brake lights, and underglow control *(Coming Soon)*

### 📹 FPV Controls
- Camera gimbal and recording controls *(Coming Soon)*

## Installation

### Option 1: Hosted PWA (Recommended)
1. Navigate to the hosted URL in a mobile browser (HTTPS required)
2. Tap "Add to Home Screen" when prompted
3. Launch the app from your home screen

### Option 2: Local Development Server
```bash
# Using live-server (Node.js)
npm install -g live-server
cd html
live-server --port=8080 --host=0.0.0.0

# Using Python
cd html
python -m http.server 8080
```

### Option 3: Local Files
Open `html/index.html` directly in a browser (limited functionality due to CORS and secure context requirements)

## Quick Start

### 1. Connect to ESP32
**Stand Alone Mode (Default):**
- Connect to WiFi network: `RCDCC`
- Password: `12345678`
- Open app at: `http://192.168.4.1`

**Home WiFi Mode:**
- ESP32 connects to your home network
- Check serial monitor for assigned IP address
- Enter IP in Settings → Network → RCDCC IP Address
- Click "Save & Apply"

### 2. Set Level Reference
1. Place vehicle on flat surface
2. Tap the **camera icon** (top right) to capture GPS coordinates and calibrate gyroscope
3. Current roll/pitch values become the zero reference point

### 3. Auto Level (Optional)
1. Navigate to Settings → Servo Configuration
2. Tap **"Initiate Auto Level"**
3. System will:
   - Reset servos to neutral (optional)
   - Verify servo directions (Phase A)
   - Iteratively adjust trims to achieve level (Phase B)

### 4. Tune Suspension
- Go to **Suspension Tuning** page
- Adjust sliders for desired handling characteristics
- Changes auto-save to ESP32 SPIFFS

## Network Configuration

### Stand Alone Mode
- ESP32 creates its own WiFi access point
- No internet connection required
- Always uses IP: `192.168.4.1`
- Ideal for field use

### Home WiFi Mode
- ESP32 connects to your home network
- Allows internet access on device
- IP assigned by router (check serial monitor)
- Better for development and testing

## Technologies

- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **UI Framework:** Bootstrap 5.3.2
- **Icons:** Material Symbols Outlined
- **Notifications:** Custom toast system with audio feedback
- **GPS:** Browser Geolocation API
- **Storage:** localStorage for persistence
- **Service Worker:** Offline support and caching
- **WebSocket:** Real-time telemetry streaming
- **Sliders:** rSlider library

## Project Structure

```
html/
├── index.html              # Main application (single-page)
├── sw.js                   # Service worker (PWA)
├── site.webmanifest        # App manifest
├── css/                    # Stylesheets
│   ├── bootstrap.min.css
│   ├── fonts.css
│   └── all.min.css
├── js/                     # JavaScript libraries
│   └── bootstrap.bundle.min.js
├── plugins/                # UI plugins
│   └── range-slider/
├── assets/                 # Images and fonts
│   ├── Material_Symbols_Outlined/
│   ├── css/
│   └── js/
├── toasty/                 # Notification sounds
│   └── dist/sounds/
├── android/                # Android PWA assets
└── *.png                   # App icons and logos
```

## Key Features Deep Dive

### Auto Level System
The auto-level feature uses a sophisticated 3-phase approach:

**Phase 0: Neutral Reset** (Optional)
- Resets all servo trims to 0° (center position)
- Allows fresh calibration from known state

**Phase A: Servo Direction Verification**
- Tests each servo individually with +10° movement
- Measures pitch response to verify correct direction
- Automatically reverses servos that respond incorrectly
- Validates fixes before proceeding

**Phase B: Iterative Leveling**
- Reads current roll and pitch
- Calculates per-servo adjustments
- Applies incremental changes (clamped to ±20°)
- Repeats until level achieved (tolerance: ±1.5°)
- Maximum 15 iterations to prevent infinite loops

### GPS Coordinate Capture
- Captures GPS on app load
- Updates when refreshing roll/pitch
- Updates when setting level reference
- Converts accuracy and altitude from meters to feet
- Displays coordinates with 6 decimal precision

### Persistent Storage
Settings saved in localStorage:
- ESP32 IP address
- Connection method (Home WiFi / Stand Alone)
- Notification sound preference
- Lock states (tuning, servo range, trim, rotation)
- Last active page and settings tab
- Bubble level modal preferences

### Notification System
- Success, error, warning, and info toasts
- Optional sound effects (user-controlled)
- Tap-to-dismiss functionality
- Auto-hide after 3 seconds (configurable)

## Browser Compatibility

- **Chrome/Edge:** Full support ✅
- **Safari (iOS/macOS):** Full support ✅
- **Firefox:** Full support ✅
- **Samsung Internet:** Full support ✅

**Requirements:**
- Modern browser with ES6+ support
- Geolocation API support
- Service Worker support (PWA features)

## Security Notes

### Geolocation
- GPS requires HTTPS or localhost in production
- Permission must be granted by user
- Works over HTTP during development

### CORS
- ESP32 enables CORS headers for cross-origin requests
- Service worker caches only HTTP/HTTPS resources
- Chrome extension URLs are excluded from caching

## Development

### Prerequisites
- Node.js (for live-server) or Python (for SimpleHTTPServer)
- Modern code editor (VS Code recommended)
- ESP32 with firmware installed (see `firmware/README.md`)

### Local Testing
```bash
cd html
live-server --port=8080 --host=0.0.0.0
```

Access at: `http://localhost:8080`

### PWA Installation Testing
1. Deploy to HTTPS server (GitHub Pages, Netlify, Vercel)
2. Open in mobile browser
3. Check for "Add to Home Screen" prompt
4. Install and test offline functionality

### Debugging
- Open Settings → Debugging tab
- View console logs in real-time
- Inspect configuration JSON
- Copy console output for troubleshooting

## Roadmap

- [ ] Light control implementation
- [ ] FPV camera controls
- [ ] Advanced telemetry graphs
- [ ] Preset profiles (save/load configurations)
- [ ] Multi-language support
- [ ] Dark mode
- [ ] Telemetry data export

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License.

## Related Projects

- **Firmware:** See `firmware/README.md` for ESP32 firmware documentation
- **Hardware:** Custom PCB design and BOM *(Coming Soon)*

## Support

For issues, questions, or contributions:
- GitHub Issues: https://github.com/highpointwebdesign/RCDCC/issues
- Repository: https://github.com/highpointwebdesign/RCDCC

---

**Built with ❤️ for the R/C community**
