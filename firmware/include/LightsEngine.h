#ifndef LIGHTS_ENGINE_H
#define LIGHTS_ENGINE_H

#include <Adafruit_NeoPixel.h>
#include "Config.h"

class LightsEngine {
private:
    Adafruit_NeoPixel *strip;
    uint16_t ledCount;
    NewLightsConfig lightsConfig;
    
    // Pattern animation state
    struct PatternState {
        uint8_t intensity;
        uint8_t direction; // 0 = increasing, 1 = decreasing
        uint16_t position;
        unsigned long lastUpdate;
        // Flicker-specific state (for candle mode)
        uint8_t flickerTarget;
        uint8_t flickerStep;
        uint8_t flashCount; // For multi-strobe/double flash
    } patternState[10]; // One state per group

    // Fast 16-bit sine approximation (adapted from WLED/FastLED)
    int16_t sin16(uint16_t theta) {
        static const uint16_t base[] = {0, 6393, 12539, 18204, 23170, 27245, 30273, 32137};
        static const uint8_t slope[] = {49, 48, 44, 38, 31, 23, 14, 4};
        
        uint16_t offset = (theta & 0x3FFF) >> 3; // 0..8191
        if (theta & 0x4000) offset = 2047 - offset; // Reflect for second quadrant
        
        uint8_t section = offset / 256; // 0..7
        uint8_t b = offset & 0xFF;     // Position within section
        
        uint16_t value = base[section];
        value += (slope[section] * b) >> 1;
        
        if (theta & 0x8000) value = -value; // Negate for lower half
        return value;
    }

    uint8_t pseudoRandom8(uint8_t groupIdx, uint16_t ledLocalIndex, unsigned long now) {
        uint32_t seed = (uint32_t)(groupIdx + 1) * 1103515245UL;
        seed ^= (uint32_t)(ledLocalIndex + 37) * 12345UL;
        seed ^= (now / 120UL) * 2654435761UL;
        return (uint8_t)(seed & 0xFF);
    }
    
    uint8_t random8() {
        static uint32_t seed = 0x12345678;
        seed = seed * 1103515245UL + 12345UL;
        return (seed >> 16) & 0xFF;
    }

    uint32_t colorLerp(uint32_t from, uint32_t to, uint8_t amount) {
        uint8_t fr = (from >> 16) & 0xFF;
        uint8_t fg = (from >> 8) & 0xFF;
        uint8_t fb = from & 0xFF;
        uint8_t tr = (to >> 16) & 0xFF;
        uint8_t tg = (to >> 8) & 0xFF;
        uint8_t tb = to & 0xFF;

        uint8_t r = fr + ((int16_t)(tr - fr) * amount) / 255;
        uint8_t g = fg + ((int16_t)(tg - fg) * amount) / 255;
        uint8_t b = fb + ((int16_t)(tb - fb) * amount) / 255;
        return ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
    }

    /**
     * Apply brightness scaling to a color (forward declaration needed by twinklePattern)
     */
    uint32_t applyBrightness(uint32_t color, uint8_t brightness) {
        if (brightness == 0 || color == 0) {
            return 0;
        }

        // Extract RGB components
        uint8_t r = (color >> 16) & 0xFF;
        uint8_t g = (color >> 8) & 0xFF;
        uint8_t b = color & 0xFF;

        // Scale by brightness (0-255)
        r = (r * brightness) / 255;
        g = (g * brightness) / 255;
        b = (b * brightness) / 255;

        // Recombine
        return (r << 16) | (g << 8) | b;
    }

    uint32_t wipePattern(uint8_t groupIdx, const ExtendedLightGroup& group, uint8_t ledLocalIndex, unsigned long now) {
        PatternState& state = patternState[groupIdx];
        uint16_t speed = group.blinkRate > 0 ? group.blinkRate : 250;
        uint16_t period = group.ledCount > 0 ? group.ledCount : 1;

        if (now - state.lastUpdate >= speed / 3) {
            state.position = (state.position + 1) % period;
            state.lastUpdate = now;
        }

        if (ledLocalIndex <= state.position) {
            return group.color;
        }
        return group.color2;
    }

    uint32_t chasePattern(uint8_t groupIdx, const ExtendedLightGroup& group, uint8_t ledLocalIndex, unsigned long now) {
        PatternState& state = patternState[groupIdx];
        uint16_t speed = group.blinkRate > 0 ? group.blinkRate : 180;

        if (now - state.lastUpdate >= speed / 2) {
            state.position = (state.position + 1) % 6;
            state.lastUpdate = now;
        }

        uint8_t phase = (uint8_t)((ledLocalIndex + state.position) % 6);
        if (phase < 2) {
            return group.color;
        }
        return group.color2;
    }

