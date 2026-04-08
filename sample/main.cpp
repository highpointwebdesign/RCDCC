/*
 * TRX4 Active Suspension System
 * ESP32-S3  |  MPU6050  |  4x 270° Digital Servos
 *
 * Pinout:
// ─────────────────────────────────────────────
 *    FL → GPIO 25
 *    FR → GPIO 26
 *    RL → GPIO 17
 *    RR → GPIO 18
 *    MPU6050 SDA → GPIO 21
 *    MPU6050 SCL → GPIO 22
 *
 * Architecture:
 *   Core 0 — MPU6050 sampling task
 *   Core 1 — Suspension control loop + WebSocket broadcast
 *   AsyncWebServer handles HTTP/WS on both cores via ISR
 */

#include <Arduino.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <AsyncTCP.h>
#include <Preferences.h>
#include <ESP32Servo.h>
#include <MPU6050.h>
#include <Wire.h>
#include <ArduinoJson.h>

#include "suspension.h"
#include "webui.h"

// ─────────────────────────────────────────────
//  WiFi credentials — change before flashing
// ─────────────────────────────────────────────
#define WIFI_SSID  "CAMELOT"
#define WIFI_PASS  "bluedaisy347"

// If connection fails, fall back to AP mode
#define AP_SSID    "TRX4-Suspension"
#define AP_PASS    "trx4admin"

// ─────────────────────────────────────────────
//  Globals
// ─────────────────────────────────────────────
AsyncWebServer  server(80);
AsyncWebSocket  ws("/ws");
Preferences     prefs;
MPU6050         mpu;

SuspensionConfig cfg;

ServoChannel servos[4] = {
    {"FL", SERVO_FL_PIN, false, SERVO_DEG_MID, 0.0f, SERVO_MECH_DEG_MIN, SERVO_MECH_DEG_MAX},
    {"FR", SERVO_FR_PIN, false, SERVO_DEG_MID, 0.0f, SERVO_MECH_DEG_MIN, SERVO_MECH_DEG_MAX},
    {"RL", SERVO_RL_PIN, false, SERVO_DEG_MID, 0.0f, SERVO_MECH_DEG_MIN, SERVO_MECH_DEG_MAX},
    {"RR", SERVO_RR_PIN, false, SERVO_DEG_MID, 0.0f, SERVO_MECH_DEG_MIN, SERVO_MECH_DEG_MAX},
};

// WebSocket message accumulator (handles fragmented frames)
static uint8_t  wsMsgBuf[512];
static size_t   wsMsgLen = 0;

// MPU data shared between tasks (use volatile + mutex)
SemaphoreHandle_t mpuMutex;
volatile float rawPitch = 0.0f;
volatile float rawRoll  = 0.0f;
volatile bool  mpuReady = false;

// Baseline (set during boot settle)
float basePitch = 0.0f;
float baseRoll  = 0.0f;

// Spring-damper state (virtual chassis physics)
float posP = 0.0f;  // spring output position — pitch axis (degrees)
float posR = 0.0f;  // spring output position — roll axis (degrees)
float velP = 0.0f;  // body velocity — pitch axis (deg/s)
float velR = 0.0f;  // body velocity — roll axis (deg/s)
float setP = 0.0f;  // equilibrium target — slews toward measured pitch
float setR = 0.0f;  // equilibrium target — slews toward measured roll

// Serial plotter throttle (20 Hz)
uint32_t lastPlotMs = 0;

// Calibration state
volatile bool calibRunning = false;
int8_t        calibDirFL = 0, calibDirFR = 0, calibDirRL = 0, calibDirRR = 0;

// Manual override — pauses control loop so test/direct commands aren't overwritten
volatile bool manualOverride = false;
uint32_t      manualOverrideUntil = 0;
#define MANUAL_OVERRIDE_MS  2000   // control loop pauses for 2s after a direct command

// Telemetry broadcast throttle
uint32_t lastBroadcast = 0;
#define BROADCAST_INTERVAL_MS  100   // max 10 Hz UI updates regardless of sensor rate

// Last saturation state — updated by control loop, read by telemetry broadcast
volatile bool lastSatFL = false, lastSatFR = false, lastSatRL = false, lastSatRR = false;

enum class WsPressureLevel : uint8_t {
    Low = 0,
    Medium = 1,
    High = 2,
};

volatile uint8_t lastWsPressure = (uint8_t)WsPressureLevel::Low;
volatile uint8_t lastWsClients = 0;
volatile uint8_t lastWsBlockedClients = 0;
volatile uint8_t lastWsFullClients = 0;
volatile uint8_t lastWsMaxQueueLen = 0;
volatile uint8_t lastWsSendStatus = (uint8_t)AsyncWebSocket::ENQUEUED;
uint32_t lastWsPressureLogMs = 0;
uint8_t lastWsPressureLogged = 255;

// ─────────────────────────────────────────────
//  Forward declarations
// ─────────────────────────────────────────────
void mpuTask(void *param);
void controlTask(void *param);
void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client,
               AwsEventType type, void *arg, uint8_t *data, size_t len);
