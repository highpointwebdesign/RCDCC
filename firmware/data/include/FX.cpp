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

// WLED breathe math expects FastLED-like sin16 output in 0..32767 range for the
// 0..16384 quarter-cycle values used by modeBreathe.
static inline uint16_t sin16_approx(uint16_t value) {
  const float radians = (static_cast<float>(value) / 65535.0f) * TWO_PI_F;
  const float s = sinf(radians);
  return static_cast<uint16_t>(max(0.0f, s) * 32767.0f);
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
  uint16_t counter = static_cast<uint16_t>((nowMs * ((group.speed >> 3) + 10U)) & 0xFFFFU);
  counter = static_cast<uint16_t>((counter >> 2) + (counter >> 4));

  unsigned var = 0;
  if (counter < 16384U) {
    if (counter > 8192U) counter = 8192U - (counter - 8192U);
    var = sin16_approx(counter) / 103U;
  }

  const uint8_t lum = static_cast<uint8_t>(30U + min<unsigned>(225U, var));
  const uint32_t fg = scaleByBrightness(group.colorPrimary, group.brightness);
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
  const uint8_t waveWidth = group.custom1; // WLED parity: running width is custom1.
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

  const uint8_t trail = group.intensity;
  const uint8_t endDelay = group.custom1;
  const bool dual = group.check1;
  const bool bidirectionalDelay = group.check2;

  const unsigned speed = max<unsigned>(1U, (1000U / LIGHTS_ENGINE_TASK_HZ) * map(group.speed, 0, 255, 96, 2));
  const unsigned pixelsPerFrame = group.ledCount / speed;

  fadeOut(group, static_cast<uint8_t>(255U - trail));

  if (group.runtime.step > nowMs) return;

  unsigned index = group.runtime.aux1 + pixelsPerFrame;
  // Slow speeds need frame-per-pixel stepping (WLED behavior) instead of always
  // forcing 1 pixel/frame, otherwise speed control feels incorrect.
  if (pixelsPerFrame == 0U) {
    const unsigned framesPerPixel = max<unsigned>(1U, speed / max<unsigned>(group.ledCount, 1U));
    if (group.runtime.step++ < framesPerPixel) return;
    group.runtime.step = 0;
    index++;
  }

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

static void modeAndroid(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  unsigned size = static_cast<unsigned>(group.runtime.aux1 >> 1);
  bool shrinking = (group.runtime.aux1 & 0x01U) != 0U;

  if (nowMs >= group.runtime.step) {
    const unsigned maxSize = max<unsigned>(2U, (static_cast<unsigned>(group.custom1) * group.ledCount) / 255U);
    group.runtime.step = nowMs + 3U + ((8U * static_cast<uint32_t>(255U - group.speed)) / max<uint8_t>(group.ledCount, 1U));

    if (size > maxSize) shrinking = true;
    else if (size < 2U) shrinking = false;

    if (!shrinking) {
      if ((group.runtime.tick % 3U) == 1U) group.runtime.aux0++;
      else size++;
    } else {
      group.runtime.aux0++;
      if ((group.runtime.tick % 3U) != 1U && size > 0U) size--;
    }

    if (group.runtime.aux0 >= group.ledCount) group.runtime.aux0 = 0;
    group.runtime.aux1 = (static_cast<uint32_t>(size) << 1U) | (shrinking ? 1U : 0U);
    group.runtime.tick++;
  }

  const unsigned start = static_cast<unsigned>(group.runtime.aux0 % group.ledCount);
  const unsigned end = (start + size) % group.ledCount;
  const uint32_t fg = scaleByBrightness(group.colorPrimary, group.brightness);
  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);

  for (unsigned i = 0; i < group.ledCount; i++) {
    const bool inArc = (start < end)
      ? (i >= start && i < end)
      : (i >= start || i < end);
    setPixel(group, i, inArc ? fg : bg);
  }
}

static void modeBpm(EngineLightGroup& group, uint32_t nowMs) {
  const uint8_t stp = static_cast<uint8_t>((nowMs / 20U) & 0xFFU);
  const uint8_t phase = static_cast<uint8_t>((nowMs * max<uint8_t>(1U, group.speed)) >> 8);
  const uint8_t beat = static_cast<uint8_t>(map(sin8_approx(phase), 0, 255, 64, 255));

  for (uint8_t i = 0; i < group.ledCount; i++) {
    const uint8_t waveBri = static_cast<uint8_t>(beat - stp + (i * 10U));
    const uint8_t outBri = scale8(waveBri, brightness100To255(group.brightness));
    setPixel(group, i, colorFromPalette(group, static_cast<uint16_t>(stp + (i * 2U)), outBri));
  }
}

