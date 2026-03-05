#ifndef LIGHTS_ENGINE_H
#define LIGHTS_ENGINE_H

#include <Adafruit_NeoPixel.h>
#include "Config.h"

class LightsEngine {
private:
    Adafruit_NeoPixel *strip;
    uint16_t ledCount;
    unsigned long lastPatternUpdate;
    NewLightsConfig lightsConfig;
    
    // Pattern animation state
    struct PatternState {
        uint8_t intensity;
        uint8_t direction; // 0 = increasing, 1 = decreasing
        unsigned long lastUpdate;
    } patternState[10]; // One state per group

public:
    LightsEngine(uint16_t pin, uint16_t count) : ledCount(count), lastPatternUpdate(0) {
        strip = new Adafruit_NeoPixel(count, pin, NEO_GRB + NEO_KHZ800);
        strip->begin();
        strip->show();
        
        // Initialize pattern states
        for (int i = 0; i < 10; i++) {
            patternState[i].intensity = 255;
            patternState[i].direction = 1;
            patternState[i].lastUpdate = 0;
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

                uint32_t color = applyPattern(groupIdx, group, now);
                uint32_t finalColor = applyBrightness(color, group.brightness);
                
                strip->setPixelColor(pixelIndex, finalColor);
            }
        }

        strip->show();
        lastPatternUpdate = now;
    }

    /**
     * Apply pattern effects (blink, pulse, etc.)
     */
    uint32_t applyPattern(uint8_t groupIdx, const ExtendedLightGroup& group, unsigned long now) {
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

            default:
                return 0; // Off
        }
    }

    /**
     * Blink pattern - alternates between color and color2
     */
    uint32_t blinkPattern(const ExtendedLightGroup& group, unsigned long now) {
        uint32_t cyclePeriod = group.blinkRate * 2; // On for blinkRate, off for blinkRate
        uint32_t elapsedInCycle = now % cyclePeriod;
        
        // First half = primary color, second half = secondary color
        if (elapsedInCycle < group.blinkRate) {
            return group.color;
        } else {
            return group.color2; // Will be black/off if color2 is 0x000000
        }
    }

    /**
     * Pulse/breathe pattern - fades in and out
     */
    uint32_t pulsePattern(uint8_t groupIdx, const ExtendedLightGroup& group, unsigned long now) {
        PatternState& state = patternState[groupIdx];
        unsigned long stepDuration = 50; // 50ms per step
        
        if (now - state.lastUpdate >= stepDuration) {
            // Update intensity
            if (state.direction == 0) {
                // Increasing
                state.intensity += 10;
                if (state.intensity >= 255) {
                    state.intensity = 255;
                    state.direction = 1; // Switch to decreasing
                }
            } else {
                // Decreasing
                state.intensity -= 10;
                if (state.intensity <= 50) {
                    state.intensity = 50;
                    state.direction = 0; // Switch to increasing
                }
            }
            state.lastUpdate = now;
        }

        return applyBrightness(group.color, state.intensity);
    }

    /**
     * Apply brightness scaling to a color
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