void handleWsMessage(AsyncWebSocketClient *client, uint8_t *data, size_t len);
void broadcastTelemetry();
void broadcastCalibLog(const String &msg);
void sendFullState(AsyncWebSocketClient *client);
void saveAllPrefs();
void loadAllPrefs();
void runAutoCalibrate();
void runServoCalibrate(uint8_t idx);
void testServo(uint8_t idx, int dir);
void centerAllServos();
void sampleWsPressure(AsyncWebSocket::SendStatus sendStatus);
const char* wsPressureLabel(WsPressureLevel level);
const char* wsSendStatusLabel(AsyncWebSocket::SendStatus status);

const char* wsPressureLabel(WsPressureLevel level) {
    switch (level) {
        case WsPressureLevel::Low:    return "LOW";
        case WsPressureLevel::Medium: return "MEDIUM";
        case WsPressureLevel::High:   return "HIGH";
        default:                      return "UNKNOWN";
    }
}

const char* wsSendStatusLabel(AsyncWebSocket::SendStatus status) {
    switch (status) {
        case AsyncWebSocket::DISCARDED:          return "DISCARDED";
        case AsyncWebSocket::ENQUEUED:           return "ENQUEUED";
        case AsyncWebSocket::PARTIALLY_ENQUEUED: return "PARTIAL";
        default:                                 return "UNKNOWN";
    }
}

void sampleWsPressure(AsyncWebSocket::SendStatus sendStatus) {
    uint8_t clients = 0;
    uint8_t blockedClients = 0;
    uint8_t fullClients = 0;
    uint8_t maxQueueLen = 0;

    for (auto &client : ws.getClients()) {
        if (client.status() != WS_CONNECTED) continue;
        clients++;

        size_t queueLen = client.queueLen();
        if (queueLen > maxQueueLen) {
            maxQueueLen = (uint8_t)min(queueLen, (size_t)255);
        }
        if (!client.canSend()) blockedClients++;
        if (client.queueIsFull()) fullClients++;
    }

    WsPressureLevel level = WsPressureLevel::Low;
    if (sendStatus == AsyncWebSocket::DISCARDED || fullClients > 0 || maxQueueLen >= 8) {
        level = WsPressureLevel::High;
    } else if (sendStatus == AsyncWebSocket::PARTIALLY_ENQUEUED || blockedClients > 0 || maxQueueLen >= 2 || !ws.availableForWriteAll()) {
        level = WsPressureLevel::Medium;
    }

    lastWsPressure = (uint8_t)level;
    lastWsClients = clients;
    lastWsBlockedClients = blockedClients;
    lastWsFullClients = fullClients;
    lastWsMaxQueueLen = maxQueueLen;
    lastWsSendStatus = (uint8_t)sendStatus;

    // determines the load placed on the websocket communications
    // if ((uint8_t)level != lastWsPressureLogged || millis() - lastWsPressureLogMs >= 2000) {
    //     lastWsPressureLogged = (uint8_t)level;
    //     lastWsPressureLogMs = millis();
    //     Serial.printf("[WSQ] %s clients=%u blocked=%u full=%u maxQ=%u send=%s\n",
    //                   wsPressureLabel(level), clients, blockedClients, fullClients,
    //                   maxQueueLen, wsSendStatusLabel(sendStatus));
    // }
}

