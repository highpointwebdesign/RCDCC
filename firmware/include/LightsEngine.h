#ifndef LIGHTS_ENGINE_H
#define LIGHTS_ENGINE_H

#include <Adafruit_NeoPixel.h>
#include <algorithm>
#include <math.h>
#include <cstring>
#include "Config.h"

class LightsEngine {
private:
  Adafruit_NeoPixel *strip;
  uint16_t ledCount;
  LightingProfile currentProfile = {};
  uint8_t frameBuffer[300];  // RGB buffer: max 100 LEDs * 3 bytes
  volatile bool flashOverrideActive = false;

  // Effect animation state per group
  struct GroupState {
    uint16_t counter;
    uint8_t position;
    unsigned long lastUpdate;
  } groupStates[MAX_GROUPS_PER_PROFILE];

  // Pseudo-random number generator (deterministic, suitable for effects)
  uint8_t random8(uint16_t seed) {
    seed ^= (seed << 13);
    seed ^= (seed >> 7);
    seed ^= (seed << 17);
    return (uint8_t)(seed & 0xFF);
  }

  // CRGB color (8-bit per channel)
  struct CRGB {
    uint8_t r, g, b;
    CRGB() : r(0), g(0), b(0) {}
    CRGB(uint8_t _r, uint8_t _g, uint8_t _b) : r(_r), g(_g), b(_b) {}
    CRGB(const char* hexStr) {
      // Parse hex color #RRGGBB
      if (hexStr && hexStr[0] == '#' && strlen(hexStr) >= 7) {
        r = strtol(hexStr + 1, nullptr, 16) >> 16 & 0xFF;
        g = (strtol(hexStr + 1, nullptr, 16) >> 8) & 0xFF;
        b = strtol(hexStr + 1, nullptr, 16) & 0xFF;
      } else {
        r = g = b = 0;
      }
    }
  };

  // Apply brightness scaling to a color
  CRGB applyBrightness(CRGB color, uint8_t brightness) {
    color.r = (uint32_t)color.r * brightness / 100;
    color.g = (uint32_t)color.g * brightness / 100;
    color.b = (uint32_t)color.b * brightness / 100;
    return color;
  }

  // Linear interpolation between two colors
  CRGB colorLerp(CRGB a, CRGB b, uint8_t frac) {
    return CRGB(
      a.r + ((b.r - a.r) * frac) / 255,
      a.g + ((b.g - a.g) * frac) / 255,
      a.b + ((b.b - a.b) * frac) / 255
    );
  }

  // Sine-wave lookup table (0-255)
  uint8_t sin8(uint8_t x) {
    if (x == 0) return 0;
    if (x == 85) return 255;
    if (x == 170) return 255;
    if (x == 255) return 0;
    // Simple sine approximation
    float rad = (x / 255.0f) * 3.14159f * 2.0f;
    return (uint8_t)((sin(rad) + 1.0f) * 127.5f);
  }

  // === EFFECT IMPLEMENTATIONS (14 effects) ===