    /**
     * WLED-inspired Candle Flicker pattern - realistic candlelight effect
     */
    uint32_t twinklePattern(uint8_t groupIdx, const ExtendedLightGroup& group, uint8_t ledLocalIndex, unsigned long now) {
        PatternState& state = patternState[groupIdx];
        
        // Per-LED independent flicker (use led index as seed modifier)
        uint8_t ledSeed = ledLocalIndex * 37;
        uint32_t ledNow = now + (ledSeed * 100);
        
        // Update flicker state every 40ms
        if (ledNow - state.lastUpdate >= 40) {
            if (state.flickerStep == 0) {
                // Initialize flicker target
                state.intensity = 128;
                state.flickerTarget = 130 + (random8() & 0x03);
                state.flickerStep = 1;
            }
            
            // Converge toward target brightness
            if (state.intensity < state.flickerTarget) {
                state.intensity++;
            } else if (state.intensity > state.flickerTarget) {
                state.intensity--;
            }
            
            // Reached target? Set new target
            if (state.intensity == state.flickerTarget) {
                uint8_t rnd = random8();
                if (rnd < 10) { // 4% chance to jump to new target
                    uint8_t newTarget = 60 + (random8() % 195); // 60-254
                    state.flickerTarget = newTarget;
                    uint8_t diff = (state.flickerTarget > state.intensity) ? 
                                   state.flickerTarget - state.intensity : 
                                   state.intensity - state.flickerTarget;
                    state.flickerStep = diff >> 2; // Damped movement speed
                    if (state.flickerStep == 0) state.flickerStep = 1;
                }
            }
            
            state.lastUpdate = ledNow;
        }
        
        // Apply brightness variation to base color
        return applyBrightness(group.color, state.intensity);
    }

    uint32_t dualBreathePattern(uint8_t groupIdx, const ExtendedLightGroup& group, unsigned long now) {
        PatternState& state = patternState[groupIdx];
        uint16_t computedStep = group.blinkRate > 0 ? (uint16_t)(group.blinkRate / 24) : 35;
        uint16_t stepDuration = computedStep < 20 ? 20 : computedStep;

        if (now - state.lastUpdate >= stepDuration) {
            if (state.direction == 0) {
                uint16_t boosted = (uint16_t)state.intensity + 8;
                state.intensity = boosted > 255 ? 255 : (uint8_t)boosted;
                if (state.intensity >= 255) {
                    state.direction = 1;
                }
            } else {
                state.intensity = (state.intensity > 8) ? (state.intensity - 8) : 0;
                if (state.intensity <= 12) {
                    state.direction = 0;
                }
            }
            state.lastUpdate = now;
        }

        return colorLerp(group.color2, group.color, state.intensity);
    }

public:
    LightsEngine(uint16_t pin, uint16_t count) : ledCount(count) {
        strip = new Adafruit_NeoPixel(count, pin, NEO_GRB + NEO_KHZ800);
        strip->begin();
        strip->show();
        
        // Initialize pattern states
        for (int i = 0; i < 10; i++) {
            patternState[i].intensity = 255;
            patternState[i].direction = 1;
            patternState[i].position = 0;
            patternState[i].lastUpdate = 0;
            patternState[i].flickerTarget = 128;
            patternState[i].flickerStep = 0;
            patternState[i].flashCount = 0;
        }
    }

    ~LightsEngine() {
        if (strip) {
            delete strip;
        }
    }

    /**
     * Update lights configuration from JSON-like payload
     */
    void updateFromPayload(const NewLightsConfig& config) {
        lightsConfig = config;
        Serial.printf("[LightsEngine] Updated config: %d dynamic groups, legacy mode: %d\n", 
                      lightsConfig.groupCount, lightsConfig.useLegacyMode);
    }

    /**
     * Main update loop - call this frequently (e.g., every 50ms)
     */
    void update() {
        unsigned long now = millis();
        
        // Clear all LEDs first
        strip->clear();

        // Process each enabled group
        for (uint8_t groupIdx = 0; groupIdx < lightsConfig.groupCount; groupIdx++) {
            const ExtendedLightGroup& group = lightsConfig.groups[groupIdx];
            
            if (!group.enabled || group.ledCount == 0) {
                continue;
            }

            // Get the appropriate color and apply pattern
            for (uint8_t ledIdx = 0; ledIdx < group.ledCount; ledIdx++) {
                uint16_t pixelIndex = group.ledIndices[ledIdx];
                
                if (pixelIndex >= ledCount) {
                    continue; // Safety check
                }

                uint32_t color = applyPattern(groupIdx, group, ledIdx, now);
                uint32_t finalColor = applyBrightness(color, group.brightness);
                
                strip->setPixelColor(pixelIndex, finalColor);
            }
        }

        strip->show();
    }

