#include <Arduino.h>
#include <math.h>

#include "FX.h"
#include "LightsEngine.h"

namespace {

using namespace RcdccFx;

constexpr float TWO_PI_F = 6.28318530717958647692f;

static inline uint8_t clamp8(int value) {
  return static_cast<uint8_t>(constrain(value, 0, 255));
}

static inline uint8_t scale8(uint8_t value, uint8_t scale) {
  return static_cast<uint8_t>((static_cast<uint16_t>(value) * scale) >> 8);
}

static inline uint8_t triwave8(uint8_t in) {
  return (in & 0x80U) ? static_cast<uint8_t>(255U - ((in & 0x7FU) << 1U)) : static_cast<uint8_t>((in & 0x7FU) << 1U);
}

static inline uint16_t triwave16(uint16_t in) {
  return (in & 0x8000U) ? static_cast<uint16_t>(65535U - ((in & 0x7FFFU) << 1U)) : static_cast<uint16_t>((in & 0x7FFFU) << 1U);
}

static inline uint8_t sin8_approx(uint8_t value) {
  const float radians = (static_cast<float>(value) / 255.0f) * TWO_PI_F;
  const float s = sinf(radians);
  return static_cast<uint8_t>(127.5f + (s * 127.5f));
}

static inline uint16_t sin16_approx(uint16_t value) {
  const float radians = (static_cast<float>(value) / 65535.0f) * TWO_PI_F;
  const float s = sinf(radians);
  return static_cast<uint16_t>(32767.5f + (s * 32767.5f));
}

static inline uint32_t nextSeed(uint32_t seed) {
  return seed * 2053UL + 13849UL;
}

static inline uint8_t random8FromSeed(uint32_t& seed) {
  seed = nextSeed(seed);
  return static_cast<uint8_t>((seed >> 8) & 0xFF);
}

static inline uint16_t random16FromSeed(uint32_t& seed, uint16_t maxValue) {
  if (maxValue == 0) return 0;
  seed = nextSeed(seed);
  return static_cast<uint16_t>((seed >> 8) % maxValue);
}

static inline uint8_t brightness100To255(uint8_t brightness) {
  return static_cast<uint8_t>((static_cast<uint16_t>(brightness) * 255U) / 100U);
}

static inline uint32_t scalePackedColor(uint32_t color, uint8_t scale) {
  const uint8_t r = scale8(static_cast<uint8_t>((color >> 16) & 0xFF), scale);
  const uint8_t g = scale8(static_cast<uint8_t>((color >> 8) & 0xFF), scale);
  const uint8_t b = scale8(static_cast<uint8_t>(color & 0xFF), scale);
  return (static_cast<uint32_t>(r) << 16) | (static_cast<uint32_t>(g) << 8) | b;
}

static inline uint32_t scaleByBrightness(uint32_t color, uint8_t brightness100) {
  return scalePackedColor(color, brightness100To255(brightness100));
}

static inline uint32_t blendPackedColor(uint32_t baseColor, uint32_t targetColor, uint8_t amount) {
  const uint16_t inv = 255U - amount;
  const uint8_t r = static_cast<uint8_t>((((baseColor >> 16) & 0xFFU) * inv + ((targetColor >> 16) & 0xFFU) * amount) >> 8);
  const uint8_t g = static_cast<uint8_t>((((baseColor >> 8) & 0xFFU) * inv + ((targetColor >> 8) & 0xFFU) * amount) >> 8);
  const uint8_t b = static_cast<uint8_t>(((baseColor & 0xFFU) * inv + (targetColor & 0xFFU) * amount) >> 8);
  return (static_cast<uint32_t>(r) << 16) | (static_cast<uint32_t>(g) << 8) | b;
}

static inline uint8_t colorAverageLight(uint32_t color) {
  return static_cast<uint8_t>((((color >> 16) & 0xFFU) + ((color >> 8) & 0xFFU) + (color & 0xFFU)) / 3U);
}

static inline uint32_t colorFade(uint32_t color, uint8_t fadeBy) {
  return scalePackedColor(color, static_cast<uint8_t>(255U - fadeBy));
}

static inline uint32_t colorWheel(uint8_t pos) {
  pos = 255U - pos;
  if (pos < 85U) {
    return (static_cast<uint32_t>(255U - pos * 3U) << 16) | static_cast<uint32_t>(pos * 3U);
  }
  if (pos < 170U) {
    pos -= 85U;
    return (static_cast<uint32_t>(pos * 3U) << 8) | (static_cast<uint32_t>(255U - pos * 3U));
  }
  pos -= 170U;
  return (static_cast<uint32_t>(pos * 3U) << 16) | (static_cast<uint32_t>(255U - pos * 3U) << 8);
}

static inline uint32_t defaultGlitterColor(const EngineLightGroup& group) {
  return group.colorSecond ? group.colorSecond : 0xFFFFFFUL;
}

static inline uint32_t colorFromPalette(const EngineLightGroup& group, uint16_t index, uint8_t brightness255 = 255) {
  if (!group.colorSecond) {
    return scalePackedColor(group.colorPrimary, brightness255);
  }

  const uint8_t mix = static_cast<uint8_t>(index & 0xFFU);
  const uint32_t blended = blendPackedColor(group.colorSecond, group.colorPrimary, mix);
  return scalePackedColor(blended, brightness255);
}

static void clearPixels(EngineLightGroup& group) {
  memset(group.pixels, 0, sizeof(group.pixels));
}

static void fillPixels(EngineLightGroup& group, uint32_t color) {
  for (uint8_t i = 0; i < group.ledCount; i++) {
    group.pixels[i] = color;
  }
}

static void fadeOut(EngineLightGroup& group, uint8_t fadeBy) {
  for (uint8_t i = 0; i < group.ledCount; i++) {
    group.pixels[i] = colorFade(group.pixels[i], fadeBy);
  }
}

static void setPixel(EngineLightGroup& group, uint16_t index, uint32_t color) {
  if (index < group.ledCount) {
    group.pixels[index] = color;
  }
}

static uint32_t getPixel(const EngineLightGroup& group, uint16_t index) {
  return (index < group.ledCount) ? group.pixels[index] : 0;
}

static void modeSolid(EngineLightGroup& group) {
  fillPixels(group, scaleByBrightness(group.colorPrimary, group.brightness));
}

static void modeBlink(EngineLightGroup& group, uint32_t nowMs, bool strobe) {
  const uint8_t intensity = group.intensity; // WLED placeholder: duty cycle / blink duration.
  const uint8_t primaryBri = brightness100To255(group.brightness);
  const uint32_t colorOn = scalePackedColor(group.colorPrimary, primaryBri);
  const uint32_t colorOff = scalePackedColor(group.colorSecond, primaryBri);
  const uint32_t cycleTime = strobe ? (40U + (255U - group.speed) * 3U) : (160U + (255U - group.speed) * 6U);
  const uint32_t onWindow = max<uint32_t>(strobe ? 18U : 30U, (cycleTime * max<uint8_t>(intensity, 16U)) / 255U);
  const bool on = (nowMs % cycleTime) < onWindow;
  fillPixels(group, on ? colorOn : colorOff);
}

static void modeBreathe(EngineLightGroup& group, uint32_t nowMs) {
  const uint32_t counterRaw = nowMs * ((group.speed >> 3) + 10U);
  uint16_t counter = static_cast<uint16_t>((counterRaw & 0xFFFFU) >> 2);
  counter += static_cast<uint16_t>(counter >> 2);

  unsigned var = 0;
  if (counter < 16384U) {
    if (counter > 8192U) counter = 8192U - (counter - 8192U);
    var = sin16_approx(counter) / 103U;
  }

  const uint8_t lum = static_cast<uint8_t>(30U + min<unsigned>(225U, var));
  const uint8_t scaledLum = scale8(lum, brightness100To255(group.brightness));
  const uint32_t fg = colorFromPalette(group, 0, scaledLum);
  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);

