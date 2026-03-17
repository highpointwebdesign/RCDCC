#pragma once
// =============================================================================
// LightsEngine.h — RCDCC Addressable LED Effect Engine
// =============================================================================
// Runs on Core 0 via FreeRTOS task. Core 1 handles BLE.
// Effects adapted from WLED open source project (MIT license).
// Each effect operates ONLY on its group's defined LED indices —
// never on the full strip.
//
// BLE sends a group update packet via CHAR_LIGHTS_CMD:
// {
//   "group": 0,
//   "name": "Headlights",
//   "enabled": true,
//   "color": "#FFFFFF",
//   "color2": "#000000",
//   "brightness": 100,
//   "effect": "solid",
//   "speed": 128,
//   "leds": [0, 2]
// }
// =============================================================================

#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>
#include "Config.h"

// ── Constants ─────────────────────────────────────────────────────────────────
#define LIGHTS_ENGINE_PIN        27
#define LIGHTS_ENGINE_MAX_LEDS   300
#define LIGHTS_ENGINE_MAX_GROUPS 16
#define LIGHTS_ENGINE_MAX_GROUP_LEDS 64
#define LIGHTS_ENGINE_TASK_HZ    50    // frame rate — 50Hz = 20ms per tick
#define LIGHTS_ENGINE_TICK_MS    (1000 / LIGHTS_ENGINE_TASK_HZ)
#define LIGHTS_ENGINE_CORE       0     // pin to Core 0; BLE runs on Core 1

// ── Effect enum ───────────────────────────────────────────────────────────────
enum LightEffect : uint8_t {
    FX_SOLID         = 0,
    FX_BLINK         = 1,
    FX_STROBE        = 2,
    FX_BREATHE       = 3,
    FX_FADE          = 4,
    FX_TWINKLE       = 5,
    FX_SPARKLE       = 6,
    FX_FLASH_SPARKLE = 7,
    FX_GLITTER       = 8,
    FX_RUNNING       = 9,
    FX_LARSON        = 10,
    FX_FLICKER       = 11,
    FX_HEARTBEAT     = 12,
    FX_ALTERNATE     = 13,
    FX_COUNT         = 14
};

static const char* const EFFECT_NAMES[FX_COUNT] = {
    "solid", "blink", "strobe", "breathe", "fade",
    "twinkle", "sparkle", "flash_sparkle", "glitter",
    "running", "larson", "flicker", "heartbeat", "alternate"
};

static LightEffect effectFromString(const char* name) {
    if (!name) return FX_SOLID;
    for (uint8_t i = 0; i < FX_COUNT; i++) {
        if (strcasecmp(name, EFFECT_NAMES[i]) == 0) return static_cast<LightEffect>(i);
    }
    return FX_SOLID;
}

// ── Light group config ─────────────────────────────────────────────────────────
struct EngineLightGroup {
    char       name[24]     = {0};
    bool       enabled      = false;
    uint32_t   colorPrimary = 0xFFFFFF;   // RGB packed
    uint32_t   colorSecond  = 0x000000;
    uint8_t    brightness   = 100;        // 0–100 %
    LightEffect effect      = FX_SOLID;
    uint8_t    speed        = 128;        // 0–255, higher = faster
    uint16_t   leds[LIGHTS_ENGINE_MAX_GROUP_LEDS] = {0};
    uint8_t    ledCount     = 0;

    // Per-group animation state (not sent over BLE, managed internally)
    uint32_t   _tick        = 0;          // increments every frame
    uint8_t    _pos         = 0;          // position for scanning effects
    int8_t     _dir         = 1;          // direction for Larson
    uint8_t    _twinkle[LIGHTS_ENGINE_MAX_GROUP_LEDS] = {0}; // per-LED twinkle phase
};

// NOTE:
// LightingProfile / NewLightsConfig / ExtendedLightGroup are defined in Config.h.
// LightsEngine maps those shared storage/BLE structs into internal EngineLightGroup.

// ── Helper: scale a 0–100 brightness onto a 0–255 channel value ──────────────
static inline uint8_t scaleBrightness(uint8_t channelVal, uint8_t bri100) {
    return (uint8_t)(((uint16_t)channelVal * bri100) / 100);
}

