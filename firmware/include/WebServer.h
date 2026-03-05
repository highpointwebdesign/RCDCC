#ifndef WEBSERVER_H
#define WEBSERVER_H

#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <functional>
#include "StorageManager.h"
#include "LightsEngine.h"

class WebServerManager {
private:
  AsyncWebServer server{80};
  StorageManager* storageManager = nullptr;
  LightsEngine* lightsEngine = nullptr;  // Reference to lights engine
  std::function<void()> calibrationCallback = nullptr;
  std::function<bool()> mpuStatusCallback = nullptr;
  std::function<void(uint8_t)> orientationCallback = nullptr;
  std::function<void()> ledBlinkCallback = nullptr;
  std::function<void()> ledUpdateCallback = nullptr;
  std::function<void(String)> emergencyLightSetCallback = nullptr;
  std::function<void(String&)> emergencyLightGetCallback = nullptr;
  
  // Latest sensor data for HTTP polling
  float latestRoll = 0.0f;
  float latestPitch = 0.0f;
  float latestYaw = 0.0f;
  float latestVerticalAccel = 0.0f;
  
  // Buffer for POST request bodies (prevents data corruption from freed memory)
  String lightsPostBuffer;
  size_t lightsPostTotalSize = 0;

  enum WifiState {
    WIFI_STATE_IDLE,
    WIFI_STATE_STA_CONNECTING,
    WIFI_STATE_STA_CONNECTED,
    WIFI_STATE_AP_FALLBACK
  };

  WifiState wifiState = WIFI_STATE_IDLE;
  bool apStarted = false;
  bool wifiConnectedLogged = false;
  unsigned long staConnectStart = 0;
  unsigned long lastReconnectAttempt = 0;
  const unsigned long reconnectIntervalMs = 15000;
  
public:
  void init(StorageManager& storage, LightsEngine* lights) {
    storageManager = &storage;
    lightsEngine = lights;

    // Start WiFi state machine (WLED-inspired STA first, AP fallback)
    startWiFiManager();
    
    // Setup web server routes
    setupRoutes();
    
    // Start server
    server.begin();
    Serial.println("Web server started on port 80");
  }