  for (uint8_t i = 0; i < group.ledCount; i++) {
    setPixel(group, i, blendPackedColor(bg, fg, lum));
  }
}

static void modeFade(EngineLightGroup& group, uint32_t nowMs) {
  const uint32_t counter = nowMs * ((group.speed >> 3) + 10U);
  const uint8_t lum = static_cast<uint8_t>(triwave16(static_cast<uint16_t>(counter)) >> 8);
  const uint32_t fg = scaleByBrightness(group.colorPrimary, group.brightness);
  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);

  for (uint8_t i = 0; i < group.ledCount; i++) {
    setPixel(group, i, blendPackedColor(bg, fg, lum));
  }
}

static void modeTwinkle(EngineLightGroup& group, uint32_t nowMs) {
  fadeOut(group, 224U);

  const uint8_t intensity = group.intensity; // WLED placeholder: maximum concurrently lit pixels.
  const uint32_t cycleTime = 20U + (255U - group.speed) * 5U;
  const uint32_t it = nowMs / cycleTime;
  if (it != group.runtime.step) {
    const unsigned maxOn = map(intensity, 0, 255, 1, max<uint8_t>(group.ledCount, 1U));
    if (group.runtime.aux0 >= maxOn) {
      group.runtime.aux0 = 0;
      group.runtime.aux1 = group.runtime.seed ? group.runtime.seed : (nowMs ^ 0xA5A55A5AUL);
    }
    group.runtime.aux0++;
    group.runtime.step = it;
  }

  uint32_t prng = group.runtime.aux1 ? group.runtime.aux1 : (group.runtime.seed ? group.runtime.seed : 1U);
  for (uint32_t i = 0; i < group.runtime.aux0; i++) {
    const unsigned j = random16FromSeed(prng, group.ledCount);
    setPixel(group, j, colorFromPalette(group, static_cast<uint16_t>(j * 255U / max<uint8_t>(group.ledCount, 1U)), brightness100To255(group.brightness)));
  }
  group.runtime.seed = prng;
}