// ─────────────────────────────────────────────
//  MPU Task — Core 0
//  Reads accelerometer, computes pitch/roll via
//  complementary filter, stores behind mutex.
// ─────────────────────────────────────────────
void mpuTask(void *param) {
    // Wire already started in setup() — just configure clock speed
    Wire.setClock(400000);

    // Init MPU6050
    mpu.initialize();
    if (!mpu.testConnection()) {
        Serial.println("[MPU] Connection FAILED — check wiring");
        vTaskDelete(NULL);
        return;
    }
    Serial.println("[MPU] Connected OK");

    // Configure: ±2g accel, ±250°/s gyro, DLPF 42Hz
    mpu.setFullScaleAccelRange(MPU6050_ACCEL_FS_2);
    mpu.setFullScaleGyroRange(MPU6050_GYRO_FS_250);
    mpu.setDLPFMode(MPU6050_DLPF_BW_42);

    // ── Settle delay ──────────────────────────
    Serial.println("[MPU] Settling 5s before baseline...");
    vTaskDelay(pdMS_TO_TICKS(MPU_SETTLE_MS));

    // ── Compute baseline (average N samples) ──
    double sumP = 0, sumR = 0;
    int16_t ax, ay, az, gx, gy, gz;
    for (int i = 0; i < BASELINE_SAMPLES; i++) {
        mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
        float accPitch = atan2f((float)ay, (float)az) * RAD_TO_DEG;
        float accRoll  = atan2f((float)ax, (float)az) * RAD_TO_DEG;
        sumP += accPitch;
        sumR += accRoll;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (xSemaphoreTake(mpuMutex, portMAX_DELAY)) {
        basePitch = (float)(sumP / BASELINE_SAMPLES);
        baseRoll  = (float)(sumR / BASELINE_SAMPLES);
        xSemaphoreGive(mpuMutex);
    }
    Serial.printf("[MPU] Baseline: pitch=%.2f  roll=%.2f\n", basePitch, baseRoll);
    mpuReady = true;

    // ── Complementary filter loop ─────────────
    // Alpha: how much to trust gyro vs accelerometer
    // Higher alpha = smoother but more lag
    const float ALPHA = 0.96f;
    float pitch = basePitch;
    float roll  = baseRoll;
    uint32_t lastTime = micros();

    for (;;) {
        // Interval from sensor refresh rate setting
        uint32_t intervalMs = 1000 / max((uint8_t)10, cfg.refreshRateHz);

        mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);

        uint32_t now = micros();
        float dt = (now - lastTime) / 1e6f;
        lastTime = now;

        // Accelerometer angles
        float accPitch = atan2f((float)ay, (float)az) * RAD_TO_DEG;
        float accRoll  = atan2f((float)ax, (float)az) * RAD_TO_DEG;

        // Gyro rates (degrees/sec)
        float gyroX = (float)gx / 131.0f;
        float gyroY = (float)gy / 131.0f;

        // Complementary filter
        pitch = ALPHA * (pitch + gyroY * dt) + (1.0f - ALPHA) * accPitch;
        roll  = ALPHA * (roll  + gyroX * dt) + (1.0f - ALPHA) * accRoll;

        if (xSemaphoreTake(mpuMutex, pdMS_TO_TICKS(5))) {
            rawPitch = pitch - basePitch;
            rawRoll  = roll  - baseRoll;
            xSemaphoreGive(mpuMutex);
        }

        vTaskDelay(pdMS_TO_TICKS(intervalMs));
    }
}

