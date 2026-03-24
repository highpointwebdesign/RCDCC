# Light Groups Enhancement: Intensity Control & BLE Protocol

## Summary of Changes

### 1. UI Enhancement: Pattern-Dependent Intensity Control

#### Files Modified
- `www/index.html` - Added intensity slider to light group editor modal
- `www/js/app.js` - Added intensity field, slider initialization, and pattern-based visibility logic

#### What Changed

**Before:**
- Light groups had: indices, brightness, color, color2, pattern, enabled
- No effect intensity control
- Only brightness was configurable

**After:**
- Light groups now include: **intensity** field (0-255 range)
- Intensity slider **appears only for patterns that support it**
  - Currently shown for: **glitter** ✓
  - Hidden for: **solid** and all future patterns (initially)
- Both brightness and intensity are sent to ESP32 via BLE

#### UI Behavior
```
Solid Pattern → Show only [Brightness]
Glitter Pattern → Show [Brightness] + [Effect Intensity]
```

### 2. Light Group Data Structure

**New field added to each light group:**
```javascript
{
  id: "lg-...",
  name: "Brake Lights",
  indices: [0, 1, 2],        // Arbitrary LED positions
  brightness: 200,            // 0-255 (from UI: 0-100%)
  color: "#ff0000",          
  color2: "#000000",
  pattern: "solid",          
  intensity: 128,            // NEW: 0-255 (Effect intensity for patterns like glitter)
  enabled: true
}
```

**Normalization (automatic on load):**
- If intensity is missing from old saved data → defaults to 128
- If intensity is out of range (0-255) → clamped to valid range
- Prevents data corruption from saved groups

### 3. BLE Protocol for Firmware Communication

**Binary format:** JSON via `CHAR_LIGHTS_CMD`

```json
{
  "group": 0,
  "name": "Brake Lights",
  "enabled": true,
  "pattern": "glitter",
  "indices": [0, 1, 2],
  "brightness": 255,
  "color": "#ff0000",
  "color2": "#000000",
  "intensity": 192
}
```

**Key points for firmware:**
- **segments[0-14]** map to app's 15 light groups
- Each segment has arbitrary LED indices (not sequential like WLED)
- Pattern + brightness + intensity configure the effect
- Master switch controls all segments at once

### 4. Pattern Metadata Extension

**Added `hasIntensity` property to pattern definitions:**
```javascript
const PATTERN_METADATA = {
  solid: { needsDualColor: false, hasIntensity: false },
  glitter: { needsDualColor: false, hasIntensity: true },  // ← NEW
  blink: { needsDualColor: true, hasIntensity: false },
  // ... (13 more patterns, all with hasIntensity: false initially)
};
```

**How to enable intensity for future patterns:**
```javascript
// When adding new pattern "breathe" with intensity support:
breathe: { needsDualColor: true, hasIntensity: true }
// → Intensity slider will automatically appear in UI
```

### 5. Implementation Details

#### State Variables Added
```javascript
let currentIntensity = 128;              // Current editing context
let lightGroupIntensitySliderInstance = null;  // Slider instance
```

#### Functions Added/Modified
- `updateLightGroupIntensityThumbLabel(value)` - Display intensity value
- `toggleSecondaryColorVisibility(pattern)` - Now also toggles intensity container
- `normalizeLightGroup(group)` - Validates and defaults intensity field
- `getLightGroupPayloadSignature(payload)` - Includes intensity for change detection
- `saveLightGroupFromModal()` - Captures intensity when saving
- Modal initialization - Loads/sets intensity on group edit/add

#### HTML Structure
```html
<!-- Effect Intensity Slider (shown only for patterns that support it) -->
<div id="lightGroupIntensityContainer" style="display: none;">
  <label for="lightGroupIntensitySlider">Effect Intensity</label>
  <div class="servo-trim-slider" id="lightGroupIntensitySlider"></div>
  <span id="lightGroupIntensityValue">128</span>
  <!-- Scale: 0 to 255 -->
</div>
```

---

## Firmware Side: Next Steps

### Required Implementation

1. **Segment-Based Architecture**
   - Replace sequential LED assumption with arbitrary index mapping
   - Each segment = one light group from app
   - Segment indices[] can contain any combination of LED positions

2. **Pattern Rendering**
   - Use existing RcdccFx library for effect generation
   - Pass **intensity** parameter to effect render function
   - Only for patterns where `hasIntensity: true` in metadata

3. **LED Assembly**
   - Frame buffer collects all segment outputs
   - Maps to physical LEDs correctly (arbitrary positions)
   - Handle multi-segment LED conflicts (max/blend/additive)

4. **BLE Handler**
   - Parse incoming JSON segment update
   - Update `segments[group]` struct with new configuration
   - Reset effect runtime for smooth transition

### Protocol Reference
See `LIGHTS_PROTOCOL.md` for complete BLE protocol specification and firmware architecture guidance.

---

## Testing Checklist

- [x] UI builds without errors
- [x] Intensity field added to modal (hidden for solid, shown for glitter)
- [x] Intensity slider initializes to 128
- [x] Intensity saved with light group data
- [x] Intensity normalized on load
- [x] Intensity included in change detection
- [x] Modal cleanup resets currentIntensity
- [ ] Manually test UI: Create glitter group, verify intensity slider appears
- [ ] Manually test UI: Switch to solid, verify intensity slider disappears
- [ ] Firmware: Implement segment parsing and rendering
- [ ] Firmware: Test BLE JSON contains intensity field
- [ ] Integration: Verify intensity affects glitter effect rendering

---

## Version Info
- App Version: 1.1.302 (auto-incremented)
- Build Date: 2026-03-23
- Pattern UI Scope: Solid + Glitter (only 2 patterns exposed in UI for Round 1)
- Future Patterns: 13 additional patterns identified, to be implemented in subsequent phases