static void modeSparkle(EngineLightGroup& group, uint32_t nowMs) {
  const bool overlay = false; // WLED check2 placeholder: overlay mode.
  const uint32_t background = scaleByBrightness(group.colorSecond, group.brightness);
  if (!overlay) {
    fillPixels(group, background);
  }

  const uint32_t cycleTime = 10U + (255U - group.speed) * 2U;
  const uint32_t it = nowMs / cycleTime;
  if (it != group.runtime.step) {
    uint32_t seed = group.runtime.seed ? group.runtime.seed : (nowMs ^ 0x51A7U);
    group.runtime.aux0 = random16FromSeed(seed, group.ledCount);
    group.runtime.seed = seed;
    group.runtime.step = it;
  }

  setPixel(group, group.runtime.aux0, scaleByBrightness(group.colorPrimary, group.brightness));
}

static void modeFlashSparkle(EngineLightGroup& group, uint32_t nowMs) {
  const bool overlay = false; // WLED check2 placeholder: overlay mode.
  if (!overlay) {
    fillPixels(group, scaleByBrightness(group.colorPrimary, group.brightness));
  }

  const uint8_t intensity = group.intensity; // WLED placeholder: flash spawn rate.
  if (nowMs - group.runtime.aux0 > group.runtime.step) {
    uint32_t seed = group.runtime.seed ? group.runtime.seed : (nowMs ^ 0xF1A54U);
    const uint8_t chanceDivisor = max<uint8_t>(1, (255U - intensity) >> 4);
    if ((random8FromSeed(seed) % chanceDivisor) == 0) {
      setPixel(group, random16FromSeed(seed, group.ledCount), scaleByBrightness(group.colorSecond ? group.colorSecond : 0xFFFFFFUL, group.brightness));
    }
    group.runtime.seed = seed;
    group.runtime.step = nowMs;
    group.runtime.aux0 = 255U - group.speed;
  }
}

static void glitterBase(EngineLightGroup& group, uint8_t intensity, uint32_t color, uint32_t nowMs) {
  if (!group.ledCount) return;

  uint32_t seed = group.runtime.seed ? group.runtime.seed : (nowMs ^ 0x7F37A5U);
  // Each LED independently decides whether to sparkle based on intensity probability.
  // intensity=255 → all LEDs sparkle every tick; intensity=1 → almost never; intensity=128 → ~half.
  for (uint8_t i = 0; i < group.ledCount; i++) {
    if (intensity > random8FromSeed(seed)) {
      setPixel(group, i, color);
    }
  }
  group.runtime.seed = seed;
}

static void modeGlitter(EngineLightGroup& group, uint32_t nowMs) {
  // Glitter FX: Fill with base color (allocation color) and overlay glitter sparkles
  const uint8_t glitterIntensity = group.intensity;
  const uint32_t glitterColor = scaleByBrightness(defaultGlitterColor(group), group.brightness);
  
  // Fill all LEDs with the primary color (the allocated color for this group)
  fillPixels(group, scaleByBrightness(group.colorPrimary, group.brightness));
  
  // Overlay glitter sparkles on top
  glitterBase(group, glitterIntensity, glitterColor, nowMs);
}

static void modeSolidGlitter(EngineLightGroup& group, uint32_t nowMs) {
  const uint8_t glitterIntensity = group.intensity;
  const uint32_t glitterColor = scaleByBrightness(defaultGlitterColor(group), group.brightness);
  fillPixels(group, scaleByBrightness(group.colorPrimary, group.brightness));
  glitterBase(group, glitterIntensity, glitterColor, nowMs);
}