// ─────────────────────────────────────────────
//  Control Task — Core 1
//  Reads filtered IMU data, computes corner
//  targets, drives servos with low-pass smoothing.
// ─────────────────────────────────────────────
void controlTask(void *param) {
    // Wait for MPU baseline — but still apply ride height while waiting
    while (!mpuReady) {
        float rideDegs = SERVO_DEG_MID + cfg.rideHeight * (SUSPENSION_TRAVEL_DEG / 2.0f);
        for (auto &sv : servos) sv.writeDeg(rideDegs);
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    Serial.println("[CTRL] Starting control loop");

    // Prime spring-damper state from first real reading so there is no
    // startup lurch across the full travel range.
    if (xSemaphoreTake(mpuMutex, portMAX_DELAY)) {
        float rp = rawPitch, rr = rawRoll;
        xSemaphoreGive(mpuMutex);
        applyOrientation(cfg.mpuOrientation, rp, rr, posP, posR);
        setP = posP;  setR = posR;
    }

    // Run control loop at a fixed fast rate for fluid servo motion.
    // MPU sampling can remain slower; we always use latest available reading.
    const uint32_t CTRL_INTERVAL_MS = 10; // 100 Hz

    for (;;) {
        // Pause loop during calibration or manual override (test buttons / direct commands)
        if (calibRunning) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        if (manualOverride) {
            if (millis() >= manualOverrideUntil) {
                manualOverride = false;
            } else {
                vTaskDelay(pdMS_TO_TICKS(20));
                continue;
            }
        }

        float pitch = 0, roll = 0;
        if (xSemaphoreTake(mpuMutex, pdMS_TO_TICKS(5))) {
            pitch = rawPitch;
            roll  = rawRoll;
            xSemaphoreGive(mpuMutex);
        }

        // Apply orientation remapping
        float mappedPitch, mappedRoll;
        applyOrientation(cfg.mpuOrientation, pitch, roll, mappedPitch, mappedRoll);

        // Input deadband + hysteresis to suppress stationary MPU noise.
        // Use a soft edge so crossing the threshold does not feel like start/stop stepping.
        static bool pitchEngaged = false;
        static bool rollEngaged  = false;
        auto applyDeadbandHyst = [&](float in, bool &engaged) -> float {
            float a = fabsf(in);
            float db = constrain(cfg.inputDeadband, 0.0f, 1.0f);
            float hy = constrain(cfg.inputHyst,     0.0f, 0.5f);

            if (engaged) {
                if (a <= db) {
                    engaged = false;
                    return 0.0f;
                }
                return copysignf(max(0.0f, a - db), in);
            }

            if (a >= (db + hy)) {
                engaged = true;
                return copysignf(max(0.0f, a - db), in);
            }
            return 0.0f;
        };
        float gatedPitch = applyDeadbandHyst(mappedPitch, pitchEngaged);
        float gatedRoll  = applyDeadbandHyst(mappedRoll,  rollEngaged);

        // Mild input smoothing to remove jagged setpoint changes without killing responsiveness.
        static float inPitch = 0.0f;
        static float inRoll  = 0.0f;
        const float inputAlpha = 0.28f;
        inPitch += inputAlpha * (gatedPitch - inPitch);
        inRoll  += inputAlpha * (gatedRoll  - inRoll);

        // ── Spring-damper physics ─────────────────────────────────────────────
        // dt from actual elapsed time so physics are sample-rate independent.
        static uint32_t lastCtrlUs = 0;
        uint32_t nowUs = micros();
        float dt = (lastCtrlUs == 0)
                   ? (CTRL_INTERVAL_MS / 1000.0f)
                   : constrain((nowUs - lastCtrlUs) / 1e6f, 0.001f, 0.1f);
        lastCtrlUs = nowUs;

        // Slew equilibrium target toward measured angle.
        // reactionSpeed=1.0 → 50 deg/s, reactionSpeed=0.1 → 5 deg/s.
        float slewMax = cfg.reactionSpeed * 50.0f * dt;
        setP += constrain(inPitch - setP, -slewMax, slewMax);
        setR += constrain(inRoll  - setR, -slewMax, slewMax);

        // 2nd-order underdamped spring-damper (Euler integration).
        //   acceleration = ωₙ²(setPoint − pos) − 2ζωₙ·vel
        //   zeta < 1.0 → underdamped → decaying oscillations (worn-shock feel)
        float wn    = cfg.omegaN;
        float wn2   = wn * wn;
        float c2wn  = 2.0f * cfg.zeta * wn;
        velP += (wn2 * (setP - posP) - c2wn * velP) * dt;
        velR += (wn2 * (setR - posR) - c2wn * velR) * dt;
        posP += velP * dt;
        posR += velR * dt;

        // ── Teleplot serial output (20 Hz) ────────────────────────────────────
        // Teleplot format: ">varName:value\n" — one variable per line.
        // In VS Code open Command Palette → "Teleplot: Open"
        // then connect to COM4 at 115200.
        if (millis() - lastPlotMs >= 50) {
            lastPlotMs = millis();
            Serial.printf(">roll_out:%.2f\n>roll_in:%.2f\n>pitch_out:%.2f\n>pitch_in:%.2f\n",
                          posR, inRoll, posP, inPitch);
        }

        if (cfg.active) {
            CornerTargets t = computeTargets(posP, posR, cfg);

            servos[0].writeDeg(t.fl);
            servos[1].writeDeg(t.fr);
            servos[2].writeDeg(t.rl);
            servos[3].writeDeg(t.rr);

            // Latch saturation flags for telemetry.
            // Include both global envelope and per-servo min/max/trim limits.
            lastSatFL = t.satFL || servos[0].wouldSaturate(t.fl);
            lastSatFR = t.satFR || servos[1].wouldSaturate(t.fr);
            lastSatRL = t.satRL || servos[2].wouldSaturate(t.rl);
            lastSatRR = t.satRR || servos[3].wouldSaturate(t.rr);
        } else {
            // Inactive: hold ride height only — convert to absolute degrees
            float rideDegs = SERVO_DEG_MID + cfg.rideHeight * (SUSPENSION_TRAVEL_DEG / 2.0f);
            for (auto &sv : servos) sv.writeDeg(rideDegs);
        }

        // Broadcast telemetry at reduced rate to avoid WS queue buildup
        if (millis() - lastBroadcast >= BROADCAST_INTERVAL_MS) {
            lastBroadcast = millis();
            broadcastTelemetry();
        }

        vTaskDelay(pdMS_TO_TICKS(CTRL_INTERVAL_MS));
    }
}

// ─────────────────────────────────────────────
//  WebSocket event handler
// ─────────────────────────────────────────────
void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client,
               AwsEventType type, void *arg, uint8_t *data, size_t len) {
    if (type == WS_EVT_CONNECT) {
        Serial.printf("[WS] Client #%u connected\n", client->id());
        ws.cleanupClients();
        wsMsgLen = 0;   // reset accumulator on new connection
        sendFullState(client);
    }
    else if (type == WS_EVT_DISCONNECT) {
        Serial.printf("[WS] Client #%u disconnected\n", client->id());
        wsMsgLen = 0;
    }
    else if (type == WS_EVT_DATA) {
        AwsFrameInfo *info = (AwsFrameInfo *)arg;
        if (info->opcode != WS_TEXT) return;

        // Accumulate chunks — AsyncWebServer may split a single WS message
        // into multiple callbacks before setting info->final
        if (wsMsgLen + len < sizeof(wsMsgBuf)) {
            memcpy(wsMsgBuf + wsMsgLen, data, len);
            wsMsgLen += len;
        } else {
            Serial.println("[WS] Message too large — discarding");
            wsMsgLen = 0;
            return;
        }

        // Process only when the final fragment arrives
        if (info->final) {
            wsMsgBuf[wsMsgLen] = '\0';
            Serial.printf("[WS] RX: %s\n", (char*)wsMsgBuf);
            handleWsMessage(client, wsMsgBuf, wsMsgLen);
            wsMsgLen = 0;
        }
    }
    else if (type == WS_EVT_ERROR) {
        Serial.printf("[WS] Error from client #%u\n", client->id());
        wsMsgLen = 0;
    }
}