    /**
     * Apply pattern effects (blink, pulse, etc.)
     */
    uint32_t applyPattern(uint8_t groupIdx, const ExtendedLightGroup& group, uint8_t ledLocalIndex, unsigned long now) {
        uint32_t baseColor = group.color;
        
        switch (group.mode) {
            case LIGHT_MODE_SOLID:
                // Solid color - no animation
                return baseColor;

            case LIGHT_MODE_BLINK:
                // Blink between primary and secondary color
                return blinkPattern(group, now);

            case LIGHT_MODE_PULSE:
                // Pulse/breathe effect
                return pulsePattern(groupIdx, group, now);

            case LIGHT_MODE_WIPE:
                return wipePattern(groupIdx, group, ledLocalIndex, now);

            case LIGHT_MODE_CHASE:
                return chasePattern(groupIdx, group, ledLocalIndex, now);

            case LIGHT_MODE_TWINKLE:
                return twinklePattern(groupIdx, group, ledLocalIndex, now);

            case LIGHT_MODE_DUAL_BREATHE:
                return dualBreathePattern(groupIdx, group, now);

            default:
                return 0; // Off
        }
    }

    /**
     * Blink pattern - alternates between color and color2
     * Supports multi-strobe (double flash) when blinkRate < 150ms
     */
    uint32_t blinkPattern(const ExtendedLightGroup& group, unsigned long now) {
        // Multi-strobe mode for "Double Flash" pattern (fast blink rate)
        if (group.blinkRate < 150) {
            // WLED-inspired multi-strobe: flash-flash-pause pattern
            uint32_t cyclePeriod = 1000; // 1 second full cycle
            uint32_t elapsedInCycle = now % cyclePeriod;
            
            uint32_t flashDuration = 80; // Each flash lasts 80ms
            uint32_t pauseBetweenFlashes = 100; // 100ms between flashes
            
            // First flash: 0-80ms
            if (elapsedInCycle < flashDuration) {
                return group.color;
            }
            // Pause: 80-180ms
            else if (elapsedInCycle < flashDuration + pauseBetweenFlashes) {
                return group.color2;
            }
            // Second flash: 180-260ms
            else if (elapsedInCycle < flashDuration * 2 + pauseBetweenFlashes) {
                return group.color;
            }
            // Long pause until cycle repeats
            else {
                return group.color2;
            }
        }
        
        // Normal blink mode
        uint32_t cyclePeriod = group.blinkRate * 2;
        uint32_t elapsedInCycle = now % cyclePeriod;
        
        if (elapsedInCycle < group.blinkRate) {
            return group.color;
        } else {
            return group.color2;
        }
    }

    /**
     * Pulse/breathe pattern - WLED-inspired smooth sine wave breathing
     */
    uint32_t pulsePattern(uint8_t groupIdx, const ExtendedLightGroup& group, unsigned long now) {
        // WLED breathe effect: smooth sine-based fade
        // For 2-second breathing cycle (0.5 Hz), counter must advance 16384 in 2000ms
        // Rate needed: 16384 / 2000ms = 8.192 per ms
        // Formula: (speed / 8) = rate, so speed = rate * 8 = 8.192 * 8 ≈ 16
        uint16_t speed = group.blinkRate > 0 ? ((group.blinkRate * 16) / 255) : 16;
        if (speed < 5) speed = 5;    // Minimum: very slow
        if (speed > 40) speed = 40;  // Maximum: reasonably fast
        
        // Calculate counter - advances at speed/8 per millisecond
        uint32_t counter = ((now * speed) >> 3) & 0x3FFF; // Divide by 8, keep in 0-16383 range
        
        // Calculate sine wave brightness (parabolic approximation)
        uint16_t var = 0;
        if (counter < 16384) {
            uint16_t workCounter = counter;
            if (workCounter > 8192) {
                workCounter = 8192 - (workCounter - 8192);
            }
            // Use sin16 for smooth curve, scaled to brightness range
            int16_t sineVal = sin16(workCounter * 4); // Multiply to use full sin16 range
            var = (sineVal + 32768) / 280; // Convert from [-32768,32767] to [~30,~230]
        }
        
        uint8_t lum = 30 + var; // Brightness oscillates between 30-253
        
        // Blend between secondary color (dim) and primary color (bright)
        return colorLerp(group.color2, group.color, lum);
    }

    /**
     * Turn off all LEDs
     */
    void clear() {
        strip->clear();
        strip->show();
        lightsConfig.groupCount = 0;
    }

    /**
     * Get reference to current config (for parsing)
     */
    NewLightsConfig* getConfigRef() {
        return &lightsConfig;
    }
};

#endif