static void candleCore(EngineLightGroup& group, uint32_t nowMs, bool perPixel) {
  const uint32_t frameMs = 12U + static_cast<uint32_t>(255U - group.speed) * 2U;
  if (nowMs - group.runtime.step < frameMs) return;
  group.runtime.step = nowMs;

  uint32_t seed = group.runtime.seed ? group.runtime.seed : (nowMs ^ 0x3A5C19U);
  const uint8_t baseBri = brightness100To255(group.brightness);
  const uint8_t flickerDepth = static_cast<uint8_t>(map(group.intensity, 0, 255, 8, 192));
  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);

  uint8_t sharedDrop = 0;
  if (!perPixel) {
    sharedDrop = random8FromSeed(seed) % max<uint8_t>(1U, flickerDepth);
  }

  for (uint8_t i = 0; i < group.ledCount; i++) {
    const uint8_t drop = perPixel
      ? static_cast<uint8_t>(random8FromSeed(seed) % max<uint8_t>(1U, flickerDepth))
      : sharedDrop;
    const uint8_t bri = static_cast<uint8_t>(max<int>(baseBri - drop, 0));
    const uint32_t fg = scalePackedColor(colorFromPalette(group, static_cast<uint16_t>(i * 13U)), bri);
    setPixel(group, i, blendPackedColor(bg, fg, 220U));
  }

  group.runtime.seed = seed;
}

static void modeCandle(EngineLightGroup& group, uint32_t nowMs) {
  candleCore(group, nowMs, false);
}

static void modeCandleMulti(EngineLightGroup& group, uint32_t nowMs) {
  candleCore(group, nowMs, true);
}

static void modeChase2(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  const uint8_t width = static_cast<uint8_t>(max<unsigned>(1U, map(group.custom1, 0, 255, 1, max<uint8_t>(1U, group.ledCount / 2U))));
  const uint16_t counter = static_cast<uint16_t>(nowMs * ((group.speed >> 2) + 1U));
  const uint8_t head = static_cast<uint8_t>((static_cast<uint32_t>(counter) * group.ledCount) >> 16);
  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);
  const uint32_t fx = scaleByBrightness(group.colorPrimary, group.brightness);

  fillPixels(group, bg);
  for (uint8_t i = 0; i < width; i++) {
    setPixel(group, static_cast<uint8_t>((head + i) % group.ledCount), fx);
  }
}

static void modeChaseFlash(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  const uint8_t flashStep = static_cast<uint8_t>(group.runtime.aux1 % 9U); // (FLASH_COUNT*2)+1 where FLASH_COUNT=4
  const uint8_t head = static_cast<uint8_t>(group.runtime.aux0 % group.ledCount);
  const uint8_t next = static_cast<uint8_t>((head + 1U) % group.ledCount);
  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);
  const uint32_t fx = scaleByBrightness(group.colorPrimary, group.brightness);

  fillPixels(group, bg);
  if (flashStep < 8U && (flashStep % 2U == 0U)) {
    setPixel(group, head, fx);
    setPixel(group, next, fx);
  }

  if (nowMs >= group.runtime.step) {
    group.runtime.aux1++;
    if (flashStep >= 8U) group.runtime.aux0 = next;
    const uint32_t delayMs = (flashStep < 8U)
      ? ((flashStep % 2U == 0U) ? 20U : 30U)
      : (10U + ((30U * static_cast<uint32_t>(255U - group.speed)) / max<uint8_t>(group.ledCount, 1U)));
    group.runtime.step = nowMs + delayMs;
  }
}

static void modeChaseRainbow(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  const uint8_t width = static_cast<uint8_t>(max<unsigned>(1U, map(group.custom1, 0, 255, 1, max<uint8_t>(1U, group.ledCount / 2U))));
  const uint16_t counter = static_cast<uint16_t>(nowMs * ((group.speed >> 2) + 1U));
  const uint8_t head = static_cast<uint8_t>((static_cast<uint32_t>(counter) * group.ledCount) >> 16);
  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);

  fillPixels(group, bg);
  for (uint8_t i = 0; i < width; i++) {
    const uint8_t pos = static_cast<uint8_t>((head + i) % group.ledCount);
    const uint8_t hue = static_cast<uint8_t>(group.runtime.tick + (pos * 255U / max<uint8_t>(group.ledCount, 1U)));
    const uint32_t rainbow = scalePackedColor(colorWheel(hue), brightness100To255(group.brightness));
    setPixel(group, pos, rainbow);
  }
}

static void modeChunchun(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  const uint8_t gapScale = static_cast<uint8_t>(max<unsigned>(2U, map(group.custom1, 0, 255, 2, 12)));
  const uint8_t birdCount = static_cast<uint8_t>(max<unsigned>(1U, (2U + (group.ledCount / gapScale))));
  const uint32_t counter = nowMs * (6U + (group.speed >> 4));
  const uint8_t fadeBy = scale8(255U - brightness100To255(group.brightness), 24U);

  fadeOut(group, static_cast<uint8_t>(220U + (fadeBy >> 1U))); // leave a short visible trail

  const uint32_t fgBase = scaleByBrightness(group.colorPrimary, group.brightness);
  for (uint8_t i = 0; i < birdCount; i++) {
    const uint32_t phase = counter - ((static_cast<uint32_t>(group.custom1) << 8U) / max<uint8_t>(birdCount, 1U)) * i;
    const uint16_t wave = static_cast<uint16_t>((sin8_approx(static_cast<uint8_t>(phase >> 8U)) << 8U) + 0x80U);
    const uint8_t pos = static_cast<uint8_t>((static_cast<uint32_t>(wave) * group.ledCount) >> 16U);
    setPixel(group, min<uint8_t>(pos, group.ledCount - 1U), colorFromPalette(group, static_cast<uint16_t>((i * 255U) / max<uint8_t>(birdCount, 1U)), colorAverageLight(fgBase)));
  }
}