static void modeRunningLights(EngineLightGroup& group, uint32_t nowMs) {
  const uint8_t waveWidth = group.intensity; // WLED placeholder: wave width.
  const unsigned xScale = max<unsigned>(1U, waveWidth >> 2);
  const uint32_t counter = (nowMs * max<uint8_t>(1U, group.speed)) >> 9;
  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);

  for (uint8_t i = 0; i < group.ledCount; i++) {
    const unsigned a = (i * xScale) - counter;
    const uint8_t s = sin8_approx(static_cast<uint8_t>(a & 0xFFU));
    const uint32_t fg = colorFromPalette(group, static_cast<uint16_t>(i * 255U / max<uint8_t>(group.ledCount, 1U)), brightness100To255(group.brightness));
    setPixel(group, i, blendPackedColor(bg, fg, s));
  }
}

static void modeLarsonScanner(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  const uint8_t trail = group.intensity; // WLED placeholder: trail fade amount.
  const uint8_t endDelay = RcdccFx::DEFAULT_CUSTOM1; // WLED placeholder: end delay slider.
  const bool dual = false; // WLED placeholder: dual scanner checkbox.
  const bool bidirectionalDelay = false; // WLED placeholder: bi-delay checkbox.

  const unsigned speed = max<unsigned>(1U, (1000U / LIGHTS_ENGINE_TASK_HZ) * map(group.speed, 0, 255, 96, 2));
  const unsigned pixelsPerFrame = max<unsigned>(1U, group.ledCount / speed);

  fadeOut(group, static_cast<uint8_t>(255U - trail));

  if (group.runtime.step > nowMs) return;

  unsigned index = group.runtime.aux1 + pixelsPerFrame;
  if (index > group.ledCount) {
    group.runtime.aux0 = !group.runtime.aux0;
    group.runtime.aux1 = 0;
    if (group.runtime.aux0 || bidirectionalDelay) {
      group.runtime.step = nowMs + endDelay * 25U;
    } else {
      group.runtime.step = 0;
    }
  } else {
    for (unsigned i = group.runtime.aux1; i < index; i++) {
      const unsigned j = group.runtime.aux0 ? i : (group.ledCount - 1U - i);
      const uint32_t c = colorFromPalette(group, static_cast<uint16_t>(j * 255U / max<uint8_t>(group.ledCount, 1U)), brightness100To255(group.brightness));
      setPixel(group, j, c);
      if (dual) {
        const unsigned mirror = group.ledCount - 1U - j;
        setPixel(group, mirror, scaleByBrightness(group.colorSecond ? group.colorSecond : c, group.brightness));
      }
    }
    group.runtime.aux1 = index;
  }
}

static void modeHeartbeat(EngineLightGroup& group, uint32_t nowMs) {
  const unsigned bpm = 40U + (group.speed >> 3);
  const uint32_t msPerBeat = 60000UL / max<unsigned>(bpm, 1U);
  const uint32_t secondBeat = msPerBeat / 3U;
  const uint32_t beatTimer = nowMs - group.runtime.step;
  const uint8_t baseBri = static_cast<uint8_t>(group.runtime.aux1 & 0xFFU);
  uint8_t beatBri = 0;

  if (beatTimer < 70U) {
    beatBri = static_cast<uint8_t>(map(beatTimer, 0U, 70U, 0U, 255U));
  } else if (beatTimer < 190U) {
    beatBri = static_cast<uint8_t>(map(beatTimer, 70U, 190U, 255U, baseBri));
  } else if (beatTimer > secondBeat && beatTimer < secondBeat + 50U) {
    beatBri = static_cast<uint8_t>(map(beatTimer - secondBeat, 0U, 50U, baseBri, 255U));
  } else if (beatTimer > secondBeat + 50U && beatTimer < secondBeat + 180U) {
    beatBri = static_cast<uint8_t>(map(beatTimer - (secondBeat + 50U), 0U, 130U, 255U, baseBri));
  } else {
    beatBri = baseBri;
  }

  if (beatTimer > msPerBeat) {
    group.runtime.step = nowMs;
    group.runtime.aux1 = map(group.speed, 0, 255, 20, 80);
  }

  const uint8_t effectBri = scale8(beatBri, brightness100To255(group.brightness));
  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);
  const uint32_t fg = scalePackedColor(group.colorPrimary, effectBri);
  for (uint8_t i = 0; i < group.ledCount; i++) {
    setPixel(group, i, blendPackedColor(bg, fg, beatBri));
  }
}