  // 1. SOLID: All LEDs in group set to color_primary at brightness
  void effectSolid(const LightingGroup& group, uint8_t groupIdx) {
    CRGB primary(group.colorPrimary);
    primary = applyBrightness(primary, group.brightness);
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led < ledCount) {
        frameBuffer[led * 3 + 0] = primary.r;
        frameBuffer[led * 3 + 1] = primary.g;
        frameBuffer[led * 3 + 2] = primary.b;
      }
    }
  }

  // 2. BLINK: Alternate between primary and secondary at effect_speed
  void effectBlink(const LightingGroup& group, uint8_t groupIdx) {
    uint16_t period = std::max<uint16_t>(100, static_cast<uint16_t>(group.effectSpeed) * 2);
    uint32_t elapsed = millis() % period;
    CRGB color = (elapsed < period / 2) ? CRGB(group.colorPrimary) : CRGB(group.colorSecondary);
    color = applyBrightness(color, group.brightness);
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led < ledCount) {
        frameBuffer[led * 3 + 0] = color.r;
        frameBuffer[led * 3 + 1] = color.g;
        frameBuffer[led * 3 + 2] = color.b;
      }
    }
  }

  // 3. STROBE: Rapid on/off flash at very high speed
  void effectStrobe(const LightingGroup& group, uint8_t groupIdx) {
    uint16_t period = std::max<uint16_t>(20, static_cast<uint16_t>(200 - (group.effectSpeed * 2)));  // 20-200ms period
    uint32_t elapsed = millis() % period;
    bool on = (elapsed < period / 8);  // Flash 1/8 of period
    CRGB color = on ? CRGB(group.colorPrimary) : CRGB(0, 0, 0);
    color = applyBrightness(color, group.brightness);
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led < ledCount) {
        frameBuffer[led * 3 + 0] = color.r;
        frameBuffer[led * 3 + 1] = color.g;
        frameBuffer[led * 3 + 2] = color.b;
      }
    }
  }

  // 4. BREATHE: Sine-wave brightness pulse at effect_speed
  void effectBreathe(const LightingGroup& group, uint8_t groupIdx) {
    uint16_t period = std::max<uint16_t>(500, static_cast<uint16_t>(1000 - (group.effectSpeed * 5)));
    uint32_t elapsed = millis() % period;
    uint8_t phase = (elapsed * 255) / period;
    uint8_t brightness = 50 + (sin8(phase) * group.brightness) / 510;  // 50-100%
    CRGB color(group.colorPrimary);
    color = applyBrightness(color, brightness);
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led < ledCount) {
        frameBuffer[led * 3 + 0] = color.r;
        frameBuffer[led * 3 + 1] = color.g;
        frameBuffer[led * 3 + 2] = color.b;
      }
    }
  }

  // 5. FADE: Linear transition between primary and secondary
  void effectFade(const LightingGroup& group, uint8_t groupIdx) {
    uint16_t period = std::max<uint16_t>(500, static_cast<uint16_t>(2000 - (group.effectSpeed * 10)));
    uint32_t elapsed = millis() % period;
    uint8_t frac = (elapsed * 255) / period;
    CRGB primary(group.colorPrimary);
    CRGB secondary(group.colorSecondary);
    CRGB color = (frac < 128) 
      ? colorLerp(primary, secondary, frac * 2)  // Primary to secondary
      : colorLerp(secondary, primary, (frac - 128) * 2);  // Back to primary
    color = applyBrightness(color, group.brightness);
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led < ledCount) {
        frameBuffer[led * 3 + 0] = color.r;
        frameBuffer[led * 3 + 1] = color.g;
        frameBuffer[led * 3 + 2] = color.b;
      }
    }
  }

  // 6. TWINKLE: Random individual LEDs fade in/out (WLED Twinkle adapted)
  void effectTwinkle(const LightingGroup& group, uint8_t groupIdx) {
    CRGB primary(group.colorPrimary);
    CRGB secondary(group.colorSecondary);
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led >= ledCount) continue;
      uint8_t noise = random8((j + groupIdx) * 123 + (millis() / 10));
      CRGB color;
      if (noise > 220) {
        color = CRGB(255, 255, 255);  // White twinkle
      } else if (noise > 180) {
        color = primary;
      } else {
        color = secondary;
      }
      color = applyBrightness(color, group.brightness);
      frameBuffer[led * 3 + 0] = color.r;
      frameBuffer[led * 3 + 1] = color.g;
      frameBuffer[led * 3 + 2] = color.b;
    }
  }

  // 7. SPARKLE: Random LED flashes to full brightness then fades
  void effectSparkle(const LightingGroup& group, uint8_t groupIdx) {
    CRGB primary(group.colorPrimary);
    uint8_t sparkleCount = static_cast<uint8_t>(std::max<int>(1, (group.effectIntensity * group.ledCount) / 300));
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led >= ledCount) continue;
      uint8_t noise = random8((j + groupIdx) * 201 + (millis() / 20));
      CRGB color = (noise < sparkleCount * 5) ? CRGB(255, 255, 255) : primary;
      color = applyBrightness(color, group.brightness);
      frameBuffer[led * 3 + 0] = color.r;
      frameBuffer[led * 3 + 1] = color.g;
      frameBuffer[led * 3 + 2] = color.b;
    }
  }

  // 8. FLASH_SPARKLE: Sparkle layered over solid color base
  void effectFlashSparkle(const LightingGroup& group, uint8_t groupIdx) {
    CRGB primary(group.colorPrimary);
    CRGB secondary(group.colorSecondary);
    uint8_t sparkleCount = static_cast<uint8_t>(std::max<int>(1, (group.effectIntensity * group.ledCount) / 300));
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led >= ledCount) continue;
      uint8_t noise = random8((j + groupIdx) * 307 + (millis() / 25));
      CRGB color = (noise < sparkleCount * 5) ? CRGB(255, 255, 255) : primary;
      color = applyBrightness(color, group.brightness);
      frameBuffer[led * 3 + 0] = color.r;
      frameBuffer[led * 3 + 1] = color.g;
      frameBuffer[led * 3 + 2] = color.b;
    }
  }

  // 9. GLITTER: Random bright white flashes (WLED Glitter adapted)
  void effectGlitter(const LightingGroup& group, uint8_t groupIdx) {
    CRGB primary(group.colorPrimary);
    uint8_t glitterDensity = (group.effectIntensity * 255) / 100;
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led >= ledCount) continue;
      uint8_t noise = random8((j + groupIdx) * 311 + (millis() / 30));
      CRGB color = (noise < glitterDensity / 8) ? CRGB(255, 255, 255) : primary;
      color = applyBrightness(color, group.brightness);
      frameBuffer[led * 3 + 0] = color.r;
      frameBuffer[led * 3 + 1] = color.g;
      frameBuffer[led * 3 + 2] = color.b;
    }
  }

  // 10. RUNNING: Sine wave sweeping across LED positions (WLED Running Lights adapted)
  void effectRunning(const LightingGroup& group, uint8_t groupIdx) {
    CRGB primary(group.colorPrimary);
    uint16_t period = std::max<uint16_t>(500, static_cast<uint16_t>(2000 - (group.effectSpeed * 10)));
    uint32_t elapsed = millis() % period;
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led >= ledCount) continue;
      uint8_t phase = ((j * 256 / group.ledCount) + (elapsed * 256 / period)) & 0xFF;
      uint8_t brightness = 50 + (sin8(phase) * group.brightness) / 510;
      CRGB color = primary;
      color = applyBrightness(color, brightness);
      frameBuffer[led * 3 + 0] = color.r;
      frameBuffer[led * 3 + 1] = color.g;
      frameBuffer[led * 3 + 2] = color.b;
    }
  }

  // 11. LARSON: Bouncing bright point with decay trail (KITT scanner, WLED Larson adapted)
  void effectLarson(const LightingGroup& group, uint8_t groupIdx) {
    if (group.ledCount == 0) return;
    CRGB primary(group.colorPrimary);
    uint16_t period = std::max<uint16_t>(500, static_cast<uint16_t>(2000 - (group.effectSpeed * 10)));
    uint32_t elapsed = millis() % period;
    uint8_t cycle = (elapsed * group.ledCount * 2) / period;
    uint8_t bouncePos = (cycle < group.ledCount) ? cycle : (group.ledCount * 2 - 1 - cycle);

    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led >= ledCount) continue;
      int distance = abs((int)j - (int)bouncePos);
      uint8_t brightness = static_cast<uint8_t>((distance == 0) ? 100 : std::max<int>(10, 100 - distance * 20));
      CRGB color = primary;
      color = applyBrightness(color, (brightness * group.brightness) / 100);
      frameBuffer[led * 3 + 0] = color.r;
      frameBuffer[led * 3 + 1] = color.g;
      frameBuffer[led * 3 + 2] = color.b;
    }
  }

  // 12. FLICKER: Random brightness variation simulating flame (WLED Fire Flicker adapted)
  void effectFlicker(const LightingGroup& group, uint8_t groupIdx) {
    CRGB primary(group.colorPrimary);
    uint8_t flickerIntensity = (group.effectIntensity * 100) / 100;
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led >= ledCount) continue;
      uint8_t noise = random8((j + groupIdx) * 401 + (millis() / 40));
      uint8_t brightness = 70 + ((noise * flickerIntensity) / 256);
      brightness = constrain(brightness, 50, 100);
      CRGB color = primary;
      color = applyBrightness(color, brightness);
      frameBuffer[led * 3 + 0] = color.r;
      frameBuffer[led * 3 + 1] = color.g;
      frameBuffer[led * 3 + 2] = color.b;
    }
  }

  // 13. HEARTBEAT: Double-pulse rhythmic pattern
  void effectHeartbeat(const LightingGroup& group, uint8_t groupIdx) {
    CRGB primary(group.colorPrimary);
    uint16_t period = std::max<uint16_t>(600, static_cast<uint16_t>(1500 - (group.effectSpeed * 5)));
    uint32_t elapsed = millis() % period;
    uint8_t brightness = 20;  // Base dim
    
    // First pulse: 0-100ms
    if (elapsed < 100) brightness = 20 + (elapsed * 80) / 100;
    // Slight dip: 100-150ms
    else if (elapsed < 150) brightness = 100 - ((elapsed - 100) * 60) / 50;
    // Second pulse: 150-250ms
    else if (elapsed < 250) brightness = 40 + ((elapsed - 150) * 60) / 100;
    // Back to base: 250+ms
    else brightness = 20;

    CRGB color = primary;
    color = applyBrightness(color, (brightness * group.brightness) / 100);
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led < ledCount) {
        frameBuffer[led * 3 + 0] = color.r;
        frameBuffer[led * 3 + 1] = color.g;
        frameBuffer[led * 3 + 2] = color.b;
      }
    }
  }

  // 14. ALTERNATE: Two halves of LED list swap colors
  void effectAlternate(const LightingGroup& group, uint8_t groupIdx) {
    CRGB primary(group.colorPrimary);
    CRGB secondary(group.colorSecondary);
    uint16_t period = std::max<uint16_t>(300, static_cast<uint16_t>(1000 - (group.effectSpeed * 5)));
    uint32_t elapsed = millis() % period;
    bool primaryFirst = (elapsed < period / 2);

    uint16_t halfway = group.ledCount / 2;
    for (int j = 0; j < group.ledCount; j++) {
      uint16_t led = group.leds[j];
      if (led >= ledCount) continue;
      bool isFirstHalf = (j < halfway);
      CRGB color = (isFirstHalf == primaryFirst) ? primary : secondary;
      color = applyBrightness(color, group.brightness);
      frameBuffer[led * 3 + 0] = color.r;
      frameBuffer[led * 3 + 1] = color.g;
      frameBuffer[led * 3 + 2] = color.b;
    }
  }