static void modeColorwaves(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);
  const uint32_t tint = scaleByBrightness(group.colorPrimary, group.brightness);
  const uint8_t hueOffset = group.custom1;
  const uint8_t drift = static_cast<uint8_t>((nowMs * (2U + (group.speed >> 5U))) >> 10U);
  const uint8_t waveBase = static_cast<uint8_t>((nowMs * (4U + (group.speed >> 4U))) >> 8U);

  for (uint8_t i = 0; i < group.ledCount; i++) {
    const uint8_t wavePos = static_cast<uint8_t>(waveBase + (i * 11U));
    const uint8_t hue = static_cast<uint8_t>(hueOffset + drift + (triwave8(static_cast<uint8_t>(wavePos + (i * 7U))) >> 1U));
    const uint8_t bri = static_cast<uint8_t>(80U + scale8(sin8_approx(static_cast<uint8_t>(wavePos + drift)), 175U));
    const uint32_t rainbow = scalePackedColor(colorWheel(hue), bri);
    const uint32_t tinted = blendPackedColor(scalePackedColor(tint, static_cast<uint8_t>(160U + (bri >> 2U))), rainbow, 144U);
    setPixel(group, i, blendPackedColor(bg, tinted, 224U));
  }
}

static void modeDancingShadows(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);
  const uint32_t base = scaleByBrightness(group.colorPrimary, group.brightness);
  const unsigned shadowCount = max<unsigned>(1U, map(group.custom1, 0, 255, 1, min<unsigned>(12U, max<uint8_t>(group.ledCount, 1U))));
  const uint32_t motion = nowMs * (2U + (group.speed >> 5U));
  const uint32_t seedBase = group.runtime.seed ? group.runtime.seed : (group.colorPrimary ^ (static_cast<uint32_t>(group.custom1) << 8U) ^ group.ledCount);

  fillPixels(group, bg);

  for (unsigned s = 0; s < shadowCount; s++) {
    uint32_t seed = seedBase + ((s + 1U) * 0x9E3779B9UL);
    const uint8_t width = static_cast<uint8_t>(1U + (random8FromSeed(seed) % max<uint8_t>(2U, min<uint8_t>(10U, group.ledCount))));
    const uint8_t style = static_cast<uint8_t>(random8FromSeed(seed) % 3U);
    const uint8_t hue = static_cast<uint8_t>(random8FromSeed(seed) + (motion >> 10U));
    const uint32_t accent = scalePackedColor(colorWheel(hue), brightness100To255(group.brightness));
    const uint32_t shadowColor = blendPackedColor(base, accent, 96U);
    const uint16_t phase = static_cast<uint16_t>(((motion / (6U + (random8FromSeed(seed) % 18U))) + (s * 8192U)) & 0xFFFFU);
    const int travel = static_cast<int>(group.ledCount + width + 1U);
    const int start = static_cast<int>((static_cast<uint32_t>(triwave16(phase)) * travel) >> 16U) - static_cast<int>(width / 2U);

    for (uint8_t j = 0; j < width; j++) {
      const int pos = start + j;
      if (pos < 0 || pos >= group.ledCount) continue;

      uint8_t alpha = 160U;
      if (style == 1U) {
        const uint8_t gradientPos = (width <= 1U) ? 255U : static_cast<uint8_t>((static_cast<uint16_t>(j) * 255U) / (width - 1U));
        alpha = triwave8(gradientPos);
      } else if (style == 2U) {
        alpha = (j % 2U == 0U) ? 180U : 92U;
      }

      setPixel(group, static_cast<uint8_t>(pos), blendPackedColor(getPixel(group, static_cast<uint8_t>(pos)), shadowColor, alpha));
    }
  }
}