static void modeFlicker(EngineLightGroup& group, uint32_t nowMs) {
  const uint8_t intensity = group.intensity; // Placeholder: flicker depth.
  const uint32_t cycleTime = 25U + (255U - group.speed) * 2U;
  const uint32_t it = nowMs / cycleTime;
  if (group.runtime.step == it) return;

  uint32_t seed = group.runtime.seed ? group.runtime.seed : (nowMs ^ 0x193A1U);
  const uint8_t baseBri = brightness100To255(group.brightness);
  const uint8_t maxDrop = max<uint8_t>(8U, intensity / 2U);
  for (uint8_t i = 0; i < group.ledCount; i++) {
    const uint8_t drop = random8FromSeed(seed) % (maxDrop + 1U);
    setPixel(group, i, scalePackedColor(group.colorPrimary, static_cast<uint8_t>(baseBri - min<uint8_t>(baseBri, drop))));
  }
  group.runtime.seed = seed;
  group.runtime.step = it;
}

static void modeFireFlicker(EngineLightGroup& group, uint32_t nowMs) {
  const uint8_t intensity = group.intensity; // WLED placeholder: flicker depth.
  const uint32_t cycleTime = 40U + (255U - group.speed);
  const uint32_t it = nowMs / cycleTime;
  if (group.runtime.step == it) return;

  uint32_t seed = group.runtime.seed ? group.runtime.seed : (nowMs ^ 0x2C77B1U);
  const uint8_t brightness = brightness100To255(group.brightness);
  const uint32_t base = scalePackedColor(group.colorPrimary, brightness);
  const uint8_t r = static_cast<uint8_t>((base >> 16) & 0xFFU);
  const uint8_t g = static_cast<uint8_t>((base >> 8) & 0xFFU);
  const uint8_t b = static_cast<uint8_t>(base & 0xFFU);
  uint8_t lum = max<uint8_t>(r, max<uint8_t>(g, b));
  lum /= (((256U - intensity) / 16U) + 1U);

  for (uint8_t i = 0; i < group.ledCount; i++) {
    const uint8_t flicker = lum ? (random8FromSeed(seed) % lum) : 0;
    setPixel(group, i,
      (static_cast<uint32_t>(max<int>(r - flicker, 0)) << 16) |
      (static_cast<uint32_t>(max<int>(g - flicker, 0)) << 8) |
      static_cast<uint32_t>(max<int>(b - flicker, 0))
    );
  }

  group.runtime.seed = seed;
  group.runtime.step = it;
}

static void runEffect(EngineLightGroup& group, uint32_t nowMs) {
  switch (group.effect) {
    case FX_SOLID:          modeSolid(group); break;
    case FX_BLINK:          modeBlink(group, nowMs, false); break;
    case FX_STROBE:         modeBlink(group, nowMs, true); break;
    case FX_BREATHE:        modeBreathe(group, nowMs); break;
    case FX_FADE:           modeFade(group, nowMs); break;
    case FX_TWINKLE:        modeTwinkle(group, nowMs); break;
    case FX_SPARKLE:        modeSparkle(group, nowMs); break;
    case FX_FLASH_SPARKLE:  modeFlashSparkle(group, nowMs); break;
    case FX_GLITTER:        modeGlitter(group, nowMs); break;
    case FX_SOLID_GLITTER:  modeSolidGlitter(group, nowMs); break;
    case FX_RUNNING:        modeRunningLights(group, nowMs); break;
    case FX_LARSON:         modeLarsonScanner(group, nowMs); break;
    case FX_HEARTBEAT:      modeHeartbeat(group, nowMs); break;
    case FX_FLICKER:        modeFlicker(group, nowMs); break;
    case FX_FIRE_FLICKER:   modeFireFlicker(group, nowMs); break;
    default:                modeSolid(group); break;
  }
}

} // namespace