public:
  LightsEngine(uint16_t pin, uint16_t count) : ledCount(count) {
    strip = new Adafruit_NeoPixel(count, pin, NEO_GRB + NEO_KHZ800);
    strip->begin();
    strip->show();
    memset(frameBuffer, 0, sizeof(frameBuffer));
    memset(groupStates, 0, sizeof(groupStates));
  }

  ~LightsEngine() {
    if (strip) {
      delete strip;
    }
  }

  // Load current lighting profile
  void loadProfile(const LightingProfile& profile) {
    currentProfile = profile;
    Serial.printf("[LightsEngine] Loaded profile: %s (%d groups)\n", 
                  profile.name, profile.groupCount);
  }

  // Backward compatibility for pre-Phase 5 callsites.
  // Converts dynamic NewLightsConfig groups into Phase 5 LightingProfile format.
  void updateFromPayload(const NewLightsConfig& config) {
    auto rgbToHex = [](uint32_t rgb, char out[8]) {
      snprintf(out, 8, "#%06X", rgb & 0xFFFFFF);
    };
    auto modeToEffect = [](uint8_t mode) -> const char* {
      switch (mode) {
        case LIGHT_MODE_BLINK: return EFFECT_BLINK;
        case LIGHT_MODE_PULSE: return EFFECT_BREATHE;
        case LIGHT_MODE_WIPE:  return EFFECT_RUNNING;
        case LIGHT_MODE_CHASE: return EFFECT_RUNNING;
        case LIGHT_MODE_TWINKLE: return EFFECT_TWINKLE;
        case LIGHT_MODE_DUAL_BREATHE: return EFFECT_FADE;
        case LIGHT_MODE_SOLID:
        default: return EFFECT_SOLID;
      }
    };

    LightingProfile p = {};
    strncpy(p.name, "Runtime", sizeof(p.name) - 1);
    p.master = true;
    p.totalLeds = ledCount;
    p.groupCount = (config.groupCount > MAX_GROUPS_PER_PROFILE) ? MAX_GROUPS_PER_PROFILE : config.groupCount;
    for (uint8_t i = 0; i < p.groupCount; i++) {
      const ExtendedLightGroup& src = config.groups[i];
      LightingGroup& dst = p.groups[i];
      dst.id = i;
      strncpy(dst.name, src.name, sizeof(dst.name) - 1);
      dst.enabled = src.enabled;
      String pattern = String(src.pattern);
      pattern.trim();
      pattern.toLowerCase();
      const char* effectName = pattern.length() ? pattern.c_str() : modeToEffect(src.mode);
      strncpy(dst.effect, effectName, sizeof(dst.effect) - 1);
      rgbToHex(src.color, dst.colorPrimary);
      rgbToHex(src.color2, dst.colorSecondary);
      dst.brightness = (src.brightness > 100) ? 100 : src.brightness;
      dst.effectSpeed = static_cast<uint8_t>(std::min<int>(100, std::max<int>(0, src.blinkRate / 10)));
      dst.effectIntensity = 100;
      dst.ledCount = (src.ledCount > MAX_GROUP_LEDS) ? MAX_GROUP_LEDS : src.ledCount;
      for (uint16_t j = 0; j < dst.ledCount; j++) {
        dst.leds[j] = src.ledIndices[j];
      }
    }
    loadProfile(p);
  }

  // Main update loop — call frequently (e.g., every 50ms)
  void update() {
    if (flashOverrideActive) {
      return;
    }

    if (!currentProfile.master) {
      strip->clear();
      strip->show();
      return;
    }

    // Clear frame buffer
    memset(frameBuffer, 0, sizeof(frameBuffer));

    // Process each group (effects only write their own LED indices)
    for (int i = 0; i < currentProfile.groupCount; i++) {
      const LightingGroup& group = currentProfile.groups[i];
      if (!group.enabled || group.ledCount == 0) continue;

      // Dispatch to appropriate effect handler
      String effect = group.effect;
      if (effect == EFFECT_SOLID) effectSolid(group, i);
      else if (effect == EFFECT_BLINK) effectBlink(group, i);
      else if (effect == EFFECT_STROBE) effectStrobe(group, i);
      else if (effect == EFFECT_BREATHE) effectBreathe(group, i);
      else if (effect == EFFECT_FADE) effectFade(group, i);
      else if (effect == EFFECT_TWINKLE) effectTwinkle(group, i);
      else if (effect == EFFECT_SPARKLE) effectSparkle(group, i);
      else if (effect == EFFECT_FLASH_SPARKLE) effectFlashSparkle(group, i);
      else if (effect == EFFECT_GLITTER) effectGlitter(group, i);
      else if (effect == EFFECT_RUNNING) effectRunning(group, i);
      else if (effect == EFFECT_LARSON) effectLarson(group, i);
      else if (effect == EFFECT_FLICKER) effectFlicker(group, i);
      else if (effect == EFFECT_HEARTBEAT) effectHeartbeat(group, i);
      else if (effect == EFFECT_ALTERNATE) effectAlternate(group, i);
      else effectSolid(group, i);  // Default to solid
    }

    // Push frame buffer to LED strip
    for (int i = 0; i < ledCount && i * 3 + 2 < (int)sizeof(frameBuffer); i++) {
      strip->setPixelColor(i, frameBuffer[i * 3], frameBuffer[i * 3 + 1], frameBuffer[i * 3 + 2]);
    }
    strip->show();
  }

  // Turn off all LEDs
  void clear() {
    strip->clear();
    strip->show();
    memset(frameBuffer, 0, sizeof(frameBuffer));
    currentProfile.groupCount = 0;
  }

  // Temporary full-strip flash override used by truck-switch confirmation.
  // This does not mutate the active lighting profile.
  void flashAllBlocking(uint32_t rgbColor, uint8_t count, uint16_t onMs = 200, uint16_t offMs = 200, volatile bool* cancelFlag = nullptr) {
    if (count == 0) return;
    flashOverrideActive = true;

    uint8_t r = (rgbColor >> 16) & 0xFF;
    uint8_t g = (rgbColor >> 8) & 0xFF;
    uint8_t b = rgbColor & 0xFF;

    for (uint8_t i = 0; i < count; i++) {
      if (cancelFlag && *cancelFlag) break;
      for (uint16_t led = 0; led < ledCount; led++) {
        strip->setPixelColor(led, r, g, b);
      }
      strip->show();
      for (uint16_t t = 0; t < onMs; t += 10) {
        if (cancelFlag && *cancelFlag) break;
        delay(10);
      }
      if (cancelFlag && *cancelFlag) break;

      strip->clear();
      strip->show();
      if (i + 1 < count) {
        for (uint16_t t = 0; t < offMs; t += 10) {
          if (cancelFlag && *cancelFlag) break;
          delay(10);
        }
      }
    }

    flashOverrideActive = false;
  }

  // Get reference to current profile
  LightingProfile* getProfile() {
    return &currentProfile;
  }
};

#endif