// ── Helper: apply brightness to a packed RGB color ────────────────────────────
static inline uint32_t applyBri(uint32_t rgb, uint8_t bri100) {
    uint8_t r = scaleBrightness((rgb >> 16) & 0xFF, bri100);
    uint8_t g = scaleBrightness((rgb >>  8) & 0xFF, bri100);
    uint8_t b = scaleBrightness( rgb        & 0xFF, bri100);
    return ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
}

// ── Helper: blend two packed colors 0..255 ────────────────────────────────────
static inline uint32_t blendColor(uint32_t c1, uint32_t c2, uint8_t t) {
    uint8_t r = ((uint16_t)((c1>>16)&0xFF)*(255-t) + (uint16_t)((c2>>16)&0xFF)*t) >> 8;
    uint8_t g = ((uint16_t)((c1>> 8)&0xFF)*(255-t) + (uint16_t)((c2>> 8)&0xFF)*t) >> 8;
    uint8_t b = ((uint16_t)( c1     &0xFF)*(255-t) + (uint16_t)( c2     &0xFF)*t) >> 8;
    return ((uint32_t)r<<16)|((uint32_t)g<<8)|b;
}

// =============================================================================
// LightsEngine class
// =============================================================================
class LightsEngine {
public:
    LightsEngine(uint8_t pin, uint16_t numLeds)
        : _strip(numLeds, pin, NEO_GRB + NEO_KHZ800)
        , _numLeds(min((uint16_t)LIGHTS_ENGINE_MAX_LEDS, numLeds))
        , _master(true)
        , _groupCount(0)
    {
        memset(_groups, 0, sizeof(_groups));
        memset(_frameBuffer, 0, sizeof(_frameBuffer));
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────
    void begin() {
        _strip.begin();
        _strip.show();
        xTaskCreatePinnedToCore(
            _task, "LEDEffects",
            4096, this,
            1, &_taskHandle,
            LIGHTS_ENGINE_CORE
        );
    }

    // ── BLE: update a single group from JSON payload ───────────────────────────
    // Expected JSON keys: group(int), name(str), enabled(bool),
    //   color(str "#RRGGBB"), color2(str), brightness(0-100),
    //   effect(str), speed(0-255), leds([int...])
    bool updateGroupFromJson(const String& payload) {
        DynamicJsonDocument doc(1024);
        if (deserializeJson(doc, payload) != DeserializationError::Ok) return false;

        int idx = doc["group"] | -1;
        if (idx < 0 || idx >= LIGHTS_ENGINE_MAX_GROUPS) return false;

        // Expand group array if needed
        if (idx >= _groupCount) _groupCount = idx + 1;

        EngineLightGroup& g = _groups[idx];

        if (doc.containsKey("name"))
            strncpy(g.name, doc["name"].as<const char*>(), sizeof(g.name)-1);

        if (doc.containsKey("enabled"))
            g.enabled = doc["enabled"].as<bool>();

        if (doc.containsKey("color"))
            g.colorPrimary = _parseHex(doc["color"].as<const char*>());

        if (doc.containsKey("color2"))
            g.colorSecond = _parseHex(doc["color2"].as<const char*>());

        if (doc.containsKey("brightness"))
            g.brightness = constrain((int)doc["brightness"], 0, 100);

        if (doc.containsKey("effect"))
            g.effect = effectFromString(doc["effect"].as<const char*>());

        if (doc.containsKey("speed"))
            g.speed = constrain((int)doc["speed"], 0, 255);

        if (doc.containsKey("leds")) {
            JsonArray arr = doc["leds"].as<JsonArray>();
            g.ledCount = 0;
            for (uint16_t ledIdx : arr) {
                if (g.ledCount >= LIGHTS_ENGINE_MAX_GROUP_LEDS) break;
                if (ledIdx < _numLeds)
                    g.leds[g.ledCount++] = ledIdx;
            }
            // Reset animation state when LED indices change
            g._tick = 0; g._pos = 0; g._dir = 1;
            memset(g._twinkle, 0, sizeof(g._twinkle));
        }

        return true;
    }

    // ── Legacy payload compat (existing main.cpp path) ─────────────────────────
    void updateFromPayload(const NewLightsConfig& cfg) {
        if (cfg.useLegacyMode) return; // legacy mode not handled by new engine
        _groupCount = 0;
        for (int i = 0; i < cfg.groupCount && i < LIGHTS_ENGINE_MAX_GROUPS; i++) {
            const ExtendedLightGroup& src = cfg.groups[i];
            EngineLightGroup& g = _groups[i];
            strncpy(g.name, src.name, sizeof(g.name)-1);
            g.name[sizeof(g.name) - 1] = '\0';
            g.enabled      = src.enabled;
            g.colorPrimary = src.color;
            g.colorSecond  = src.color2;
            g.brightness   = (src.brightness * 100) / 255;
            g.effect       = effectFromString(src.pattern);
            g.speed        = 128;
            g.ledCount     = min((uint8_t)src.ledCount, (uint8_t)LIGHTS_ENGINE_MAX_GROUP_LEDS);
            for (int j = 0; j < g.ledCount; j++) g.leds[j] = src.ledIndices[j];
            g._tick = 0; g._pos = 0; g._dir = 1;
            _groupCount++;
        }
    }

    // ── Profile load/save compat ───────────────────────────────────────────────
    void loadProfile(const LightingProfile& profile) {
        _master = profile.master;
        _groupCount = min((int)profile.groupCount, LIGHTS_ENGINE_MAX_GROUPS);
        for (int i = 0; i < _groupCount; i++) {
            const LightingGroup& src = profile.groups[i];
            EngineLightGroup& dst = _groups[i];

            strncpy(dst.name, src.name, sizeof(dst.name) - 1);
            dst.name[sizeof(dst.name) - 1] = '\0';
            dst.enabled = src.enabled;
            dst.colorPrimary = _parseHex(src.colorPrimary);
            dst.colorSecond = _parseHex(src.colorSecondary);
            dst.brightness = constrain((int)src.brightness, 0, 100);
            dst.effect = effectFromString(src.effect);
            dst.speed = (uint8_t)((uint16_t)constrain((int)src.effectSpeed, 0, 100) * 255 / 100);

            dst.ledCount = 0;
            uint16_t maxLeds = min((uint16_t)src.ledCount, (uint16_t)LIGHTS_ENGINE_MAX_GROUP_LEDS);
            for (uint16_t j = 0; j < maxLeds; j++) {
                uint16_t led = src.leds[j];
                if (led < _numLeds) {
                    dst.leds[dst.ledCount++] = led;
                }
            }

            dst._tick = 0;
            dst._pos = 0;
            dst._dir = 1;
            memset(dst._twinkle, 0, sizeof(dst._twinkle));
        }
    }

    LightingProfile* getProfile() {
        if (_exportProfile.name[0] == '\0') {
            strncpy(_exportProfile.name, "Runtime", sizeof(_exportProfile.name) - 1);
            _exportProfile.name[sizeof(_exportProfile.name) - 1] = '\0';
        }
        _exportProfile.master     = _master;
        _exportProfile.totalLeds  = _numLeds;
        _exportProfile.groupCount = _groupCount;
        for (int i = 0; i < _groupCount; i++) {
            EngineLightGroup& src = _groups[i];
            LightingGroup& dst = _exportProfile.groups[i];

            dst.id = i;
            strncpy(dst.name, src.name, sizeof(dst.name) - 1);
            dst.name[sizeof(dst.name) - 1] = '\0';
            dst.ledCount = src.ledCount;
            for (uint16_t j = 0; j < src.ledCount; j++) {
                dst.leds[j] = src.leds[j];
            }

            dst.enabled = src.enabled;
            strncpy(dst.effect, EFFECT_NAMES[src.effect], sizeof(dst.effect) - 1);
            dst.effect[sizeof(dst.effect) - 1] = '\0';
            snprintf(dst.colorPrimary, sizeof(dst.colorPrimary), "#%06lX", (unsigned long)(src.colorPrimary & 0xFFFFFF));
            snprintf(dst.colorSecondary, sizeof(dst.colorSecondary), "#%06lX", (unsigned long)(src.colorSecond & 0xFFFFFF));
            dst.brightness = src.brightness;
            dst.effectSpeed = (uint8_t)((uint16_t)src.speed * 100 / 255);
            dst.effectIntensity = DEFAULT_EFFECT_INTENSITY;
        }
        return &_exportProfile;
    }

    // ── Master switch ──────────────────────────────────────────────────────────
    void setMaster(bool on) { _master = on; }
    bool getMaster() const  { return _master; }

    // ── Flash all LEDs blocking (used by garage truck-switch command) ──────────
    void flashAllBlocking(uint32_t color, uint8_t count,
                          uint16_t onMs, uint16_t offMs,
                          volatile bool* cancel = nullptr)
    {
        for (uint8_t i = 0; i < count; i++) {
            if (cancel && *cancel) break;
            _fillAll(color);
            _strip.show();
            delay(onMs);
            if (cancel && *cancel) break;
            _fillAll(0);
            _strip.show();
            delay(offMs);
        }
        // Restore normal operation on next tick
    }

private:
    Adafruit_NeoPixel _strip;
    uint16_t          _numLeds;
    bool              _master;
    int               _groupCount;
    EngineLightGroup        _groups[LIGHTS_ENGINE_MAX_GROUPS];
    uint32_t          _frameBuffer[LIGHTS_ENGINE_MAX_LEDS]; // RGB packed
    TaskHandle_t      _taskHandle = nullptr;
    LightingProfile   _exportProfile;
    SemaphoreHandle_t _mutex = xSemaphoreCreateMutex();

    // ── FreeRTOS task ──────────────────────────────────────────────────────────
    static void _task(void* arg) {
        LightsEngine* self = static_cast<LightsEngine*>(arg);
        TickType_t xLastWake = xTaskGetTickCount();
        for (;;) {
            vTaskDelayUntil(&xLastWake, pdMS_TO_TICKS(LIGHTS_ENGINE_TICK_MS));
            self->_tick();
        }
    }

    void _tick() {
        if (xSemaphoreTake(_mutex, 0) != pdTRUE) return; // skip frame if busy

        memset(_frameBuffer, 0, _numLeds * sizeof(uint32_t));

        if (_master) {
            for (int i = 0; i < _groupCount; i++) {
                EngineLightGroup& g = _groups[i];
                if (!g.enabled || g.ledCount == 0) continue;
                _runEffect(g);
                g._tick++;
            }
        }

        // Push frame buffer to strip
        for (uint16_t i = 0; i < _numLeds; i++) {
            uint32_t c = _frameBuffer[i];
            _strip.setPixelColor(i, (c>>16)&0xFF, (c>>8)&0xFF, c&0xFF);
        }
        _strip.show();

        xSemaphoreGive(_mutex);
    }

    // ── Write a color to a group LED by slot index ─────────────────────────────
    inline void _setGroupLed(const EngineLightGroup& g, uint8_t slot, uint32_t color) {
        if (slot < g.ledCount && g.leds[slot] < _numLeds)
            _frameBuffer[g.leds[slot]] = color;
    }

    // ── Fill all physical LEDs ─────────────────────────────────────────────────
    void _fillAll(uint32_t color) {
        for (uint16_t i = 0; i < _numLeds; i++) _frameBuffer[i] = color;
    }

    // ── Speed to period conversion (ticks) ────────────────────────────────────
    // speed 0 = very slow (~10s period), speed 255 = very fast (~0.1s period)
    inline uint32_t _speedToPeriod(uint8_t speed, uint32_t slowTicks, uint32_t fastTicks) {
        // Linearly interpolate between slow and fast
        return fastTicks + ((uint32_t)(255 - speed) * (slowTicks - fastTicks)) / 255;
    }

    // ── Parse "#RRGGBB" or "RRGGBB" hex string ────────────────────────────────
    static uint32_t _parseHex(const char* s) {
        if (!s) return 0;
        if (*s == '#') s++;
        return strtoul(s, nullptr, 16) & 0xFFFFFF;
    }

    // ── Pseudo-random helper (no stdlib rand() dependency) ────────────────────
    static uint8_t _rnd8(uint32_t seed) {
        seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
        return (uint8_t)(seed & 0xFF);
    }

    // =========================================================================
    // EFFECT IMPLEMENTATIONS
    // Each effect writes only to _frameBuffer at positions in g.leds[].
    // Adapted from WLED (MIT license) — WLED segment abstraction replaced
    // with direct iteration over g.leds[].
    // =========================================================================

    void _runEffect(EngineLightGroup& g) {
        switch (g.effect) {
            case FX_SOLID:         _fx_solid(g);         break;
            case FX_BLINK:         _fx_blink(g, false);  break;
            case FX_STROBE:        _fx_blink(g, true);   break;
            case FX_BREATHE:       _fx_breathe(g);       break;
            case FX_FADE:          _fx_fade(g);          break;
            case FX_TWINKLE:       _fx_twinkle(g);       break;
            case FX_SPARKLE:       _fx_sparkle(g, false);break;
            case FX_FLASH_SPARKLE: _fx_sparkle(g, true); break;
            case FX_GLITTER:       _fx_glitter(g);       break;
            case FX_RUNNING:       _fx_running(g);       break;
            case FX_LARSON:        _fx_larson(g);        break;
            case FX_FLICKER:       _fx_flicker(g);       break;
            case FX_HEARTBEAT:     _fx_heartbeat(g);     break;
            case FX_ALTERNATE:     _fx_alternate(g);     break;
            default:               _fx_solid(g);         break;
        }
    }

    // ── Solid ─────────────────────────────────────────────────────────────────
    void _fx_solid(EngineLightGroup& g) {
        uint32_t c = applyBri(g.colorPrimary, g.brightness);
        for (uint8_t i = 0; i < g.ledCount; i++) _setGroupLed(g, i, c);
    }

    // ── Blink / Strobe ────────────────────────────────────────────────────────
    // Blink: slow (period ~500ms at speed 128)
    // Strobe: same logic, caller passes isStrobe=true for tight duty cycle
    void _fx_blink(EngineLightGroup& g, bool isStrobe) {
        // Period in ticks. Speed 128 => ~25 ticks on / 25 off at 50Hz = ~1s cycle
        uint32_t halfPeriod = _speedToPeriod(g.speed, 150, 2); // ticks
        bool on = (g._tick % (halfPeriod * 2)) < (isStrobe ? 1 : halfPeriod);
        uint32_t c = on ? applyBri(g.colorPrimary, g.brightness) : 0;
        for (uint8_t i = 0; i < g.ledCount; i++) _setGroupLed(g, i, c);
    }

    // ── Breathe (sine wave brightness on colorPrimary) ────────────────────────
    void _fx_breathe(EngineLightGroup& g) {
        uint32_t period = _speedToPeriod(g.speed, 300, 20); // ticks per full cycle
        uint8_t phase = (uint8_t)((g._tick % period) * 255 / period);
        // Sine approximation: use quarter-wave lookup
        // phase 0=bottom(dim), 128=top(bright)
        // Simple formula: bri = (1 - cos(2π*phase/255)) / 2
        // Integer approx: bri = (255 - cos8(phase)) / 2  where cos8 gives 0-255
        // cos8 approximation using parabola
        uint8_t p2 = phase < 128 ? phase * 2 : (255 - phase) * 2;
        // p2 goes 0→255→0 over the cycle (triangle wave)
        // Smooth it: bri8 = p2^2 / 255
        uint8_t bri8 = (uint8_t)(((uint16_t)p2 * p2) >> 8);
        uint8_t scaledBri = (uint8_t)(((uint16_t)bri8 * g.brightness) / 100);
        uint32_t c = applyBri(g.colorPrimary, scaledBri);
        for (uint8_t i = 0; i < g.ledCount; i++) _setGroupLed(g, i, c);
    }

    // ── Fade (cross-fade between colorPrimary and colorSecond) ───────────────
    void _fx_fade(EngineLightGroup& g) {
        uint32_t period = _speedToPeriod(g.speed, 300, 20);
        uint8_t phase = (uint8_t)((g._tick % period) * 255 / period);
        uint8_t t = phase < 128 ? phase * 2 : (255 - phase) * 2;
        uint32_t c = applyBri(blendColor(g.colorPrimary, g.colorSecond, t), g.brightness);
        for (uint8_t i = 0; i < g.ledCount; i++) _setGroupLed(g, i, c);
    }

    // ── Twinkle (random LEDs fade in and out independently) ───────────────────
    void _fx_twinkle(EngineLightGroup& g) {
        uint8_t fadeRate = 8 + (g.speed >> 3); // faster speed = faster fade
        for (uint8_t i = 0; i < g.ledCount; i++) {
            uint8_t& phase = g._twinkle[i];
            // Randomly trigger a new twinkle
            if (phase == 0 && (_rnd8(g._tick * 31 + i * 7) < 12)) {
                phase = 255;
            }
            if (phase > 0) {
                uint8_t bri8 = phase;
                uint8_t scaledBri = (uint8_t)(((uint16_t)bri8 * g.brightness) / 100);
                _setGroupLed(g, i, applyBri(g.colorPrimary, scaledBri));
                phase = (phase > fadeRate) ? phase - fadeRate : 0;
            } else {
                _setGroupLed(g, i, 0);
            }
        }
    }

    // ── Sparkle / Flash Sparkle ───────────────────────────────────────────────
    // Sparkle: random single LED flashes bright then fades
    // Flash Sparkle: same but with solid colorPrimary as base
    void _fx_sparkle(EngineLightGroup& g, bool flashBase) {
        uint32_t base = flashBase ? applyBri(g.colorPrimary, g.brightness) : 0;
        for (uint8_t i = 0; i < g.ledCount; i++) _setGroupLed(g, i, base);
        // Pick a random LED to sparkle this frame
        uint8_t sparkIdx = _rnd8(g._tick * 13 + 7) % g.ledCount;
        uint32_t period  = _speedToPeriod(g.speed, 40, 3);
        if ((g._tick % period) == 0) {
            _setGroupLed(g, sparkIdx, applyBri(0xFFFFFF, g.brightness));
        }
    }

    // ── Glitter (random bright white flashes over a base solid) ───────────────
    void _fx_glitter(EngineLightGroup& g) {
        // Base: solid colorPrimary
        uint32_t base = applyBri(g.colorPrimary, g.brightness);
        for (uint8_t i = 0; i < g.ledCount; i++) _setGroupLed(g, i, base);
        // Add glitter: density ~speed/32 sparkles per frame
        uint8_t density = 1 + (g.speed >> 5);
        for (uint8_t d = 0; d < density; d++) {
            uint8_t idx = _rnd8(g._tick * 17 + d * 11) % g.ledCount;
            _setGroupLed(g, idx, 0xFFFFFF); // full white glitter
        }
    }

    // ── Running Lights (sine wave sweeping across LEDs) ───────────────────────
    void _fx_running(EngineLightGroup& g) {
        uint32_t period = _speedToPeriod(g.speed, 200, 10);
        uint8_t offset = (uint8_t)((g._tick % period) * 255 / period);
        for (uint8_t i = 0; i < g.ledCount; i++) {
            // Phase per LED: spread 255 across all LEDs
            uint8_t phase = offset + (i * 255 / max((uint8_t)1, g.ledCount));
            // Sine brightness: 0-255 mapped to 0-bri
            uint8_t p2 = phase < 128 ? phase * 2 : (255 - phase) * 2;
            uint8_t bri8 = (uint8_t)(((uint16_t)p2 * p2) >> 8);
            uint8_t scaledBri = (uint8_t)(((uint16_t)bri8 * g.brightness) / 100);
            _setGroupLed(g, i, applyBri(g.colorPrimary, scaledBri));
        }
    }

    // ── Larson Scanner (KITT — bouncing point with decay trail) ───────────────
    void _fx_larson(EngineLightGroup& g) {
        uint32_t period = _speedToPeriod(g.speed, 60, 4); // ticks to traverse one LED
        if ((g._tick % period) == 0) {
            g._pos += g._dir;
            if (g._pos >= g.ledCount - 1) { g._pos = g.ledCount - 1; g._dir = -1; }
            if (g._pos <= 0)              { g._pos = 0;               g._dir =  1; }
        }
        // Draw decay: center full, neighbors at 50%, outer at 20%
        // First clear group
        for (uint8_t i = 0; i < g.ledCount; i++) _setGroupLed(g, i, 0);
        uint32_t c = applyBri(g.colorPrimary, g.brightness);
        _setGroupLed(g, g._pos, c);
        if (g._pos > 0)
            _setGroupLed(g, g._pos - 1, applyBri(g.colorPrimary, g.brightness / 2));
        if (g._pos < g.ledCount - 1)
            _setGroupLed(g, g._pos + 1, applyBri(g.colorPrimary, g.brightness / 2));
        if (g._pos > 1)
            _setGroupLed(g, g._pos - 2, applyBri(g.colorPrimary, g.brightness / 5));
        if (g._pos < g.ledCount - 2)
            _setGroupLed(g, g._pos + 2, applyBri(g.colorPrimary, g.brightness / 5));
    }

    // ── Flicker (random irregular brightness — flame / damaged light) ──────────
    void _fx_flicker(EngineLightGroup& g) {
        for (uint8_t i = 0; i < g.ledCount; i++) {
            // Random brightness per LED per frame, weighted toward high
            uint8_t rnd = _rnd8(g._tick * 29 + i * 13);
            // Bias: mostly bright with occasional dips
            uint8_t flickBri;
            if (rnd < 30) {
                flickBri = 30 + (rnd * 2); // occasional deep dip
            } else {
                flickBri = 180 + (rnd >> 2); // mostly bright
            }
            uint8_t scaledBri = (uint8_t)(((uint16_t)flickBri * g.brightness) / 255);
            _setGroupLed(g, i, applyBri(g.colorPrimary, scaledBri));
        }
    }

    // ── Heartbeat (double-pulse pattern) ──────────────────────────────────────
    // Pattern: quick beat, quick beat, long pause — ~BPM controlled by speed
    void _fx_heartbeat(EngineLightGroup& g) {
        // Heartbeat sequence in ticks at 50Hz:
        // speed 128 => total cycle ~100 ticks (2 seconds)
        uint32_t cycle = _speedToPeriod(g.speed, 200, 30);
        uint32_t t = g._tick % cycle;

        uint8_t bri8 = 0;
        uint32_t beat1End   = cycle / 10;      // first beat
        uint32_t beat1Decay = cycle / 7;
        uint32_t beat2Start = cycle / 5;       // second beat
        uint32_t beat2End   = beat2Start + beat1End;
        uint32_t beat2Decay = beat2Start + beat1Decay;

        if (t < beat1End) {
            bri8 = 255;
        } else if (t < beat1Decay) {
            bri8 = 255 - (uint8_t)((t - beat1End) * 255 / (beat1Decay - beat1End));
        } else if (t >= beat2Start && t < beat2End) {
            bri8 = 200;
        } else if (t >= beat2End && t < beat2Decay) {
            bri8 = 200 - (uint8_t)((t - beat2End) * 200 / (beat2Decay - beat2End));
        }

        uint8_t scaledBri = (uint8_t)(((uint16_t)bri8 * g.brightness) / 255);
        uint32_t c = applyBri(g.colorPrimary, scaledBri);
        for (uint8_t i = 0; i < g.ledCount; i++) _setGroupLed(g, i, c);
    }

    // ── Alternate (two halves swap between colorPrimary and colorSecond) ───────
    // Classic police light bar / blinker alternation
    void _fx_alternate(EngineLightGroup& g) {
        uint32_t halfPeriod = _speedToPeriod(g.speed, 100, 3);
        bool phase = (g._tick / halfPeriod) & 1;
        uint8_t half = g.ledCount / 2;
        uint32_t cA = applyBri(phase ? g.colorSecond  : g.colorPrimary, g.brightness);
        uint32_t cB = applyBri(phase ? g.colorPrimary : g.colorSecond,  g.brightness);
        for (uint8_t i = 0; i < half; i++)              _setGroupLed(g, i, cA);
        for (uint8_t i = half; i < g.ledCount; i++)     _setGroupLed(g, i, cB);
    }
};