  void updateConnectivity() {
    wl_status_t status = WiFi.status();

    if (status == WL_CONNECTED) {
      if (!wifiConnectedLogged) {
        Serial.printf("WiFi connected: SSID=%s, IP=%s\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
        wifiConnectedLogged = true;
      }

      if (wifiState != WIFI_STATE_STA_CONNECTED) {
        wifiState = WIFI_STATE_STA_CONNECTED;
        if (apStarted) {
          WiFi.softAPdisconnect(true);
          apStarted = false;
          Serial.println("AP disabled after STA connection restored");
        }
      }
      return;
    }

    wifiConnectedLogged = false;

    if (wifiState == WIFI_STATE_STA_CONNECTING) {
      if (millis() - staConnectStart >= WIFI_CONNECT_TIMEOUT) {
        Serial.println("STA connect timeout, enabling AP fallback");
        startFallbackAP();
      }
      return;
    }

    if (wifiState == WIFI_STATE_AP_FALLBACK) {
      if (millis() - lastReconnectAttempt >= reconnectIntervalMs) {
        lastReconnectAttempt = millis();
        Serial.println("AP fallback active; retrying STA connection in background...");
        WiFi.mode(WIFI_AP_STA);
        WiFi.begin(HOME_WIFI_SSID, HOME_WIFI_PASSWORD);
      }
      return;
    }

    // Recover if state is unknown
    startWiFiManager();
  }
  
  // WebSocket telemetry and status functions have been removed
  // All communication is now HTTP-based (poll model)
  
  // Set calibration callback for MPU6050 recalibration
  void setCalibrationCallback(std::function<void()> callback) {
    calibrationCallback = callback;
  }
  
  void setMPUStatusCallback(std::function<bool()> callback) {
    mpuStatusCallback = callback;
  }
  
  void setOrientationCallback(std::function<void(uint8_t)> callback) {
    orientationCallback = callback;
  }
  
  void setLedBlinkCallback(std::function<void()> callback) {
    ledBlinkCallback = callback;
  }
  
  void setLedUpdateCallback(std::function<void()> callback) {
    ledUpdateCallback = callback;
  }
  
  void setEmergencyLightSetCallback(std::function<void(String)> callback) {
    emergencyLightSetCallback = callback;
  }
  
  void setEmergencyLightGetCallback(std::function<void(String&)> callback) {
    emergencyLightGetCallback = callback;
  }
  
  // Store latest sensor data for HTTP polling
  void setSensorData(float roll, float pitch, float yaw, float verticalAccel) {
    latestRoll = roll;
    latestPitch = pitch;
    latestYaw = yaw;
    latestVerticalAccel = verticalAccel;
  }
  
private:
  /**
   * Parse hex color string (e.g., "ff0000" or "#ff0000") to uint32_t RGB
   */
  uint32_t parseHexColor(const String& hex) {
    String cleanHex = hex;
    if (cleanHex.startsWith("#")) {
      cleanHex = cleanHex.substring(1);
    }
    
    if (cleanHex.length() < 6) {
      return 0; // Black/off
    }
    
    // Convert hex string to uint32_t
    char* endptr;
    uint32_t color = strtol(cleanHex.c_str(), &endptr, 16);
    return color & 0xFFFFFF; // Ensure only 24 bits (RGB)
  }

  void startWiFiManager() {
    Serial.println("WiFi manager init: STA primary, AP fallback");
    Serial.printf("Target STA SSID: %s\n", HOME_WIFI_SSID);

    if (storageManager) {
      const char* deviceName = storageManager->getDeviceName();
      WiFi.setHostname(deviceName);
      Serial.printf("WiFi hostname set to: %s\n", deviceName);
    }

    WiFi.persistent(false);
    WiFi.setAutoReconnect(true);
    WiFi.mode(WIFI_STA);
    WiFi.begin(HOME_WIFI_SSID, HOME_WIFI_PASSWORD);

    wifiState = WIFI_STATE_STA_CONNECTING;
    staConnectStart = millis();
    lastReconnectAttempt = millis();
  }

  void startFallbackAP() {
    WiFi.mode(WIFI_AP_STA);

    IPAddress ip(WIFI_AP_IP);
    IPAddress gateway(WIFI_AP_GATEWAY);
    IPAddress subnet(WIFI_AP_SUBNET);

    WiFi.softAPConfig(ip, gateway, subnet);
    WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASSWORD);

    apStarted = true;
    wifiState = WIFI_STATE_AP_FALLBACK;
    lastReconnectAttempt = millis();

    Serial.print("AP fallback active: ");
    Serial.println(WIFI_AP_SSID);
    Serial.print("AP IP address: ");
    Serial.println(WiFi.softAPIP());
  }
  
