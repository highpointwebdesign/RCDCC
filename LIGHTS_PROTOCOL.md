# Light Groups to WLED Segments Protocol

## Overview
User-defined light groups (with arbitrary LED indices) map to WLED segments. Each segment renders a specific pattern independently to its assigned LEDs.

## Current UI Configuration
- **Solid Pattern**: Brightness only (0-255)
- **Glitter Pattern**: Brightness (0-255) + Effect Intensity (0-255)
- Future: 13 additional patterns (blink, strobe, breathe, fade, twinkle, sparkle, flash_sparkle, solid_glitter, running, larson, heartbeat, flicker, fire_flicker)

## BLE Protocol for Light Group Updates

### Command Structure
```javascript
// BLE CHAR_LIGHTS_CMD carries JSON-formatted segment commands
{
  "group": <index>,           // 0-14 (LIGHTS_ENGINE_MAX_GROUPS = 15)
  "name": "<string>",          // Group name (up to 23 chars)
  "enabled": <boolean>,        // Master switch for segment
  "indices": [n1, n2, ...],    // Arbitrary LED positions (up to 15 LEDs per group)
  "pattern": "<pattern>",      // 'solid', 'glitter', etc.
  "brightness": <0-255>,       // LED brightness
  "color": <0xRRGGBB>,         // Primary color (32-bit)
  "color2": <0xRRGGBB>,        // Secondary color (only for dual-color patterns)
  "intensity": <0-255>,        // Effect intensity (for patterns that support it, e.g. glitter)
  "speed": <0-255>             // Effect speed (for future patterns)
}
```

### Example Payloads

**Solid White Brake Lights (LEDs 0-2, Full Brightness)**
```json
{
  "group": 0,
  "name": "Brake Lights",
  "enabled": true,
  "pattern": "solid",
  "indices": [0, 1, 2],
  "brightness": 255,
  "color": "#ff0000",
  "intensity": 128
}
```

**Glitter Effect with Custom Intensity (LEDs 5-7, Medium Brightness)**
```json
{
  "group": 1,
  "name": "Accent Glitter",
  "enabled": true,
  "pattern": "glitter",
  "indices": [5, 6, 7],
  "brightness": 200,
  "color": "#00ff00",
  "intensity": 192
}
```

## Firmware Implementation Strategy (WLED Integration)

### Architecture
1. **Segment Array**: Create struct array `segments[15]` matching app's max groups
2. **LED Mapping**: Each segment stores its arbitrary LED indices (not sequential)
3. **Pattern Execution**: WLED's effect engine runs on each segment independently
4. **Pixel Assembly**: Frame buffer collects all segment outputs, maps to physical LEDs

### ESP32 Struct Example
```cpp
struct WledSegment {
  uint16_t indices[LIGHTS_ENGINE_MAX_GROUP_LEDS];        // Arbitrary LED positions
  uint8_t ledCount;                                        // How many indices in use
  uint32_t colorPrimary;                                   // 0xRRGGBB
  uint32_t colorSecondary;                                 // 0xRRGGBB
  uint8_t brightness;                                      // 0-255
  uint8_t effect;                                          // FX_SOLID, FX_GLITTER, etc.
  uint8_t speed;                                           // 0-255
  uint8_t intensity;                                       // 0-255 (effect intensity)
  uint32_t pixels[LIGHTS_ENGINE_MAX_GROUP_LEDS];           // Rendered RGB values
  bool enabled;
  FxRuntime runtime;                                       // Effect state
};
```

### Processing Flow
```
1. Parse BLE JSON → Update segment[group]
2. Every tick (50Hz):
   a. For each enabled segment:
      - Run FX::render(effect, runtime, colorPrimary, colorSecondary, intensity, ...)
      - Store result in segment.pixels[]
   b. Assemble frame buffer:
      - For each physical LED index:
        - Find all segments using this LED
        - Composite their pixels (max/blend/additive)
        - Write to frame buffer
   c. Push frame buffer to NeoPixel strip
3. BLE gate: Master OFF → all segments disabled visually (frame = black)
```

### Key Differences from App Logic
- **Firmware doesn't know about "profiles"** - processes segments directly
- **No sequential assumption** - segment.indices[] can be arbitrary
- **Standard FX runtime** - leverage existing WLED effect libraries (RcdccFx)
- **Master switch integrated** - global master disables all segments at once

## Firmware Entry Point (BLE Handler)
```cpp
// In BLE command handler
void handleLightsGroupDetail(const String& jsonPayload) {
  // 1. Parse JSON
  // 2. Validate group index (0-14)
  // 3. Update segments[group] with new config
  // 4. Reset FxRuntime for smooth effect playback
  // 5. Mark dirty for next render tick
}
```

## Transition (From UI to Firmware)
1. **App Side** (Already complete):
   - Intensity field added to UI (shown only for glitter)
   - Light group normalization includes intensity (default 128)
   - Payload signature includes intensity for change detection
   - BLE sends full group JSON with intensity field

2. **Firmware Side** (To implement):
   - Create/restore LightsEngine with segment-based architecture
   - Parse BLE JSON payload into segment struct
   - Map arbitrary indices to frame buffer correctly
   - Render each pattern independently using RcdccFx
   - Composite multiple segments if they share LEDs
   - Return to BLE any errors/acknowledgments

## Testing Strategy
1. **Unit**: Verify segment JSON parsing
2. **Integration**: Test arbitrary LED mapping (e.g., [0, 5, 10] all light correctly)
3. **Effect Verification**: Confirm solid renders correctly, glitter applies intensity
4. **Multi-segment**: Enable 2+ segments, verify no LED conflict/ghosting
5. **Master Switch**: Turn master OFF, confirm all LEDs go dark immediately

## Notes
- Intensity is currently only functional for "glitter" (metadata.hasIntensity = true)
- Future patterns will be added by expanding PATTERN_METADATA
- Color order (RGB/GRB/etc) is handled separately via `lights_color_order` command
- All indices are 0-based, validated to be < MAX_LIGHTS_TOTAL_LEDS (30)
