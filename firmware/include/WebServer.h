#ifndef WEBSERVER_H
#define WEBSERVER_H

#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <functional>
#include "StorageManager.h"

class WebServerManager {
private:
  AsyncWebServer server{80};
  AsyncWebSocket ws{"/ws"};
  StorageManager* storageManager = nullptr;
  std::function<void()> calibrationCallback = nullptr;
  std::function<bool()> mpuStatusCallback = nullptr;
  std::function<void(uint8_t)> orientationCallback = nullptr;
  std::function<void()> ledBlinkCallback = nullptr;
  
  // Latest sensor data for HTTP polling
  float latestRoll = 0.0f;
  float latestPitch = 0.0f;
  float latestYaw = 0.0f;
  float latestVerticalAccel = 0.0f;
  float latestBattery1 = 0.0f;
  float latestBattery2 = 0.0f;
  float latestBattery3 = 0.0f;
  
public:
  void init(StorageManager& storage) {
    storageManager = &storage;
    
    // Start WiFi in AP mode
    startWiFiAP();
    
    // Setup WebSocket
    ws.onEvent([](AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len) {
      if (type == WS_EVT_CONNECT) {
        Serial.printf("WebSocket client #%u connected\n", client->id());
      } else if (type == WS_EVT_DISCONNECT) {
        Serial.printf("WebSocket client #%u disconnected\n", client->id());
      }
    });
    server.addHandler(&ws);
    
    // Setup web server routes
    setupRoutes();
    
    // Start server
    server.begin();
    Serial.println("Web server started on http://192.168.4.1");
  }
  
  // Public method to send status messages to all connected clients
  void sendStatus(const String& message) {
    ws.textAll(message);
  }
  
  // Store latest sensor/battery data
  struct {
    float roll = NAN, pitch = NAN, yaw = NAN, verticalAccel = NAN;
    float battery1 = 0, battery2 = 0, battery3 = 0;
  } latestData;
  
  // Send combined sensor and battery data to all connected clients
  void sendTelemetry() {
    String json = "{\"type\":\"telemetry\",\"roll\":" + String(latestData.roll, 1) + 
                  ",\"pitch\":" + String(latestData.pitch, 1) + 
                  ",\"yaw\":" + String(latestData.yaw, 1) + 
                  ",\"verticalAccel\":" + String(latestData.verticalAccel, 2) + 
                  ",\"voltages\":[" + 
                  String(latestData.battery1, 2) + "," + 
                  String(latestData.battery2, 2) + "," + 
                  String(latestData.battery3, 2) + "]}";
    ws.textAll(json);
  }
  
  // Send sensor data to all connected clients
  void sendSensorData(float roll, float pitch, float yaw, float verticalAccel) {
    latestData.roll = roll;
    latestData.pitch = pitch;
    latestData.yaw = yaw;
    latestData.verticalAccel = verticalAccel;
    sendTelemetry();
  }
  
  // Send battery voltage data to all connected clients
  void sendBatteryData(float battery1, float battery2, float battery3) {
    latestData.battery1 = battery1;
    latestData.battery2 = battery2;
    latestData.battery3 = battery3;
    sendTelemetry();
  }
  
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
  
  // Store latest sensor data for HTTP polling
  void setSensorData(float roll, float pitch, float yaw, float verticalAccel) {
    latestRoll = roll;
    latestPitch = pitch;
    latestYaw = yaw;
    latestVerticalAccel = verticalAccel;
  }
  
  // Store latest battery data for HTTP polling
  void setBatteryData(float battery1, float battery2, float battery3) {
    latestBattery1 = battery1;
    latestBattery2 = battery2;
    latestBattery3 = battery3;
  }
  
private:
  void startWiFiAP() {
    // First, try to connect to home WiFi
    Serial.println("Attempting to connect to home WiFi...");
    Serial.print("SSID: ");
    Serial.println(HOME_WIFI_SSID);
    
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(false); // CRITICAL: Disable auto-reconnect to prevent blocking
    WiFi.begin(HOME_WIFI_SSID, HOME_WIFI_PASSWORD);
    
    unsigned long startAttemptTime = millis();
    
    // Wait for connection with timeout - REDUCE TIMEOUT to 5 seconds to not starve watchdog
    const unsigned long SHORT_TIMEOUT = 5000; // 5 seconds instead of 30
    while (WiFi.status() != WL_CONNECTED && 
           millis() - startAttemptTime < SHORT_TIMEOUT) {
      delay(500);
      Serial.print(".");
    }
    Serial.println();
    
    // Check if connected to home WiFi
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("Connected to home WiFi");
      Serial.print("IP address: ");
      Serial.println(WiFi.localIP());
      Serial.print("Access web interface at: http://");
      Serial.println(WiFi.localIP());
    } else {
      // Connection failed, fall back to AP mode
      Serial.println("Failed to connect to home WiFi (timeout after 5s)");
      Serial.println("Starting Access Point mode...");
      
      WiFi.mode(WIFI_AP);
      WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASSWORD);
      