  void setupRoutes() {
    // Enable CORS for all routes
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type");
    
    // Handle OPTIONS preflight requests
    server.on("/*", HTTP_OPTIONS, [](AsyncWebServerRequest *request) {
      request->send(200);
    });
    
    // API endpoint for sensor data (HTTP polling)
    server.on("/api/sensors", HTTP_GET, [this](AsyncWebServerRequest *request) {
      String json = "{\"roll\":" + String(latestRoll, 1) + 
                    ",\"pitch\":" + String(latestPitch, 1) + 
                    ",\"yaw\":" + String(latestYaw, 1) + 
                    ",\"verticalAccel\":" + String(latestVerticalAccel, 2) + "}";
      request->send(200, "application/json", json);
    });
    
    // API endpoint to get current config
    server.on("/api/config", HTTP_GET, [this](AsyncWebServerRequest *request) {
      // Return system config with servo config combined
      String configJson = storageManager->getConfigJSON();
      String servoConfigJson = storageManager->getServoConfigJSON();
      
      // Parse all JSON strings and combine them
      DynamicJsonDocument doc(4096);
      DeserializationError error1 = deserializeJson(doc, configJson);
      
      if (!error1) {
        // Add servo config under "servos" key
        DynamicJsonDocument servoDoc(2048);
        DeserializationError error2 = deserializeJson(servoDoc, servoConfigJson);
        if (!error2) {
          doc["servos"] = servoDoc;
        }
      }
      
      if (storageManager->consumeServoTrimResetWarning()) {
        JsonObject warnings = doc.createNestedObject("warnings");
        warnings["servoTrimReset"] = true;
        warnings["message"] = "Unexpected servo trim value was reset to 0. Check settings before driving.";
      }
      
      String combinedJson;
      serializeJson(doc, combinedJson);
      request->send(200, "application/json", combinedJson);
    });
    
    // API endpoint for heartbeat/health check
    server.on("/api/health-check", HTTP_GET, [this](AsyncWebServerRequest *request) {
      String json = "{\"status\":\"ok\",\"version\":\"" + String(FIRMWARE_VERSION) + "\"}";
      request->send(200, "application/json", json);
    });

    // API endpoint for WiFi connectivity diagnostics
    server.on("/api/network/status", HTTP_GET, [this](AsyncWebServerRequest *request) {
      String mode = "disconnected";
      if (WiFi.status() == WL_CONNECTED) {
        mode = "sta";
      } else if (apStarted) {
        mode = "ap_fallback";
      }

      String json = "{\"mode\":\"" + mode +
                    "\",\"ssid\":\"" + WiFi.SSID() +
                    "\",\"staIp\":\"" + WiFi.localIP().toString() +
                    "\",\"apIp\":\"" + WiFi.softAPIP().toString() +
                    "\"}";
      request->send(200, "application/json", json);
    });
    
    // API endpoint to flash LED (for notifications)
    server.on("/api/flash-led", HTTP_GET, [this](AsyncWebServerRequest *request) {
      if (ledBlinkCallback) {
        ledBlinkCallback();
      }
      request->send(200, "application/json", "{\"status\":\"ok\"}");
    });
    
    // API endpoint to update config
    server.on("/api/config", HTTP_POST, [this](AsyncWebServerRequest *request) {}, nullptr, 
      [this](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
        DynamicJsonDocument doc(1024);
        DeserializationError error = deserializeJson(doc, data);
        
        if (!error) {
          Serial.print("Config update received: ");
          serializeJson(doc, Serial);
          Serial.println();
          
          if (doc.containsKey("reactionSpeed")) {
            float val = doc["reactionSpeed"];
            Serial.printf("Updating reactionSpeed to: %.2f\n", val);
            storageManager->updateParameter("reactionSpeed", val);
          }
          if (doc.containsKey("rideHeightOffset")) {
            float val = doc["rideHeightOffset"];
            Serial.printf("Updating rideHeightOffset to: %.0f\n", val);
            storageManager->updateParameter("rideHeightOffset", val);
          }
          if (doc.containsKey("rangeLimit")) {
            float val = doc["rangeLimit"];
            Serial.printf("Updating rangeLimit to: %.0f\n", val);
            storageManager->updateParameter("rangeLimit", val);
          }
          if (doc.containsKey("damping")) {
            float val = doc["damping"];
            Serial.printf("Updating damping to: %.2f\n", val);
            storageManager->updateParameter("damping", val);
          }
          if (doc.containsKey("frontRearBalance")) {
            float val = doc["frontRearBalance"];
            Serial.printf("Updating frontRearBalance to: %.2f\n", val);
            storageManager->updateParameter("frontRearBalance", val);
          }
          if (doc.containsKey("stiffness")) {
            float val = doc["stiffness"];
            Serial.printf("Updating stiffness to: %.2f\n", val);
            storageManager->updateParameter("stiffness", val);
          }
          if (doc.containsKey("sampleRate")) {
            uint16_t rate = doc["sampleRate"];
            Serial.printf("Updating sampleRate to: %d Hz\n", rate);
            storageManager->updateParameter("sampleRate", rate);
          }
          if (doc.containsKey("telemetryRate")) {
            uint8_t rate = doc["telemetryRate"];
            Serial.printf("Updating telemetryRate to: %d Hz\n", rate);
            storageManager->updateParameter("telemetryRate", rate);
          }
          if (doc.containsKey("mpuOrientation")) {
            uint8_t orientation = doc["mpuOrientation"];
            Serial.printf("Updating mpuOrientation to: %d\n", orientation);
            storageManager->updateParameter("mpuOrientation", orientation);
            // Notify sensor fusion of orientation change
            if (orientationCallback) {
              orientationCallback(orientation);
            }
          }
          if (doc.containsKey("fpvAutoMode")) {
            bool autoMode = doc["fpvAutoMode"];
            Serial.printf("Updating fpvAutoMode to: %s\n", autoMode ? "true" : "false");
            storageManager->updateParameter("fpvAutoMode", autoMode ? 1.0f : 0.0f);
          }
          
          if (doc.containsKey("deviceName")) {
            String newName = doc["deviceName"];
            Serial.printf("Updating deviceName to: %s\n", newName.c_str());
            storageManager->updateDeviceName(newName);
            // Update WiFi hostname
            WiFi.setHostname(newName.c_str());
          }
          
          // Handle servo configuration updates
          if (doc.containsKey("servos")) {
            JsonObject servos = doc["servos"];
            
            // Process each servo
            for (const char* servoName : {"frontLeft", "frontRight", "rearLeft", "rearRight"}) {
              if (servos.containsKey(servoName)) {
                JsonObject servo = servos[servoName];
                
                if (servo.containsKey("min")) {
                  int minVal = servo["min"];
                  Serial.printf("Updating %s min to: %d\n", servoName, minVal);
                  storageManager->updateServoParameter(servoName, "min", minVal);
                }
                if (servo.containsKey("max")) {
                  int maxVal = servo["max"];
                  Serial.printf("Updating %s max to: %d\n", servoName, maxVal);
                  storageManager->updateServoParameter(servoName, "max", maxVal);
                }
                if (servo.containsKey("trim")) {
                  int trimVal = servo["trim"];
                  Serial.printf("Updating %s trim to: %d\n", servoName, trimVal);
                  storageManager->updateServoParameter(servoName, "trim", trimVal);
                }
                if (servo.containsKey("reversed")) {
                  int reversed = servo["reversed"];
                  Serial.printf("Updating %s reversed to: %d\n", servoName, reversed);
                  storageManager->updateServoParameter(servoName, "reversed", reversed);
                }
              }
            }
          }
          
          // Trigger LED blink feedback
          if (ledBlinkCallback) {
            ledBlinkCallback();
          }
          
          request->send(200, "application/json", "{\"status\":\"success\"}");
        } else {
          Serial.println("Config update JSON parse error");
          request->send(400, "application/json", "{\"status\":\"error\"}");
        }
      });
    
    // API endpoint to reset config to defaults
    server.on("/api/reset", HTTP_POST, [this](AsyncWebServerRequest *request) {
      storageManager->resetToDefaults();
      request->send(200, "application/json", "{\"status\":\"success\"}");
    });
    
    // API endpoint to recalibrate MPU6050
    server.on("/api/calibrate", HTTP_POST, [this](AsyncWebServerRequest *request) {
      if (calibrationCallback) {
        calibrationCallback();
        request->send(200, "application/json", "{\"status\":\"success\"}");
      } else {
        request->send(500, "application/json", "{\"status\":\"error\",\"message\":\"Calibration not available\"}");
      }
    });
    
    // API endpoint to update servo configuration
    server.on("/api/servo-config", HTTP_POST, [this](AsyncWebServerRequest *request) {}, nullptr, 
      [this](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
        DynamicJsonDocument doc(1024);
        DeserializationError error = deserializeJson(doc, data);
        
        if (!error) {
          // Check which servo and parameter to update
          if (doc.containsKey("servo") && doc.containsKey("param") && doc.containsKey("value")) {
            String servo = doc["servo"].as<String>();
            String param = doc["param"].as<String>();
            int value = doc["value"].as<int>();
            
            storageManager->updateServoParameter(servo, param, value);
            
            // Trigger LED blink feedback
            if (ledBlinkCallback) {
              ledBlinkCallback();
            }
            
            request->send(200, "application/json", "{\"status\":\"success\"}");
          } else {
            request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Missing parameters\"}");
          }
        } else {
          request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Invalid JSON\"}");
        }
      });
    
    // LED configuration endpoint
    server.on("/api/led-config", HTTP_POST, [this](AsyncWebServerRequest *request) {}, nullptr, 
      [this](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
        DynamicJsonDocument doc(512);
        DeserializationError error = deserializeJson(doc, data);
        
        if (!error) {
          if (doc.containsKey("ledColor")) {
            String colorName = doc["ledColor"].as<String>();
            Serial.printf("Updating LED color to: %s\n", colorName.c_str());
            
            storageManager->setLEDColor(colorName);
            
            // Update the LED color immediately
            if (ledUpdateCallback) {
              ledUpdateCallback();
            }
            
            // Trigger LED blink feedback
            if (ledBlinkCallback) {
              ledBlinkCallback();
            }
            
            request->send(200, "application/json", "{\"status\":\"success\"}");
          } else {
            request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Missing ledColor parameter\"}");
          }
        } else {
          request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Invalid JSON\"}");
        }
      });
    
    // Lights configuration API - GET current state
    server.on("/api/lights", HTTP_GET, [this](AsyncWebServerRequest *request) {
      String response = storageManager->getLightsConfigJSON();
      request->send(200, "application/json", response);
    });
    
    // Lights configuration API - UPDATE lights state  
    server.on("/api/lights", HTTP_POST, [this](AsyncWebServerRequest *request) {
      // Body has been buffered by the body handler - now process it
      Serial.printf("Lights POST onRequest handler: buffer size = %d bytes\n", lightsPostBuffer.length());
      
      if (lightsPostBuffer.length() == 0) {
        request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"No body received\"}");
        return;
      }
      
      // Create JSON document from buffered data
      DynamicJsonDocument doc(4096); // Increased for more groups
      DeserializationError error = deserializeJson(doc, lightsPostBuffer);
      
      if (error) {
        Serial.printf("Lights JSON parse error: %s\n", error.c_str());
        request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Invalid JSON\"}");
        lightsPostBuffer.clear();
        return;
      }
      
      Serial.println("Lights JSON parsed successfully");
      
      // NEW format: lightGroups array with full group definitions
      if (doc.containsKey("lightGroupsArray")) {
        Serial.println("Processing new light format (array)...");
        JsonArray groupsArray = doc["lightGroupsArray"];
        
        NewLightsConfig config;
        config.useLegacyMode = false;
        config.groupCount = 0;
        
        // Parse each light group from the array
        for (JsonObject groupObj : groupsArray) {
          if (config.groupCount >= 10) break; // Max 10 groups
          
          ExtendedLightGroup& group = config.groups[config.groupCount];
          memset(&group, 0, sizeof(ExtendedLightGroup));
          
          // Parse group properties
          if (groupObj.containsKey("name")) {
            strncpy(group.name, groupObj["name"], sizeof(group.name) - 1);
          }
          const char* pattern = groupObj["pattern"] | "Solid";
          strncpy(group.pattern, pattern, sizeof(group.pattern) - 1);
          group.pattern[sizeof(group.pattern) - 1] = '\0';
          
          group.enabled = groupObj["enabled"] | false;
          group.brightness = groupObj["brightness"] | 255;
          group.mode = groupObj["mode"] | LIGHT_MODE_SOLID;
          group.blinkRate = groupObj["blinkRate"] | 500;
          
          // Parse colors (hex strings like "ff0000")
          if (groupObj.containsKey("color")) {
            String colorStr = groupObj["color"];
            group.color = parseHexColor(colorStr);
          }
          if (groupObj.containsKey("color2")) {
            String colorStr2 = groupObj["color2"];
            group.color2 = parseHexColor(colorStr2);
          }
          
          // Parse LED indices
          if (groupObj.containsKey("indices")) {
            JsonArray indicesArray = groupObj["indices"];
            group.ledCount = 0;
            for (uint16_t idx : indicesArray) {
              if (group.ledCount < 100) { // Max 100 LEDs per group
                group.ledIndices[group.ledCount++] = idx;
              }
            }
            Serial.printf("  Group '%s': %d LEDs, enabled=%d, color=%06lx, mode=%d\n",
                          group.name, group.ledCount, group.enabled, group.color, group.mode);
          }
          
          config.groupCount++;
        }
        
        // Pass to storage and lights engine
        storageManager->setNewLightsConfig(config);
        if (lightsEngine) {
          lightsEngine->updateFromPayload(config);
        }
        Serial.printf("Updated %d light groups\n", config.groupCount);
        request->send(200, "application/json", "{\"status\":\"success\",\"type\":\"new_format\"}");
      }
      // OLD format: legacy 3-group alias-based format (for backward compatibility)
      else if (doc.containsKey("lightGroups")) {
        Serial.println("Processing legacy light format (3-group)...");
        JsonObject groups = doc["lightGroups"];
        
        NewLightsConfig config;
        config.useLegacyMode = true;
        config.groupCount = 0;
        
        // Parse legacy groups
        if (groups.containsKey("headlights")) {
          JsonObject hl = groups["headlights"];
          config.legacy.headlights.enabled = hl["enabled"] | false;
          config.legacy.headlights.brightness = hl["brightness"] | 255;
          config.legacy.headlights.mode = hl["mode"] | LIGHT_MODE_SOLID;
          config.legacy.headlights.blinkRate = hl["blinkRate"] | 500;
        }
        if (groups.containsKey("tailLights")) {
          JsonObject tl = groups["tailLights"];
          config.legacy.tailLights.enabled = tl["enabled"] | false;
          config.legacy.tailLights.brightness = tl["brightness"] | 255;
          config.legacy.tailLights.mode = tl["mode"] | LIGHT_MODE_SOLID;
          config.legacy.tailLights.blinkRate = tl["blinkRate"] | 500;
        }
        if (groups.containsKey("emergencyLights")) {
          JsonObject el = groups["emergencyLights"];
          config.legacy.emergencyLights.enabled = el["enabled"] | false;
          config.legacy.emergencyLights.brightness = el["brightness"] | 255;
          config.legacy.emergencyLights.mode = el["mode"] | LIGHT_MODE_SOLID;
          config.legacy.emergencyLights.blinkRate = el["blinkRate"] | 500;
        }
        
        storageManager->setNewLightsConfig(config);
        if (lightsEngine) {
          lightsEngine->updateFromPayload(config);
        }
        request->send(200, "application/json", "{\"status\":\"success\",\"type\":\"legacy_format\"}");
      }
      else {
        request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Missing light data\"}");
      }
      
      lightsPostBuffer.clear();
      lightsPostTotalSize = 0;
    }, nullptr, [this](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
      // Body handler - accumulate data into buffer
      if (index == 0) {
        // First chunk - reset buffer
        lightsPostBuffer.clear();
        lightsPostTotalSize = total;
        Serial.printf("Lights POST body handler: starting, total size = %d bytes\n", total);
      }
      
      // Append this chunk to buffer
      if (data && len > 0) {
        lightsPostBuffer.concat((const char*)data, len);
        Serial.printf("Lights POST body handler: got %d bytes (index=%d, total=%d)\n", len, index, total);
      }
      
      // Check if we have all the data
      if (index + len == total) {
        Serial.printf("Lights POST body handler: all data received (%d bytes)\n", lightsPostBuffer.length());
        // Data is complete, onRequest handler will process it now
      }
    });
    
    // Serve static files from SPIFFS
    server.on("/test-gps.html", HTTP_GET, [](AsyncWebServerRequest *request) {
      request->send(SPIFFS, "/test-gps.html", "text/html");
    });
    
    server.on("/test.webmanifest", HTTP_GET, [](AsyncWebServerRequest *request) {
      request->send(SPIFFS, "/test.webmanifest", "application/manifest+json");
    });
    
    server.on("/test-sw.js", HTTP_GET, [](AsyncWebServerRequest *request) {
      request->send(SPIFFS, "/test-sw.js", "application/javascript");
    });
  }
};


#endif