void handleWsMessage(AsyncWebSocketClient *client, uint8_t *data, size_t len) {
    StaticJsonDocument<512> doc;
    if (deserializeJson(doc, data, len) != DeserializationError::Ok) return;

    const char* cmd = doc["cmd"] | "";

    // ── getState ─────────────────────────────
    if (strcmp(cmd, "getState") == 0) {
        sendFullState(client);
    }

    // ── set (global setting) ─────────────────
    else if (strcmp(cmd, "set") == 0) {
        const char* key = doc["key"] | "";
        float val = doc["val"] | 0.0f;

        if      (strcmp(key,"rideHeight")    == 0) {
            cfg.rideHeight = constrain(val,-1.0f,1.0f);
            // Immediately move all servos to new ride height (absolute degrees)
            float rideDegs = SERVO_DEG_MID + cfg.rideHeight * (SUSPENSION_TRAVEL_DEG / 2.0f);
            manualOverride      = true;
            manualOverrideUntil = millis() + MANUAL_OVERRIDE_MS;
            for (auto &sv : servos) sv.writeDeg(rideDegs);
        }
        else if (strcmp(key,"reactionSpeed") == 0) cfg.reactionSpeed = constrain(val,0.0f,1.0f);
        else if (strcmp(key,"range")         == 0) cfg.range         = constrain(val,0.1f,4.0f);
        else if (strcmp(key,"inputDeadband") == 0) cfg.inputDeadband = constrain(val,0.0f,1.0f);
        else if (strcmp(key,"inputHyst")     == 0) cfg.inputHyst     = constrain(val,0.0f,0.5f);
        else if (strcmp(key,"omegaN")        == 0) cfg.omegaN        = constrain(val,0.5f,15.0f);
        else if (strcmp(key,"zeta")          == 0) cfg.zeta          = constrain(val,0.05f,0.95f);
        else if (strcmp(key,"balance")       == 0) cfg.balance       = constrain(val,-1.0f,1.0f);
        else if (strcmp(key,"refreshRate")   == 0) cfg.refreshRateHz = (uint8_t)val;
        else if (strcmp(key,"mpuOri")        == 0) cfg.mpuOrientation = (MPUOrientation)(uint8_t)val;
        else if (strcmp(key,"active")        == 0) {
            cfg.active = (val != 0.0f);
            if (!cfg.active) {
                float rideDegs = SERVO_DEG_MID + cfg.rideHeight * (SUSPENSION_TRAVEL_DEG / 2.0f);
                manualOverride      = true;
                manualOverrideUntil = millis() + MANUAL_OVERRIDE_MS;
                for (auto &sv : servos) sv.writeDeg(rideDegs);
            }
        }

        prefs.begin("susp", false);
        cfg.save(prefs);
        prefs.end();
    }

    // ── setServo (per-channel setting) ───────
    else if (strcmp(cmd, "setServo") == 0) {
        uint8_t idx = doc["idx"] | 0;
        if (idx >= 4) return;
        const char* key = doc["key"] | "";
        float val = doc["val"] | 0.0f;

        if (strcmp(key,"inv") == 0) {
            servos[idx].inverted = (val != 0.0f);
            manualOverride      = true;
            manualOverrideUntil = millis() + MANUAL_OVERRIDE_MS;
            servos[idx].writeDeg(servos[idx].currentDeg);
        }
        else if (strcmp(key,"trim") == 0) {
            servos[idx].trimDeg = constrain(val, -30.0f, 30.0f);
            manualOverride      = true;
            manualOverrideUntil = millis() + MANUAL_OVERRIDE_MS;
            servos[idx].writeDeg(servos[idx].currentDeg);
        }
        else if (strcmp(key,"min") == 0) {
            servos[idx].mechMinDeg = constrain(val, SERVO_DEG_MIN, SERVO_DEG_MAX);
            servos[idx].sanitizeLimits();
            manualOverride      = true;
            manualOverrideUntil = millis() + MANUAL_OVERRIDE_MS;
            servos[idx].writeDeg(servos[idx].currentDeg);
        }
        else if (strcmp(key,"max") == 0) {
            servos[idx].mechMaxDeg = constrain(val, SERVO_DEG_MIN, SERVO_DEG_MAX);
            servos[idx].sanitizeLimits();
            manualOverride      = true;
            manualOverrideUntil = millis() + MANUAL_OVERRIDE_MS;
            servos[idx].writeDeg(servos[idx].currentDeg);
        }

        prefs.begin("susp", false);
        servos[idx].savePrefs(prefs);
        prefs.end();
    }

    // ── testServo ─────────────────────────────
    else if (strcmp(cmd, "testServo") == 0) {
        uint8_t idx = doc["idx"] | 0;
        int dir     = doc["dir"] | 0;
        if (idx < 4) testServo(idx, dir);
    }

    // ── calibrate (all 4) ────────────────────
    else if (strcmp(cmd, "calibrate") == 0) {
        // Run on a separate task so control loop stays alive
        xTaskCreate([](void*){ runAutoCalibrate(); vTaskDelete(NULL); },
                    "calib", 4096, NULL, 1, NULL);
    }

    // ── calibrate single servo ───────────────
    else if (strcmp(cmd, "calibServo") == 0) {
        uint8_t idx = doc["idx"] | 0;
        if (idx < 4) {
            uint8_t *idxPtr = new uint8_t(idx);
            xTaskCreate([](void *p){
                runServoCalibrate(*(uint8_t*)p);
                delete (uint8_t*)p;
                vTaskDelete(NULL);
            }, "calibSingle", 4096, idxPtr, 1, NULL);
        }
    }

    // ── rebaseline ───────────────────────────
    else if (strcmp(cmd, "rebaseline") == 0) {
        broadcastCalibLog("Re-baselining in 5s — place on flat surface...");
        vTaskDelay(pdMS_TO_TICKS(5000));
        double sumP = 0, sumR = 0;
        int16_t ax, ay, az, gx, gy, gz;
        for (int i = 0; i < BASELINE_SAMPLES; i++) {
            mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
            sumP += atan2f((float)ay,(float)az) * RAD_TO_DEG;
            sumR += atan2f((float)ax,(float)az) * RAD_TO_DEG;
            delay(10);
        }
        if (xSemaphoreTake(mpuMutex, portMAX_DELAY)) {
            basePitch = (float)(sumP / BASELINE_SAMPLES);
            baseRoll  = (float)(sumR / BASELINE_SAMPLES);
            xSemaphoreGive(mpuMutex);
        }
        broadcastCalibLog("Baseline set: P=" + String(basePitch,2) +
                          "  R=" + String(baseRoll,2));
    }

    // ── center_all ───────────────────────────
    else if (strcmp(cmd, "center_all") == 0) {
        centerAllServos();
        broadcastCalibLog("All servos centered.");
    }
}