static void modeFairy(EngineLightGroup& group, uint32_t nowMs) {
  if (!group.ledCount) return;

  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);
  const uint32_t base = scalePackedColor(group.colorPrimary, static_cast<uint8_t>(40U + (brightness100To255(group.brightness) >> 3U)));
  const unsigned flasherCount = max<unsigned>(1U, map(group.custom1, 0, 255, 1, max<unsigned>(1U, min<unsigned>(group.ledCount, 10U))));
  const uint32_t pulseBase = nowMs * (3U + (group.speed >> 5U));
  const uint32_t seedBase = group.runtime.seed ? group.runtime.seed : (group.colorPrimary ^ 0x5A1F00UL);
  const uint8_t slotSpan = max<uint8_t>(1U, static_cast<uint8_t>((group.ledCount + flasherCount - 1U) / flasherCount));

  fillPixels(group, bg);
  for (uint8_t i = 0; i < group.ledCount; i++) {
    setPixel(group, i, blendPackedColor(bg, base, 88U));
  }

  for (unsigned f = 0; f < flasherCount; f++) {
    uint32_t seed = seedBase + ((f + 1U) * 0x045D9F3BUL);
    const uint8_t offset = static_cast<uint8_t>(random8FromSeed(seed) % slotSpan);
    const uint8_t pos = min<uint8_t>(group.ledCount - 1U, static_cast<uint8_t>(f * slotSpan + offset));
    const uint8_t paletteHue = random8FromSeed(seed);
    const uint8_t phase = static_cast<uint8_t>((pulseBase / (4U + (random8FromSeed(seed) % 8U))) + (f * 37U));
    const uint8_t wave = sin8_approx(phase);
    const uint8_t bri = (wave > 180U)
      ? static_cast<uint8_t>(96U + scale8(static_cast<uint8_t>(wave - 180U), 223U))
      : scale8(wave, 32U);
    const uint32_t flashColor = blendPackedColor(scalePackedColor(group.colorPrimary, bri), scalePackedColor(colorWheel(paletteHue), bri), 72U);
    setPixel(group, pos, blendPackedColor(getPixel(group, pos), flashColor, max<uint8_t>(96U, bri)));
  }
}

static void modeFairyTwinkle(EngineLightGroup& group, uint32_t nowMs) {
  if (!group.ledCount) return;

  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);
  const uint32_t fg = scaleByBrightness(group.colorPrimary, group.brightness);
  const uint8_t variation = static_cast<uint8_t>(map(group.intensity, 0, 255, 24, 170));
  const uint32_t twinkleBase = nowMs * (2U + (group.speed >> 6U));
  const uint32_t seedBase = group.runtime.seed ? group.runtime.seed : (group.colorPrimary ^ 0xA55AA55AUL);

  for (uint8_t i = 0; i < group.ledCount; i++) {
    uint32_t seed = seedBase + ((static_cast<uint32_t>(i) + 1U) * 1103515245UL);
    const uint8_t paletteHue = random8FromSeed(seed);
    const uint8_t phase = static_cast<uint8_t>((twinkleBase / (3U + (random8FromSeed(seed) % 7U))) + paletteHue + (i * 17U));
    const uint8_t wave = sin8_approx(phase);
    const uint8_t mix = clamp8(176 + (((static_cast<int>(wave) - 128) * variation) / 127));
    const uint32_t twinkleColor = blendPackedColor(fg, scaleByBrightness(colorWheel(paletteHue), group.brightness), 48U);
    setPixel(group, i, blendPackedColor(bg, twinkleColor, mix));
  }
}

static void modeRipple(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);
  const uint32_t fg = scaleByBrightness(group.colorPrimary, group.brightness);
  const uint8_t waveCount = static_cast<uint8_t>(max<unsigned>(1U, map(group.custom1, 0, 255, 1, 8)));
  const uint32_t rippleSpeed = 1U + (group.speed >> 5U);
  const uint32_t timeBase = nowMs * rippleSpeed;

  fillPixels(group, bg);

  for (uint8_t w = 0; w < waveCount; w++) {
    const uint32_t offset = (static_cast<uint32_t>(w) * 65535UL) / waveCount;
    const uint16_t centerWave = static_cast<uint16_t>((timeBase * 23U + offset) & 0xFFFFU);
    const uint8_t center = static_cast<uint8_t>((static_cast<uint32_t>(triwave16(centerWave)) * group.ledCount) >> 16U);
    const uint8_t phase = static_cast<uint8_t>((timeBase >> 3U) + (w * 47U));
    const uint8_t radius = static_cast<uint8_t>(1U + map(sin8_approx(phase), 0, 255, 1, max<uint8_t>(2U, group.ledCount / 2U)));

    for (uint8_t i = 0; i < group.ledCount; i++) {
      const uint8_t d = static_cast<uint8_t>(abs(static_cast<int>(i) - static_cast<int>(center)));
      if (d > radius) continue;
      const uint8_t alpha = static_cast<uint8_t>(255U - ((static_cast<uint16_t>(d) * 255U) / max<uint8_t>(1U, radius)));
      setPixel(group, i, blendPackedColor(getPixel(group, i), fg, alpha));
    }
  }
}

static void modeSine(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  const uint8_t scale = static_cast<uint8_t>(max<unsigned>(1U, (group.custom1 >> 2U) + 1U));
  const uint32_t step = nowMs * (1U + (group.speed >> 5U));
  const uint32_t fg = scaleByBrightness(group.colorPrimary, group.brightness);
  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);

  for (uint8_t i = 0; i < group.ledCount; i++) {
    const uint8_t wave = sin8_approx(static_cast<uint8_t>((i * scale) + (step >> 4U)));
    const uint8_t mix = static_cast<uint8_t>(48U + scale8(wave, 207U));
    setPixel(group, i, blendPackedColor(bg, fg, mix));
  }
}

