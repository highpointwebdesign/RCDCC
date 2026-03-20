#pragma once

#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>

#include "Config.h"
#include "FX.h"

#define LIGHTS_ENGINE_PIN 27
#define LIGHTS_ENGINE_MAX_LEDS 30
#define LIGHTS_ENGINE_MAX_GROUPS 15
#define LIGHTS_ENGINE_MAX_GROUP_LEDS 15
#define LIGHTS_ENGINE_TASK_HZ 50
#define LIGHTS_ENGINE_TICK_MS (1000 / LIGHTS_ENGINE_TASK_HZ)
#define LIGHTS_ENGINE_CORE 0

using RcdccFx::LightEffect;
using RcdccFx::FxRuntime;

enum LedColorOrder : uint8_t {
    LED_ORDER_GRB = 0,
    LED_ORDER_RGB = 1,
    LED_ORDER_RBG = 2,
    LED_ORDER_GBR = 3,
    LED_ORDER_BRG = 4,
    LED_ORDER_BGR = 5
};

static LedColorOrder colorOrderFromString(const char* name) {
    if (!name) return LED_ORDER_GRB;
    if (strcasecmp(name, "rgb") == 0) return LED_ORDER_RGB;
    if (strcasecmp(name, "rbg") == 0) return LED_ORDER_RBG;
    if (strcasecmp(name, "gbr") == 0) return LED_ORDER_GBR;
    if (strcasecmp(name, "brg") == 0) return LED_ORDER_BRG;
    if (strcasecmp(name, "bgr") == 0) return LED_ORDER_BGR;
    return LED_ORDER_GRB;
}

struct EngineLightGroup {
  char name[24] = {0};
  bool enabled = false;
  uint32_t colorPrimary = 0xFFFFFF;
  uint32_t colorSecond = 0x000000;
  uint8_t brightness = 100;
  LightEffect effect = RcdccFx::FX_SOLID;
  uint8_t speed = RcdccFx::DEFAULT_SPEED;
  uint8_t intensity = RcdccFx::DEFAULT_INTENSITY;
  uint16_t leds[LIGHTS_ENGINE_MAX_GROUP_LEDS] = {0};
  uint8_t ledCount = 0;
  uint32_t pixels[LIGHTS_ENGINE_MAX_GROUP_LEDS] = {0};
  FxRuntime runtime = {};
};
class LightsEngine {
public:
  LightsEngine(uint8_t pin, uint16_t numLeds);
  void begin();
  bool updateGroupFromJson(const String& payload);
  void updateFromPayload(const NewLightsConfig& cfg);
  void loadProfile(const LightingProfile& profile);
  LightingProfile* getProfile();
  void setMaster(bool on);
  bool getMaster() const;
  void setColorOrderByName(const char* orderName);
  void clearAllGroups(bool clearPixels = true);
  void flashAllBlocking(uint32_t color, uint8_t count, uint16_t onMs, uint16_t offMs, volatile bool* cancel = nullptr);
  // Basic diagnostic mode: bypasses all group/profile logic in-task, no RMT contention.
  void setBasicMode(bool on, uint8_t r = 0, uint8_t g = 0, uint8_t b = 0, int count = 0);

private:
  Adafruit_NeoPixel _strip;
  uint16_t _numLeds;
  bool _master;
  int _groupCount;
  LedColorOrder _colorOrder;
  EngineLightGroup _groups[LIGHTS_ENGINE_MAX_GROUPS];
  uint32_t _frameBuffer[LIGHTS_ENGINE_MAX_LEDS];
  TaskHandle_t _taskHandle = nullptr;
  LightingProfile _exportProfile;
  SemaphoreHandle_t _mutex = xSemaphoreCreateMutex();
  // Basic mode state (written from BLE handler, read from task — volatile for visibility)
  volatile bool    _basicMode  = false;
  volatile uint8_t _basicR = 0, _basicG = 0, _basicB = 0;
  volatile int     _basicCount = 0;

  static void _task(void* arg);
  void _tick();
  void _resetGroupRuntime(EngineLightGroup& group);
  void _setGroupLed(const EngineLightGroup& group, uint8_t slot, uint32_t color);
  void _blitGroupPixels(const EngineLightGroup& group);
  void _fillAll(uint32_t color);
  void _setPixelColorMapped(uint16_t idx, uint8_t r, uint8_t g, uint8_t b);
  void _showFrameBuffer();
  static uint32_t _parseHex(const char* value);
};