// ─────────────────────────────────────────────
//  Auto-calibrate all 4 servos
//  Moves each servo ±, reads MPU response,
//  determines correct direction, then levels.
// ─────────────────────────────────────────────
void runAutoCalibrate() {
    calibRunning = true;
    broadcastCalibLog("=== AUTO CALIBRATE START ===");

    const char* names[] = {"FL","FR","RL","RR"};
    int8_t dirs[4] = {0, 0, 0, 0};

    for (uint8_t i = 0; i < 4; i++) {
        broadcastCalibLog("Testing servo " + String(names[i]) + "...");

        // 1. Center the servo
        servos[i].writeDeg(SERVO_DEG_MID);
        delay(500);

        // 2. Read MPU baseline for this test
        float p0 = 0, r0 = 0;
        if (xSemaphoreTake(mpuMutex, portMAX_DELAY)) {
            p0 = rawPitch; r0 = rawRoll;
            xSemaphoreGive(mpuMutex);
        }
        delay(200);

        // 3. Move +20 degrees from center
        float testPos = SERVO_DEG_MID + 20.0f;
        servos[i].writeDeg(testPos);
        delay(600);   // let chassis settle

        float p1 = 0, r1 = 0;
        if (xSemaphoreTake(mpuMutex, portMAX_DELAY)) {
            p1 = rawPitch; r1 = rawRoll;
            xSemaphoreGive(mpuMutex);
        }

        // 4. Return to center
        servos[i].writeDeg(SERVO_DEG_MID);
        delay(400);

        // 5. Determine which axis this corner affects most
        float dp = fabsf(p1 - p0);
        float dr = fabsf(r1 - r0);
        float change = (dp > dr) ? (p1 - p0) : (r1 - r0);

        // If chassis went UP when servo moved +, dir=+1 (raise = + degrees)
        // If chassis went DOWN, dir=-1 (need to invert)
        dirs[i] = (change > 0) ? 1 : -1;

        broadcastCalibLog("  -> " + String(names[i]) + " dir=" +
                          String(dirs[i]) + "  dp=" + String(dp,2) +
                          "  dr=" + String(dr,2));

        // Update servo inversion flag based on expected vs actual
        // Convention: positive correction = chassis should rise = servo moves +
        // FL/RL left-side: if dir=-1, they're inverted
        // FR/RR right-side: if dir=+1, they're inverted (opposite side convention)
        bool expectedPos = (i == 1 || i == 3); // FR, RR expected to be -1 (right side)
        bool shouldInvert;
        if (expectedPos) {
            shouldInvert = (dirs[i] == 1);   // right side: + should lower
        } else {
            shouldInvert = (dirs[i] == -1);  // left side: + should raise
        }

        if (shouldInvert != servos[i].inverted) {
            servos[i].inverted = shouldInvert;
            broadcastCalibLog("  -> Invert flag updated: " + String(shouldInvert?"YES":"NO"));
            prefs.begin("susp", false);
            servos[i].savePrefs(prefs);
            prefs.end();
        }
    }

    // ── Final leveling pass ───────────────────
    broadcastCalibLog("Leveling chassis...");
    const int MAX_ITER = 20;
    for (int iter = 0; iter < MAX_ITER; iter++) {
        float pitch = 0, roll = 0;
        if (xSemaphoreTake(mpuMutex, portMAX_DELAY)) {
            pitch = rawPitch; roll = rawRoll;
            xSemaphoreGive(mpuMutex);
        }
        float mappedPitch, mappedRoll;
        applyOrientation(cfg.mpuOrientation, pitch, roll, mappedPitch, mappedRoll);

        if (fabsf(mappedPitch) <= LEVEL_TOLERANCE &&
            fabsf(mappedRoll)  <= LEVEL_TOLERANCE) {
            broadcastCalibLog("Level achieved: P=" + String(mappedPitch,2) +
                              "  R=" + String(mappedRoll,2));
            break;
        }

        CornerTargets t = computeTargets(mappedPitch, mappedRoll, cfg);
        servos[0].writeDeg(t.fl);
        servos[1].writeDeg(t.fr);
        servos[2].writeDeg(t.rl);
        servos[3].writeDeg(t.rr);
        delay(250);

        if (iter == MAX_ITER - 1) {
            broadcastCalibLog("WARNING: Could not fully level within tolerance.");
        }
    }

    broadcastCalibLog("=== AUTO CALIBRATE DONE ===");
    calibRunning = false;
}