static void modeStrobe(EngineLightGroup& group, uint32_t nowMs) {
  modeBlink(group, nowMs, true);
}

static void modeStrobeMega(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  const uint32_t bg = scaleByBrightness(group.colorSecond, group.brightness);
  const uint32_t fg = scaleByBrightness(group.colorPrimary, group.brightness);
  const uint8_t flashCount = static_cast<uint8_t>(2U * ((group.intensity / 10U) + 1U));
  const uint8_t phase = static_cast<uint8_t>(group.runtime.aux1 % (flashCount + 2U));

  fillPixels(group, bg);
  if (phase < flashCount && ((phase & 0x01U) == 0U)) {
    fillPixels(group, fg);
  }

  if (nowMs >= group.runtime.step) {
    const uint32_t delayMs = (phase < flashCount)
      ? (((phase & 0x01U) == 0U) ? 15U : 50U)
      : (50U + 20U * static_cast<uint32_t>(255U - group.speed));
    group.runtime.aux1 = phase + 1U;
    group.runtime.step = nowMs + delayMs;
  }
}

static void modeWipe(EngineLightGroup& group, uint32_t nowMs) {
  if (group.ledCount <= 1) {
    modeSolid(group);
    return;
  }

  const uint32_t cycleMs = 750U + (255U - group.speed) * 150U;
  const uint32_t perc = cycleMs ? (nowMs % cycleMs) : 0U;
  const uint16_t prog = static_cast<uint16_t>((perc * 65535UL) / max<uint32_t>(1U, cycleMs));
  const bool back = prog > 32767U;
  const uint16_t front = back ? static_cast<uint16_t>(prog - 32767U) : prog;
  const uint8_t wipePos = static_cast<uint8_t>((static_cast<uint32_t>(front) * group.ledCount) >> 15U);

  const uint8_t blendAmount = static_cast<uint8_t>(map(group.intensity, 0, 255, 32, 255));
  const uint32_t onColor = scaleByBrightness(group.colorPrimary, group.brightness);
  const uint32_t offColor = scaleByBrightness(group.colorSecond, group.brightness);

  for (uint8_t i = 0; i < group.ledCount; i++) {
    const bool lit = back ? (i >= wipePos) : (i < wipePos);
    const uint32_t base = lit ? onColor : offColor;
    setPixel(group, i, blendPackedColor(offColor, base, blendAmount));
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
    case FX_BREATHE:        modeBreathe(group, nowMs); break;
    case FX_FADE:           modeFade(group, nowMs); break;
    case FX_TWINKLE:        modeTwinkle(group, nowMs); break;
    case FX_SPARKLE:        modeSparkle(group, nowMs); break;
    case FX_FLASH_SPARKLE:  modeFlashSparkle(group, nowMs); break;
    case FX_GLITTER:        modeGlitter(group, nowMs); break;
    case FX_RUNNING:        modeRunningLights(group, nowMs); break;
    case FX_LARSON:         modeLarsonScanner(group, nowMs); break;
    case FX_ANDROID:        modeAndroid(group, nowMs); break;
    case FX_BPM:            modeBpm(group, nowMs); break;
    case FX_CANDLE:         modeCandle(group, nowMs); break;
    case FX_CANDLE_MULTI:   modeCandleMulti(group, nowMs); break;
    case FX_CHASE_2:        modeChase2(group, nowMs); break;
    case FX_CHASE_FLASH:    modeChaseFlash(group, nowMs); break;
    case FX_CHASE_RAINBOW:  modeChaseRainbow(group, nowMs); break;
    case FX_CHUNCHUN:       modeChunchun(group, nowMs); break;
    case FX_COLORWAVES:     modeColorwaves(group, nowMs); break;
    case FX_DANCING_SHADOWS: modeDancingShadows(group, nowMs); break;
    case FX_FAIRY:          modeFairy(group, nowMs); break;
    case FX_FAIRY_TWINKLE:  modeFairyTwinkle(group, nowMs); break;
    case FX_RIPPLE:         modeRipple(group, nowMs); break;
    case FX_SINE:           modeSine(group, nowMs); break;
    case FX_STROBE:         modeStrobe(group, nowMs); break;
    case FX_STROBE_MEGA:    modeStrobeMega(group, nowMs); break;
    case FX_WIPE:           modeWipe(group, nowMs); break;
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
  "breathe",
  "fade",
  "twinkle",
  "sparkle",
  "flash_sparkle",
  "glitter",
  "running",
  "larson",
  "heartbeat",
  "flicker",
  "fire_flicker",
  "android",
  "bpm",
  "candle",
  "candle_multi",
  "chase_2",
  "chase_flash",
  "chase_rainbow",
  "chunchun",
  "colorwaves",
  "dancing_shadows",
  "fairy",
  "fairy_twinkle",
  "ripple",
  "sine",
  "strobe",
  "strobe_mega",
  "wipe"
};

// TODO(Future Effects): Track planned additions in one place.
// - theater (WLED "Theater"): alternating odd/even style cadence
// - theater_rainbow (WLED "Theater Rainbow")

static const FxMetadata EFFECT_METADATA[FX_COUNT] = {
  { "solid", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: none." },
  { "blink", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls duty cycle; secondary color is the off-state/background." },
  { "breathe", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: secondary color acts as the blended background." },
  { "fade", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: secondary color is required for the crossfade target." },
  { "twinkle", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls the number of lit pixels; default intensity matches WLED mid-value." },
  { "sparkle", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: overlay/background checkbox and secondary background color are reserved for future UI support." },
  { "flash_sparkle", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls flash spawn rate; secondary color is the flash color." },
  { "glitter", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED-style glitter: intensity controls random sparkle density and color2 is used as the glitter color." },
  { "running", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls wave width; secondary color acts as the background." },
  { "larson", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: intensity controls trail fade; custom1 controls end delay; check1 enables dual scanner; check2 enables bi-delay." },
  { "heartbeat", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: secondary color acts as the pulse background." },
  { "flicker", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls flicker depth." },
  { "fire_flicker", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "Extra WLED params: intensity controls flicker depth and preserves the fire-like WLED falloff." },
  { "android", DEFAULT_SPEED, DEFAULT_INTENSITY, 96, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls rotation rate, custom1 controls scanner width, and secondary color is background." },
  { "bpm", 64, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls beat rate." },
  { "candle", 96, 224, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls flicker rate and intensity controls flicker depth." },
  { "candle_multi", 96, 224, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls flicker rate and intensity controls per-pixel flicker depth." },
  { "chase_2", DEFAULT_SPEED, DEFAULT_INTENSITY, 64, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls chase speed and custom1 controls chase width." },
  { "chase_flash", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls chase/flash cadence; secondary color is background." },
  { "chase_rainbow", DEFAULT_SPEED, DEFAULT_INTENSITY, 64, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls chase speed and custom1 controls chase width." },
  { "chunchun", DEFAULT_SPEED, DEFAULT_INTENSITY, 128, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls motion and custom1 controls gap size between birds." },
  { "colorwaves", DEFAULT_SPEED, DEFAULT_INTENSITY, 160, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED-style colorwaves: speed controls wave motion, custom1 offsets hue, and secondary color acts as the background." },
  { "dancing_shadows", DEFAULT_SPEED, DEFAULT_INTENSITY, 96, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED-style dancing shadows: speed controls motion, custom1 controls the number of moving shadows, and secondary color is the background." },
  { "fairy", DEFAULT_SPEED, DEFAULT_INTENSITY, 96, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED-style fairy: speed controls flasher cadence, custom1 controls the number of flashers, and secondary color is the background." },
  { "fairy_twinkle", DEFAULT_SPEED, 160, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED-style fairy twinkle: speed controls twinkle tempo, intensity controls twinkle depth, and secondary color is the background." },
  { "ripple", DEFAULT_SPEED, DEFAULT_INTENSITY, 128, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls ripple cadence and custom1 controls wave count." },
  { "sine", DEFAULT_SPEED, DEFAULT_INTENSITY, 128, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls phase rate and custom1 controls sine scale." },
  { "strobe", DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls strobe cadence and secondary color is background/off-state." },
  { "strobe_mega", DEFAULT_SPEED, 128, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls burst cadence and intensity controls strobe burst count." },
  { "wipe", DEFAULT_SPEED, 180, DEFAULT_CUSTOM1, DEFAULT_CUSTOM2, DEFAULT_CUSTOM3, false, false, false, "WLED parity: speed controls wipe travel and intensity controls wipe blend strength; secondary color is background." }
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
  xTaskCreatePinnedToCore(_task, "LEDEffects", LIGHTS_ENGINE_STACK_WORDS, this, 1, &_taskHandle, LIGHTS_ENGINE_CORE);
}

bool LightsEngine::updateGroupFromJson(const String& payload) {
  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, payload) != DeserializationError::Ok) return false;

  const int idx = doc["group"] | -1;
  if (idx < 0 || idx >= LIGHTS_ENGINE_MAX_GROUPS) return false;

  if (xSemaphoreTake(_mutex, pdMS_TO_TICKS(50)) != pdTRUE) return false;

  if (idx >= _groupCount) _groupCount = idx + 1;

  EngineLightGroup& group = _groups[idx];
  const LightEffect prevEffect = group.effect;
  const bool prevEnabled = group.enabled;
  const uint32_t prevColorPrimary = group.colorPrimary;
  const uint32_t prevColorSecond = group.colorSecond;
  const uint8_t prevLedCount = group.ledCount;
  uint16_t prevLeds[LIGHTS_ENGINE_MAX_GROUP_LEDS];
  memcpy(prevLeds, group.leds, sizeof(prevLeds));

  if (doc.containsKey("name")) {
    strncpy(group.name, doc["name"].as<const char*>(), sizeof(group.name) - 1);
    group.name[sizeof(group.name) - 1] = '\0';
  }
  if (doc.containsKey("enabled")) group.enabled = doc["enabled"].as<bool>();
  if (doc.containsKey("color")) {
    JsonVariantConst colorValue = doc["color"];
    if (colorValue.is<const char*>()) {
      group.colorPrimary = _parseHex(colorValue.as<const char*>());
    } else if (colorValue.is<unsigned long>() || colorValue.is<long>() || colorValue.is<unsigned int>() || colorValue.is<int>()) {
      group.colorPrimary = static_cast<uint32_t>(colorValue.as<unsigned long>()) & 0xFFFFFFUL;
    } else {
      const String colorStr = colorValue.as<String>();
      group.colorPrimary = _parseHex(colorStr.c_str());
    }
  }
  if (doc.containsKey("color2")) {
    JsonVariantConst color2Value = doc["color2"];
    if (color2Value.is<const char*>()) {
      group.colorSecond = _parseHex(color2Value.as<const char*>());
    } else if (color2Value.is<unsigned long>() || color2Value.is<long>() || color2Value.is<unsigned int>() || color2Value.is<int>()) {
      group.colorSecond = static_cast<uint32_t>(color2Value.as<unsigned long>()) & 0xFFFFFFUL;
    } else {
      const String color2Str = color2Value.as<String>();
      group.colorSecond = _parseHex(color2Str.c_str());
    }
  }
  if (doc.containsKey("brightness")) group.brightness = constrain((int)doc["brightness"], 0, 100);
  if (doc.containsKey("effect")) group.effect = effectFromString(doc["effect"].as<const char*>());

  const FxMetadata& meta = metadataForEffect(group.effect);
  group.speed = doc.containsKey("speed") ? constrain((int)doc["speed"], 0, 255) : meta.defaultSpeed;
  group.intensity = doc.containsKey("intensity") ? constrain((int)doc["intensity"], 0, 255) : meta.defaultIntensity;
  group.custom1 = doc.containsKey("custom1") ? constrain((int)doc["custom1"], 0, 255) : meta.defaultCustom1;
  group.custom2 = doc.containsKey("custom2") ? constrain((int)doc["custom2"], 0, 255) : meta.defaultCustom2;
  group.custom3 = doc.containsKey("custom3") ? constrain((int)doc["custom3"], 0, 31) : meta.defaultCustom3;
  group.check1 = doc.containsKey("check1") ? doc["check1"].as<bool>() : meta.defaultCheck1;
  group.check2 = doc.containsKey("check2") ? doc["check2"].as<bool>() : meta.defaultCheck2;
  group.check3 = doc.containsKey("check3") ? doc["check3"].as<bool>() : meta.defaultCheck3;

  if (doc.containsKey("leds") || doc.containsKey("indices")) {
    JsonArray arr = doc.containsKey("leds") ? doc["leds"].as<JsonArray>() : doc["indices"].as<JsonArray>();
    group.ledCount = 0;

    // Heuristic: if there are no zeros and values are in 1.._numLeds, treat as 1-based indices.
    bool sawZero = false;
    bool allWithinOneBasedRange = true;
    for (JsonVariantConst value : arr) {
      const int raw = value.as<int>();
      if (raw == 0) sawZero = true;
      if (raw < 1 || raw > static_cast<int>(_numLeds)) allWithinOneBasedRange = false;
    }
    const bool oneBased = !sawZero && allWithinOneBasedRange;

    for (JsonVariantConst value : arr) {
      if (group.ledCount >= LIGHTS_ENGINE_MAX_GROUP_LEDS) break;
      int ledIdx = value.as<int>();
      if (oneBased) ledIdx -= 1;
      if (ledIdx >= 0 && ledIdx < static_cast<int>(_numLeds)) {
        group.leds[group.ledCount++] = static_cast<uint16_t>(ledIdx);
      }
    }
  }

  Serial.printf("[LightsEngine] Group %d: enabled=%d ledCount=%d leds=[", idx, group.enabled, group.ledCount);
  for (uint8_t i = 0; i < group.ledCount; i++) {
    Serial.printf("%d%s", group.leds[i], i + 1 < group.ledCount ? "," : "");
  }
  Serial.printf("] effect=%d color=#%06lX\n", (int)group.effect, (unsigned long)group.colorPrimary);

  const bool effectChanged = (group.effect != prevEffect);
  const bool becameEnabled = (!prevEnabled && group.enabled);
  const bool colorChanged = (group.colorPrimary != prevColorPrimary) || (group.colorSecond != prevColorSecond);
  const bool ledCountChanged = (group.ledCount != prevLedCount);
  const bool ledMapChanged = ledCountChanged || memcmp(prevLeds, group.leds, sizeof(prevLeds)) != 0;

  // Preserve runtime animation state across control updates so effects like
  // Larson keep sweeping continuously instead of restarting each payload.
  if (effectChanged || becameEnabled || colorChanged || ledMapChanged) {
    _resetGroupRuntime(group);
  }

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
    dst.custom1 = meta.defaultCustom1;
    dst.custom2 = meta.defaultCustom2;
    dst.custom3 = meta.defaultCustom3;
    dst.check1 = meta.defaultCheck1;
    dst.check2 = meta.defaultCheck2;
    dst.check3 = meta.defaultCheck3;
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
    const FxMetadata& meta = metadataForEffect(dst.effect);
    dst.speed = (uint8_t)((uint16_t)constrain((int)src.effectSpeed, 0, 100) * 255U / 100U);
    dst.intensity = (uint8_t)((uint16_t)constrain((int)src.effectIntensity, 0, 100) * 255U / 100U);
    dst.custom1 = meta.defaultCustom1;
    dst.custom2 = meta.defaultCustom2;
    dst.custom3 = meta.defaultCustom3;
    dst.check1 = meta.defaultCheck1;
    dst.check2 = meta.defaultCheck2;
    dst.check3 = meta.defaultCheck3;
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
#if LIGHTS_DIAGNOSTIC_BASICONLY
  // Diagnostic mode: ALWAYS render a pattern, either basicMode if set or default white diagnostic pattern
  if (!_basicMode) {
    // Auto-enable white diagnostic pattern so user can see LEDs are working
    for (int i = 0; i < (int)_numLeds; i++) {
      _setPixelColorMapped(i, 255, 255, 255);  // All white
    }
    _strip.show();
    return;
  }
  // Otherwise fall through to basicMode rendering below
#endif

  // Basic mode: write solid colour directly, skip all group logic.
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

#if LIGHTS_DIAGNOSTIC_STABLE_SINE
  // Deterministic diagnostic path: no group mapping, no random effects, no runtime churn.
  const uint32_t nowMs = millis();
  const uint16_t ledSpan = max<uint16_t>(_numLeds, 1U);
  for (uint16_t i = 0; i < _numLeds; i++) {
    const uint8_t phase = static_cast<uint8_t>(((nowMs / 6U) + ((i * 256U) / ledSpan)) & 0xFFU);
    const uint8_t v = triwave8(phase);
    _setPixelColorMapped(i, v, 0, 0);
  }
  _strip.show();
  return;
#endif

  // Group rendering path (normal mode).
  if (xSemaphoreTake(_mutex, 0) != pdTRUE) return;

  memset(_frameBuffer, 0, _numLeds * sizeof(uint32_t));

  if (_master) {
    const uint32_t nowMs = millis();
#if LIGHTS_DIAGNOSTIC_FORCE_FIRST_GROUP_FULL_STRIP
    for (int i = 0; i < _groupCount; i++) {
      EngineLightGroup& src = _groups[i];
      if (!src.enabled || src.ledCount == 0) continue;

      const uint8_t savedLedCount = src.ledCount;
      uint16_t savedLeds[LIGHTS_ENGINE_MAX_GROUP_LEDS];
      memcpy(savedLeds, src.leds, sizeof(savedLeds));

      src.ledCount = static_cast<uint8_t>(min<uint16_t>(_numLeds, LIGHTS_ENGINE_MAX_GROUP_LEDS));
      for (uint8_t p = 0; p < src.ledCount; p++) {
        src.leds[p] = p;
      }

      runEffect(src, nowMs);
      for (uint8_t p = 0; p < src.ledCount; p++) {
        _frameBuffer[p] = src.pixels[p];
      }

      src.ledCount = savedLedCount;
      memcpy(src.leds, savedLeds, sizeof(savedLeds));
      src.runtime.tick++;
      break;
    }
#else
    int renderOrder[LIGHTS_ENGINE_MAX_GROUPS];
    int renderCount = 0;
    for (int i = 0; i < _groupCount && i < LIGHTS_ENGINE_MAX_GROUPS; i++) {
      EngineLightGroup& group = _groups[i];
      if (!group.enabled || group.ledCount == 0) continue;
      renderOrder[renderCount++] = i;
    }

    // Render broad/background groups first and narrower mapped groups last so mapped colors win overlaps.
    // Ties use index priority where lower index renders later (wins).
    for (int a = 0; a < renderCount - 1; a++) {
      for (int b = a + 1; b < renderCount; b++) {
        EngineLightGroup& ga = _groups[renderOrder[a]];
        EngineLightGroup& gb = _groups[renderOrder[b]];
        const bool swapByCoverage = ga.ledCount < gb.ledCount;
        const bool sameCoverage = ga.ledCount == gb.ledCount;
        const bool swapByIndex = sameCoverage && (renderOrder[a] < renderOrder[b]);
        if (swapByCoverage || swapByIndex) {
          const int tmp = renderOrder[a];
          renderOrder[a] = renderOrder[b];
          renderOrder[b] = tmp;
        }
      }
    }

    int renderedGroups = 0;
    for (int i = 0; i < renderCount; i++) {
#if LIGHTS_DIAGNOSTIC_MAX_GROUPS > 0
      if (renderedGroups >= LIGHTS_DIAGNOSTIC_MAX_GROUPS) break;
#endif
      EngineLightGroup& group = _groups[renderOrder[i]];
      runEffect(group, nowMs);
      _blitGroupPixels(group);
      group.runtime.tick++;
      renderedGroups++;
    }
#endif
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