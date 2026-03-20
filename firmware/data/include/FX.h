#pragma once

#include <Arduino.h>

namespace RcdccFx {

constexpr uint8_t DEFAULT_SPEED = 128;
constexpr uint8_t DEFAULT_INTENSITY = 128;
constexpr uint8_t DEFAULT_CUSTOM1 = 128;
constexpr uint8_t DEFAULT_CUSTOM2 = 128;
constexpr uint8_t DEFAULT_CUSTOM3 = 16;

enum LightEffect : uint8_t {
  FX_SOLID = 0,
  FX_BLINK,
  FX_STROBE,
  FX_BREATHE,
  FX_FADE,
  FX_TWINKLE,
  FX_SPARKLE,
  FX_FLASH_SPARKLE,
  FX_GLITTER,
  FX_SOLID_GLITTER,
  FX_RUNNING,
  FX_LARSON,
  FX_HEARTBEAT,
  FX_FLICKER,
  FX_FIRE_FLICKER,
  FX_COUNT
};

struct FxRuntime {
  uint32_t tick = 0;
  uint32_t step = 0;
  uint32_t aux0 = 0;
  uint32_t aux1 = 0;
  uint32_t aux2 = 0;
  uint32_t seed = 0;
};

struct FxMetadata {
  const char* name;
  uint8_t defaultSpeed;
  uint8_t defaultIntensity;
  uint8_t defaultCustom1;
  uint8_t defaultCustom2;
  uint8_t defaultCustom3;
  bool defaultCheck1;
  bool defaultCheck2;
  bool defaultCheck3;
  const char* parameterSummary;
};

extern const char* const EFFECT_NAMES[FX_COUNT];

LightEffect effectFromString(const char* name);
const FxMetadata& metadataForEffect(LightEffect effect);

} // namespace RcdccFx