// ─────────────────────────────────────────────
//  Calibrate a single servo
// ─────────────────────────────────────────────
void runServoCalibrate(uint8_t idx) {
    calibRunning = true;
    broadcastCalibLog("Single calib: servo " + String(servos[idx].name));

    servos[idx].writeDeg(SERVO_DEG_MID);
    delay(500);

    float p0 = 0, r0 = 0;
    if (xSemaphoreTake(mpuMutex, portMAX_DELAY)) {
        p0 = rawPitch; r0 = rawRoll;
        xSemaphoreGive(mpuMutex);
    }
    delay(200);

    servos[idx].writeDeg(SERVO_DEG_MID + 20.0f);
    delay(600);

    float p1 = 0, r1 = 0;
    if (xSemaphoreTake(mpuMutex, portMAX_DELAY)) {
        p1 = rawPitch; r1 = rawRoll;
        xSemaphoreGive(mpuMutex);
    }

    servos[idx].writeDeg(SERVO_DEG_MID);
    delay(400);

    float dp = fabsf(p1 - p0);
    float dr = fabsf(r1 - r0);
    float change = (dp > dr) ? (p1 - p0) : (r1 - r0);
    int8_t dir = (change > 0) ? 1 : -1;

    broadcastCalibLog("  " + String(servos[idx].name) + " dir=" + String(dir) +
                      "  dp=" + String(dp,2) + "  dr=" + String(dr,2));

    calibRunning = false;
}

// ─────────────────────────────────────────────
//  Test a single servo
//  dir:  1 = move to max travel
//        -1 = move to min travel
//        0 = center
// ─────────────────────────────────────────────
void testServo(uint8_t idx, int dir) {
    // Pause control loop so it doesn't overwrite our test position
    manualOverride      = true;
    manualOverrideUntil = millis() + MANUAL_OVERRIDE_MS;

    if (dir == 0) {
        servos[idx].writeDeg(SERVO_DEG_MID);
    } else if (dir > 0) {
        servos[idx].writeDeg(servos[idx].mechMaxDeg);
    } else {
        servos[idx].writeDeg(servos[idx].mechMinDeg);
    }
}

void centerAllServos() {
    for (auto &sv : servos) sv.writeDeg(SERVO_DEG_MID);
}

// ─────────────────────────────────────────────
//  WebSocket broadcasts
// ─────────────────────────────────────────────
void broadcastTelemetry() {
    if (ws.count() == 0) return;  // no clients, skip

    float pitch = 0, roll = 0;
    if (xSemaphoreTake(mpuMutex, pdMS_TO_TICKS(2))) {
        pitch = rawPitch;
        roll  = rawRoll;
        xSemaphoreGive(mpuMutex);
    }

    StaticJsonDocument<256> doc;
    doc["type"]      = "telemetry";
    doc["pitch"]     = pitch;
    doc["roll"]      = roll;
    doc["basePitch"] = basePitch;
    doc["baseRoll"]  = baseRoll;
    doc["satFL"]     = lastSatFL;
    doc["satFR"]     = lastSatFR;
    doc["satRL"]     = lastSatRL;
    doc["satRR"]     = lastSatRR;
    doc["wsPressure"] = lastWsPressure;
    doc["wsClients"]  = lastWsClients;
    doc["wsBlocked"]  = lastWsBlockedClients;
    doc["wsFull"]     = lastWsFullClients;
    doc["wsMaxQ"]     = lastWsMaxQueueLen;

    String out;
    serializeJson(doc, out);
    AsyncWebSocket::SendStatus status = ws.textAll(out);
    sampleWsPressure(status);
}

void broadcastCalibLog(const String &msg) {
    Serial.println("[CALIB] " + msg);
    if (ws.count() == 0) return;

    StaticJsonDocument<256> doc;
    doc["type"] = "calibLog";
    doc["text"] = msg;
    String out;
    serializeJson(doc, out);
    AsyncWebSocket::SendStatus status = ws.textAll(out);
    sampleWsPressure(status);
}

