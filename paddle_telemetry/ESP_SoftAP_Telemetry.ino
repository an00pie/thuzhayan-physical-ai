/*
 * THUZHAYAN Physical AI Rowing System
 * ESP32 / ESP8266 Paddle Sensor Hub with SoftAP (Personal Hotspot) & Web Server
 * 
 * Hardware Required:
 * - ESP32 or ESP8266 Microcontroller
 * - MPU-6050 6-DOF Accelerometer & Gyroscope (I2C: 0x68)
 * - SSD1306 0.96" OLED Display (I2C: 0x3C)
 * 
 * Features:
 * - Hosts a standalone Wi-Fi Personal Hotspot (Access Point mode: 192.168.4.1)
 * - Serves real-time HTTP JSON telemetry at http://192.168.4.1/
 * - Renders telemetry stats on local OLED display
 */

#if defined(ESP32)
  #include <WiFi.h>
  #include <WebServer.h>
  WebServer server(80);
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266WebServer.h>
  ESP8266WebServer server(80);
#endif

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

// OLED Display Configuration
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

// MPU-6050 IMU Sensor
Adafruit_MPU6050 mpu;

// Hotspot Settings
const char* AP_SSID = "THUZHAYAN_PADDLE_1";
const char* AP_PASS = "thuzhayan123";

// Telemetry State
float accel_mag_g = 1.0;
float gyro_x = 0, gyro_y = 0, gyro_z = 0;
float roll_deg = 0, pitch_deg = 0;
float temp_c = 30.0;

void handleRoot() {
  String json = "{";
  json += "\"device_name\":\"PADDLER-1\",";
  json += "\"ip\":\"" + WiFi.softAPIP().toString() + "\",";
  json += "\"accel_magnitude_g\":" + String(accel_mag_g, 2) + ",";
  json += "\"gyro_dps\":{\"x\":" + String(gyro_x, 1) + ",\"y\":" + String(gyro_y, 1) + ",\"z\":" + String(gyro_z, 1) + "},";
  json += "\"orientation_deg\":{\"roll\":" + String(roll_deg, 1) + ",\"pitch\":" + String(pitch_deg, 1) + "},";
  json += "\"temp_c\":" + String(temp_c, 1);
  json += "}";

  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", json);
}

void setup() {
  Serial.begin(115200);
  Wire.begin();

  // Initialize OLED
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED allocation failed!");
  } else {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println("THUZHAYAN PADDLE #1");
    display.println("Initializing AP...");
    display.display();
  }

  // Initialize MPU6050
  if (!mpu.begin()) {
    Serial.println("Could not find MPU6050 sensor!");
  } else {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BANDWIDTH_21_HZ);
  }

  // Configure ESP in Access Point (Personal Hotspot) Mode
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);

  IPAddress apIP = WiFi.softAPIP();
  Serial.print("Access Point Started! SSID: ");
  Serial.println(AP_SSID);
  Serial.print("ESP IP Address: ");
  Serial.println(apIP);

  // Setup Web Server Routes
  server.on("/", handleRoot);
  server.on("/json", handleRoot);
  server.begin();
  Serial.println("HTTP server started at http://192.168.4.1/");
}

void loop() {
  server.handleClient();

  // Read MPU6050 Sensor Data
  sensors_event_t a, g, temp;
  if (mpu.getEvent(&a, &g, &temp)) {
    float ax = a.acceleration.x / 9.81;
    float ay = a.acceleration.y / 9.81;
    float az = a.acceleration.z / 9.81;
    accel_mag_g = sqrt(ax * ax + ay * ay + az * az);

    gyro_x = g.gyro.x * 57.2958;
    gyro_y = g.gyro.y * 57.2958;
    gyro_z = g.gyro.z * 57.2958;

    roll_deg = atan2(ay, az) * 57.2958;
    pitch_deg = atan2(-ax, sqrt(ay * ay + az * az)) * 57.2958;
    temp_c = temp.temperature;
  }

  // Update OLED Display
  static unsigned long lastOled = 0;
  if (millis() - lastOled > 200) {
    lastOled = millis();
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("PADDLER-1 [HOTSPOT]");
    display.print("AP: "); display.println(AP_SSID);
    display.print("IP: "); display.println(WiFi.softAPIP());
    display.print("MAG: "); display.print(accel_mag_g, 2); display.println("g");
    display.print("ROLL: "); display.print(roll_deg, 1); display.print("deg ");
    display.print("Temp: "); display.print(temp_c, 1); display.println("C");
    display.display();
  }
}