namespace RcdccFx {

const char* const EFFECT_NAMES[FX_COUNT] = {
  "solid",
  "blink",
  "strobe",
  "breathe",
  "fade",
  "twinkle",
  "sparkle",
  "flash_sparkle",
  "glitter",
  "solid_glitter",
  "running",
  "larson",
  "heartbeat",
  "flicker",
  "fire_flicker"
};

// TODO(Future Effects): Track planned additions in one place.
// - theater (WLED "Theater"): alternating odd/even style cadence
// - theater_rainbow (WLED "Theater Rainbow")

static const FxMetadata EFFECT_METADATA[FX_COUNT] = {
  { "solid", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: none." },
  { "blink", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls duty cycle; secondary color is the off-state/background." },
  { "strobe", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: secondary color is the off-state/background." },
  { "breathe", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: secondary color acts as the blended background." },
  { "fade", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: secondary color is required for the crossfade target." },
  { "twinkle", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls the number of lit pixels; default intensity matches WLED mid-value." },
  { "sparkle", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: overlay/background checkbox and secondary background color are reserved for future UI support." },
  { "flash_sparkle", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls flash spawn rate; secondary color is the flash color." },
  { "glitter", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED-style glitter: intensity controls random sparkle density and color2 is used as the glitter color." },
  { "solid_glitter", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED-style solid glitter: intensity controls random sparkle density and color2 is used as the glitter color." },
  { "running", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls wave width; secondary color acts as the background." },
  { "larson", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls trail fade; custom1 controls end delay; dual and bi-delay checkboxes are reserved for future UI support." },
  { "heartbeat", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: secondary color acts as the pulse background." },
  { "flicker", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls flicker depth." },
  { "fire_flicker", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls flicker depth and preserves the fire-like WLED falloff." }
};

LightEffect effectFromString(const char* name) {
  if (!name) return FX_SOLID;
  for (uint8_t i = 0; i < FX_COUNT; i++) {
    if (strcasecmp(name, EFFECT_NAMES[i]) == 0) {
      return static_cast<LightEffect>(i);
    }
  }
  return FX_SOLID;
}

const FxMetadata& metadataForEffect(LightEffect effect) {
  const uint8_t index = (effect < FX_COUNT) ? static_cast<uint8_t>(effect) : static_cast<uint8_t>(FX_SOLID);
  return EFFECT_METADATA[index];
}

} // namespace RcdccFx

using namespace RcdccFx;

LightsEngine::LightsEngine(uint8_t pin, uint16_t numLeds)
  : _strip(numLeds, pin, NEO_GRB + NEO_KHZ800)
  , _numLeds(min((uint16_t)LIGHTS_ENGINE_MAX_LEDS, numLeds))
  , _master(true)
  , _groupCount(0)
  , _colorOrder(LED_ORDER_GRB) {
  memset(_groups, 0, sizeof(_groups));
  memset(_frameBuffer, 0, sizeof(_frameBuffer));
}

void LightsEngine::begin() {
  _strip.begin();
  _strip.show();
  xTaskCreatePinnedToCore(_task, "LEDEffects", 6144, this, 1, &_taskHandle, LIGHTS_ENGINE_CORE);
}

bool LightsEngine::updateGroupFromJson(const String& payload) {
  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, payload) != DeserializationError::Ok) return false;

  const int idx = doc["group"] | -1;
  if (idx < 0 || idx >= LIGHTS_ENGINE_MAX_GROUPS) return false;

  if (xSemaphoreTake(_mutex, pdMS_TO_TICKS(50)) != pdTRUE) return false;

  if (idx >= _groupCount) _groupCount = idx + 1;

  EngineLightGroup& group = _groups[idx];
  if (doc.containsKey("name")) {
    strncpy(group.name, doc["name"].as<const char*>(), sizeof(group.name) - 1);
    group.name[sizeof(group.name) - 1] = '\0';
  }
  if (doc.containsKey("enabled")) group.enabled = doc["enabled"].as<bool>();
  if (doc.containsKey("color")) group.colorPrimary = _parseHex(doc["color"].as<const char*>());
  if (doc.containsKey("color2")) group.colorSecond = _parseHex(doc["color2"].as<const char*>());
  if (doc.containsKey("brightness")) group.brightness = constrain((int)doc["brightness"], 0, 100);
  if (doc.containsKey("effect")) group.effect = effectFromString(doc["effect"].as<const char*>());

  const FxMetadata& meta = metadataForEffect(group.effect);
  group.speed = doc.containsKey("speed") ? constrain((int)doc["speed"], 0, 255) : meta.defaultSpeed;
  group.intensity = doc.containsKey("intensity") ? constrain((int)doc["intensity"], 0, 255) : meta.defaultIntensity;

  if (doc.containsKey("leds")) {
    JsonArray arr = doc["leds"].as<JsonArray>();
    group.ledCount = 0;
    for (uint16_t ledIdx : arr) {
      if (group.ledCount >= LIGHTS_ENGINE_MAX_GROUP_LEDS) break;
      if (ledIdx < _numLeds) group.leds[group.ledCount++] = ledIdx;
    }
  }

  _resetGroupRuntime(group);
  xSemaphoreGive(_mutex);
  return true;
}

void LightsEngine::updateFromPayload(const NewLightsConfig& cfg) {
  if (cfg.useLegacyMode) return;

  _groupCount = 0;
  for (int i = 0; i < cfg.groupCount && i < LIGHTS_ENGINE_MAX_GROUPS; i++) {
    const ExtendedLightGroup& src = cfg.groups[i];
    EngineLightGroup& dst = _groups[i];
    memset(&dst, 0, sizeof(EngineLightGroup));

    strncpy(dst.name, src.name, sizeof(dst.name) - 1);
    dst.name[sizeof(dst.name) - 1] = '\0';
    dst.enabled = src.enabled;
    dst.colorPrimary = src.color;
    dst.colorSecond = src.color2;
    dst.brightness = (src.brightness * 100U) / 255U;
    dst.effect = effectFromString(src.pattern);

    const FxMetadata& meta = metadataForEffect(dst.effect);
    dst.speed = meta.defaultSpeed;
    dst.intensity = meta.defaultIntensity;
    dst.ledCount = min((uint8_t)src.ledCount, (uint8_t)LIGHTS_ENGINE_MAX_GROUP_LEDS);
    for (uint8_t j = 0; j < dst.ledCount; j++) dst.leds[j] = src.ledIndices[j];

    _resetGroupRuntime(dst);
    _groupCount++;
  }
}

void LightsEngine::loadProfile(const LightingProfile& profile) {
  _master = profile.master;
  _groupCount = min((int)profile.groupCount, LIGHTS_ENGINE_MAX_GROUPS);

  for (int i = 0; i < _groupCount; i++) {
    const LightingGroup& src = profile.groups[i];
    EngineLightGroup& dst = _groups[i];
    memset(&dst, 0, sizeof(EngineLightGroup));

    strncpy(dst.name, src.name, sizeof(dst.name) - 1);
    dst.name[sizeof(dst.name) - 1] = '\0';
    dst.enabled = src.enabled;
    dst.colorPrimary = _parseHex(src.colorPrimary);
    dst.colorSecond = _parseHex(src.colorSecondary);
    dst.brightness = constrain((int)src.brightness, 0, 100);
    dst.effect = effectFromString(src.effect);
    dst.speed = (uint8_t)((uint16_t)constrain((int)src.effectSpeed, 0, 100) * 255U / 100U);
    dst.intensity = (uint8_t)((uint16_t)constrain((int)src.effectIntensity, 0, 100) * 255U / 100U);
    dst.ledCount = 0;

    const uint16_t maxLeds = min((uint16_t)src.ledCount, (uint16_t)LIGHTS_ENGINE_MAX_GROUP_LEDS);
    for (uint16_t j = 0; j < maxLeds; j++) {
      if (src.leds[j] < _numLeds) dst.leds[dst.ledCount++] = src.leds[j];
    }

    _resetGroupRuntime(dst);
  }
}

LightingProfile* LightsEngine::getProfile() {
  if (_exportProfile.name[0] == '\0') {
    strncpy(_exportProfile.name, "Runtime", sizeof(_exportProfile.name) - 1);
    _exportProfile.name[sizeof(_exportProfile.name) - 1] = '\0';
  }

  _exportProfile.master = _master;
  _exportProfile.totalLeds = _numLeds;
  _exportProfile.groupCount = _groupCount;

  for (int i = 0; i < _groupCount; i++) {
    EngineLightGroup& src = _groups[i];
    LightingGroup& dst = _exportProfile.groups[i];

    dst.id = i;
    strncpy(dst.name, src.name, sizeof(dst.name) - 1);
    dst.name[sizeof(dst.name) - 1] = '\0';
    dst.ledCount = src.ledCount;
    for (uint16_t j = 0; j < src.ledCount; j++) dst.leds[j] = src.leds[j];
    dst.enabled = src.enabled;
    strncpy(dst.effect, EFFECT_NAMES[src.effect], sizeof(dst.effect) - 1);
    dst.effect[sizeof(dst.effect) - 1] = '\0';
    snprintf(dst.colorPrimary, sizeof(dst.colorPrimary), "#%06lX", (unsigned long)(src.colorPrimary & 0xFFFFFF));
    snprintf(dst.colorSecondary, sizeof(dst.colorSecondary), "#%06lX", (unsigned long)(src.colorSecond & 0xFFFFFF));
    dst.brightness = src.brightness;
    dst.effectSpeed = (uint8_t)((uint16_t)src.speed * 100U / 255U);
    dst.effectIntensity = (uint8_t)((uint16_t)src.intensity * 100U / 255U);
  }

  return &_exportProfile;
}

void LightsEngine::setMaster(bool on) { _master = on; }
bool LightsEngine::getMaster() const { return _master; }
void LightsEngine::setColorOrderByName(const char* orderName) { _colorOrder = colorOrderFromString(orderName); }
void LightsEngine::setBasicMode(bool on, uint8_t r, uint8_t g, uint8_t b, int count) {
  // Write data fields before the mode flag so the task sees a consistent state.
  _basicR = r; _basicG = g; _basicB = b; _basicCount = count;
  _basicMode = on;
}

void LightsEngine::clearAllGroups(bool clearPixels) {
  if (xSemaphoreTake(_mutex, pdMS_TO_TICKS(50)) != pdTRUE) return;

  _groupCount = 0;
  memset(_groups, 0, sizeof(_groups));
  memset(_frameBuffer, 0, sizeof(_frameBuffer));

  if (clearPixels) _showFrameBuffer();

  xSemaphoreGive(_mutex);
}

void LightsEngine::flashAllBlocking(uint32_t color, uint8_t count, uint16_t onMs, uint16_t offMs, volatile bool* cancel) {
  for (uint8_t i = 0; i < count; i++) {
    if (cancel && *cancel) break;
    _fillAll(color);
    _showFrameBuffer();
    delay(onMs);
    if (cancel && *cancel) break;
    _fillAll(0);
    _showFrameBuffer();
    delay(offMs);
  }
}

void LightsEngine::_task(void* arg) {
  auto* self = static_cast<LightsEngine*>(arg);
  TickType_t lastWake = xTaskGetTickCount();
  for (;;) {
    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(LIGHTS_ENGINE_TICK_MS));
    self->_tick();
  }
}

void LightsEngine::_tick() {
  // Basic diagnostic mode: write solid colour directly, skip all group logic.
  if (_basicMode) {
    const int n = (_basicCount < 0) ? 0 : ((_basicCount > (int)_numLeds) ? (int)_numLeds : _basicCount);
    const uint8_t r = _basicR, g = _basicG, b = _basicB;
    for (int i = 0; i < (int)_numLeds; i++) {
      if (i < n) _setPixelColorMapped(i, r, g, b);
      else _strip.setPixelColor(i, 0);
    }
    _strip.show();
    return;
  }

  if (xSemaphoreTake(_mutex, 0) != pdTRUE) return;

  memset(_frameBuffer, 0, _numLeds * sizeof(uint32_t));

  if (_master) {
    const uint32_t nowMs = millis();
    for (int i = 0; i < _groupCount; i++) {
      EngineLightGroup& group = _groups[i];
      if (!group.enabled || group.ledCount == 0) continue;
      runEffect(group, nowMs);
      _blitGroupPixels(group);
      group.runtime.tick++;
    }
  }

  _showFrameBuffer();
  xSemaphoreGive(_mutex);
}

void LightsEngine::_resetGroupRuntime(EngineLightGroup& group) {
  memset(group.pixels, 0, sizeof(group.pixels));
  group.runtime = FxRuntime{};
  group.runtime.seed = millis() ^ reinterpret_cast<uintptr_t>(&group);
}

void LightsEngine::_setGroupLed(const EngineLightGroup& group, uint8_t slot, uint32_t color) {
  if (slot < group.ledCount && group.leds[slot] < _numLeds) {
    _frameBuffer[group.leds[slot]] = color;
  }
}

void LightsEngine::_blitGroupPixels(const EngineLightGroup& group) {
  for (uint8_t i = 0; i < group.ledCount; i++) {
    _setGroupLed(group, i, group.pixels[i]);
  }
}

void LightsEngine::_fillAll(uint32_t color) {
  for (uint16_t i = 0; i < _numLeds; i++) _frameBuffer[i] = color;
}

void LightsEngine::_setPixelColorMapped(uint16_t idx, uint8_t r, uint8_t g, uint8_t b) {
  switch (_colorOrder) {
    case LED_ORDER_RGB: _strip.setPixelColor(idx, g, r, b); break;
    case LED_ORDER_RBG: _strip.setPixelColor(idx, b, r, g); break;
    case LED_ORDER_GBR: _strip.setPixelColor(idx, b, g, r); break;
    case LED_ORDER_BRG: _strip.setPixelColor(idx, r, b, g); break;
    case LED_ORDER_BGR: _strip.setPixelColor(idx, g, b, r); break;
    case LED_ORDER_GRB:
    default:
      _strip.setPixelColor(idx, r, g, b);
      break;
  }
}

void LightsEngine::_showFrameBuffer() {
  for (uint16_t i = 0; i < _numLeds; i++) {
    const uint32_t color = _frameBuffer[i];
    _setPixelColorMapped(i, static_cast<uint8_t>((color >> 16) & 0xFF), static_cast<uint8_t>((color >> 8) & 0xFF), static_cast<uint8_t>(color & 0xFF));
  }
  _strip.show();
}

uint32_t LightsEngine::_parseHex(const char* value) {
  if (!value) return 0;
  if (*value == '#') value++;
  return strtoul(value, nullptr, 16) & 0xFFFFFFUL;
}