void sendFullState(AsyncWebSocketClient *client) {
    DynamicJsonDocument doc(1024);
    doc["type"] = "state";

    // Global config
    JsonObject cfgObj = doc.createNestedObject("cfg");
    cfgObj["rideHeight"]    = cfg.rideHeight;
    cfgObj["reactionSpeed"] = cfg.reactionSpeed;
    cfgObj["range"]         = cfg.range;
    cfgObj["inputDeadband"] = cfg.inputDeadband;
    cfgObj["inputHyst"]     = cfg.inputHyst;
    cfgObj["omegaN"]        = cfg.omegaN;
    cfgObj["zeta"]          = cfg.zeta;
    cfgObj["balance"]       = cfg.balance;
    cfgObj["refreshRate"]   = cfg.refreshRateHz;
    cfgObj["mpuOri"]        = (uint8_t)cfg.mpuOrientation;
    cfgObj["active"]        = cfg.active;
    cfgObj["wsPressure"]    = lastWsPressure;
    cfgObj["wsClients"]     = lastWsClients;
    cfgObj["wsBlocked"]     = lastWsBlockedClients;
    cfgObj["wsFull"]        = lastWsFullClients;
    cfgObj["wsMaxQ"]        = lastWsMaxQueueLen;

    // Per-servo config
    JsonArray sArr = doc.createNestedArray("servos");
    for (auto &sv : servos) {
        JsonObject s = sArr.createNestedObject();
        s["name"]     = sv.name;
        s["inverted"] = sv.inverted;
        s["trimDeg"]  = sv.trimDeg;
        s["minDeg"]   = sv.mechMinDeg;
        s["maxDeg"]   = sv.mechMaxDeg;
    }

    String out;
    serializeJson(doc, out);
    bool sent = client->text(out);
    sampleWsPressure(sent ? AsyncWebSocket::ENQUEUED : AsyncWebSocket::DISCARDED);
}

// ─────────────────────────────────────────────
//  Prefs helpers
// ─────────────────────────────────────────────
void saveAllPrefs() {
    prefs.begin("susp", false);
    cfg.save(prefs);
    for (auto &sv : servos) sv.savePrefs(prefs);
    prefs.end();
}

void loadAllPrefs() {
    prefs.begin("susp", true);  // read-only
    cfg.load(prefs);
    for (auto &sv : servos) sv.loadPrefs(prefs);
    prefs.end();
}

// ─────────────────────────────────────────────
//  setup()
// ─────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\n[BOOT] TRX4 Active Suspension");

    // ── Load persisted settings ───────────────
    loadAllPrefs();
    Serial.println("[BOOT] Preferences loaded");

    // ── Servo init ────────────────────────────
    // ESP32Servo: allocate PWM timers before attaching
    ESP32PWM::allocateTimer(0);
    ESP32PWM::allocateTimer(1);
    ESP32PWM::allocateTimer(2);
    ESP32PWM::allocateTimer(3);

    for (auto &sv : servos) sv.begin();
    Serial.println("[BOOT] Servos initialized");

    // ── WiFi ──────────────────────────────────
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print("[WIFI] Connecting");
    uint8_t tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 20) {
        delay(500); Serial.print("."); tries++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\n[WIFI] Connected: %s\n", WiFi.localIP().toString().c_str());
    } else {
        Serial.println("\n[WIFI] STA failed — starting AP mode");
        WiFi.mode(WIFI_AP);
        WiFi.softAP(AP_SSID, AP_PASS);
        Serial.printf("[WIFI] AP IP: %s\n", WiFi.softAPIP().toString().c_str());
    }

    // ── WebSocket ─────────────────────────────
    ws.onEvent(onWsEvent);
    server.addHandler(&ws);

    // ── HTTP routes ───────────────────────────
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *req) {
        req->send_P(200, "text/html", WEBUI_HTML);
    });

    server.onNotFound([](AsyncWebServerRequest *req) {
        req->send(404, "text/plain", "Not found");
    });

    server.begin();
    Serial.println("[HTTP] Server started");

    // ── I2C — must init here before MPU task starts ───
    Wire.begin(21, 22);
    Serial.println("[BOOT] I2C initialized");

    // ── Mutex ─────────────────────────────────
    mpuMutex = xSemaphoreCreateMutex();

    // ── FreeRTOS tasks ────────────────────────
    // MPU task on Core 0, priority 2
    xTaskCreatePinnedToCore(mpuTask,     "mpuTask",     8192, NULL, 2, NULL, 0);
    // Control task on Core 1, priority 3
    xTaskCreatePinnedToCore(controlTask, "ctrlTask",    8192, NULL, 3, NULL, 1);

    Serial.println("[BOOT] Tasks launched — system running");
}

// ─────────────────────────────────────────────
//  loop() — nothing here; FreeRTOS runs the show
// ─────────────────────────────────────────────
void loop() {
    ws.cleanupClients();   // periodic WS client GC
    delay(1000);
}