      IPAddress ip(WIFI_AP_IP);
      IPAddress gateway(WIFI_AP_GATEWAY);
      IPAddress subnet(WIFI_AP_SUBNET);
      
      WiFi.softAPConfig(ip, gateway, subnet);
      
      Serial.print("WiFi AP started: ");
      Serial.println(WIFI_AP_SSID);
      Serial.print("IP address: ");
      Serial.println(WiFi.softAPIP());
      Serial.println("Access web interface at: http://192.168.4.1");
    }
    
    Serial.println("⚠️  WiFi auto-reconnect disabled to prevent watchdog issues");
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
                    ",\"verticalAccel\":" + String(latestVerticalAccel, 2) + 
                    ",\"batteries\":[" + String(latestBattery1, 2) + "," + 
                    String(latestBattery2, 2) + "," + String(latestBattery3, 2) + "]}";
      request->send(200, "application/json", json);
    });
    
    // API endpoint to get current config
    server.on("/api/config", HTTP_GET, [this](AsyncWebServerRequest *request) {
      // Combine system config, servo config, and battery config into one response
      String configJson = storageManager->getConfigJSON();
      String servoConfigJson = storageManager->getServoConfigJSON();
      String batteryConfigJson = storageManager->getBatteryConfigJSON();
      
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
        
        // Add battery config under "batteries" key
        DynamicJsonDocument batteryDoc(1024);
        DeserializationError error3 = deserializeJson(batteryDoc, batteryConfigJson);
        if (!error3) {
          doc["batteries"] = batteryDoc["batteries"];
        }
      }
      
      String combinedJson;
      serializeJson(doc, combinedJson);
      request->send(200, "application/json", combinedJson);
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
      sendStatus("Settings reset to factory defaults");
      request->send(200, "application/json", "{\"status\":\"success\"}");
    });
    
    // API endpoint to recalibrate MPU6050
    server.on("/api/calibrate", HTTP_POST, [this](AsyncWebServerRequest *request) {
      if (calibrationCallback) {
        sendStatus("Starting recalibration...");
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
    
    // API endpoint to update battery configuration
    server.on("/api/batteries", HTTP_POST, [this](AsyncWebServerRequest *request) {}, nullptr, 
      [this](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
        DynamicJsonDocument doc(2048);
        DeserializationError error = deserializeJson(doc, data);
        
        if (!error) {
          Serial.print("Battery config update received: ");
          serializeJson(doc, Serial);
          Serial.println();
          
          // Handle array format: {"batteries": [{...}, {...}, {...}]}
          if (doc.containsKey("batteries") && doc["batteries"].is<JsonArray>()) {
            JsonArray batteries = doc["batteries"].as<JsonArray>();
            
            for (size_t i = 0; i < batteries.size() && i < 3; i++) {
              JsonObject battery = batteries[i];
              int batteryNum = i + 1;
              
              if (battery.containsKey("name")) {
                String name = battery["name"].as<String>();
                storageManager->updateBatteryParameter(batteryNum, "name", name);
              }
              if (battery.containsKey("cellCount")) {
                String cellCount = String(battery["cellCount"].as<int>());
                storageManager->updateBatteryParameter(batteryNum, "cellCount", cellCount);
              }
              if (battery.containsKey("plugAssignment")) {
                String plug = String(battery["plugAssignment"].as<int>());
                storageManager->updateBatteryParameter(batteryNum, "plugAssignment", plug);
              }
              if (battery.containsKey("showOnDashboard")) {
                String show = battery["showOnDashboard"].as<bool>() ? "true" : "false";
                storageManager->updateBatteryParameter(batteryNum, "showOnDashboard", show);
              }
            }
            
            // Trigger LED blink feedback
            if (ledBlinkCallback) {
              ledBlinkCallback();
            }
            
            request->send(200, "application/json", "{\"status\":\"success\"}");
          } else {
            request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Invalid batteries array\"}");
          }
        } else {
          Serial.println("Battery config JSON parse error");
          request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Invalid JSON\"}");
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
