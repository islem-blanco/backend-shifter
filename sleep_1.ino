#include <Arduino.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <MPU6050.h>
#include <DHT.h>
#include <math.h>

// ════════════════════════════════════════════════════════════
// MODE TEST — Mettre à 0 pour la production
// ════════════════════════════════════════════════════════════
#define TEST_MODE 1   // 1 = timers accélérés + logs détaillés

#if TEST_MODE
  #define DHT_INTERVAL      10000   // 10s  (production: 30000)
  #define MPU_INTERVAL       2000   // 2s   (production: 3000)
  #define PING_INTERVAL     20000   // 20s  (production: 60000)
  #define SLEEP_INTERVAL    30000   // 30s  (production: 120000)
  #define ANOMALY_STAY_MS   60000   // 1min (production: 180000)
  #warning "=== TEST_MODE ACTIF — NE PAS FLASHER EN PRODUCTION ==="
#else
  #define DHT_INTERVAL      30000
  #define MPU_INTERVAL       3000
  #define PING_INTERVAL     60000
  #define SLEEP_INTERVAL   120000
  #define ANOMALY_STAY_MS  180000
#endif

#define RXD2      16
#define TXD2      17
#define SDA_PIN   21
#define SCL_PIN   22
#define DHT_PIN   4
#define DHT_TYPE  DHT22

MPU6050 mpu;
DHT dht(DHT_PIN, DHT_TYPE);

// ─────────────────────────────────────────────
// SEUILS D'ANOMALIE
// ─────────────────────────────────────────────
#define MPU_MAGNITUDE_THRESHOLD 2.0f
#define MPU_DELTA_THRESHOLD     0.5f
#define MPU_LOW_DELTA           0.2f

// ── Configuration GPRS ──────────────────────────────────────
const char* APN      = "internet.tn";
const char* APN_USER = "";
const char* APN_PASS = "";

// ── Configuration MQTT ──────────────────────────────────────
const char* MQTT_HOST         = "broker.hivemq.com";
const int   MQTT_PORT         = 1883;
const char* MQTT_CLIENT       = "ESP32-Sahra-001";
const char* MQTT_TOPIC_SENSOR = "sahra/sensor";
const char* MQTT_TOPIC_DHT    = "sahra/dht";
const char* MQTT_TOPIC_GPS    = "sahra/gps";
const char* MQTT_TOPIC_STATUS = "sahra/status";
const char* MQTT_TOPIC_CMD    = "sahra/commande";
#define MQTT_KEEP_ALIVE 60

// ── Variables globales ──────────────────────────────────────
unsigned long dernierDHT     = 0;
unsigned long dernierSensor  = 0;
unsigned long dernierPing    = 0;
unsigned long dernierAppel   = 0;
String        derniereVille  = "...";
bool          mqttConnecte   = false;
bool          gpsFixed       = false;

// ── Gestion Kit / Colis ──────────────────────────────────────
String     packageId   = "";
bool       kitActif    = false;
bool       kitDelivre  = false;

// ── Deep sleep & anomalie tracker ───────────────────────────
unsigned long lastWakeUp   = 0;
unsigned long lastAnomaly  = 0;

// ── Buffer MQTT entrant ──────────────────────────────────────
#define MQTT_IN_BUF_SIZE 256
uint8_t   mqttInBuf[MQTT_IN_BUF_SIZE];
uint16_t  mqttInLen  = 0;
bool      mqttInMode = false;
String    buffer     = "";

float         prev_mag    = 0;
unsigned long shock_start = 0;

// GPS NMEA Stream
String gpsBuffer = "";

// ════════════════════════════════════════════════════════════
// AT HELPERS
// ════════════════════════════════════════════════════════════
void flushSerial1() {
  delay(300);
  while (Serial1.available()) Serial1.read();
}

bool sendAT(const String& cmd, const String& expected, unsigned long timeout = 5000) {
  flushSerial1();
  Serial.println("[AT] >> " + cmd);
  Serial1.println(cmd);
  unsigned long t = millis();
  String resp = "";
  while (millis() - t < timeout) {
    while (Serial1.available()) resp += (char)Serial1.read();
    if (resp.indexOf(expected) != -1) {
      Serial.println("[AT] << OK");
      return true;
    }
    delay(10);
  }
  Serial.println("[AT] TIMEOUT – got: " + resp.substring(0, 80));
  return false;
}

void sendRaw(const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; i++) Serial1.write(data[i]);
}

// ════════════════════════════════════════════════════════════
// GPS — Stop / Start NMEA Stream
// ════════════════════════════════════════════════════════════
void gpsStopStream() {
  Serial1.println("AT+CGPSOUT=0");
  delay(1200);
  flushSerial1();
}

void gpsStartStream() {
  flushSerial1();
  sendAT("AT+CGPSOUT=255", "OK", 3000);
  flushSerial1();
}

// ════════════════════════════════════════════════════════════
// Extraction JSON simple
// ════════════════════════════════════════════════════════════
String extractJson(const String& json, const String& key) {
  int idx = json.indexOf(key);
  if (idx == -1) return "";
  int colon = json.indexOf(":", idx);
  if (colon == -1) return "";
  int q1 = json.indexOf("\"", colon + 1);
  if (q1 == -1) return "";
  int q2 = json.indexOf("\"", q1 + 1);
  if (q2 == -1) return "";
  return json.substring(q1 + 1, q2);
}

// ════════════════════════════════════════════════════════════
// TCP / MQTT
// ════════════════════════════════════════════════════════════
void closeTCP() {
  while (Serial1.available()) Serial1.read();
  Serial1.println("AT+CIPCLOSE");
  delay(2000);
  while (Serial1.available()) Serial1.read();
  Serial.println("[TCP] Fermé");
}

bool mqttConnect() {
  String  clientId = String(MQTT_CLIENT);
  uint8_t cidLen   = clientId.length();
  uint8_t remLen   = 12 + cidLen;
  uint8_t pkt[100];
  uint8_t i = 0;

  pkt[i++] = 0x10; pkt[i++] = remLen;
  pkt[i++] = 0x00; pkt[i++] = 0x04;
  pkt[i++] = 'M'; pkt[i++] = 'Q'; pkt[i++] = 'T'; pkt[i++] = 'T';
  pkt[i++] = 0x04; pkt[i++] = 0x02;
  pkt[i++] = MQTT_KEEP_ALIVE >> 8;
  pkt[i++] = MQTT_KEEP_ALIVE & 0xFF;
  pkt[i++] = 0x00; pkt[i++] = cidLen;
  for (uint8_t j = 0; j < cidLen; j++) pkt[i++] = clientId[j];

  Serial1.println("AT+CIPSEND=" + String(i));
  delay(600);
  sendRaw(pkt, i);

  unsigned long t = millis();
  bool connackRecu = false;
  while (millis() - t < 8000) {
    while (Serial1.available()) {
      uint8_t b = Serial1.read();
      if (b == 0x20) {
        delay(100);
        flushSerial1();
        Serial.println("[MQTT] CONNACK reçu ✓");
        connackRecu = true;
        break;
      }
    }
    if (connackRecu) break;
  }
  if (!connackRecu) { Serial.println("[MQTT] CONNACK timeout"); return false; }

  const char* topic  = MQTT_TOPIC_CMD;
  uint8_t topicLen   = strlen(topic);
  uint8_t subPkt[80];
  uint8_t s = 0;
  subPkt[s++] = 0x82; subPkt[s++] = 5 + topicLen;
  subPkt[s++] = 0x00; subPkt[s++] = 0x01;
  subPkt[s++] = 0x00; subPkt[s++] = topicLen;
  for (int j = 0; j < topicLen; j++) subPkt[s++] = topic[j];
  subPkt[s++] = 0x00;

  Serial1.println("AT+CIPSEND=" + String(s));
  delay(600);
  sendRaw(subPkt, s);
  delay(300);
  while (Serial1.available()) Serial1.read();
  Serial.println("[MQTT] Abonné à sahra/commande ✓");
  return true;
}

bool reopenMQTT() {
  Serial.println("[MQTT] Reconnexion...");
  flushSerial1();
  String cmd = "AT+CIPSTART=\"TCP\",\"" + String(MQTT_HOST) + "\"," + String(MQTT_PORT);
  if (!sendAT(cmd, "CONNECT", 20000)) { mqttConnecte = false; return false; }
  delay(500);
  if (!mqttConnect())                  { mqttConnecte = false; return false; }
  mqttConnecte = true;
  Serial.println("[MQTT] Reconnecté ✓");
  return true;
}

// ════════════════════════════════════════════════════════════
// Publication MQTT
// ════════════════════════════════════════════════════════════
void mqttPublish(const char* topic, const String& payload) {
  if (!mqttConnecte) { Serial.println("[MQTT] ⚠️ Pas connecté"); return; }

  uint8_t  tLen   = strlen(topic);
  uint16_t pLen   = payload.length();
  uint16_t remLen = 2 + tLen + pLen;
  uint8_t  pkt[512];
  uint8_t  i = 0;

  pkt[i++] = 0x30;
  if (remLen < 128) { pkt[i++] = remLen; }
  else { pkt[i++] = (remLen & 0x7F) | 0x80; pkt[i++] = remLen >> 7; }
  pkt[i++] = 0x00; pkt[i++] = tLen;
  for (uint8_t j = 0; j < tLen; j++) pkt[i++] = topic[j];
  for (uint16_t j = 0; j < pLen; j++) pkt[i++] = payload[j];

  Serial.println("[MQTT] 📤 " + String(topic) + " → " + payload.substring(0, 80));
  Serial1.println("AT+CIPSEND=" + String(i));
  delay(500);
  sendRaw(pkt, i);
  delay(300);
  flushSerial1();
  Serial.println("[MQTT] ✅ Publié");
}

void mqttPing() {
  gpsStopStream();
  Serial1.println("AT+CIPSEND=2");
  delay(300);
  uint8_t pingPacket[2] = {0xC0, 0x00};
  sendRaw(pingPacket, 2);
  delay(200);
  flushSerial1();
  gpsStartStream();
}

// ════════════════════════════════════════════════════════════
// Reverse geocoding
// ════════════════════════════════════════════════════════════
String getVille(float lat, float lon) {
  gpsStopStream();
  closeTCP();
  delay(500);

  String url = "http://api-bdc.net/data/reverse-geocode-client?latitude="
               + String(lat, 6) + "&longitude=" + String(lon, 6)
               + "&localityLanguage=fr";
  Serial.println("[GEO] URL: " + url);
  String ville = "Localisation inconnue";

  sendAT("AT+HTTPTERM", "OK", 3000);
  delay(500);
  if (!sendAT("AT+HTTPINIT", "OK", 5000)) goto reopen;
  sendAT("AT+HTTPPARA=\"CID\",1", "OK", 3000);
  sendAT("AT+HTTPPARA=\"URL\",\"" + url + "\"", "OK", 5000);

  if (sendAT("AT+HTTPACTION=0", "OK", 25000)) {
    String actionResp = "";
    unsigned long t = millis();
    while (millis() - t < 20000) {
      while (Serial1.available()) actionResp += (char)Serial1.read();
      if (actionResp.indexOf("+HTTPACTION:") != -1) break;
      delay(100);
    }
    if (actionResp.indexOf(",200,") != -1) {
      Serial1.println("AT+HTTPREAD");
      delay(1500);
      String response = "";
      t = millis();
      while (millis() - t < 10000) {
        while (Serial1.available()) response += (char)Serial1.read();
        delay(50);
      }
      String commune = "";
      int searchPos = 0;
      while (true) {
        int lvlIdx = response.indexOf("\"adminLevel\": 8", searchPos);
        if (lvlIdx == -1) break;
        int blockStart = response.lastIndexOf("{", lvlIdx);
        if (blockStart == -1) break;
        String bloc = response.substring(blockStart, lvlIdx + 20);
        String nom  = extractJson(bloc, "\"name\"");
        if (nom.length() > 0) { commune = nom; break; }
        searchPos = lvlIdx + 1;
      }
      if (commune.length() == 0) {
        searchPos = 0;
        while (true) {
          int lvlIdx = response.indexOf("\"adminLevel\": 6", searchPos);
          if (lvlIdx == -1) break;
          int blockStart = response.lastIndexOf("{", lvlIdx);
          if (blockStart == -1) break;
          String bloc = response.substring(blockStart, lvlIdx + 20);
          String nom  = extractJson(bloc, "\"name\"");
          if (nom.length() > 0) { commune = nom; break; }
          searchPos = lvlIdx + 1;
        }
      }
      String country = extractJson(response, "\"countryName\"");
      int parIdx = country.indexOf(" (");
      if (parIdx != -1) country = country.substring(0, parIdx);
      if (commune.length() > 0) {
        ville = commune;
        if (country.length() > 0) ville += ", " + country;
      } else if (country.length() > 0) {
        ville = country;
      }
      Serial.println("[GEO] Ville: " + ville);
    }
  }
  sendAT("AT+HTTPTERM", "OK", 3000);

reopen:
  delay(500);
  reopenMQTT();
  gpsStartStream();
  return ville;
}

// ════════════════════════════════════════════════════════════
// NMEA Parser
// ════════════════════════════════════════════════════════════
float nmeaToDegrees(String nmea) {
  float raw = nmea.toFloat();
  int deg   = (int)(raw / 100);
  float min = raw - (deg * 100);
  return deg + (min / 60.0);
}

void processNMEA_RMC(const String& sentence) {
  String champs[12];
  int idx = 0, start = 0;
  for (int i = 0; i <= (int)sentence.length() && idx < 12; i++) {
    if (i == (int)sentence.length() || sentence[i] == ',' || sentence[i] == '*') {
      champs[idx++] = sentence.substring(start, i);
      start = i + 1;
    }
  }
  if (idx < 10) return;
  if (champs[2] != "A") { Serial.println("⏳ GPS pas actif (status=" + champs[2] + ")"); return; }

  float lat = nmeaToDegrees(champs[3]);
  float lon = nmeaToDegrees(champs[5]);
  if (champs[4] == "S") lat = -lat;
  if (champs[6] == "W") lon = -lon;
  float kmh = champs[7].toFloat() * 1.852;

  if (!gpsFixed) {
    gpsFixed = true;
    Serial.println("\n╔════════════════════════════════════╗");
    Serial.println("║  ✅ GPS FIX OBTENU !                ║");
    Serial.println("╚════════════════════════════════════╝\n");
  }

  if (derniereVille == "..." || millis() - dernierAppel > 60000) {
    derniereVille = getVille(lat, lon);
    dernierAppel  = millis();
  }

  String h     = champs[1].substring(0, 2);
  String m     = champs[1].substring(2, 4);
  String s     = champs[1].substring(4, 6);
  String jour  = champs[9].substring(0, 2);
  String mois  = champs[9].substring(2, 4);
  String annee = "20" + champs[9].substring(4, 6);

  Serial.println("┌──────────────────────────────────┐");
  Serial.println("│  ✓ GPS FIX                       │");
  Serial.println("├──────────────────────────────────┤");
  Serial.println("│  Ville    : " + derniereVille);
  Serial.printf( "│  Lat      : %.6f %s\n", lat, champs[4].c_str());
  Serial.printf( "│  Lon      : %.6f %s\n", lon, champs[6].c_str());
  Serial.printf( "│  Vitesse  : %.1f km/h\n", kmh);
  Serial.println("│  Date     : " + jour + "/" + mois + "/" + annee);
  Serial.println("│  Heure    : " + h + ":" + m + ":" + s);
  Serial.println("└──────────────────────────────────┘");

  if (!mqttConnecte) reopenMQTT();

  StaticJsonDocument<384> doc;
  doc["ville"]   = derniereVille;
  doc["device"]  = "sahra001";
  doc["lat"]     = lat; doc["lat_dir"] = champs[4];
  doc["lon"]     = lon; doc["lon_dir"] = champs[6];
  doc["vitesse"] = kmh;
  doc["date"]    = jour + "/" + mois + "/" + annee;
  doc["heure"]   = h + ":" + m + ":" + s;
  if (kitActif) doc["package_id"] = packageId;

  String payload;
  serializeJson(doc, payload);
  mqttPublish(MQTT_TOPIC_GPS, payload);
  Serial.println("📍 GPS publié !");
}

// ════════════════════════════════════════════════════════════
// Init GPRS
// ════════════════════════════════════════════════════════════
bool initGPRS() {
  delay(2000);
  Serial.println("[SIM808] Attente module...");
  bool ready = false;
  for (int attempt = 0; attempt < 20; attempt++) {
    while (Serial1.available()) Serial1.read();
    Serial1.println("AT");
    delay(800);
    String r = "";
    while (Serial1.available()) r += (char)Serial1.read();
    Serial.println("  essai " + String(attempt + 1) + " → [" + r + "]");
    if (r.indexOf("OK") != -1) { ready = true; break; }
  }
  if (!ready) return false;

  sendAT("ATE0",       "OK",    3000);
  sendAT("AT+CPIN?",   "READY", 8000);
  sendAT("AT+CREG?",   "0,1",   15000);
  sendAT("AT+CGATT=1", "OK",    8000);

  Serial1.println("AT+SAPBR=0,1");
  delay(3000);
  while (Serial1.available()) Serial1.read();

  sendAT("AT+SAPBR=3,1,\"Contype\",\"GPRS\"",                   "OK");
  sendAT("AT+SAPBR=3,1,\"APN\",\""  + String(APN)       + "\"", "OK");
  sendAT("AT+SAPBR=3,1,\"USER\",\"" + String(APN_USER)  + "\"", "OK");
  sendAT("AT+SAPBR=3,1,\"PWD\",\""  + String(APN_PASS)  + "\"", "OK");

  if (!sendAT("AT+SAPBR=1,1", "OK", 30000)) return false;
  sendAT("AT+SAPBR=2,1", "OK", 3000);
  return true;
}

// ════════════════════════════════════════════════════════════
// Init MQTT
// ════════════════════════════════════════════════════════════
bool initMQTT() {
  String cmd = "AT+CIPSTART=\"TCP\",\"" + String(MQTT_HOST) + "\"," + String(MQTT_PORT);
  Serial.println("[MQTT] Connexion à " + String(MQTT_HOST));
  if (!sendAT(cmd, "CONNECT", 20000)) return false;
  Serial.println("[MQTT] ✅ TCP connecté");
  delay(1000);
  if (!mqttConnect()) return false;
  mqttConnecte = true;
  Serial.println("[MQTT] ✅ Connecté à HiveMQ !");
  return true;
}

// ════════════════════════════════════════════════════════════
// MPU6050
// ════════════════════════════════════════════════════════════
void publishMPUIfAnomaly() {
  int16_t axRaw, ayRaw, azRaw, gx, gy, gz;
  mpu.getMotion6(&axRaw, &ayRaw, &azRaw, &gx, &gy, &gz);

  float ax = axRaw / 16384.0;
  float ay = ayRaw / 16384.0;
  float az = azRaw / 16384.0;
  float magnitude = sqrt(ax*ax + ay*ay + az*az);
  float delta = fabs(magnitude - prev_mag);
  prev_mag = magnitude;

  if (magnitude > 2.5f && shock_start == 0) shock_start = millis();
  if (magnitude < 1.2f && shock_start > 0)  shock_start = 0;
  uint32_t dur = (shock_start > 0) ? (uint32_t)(millis() - shock_start) : 0;

  Serial.printf("[MPU] mag=%.2f delta=%.2f ", magnitude, delta);

  bool anomaly = false;
  if (magnitude > MPU_MAGNITUDE_THRESHOLD && delta > MPU_DELTA_THRESHOLD) anomaly = true;
  if (delta < MPU_LOW_DELTA) anomaly = false;

  if (!mqttConnecte) { if (!reopenMQTT()) return; }

  gpsStopStream();

  StaticJsonDocument<256> doc;
  doc["ax"] = ax; doc["ay"] = ay; doc["az"] = az;
  doc["magnitude"] = magnitude;
  doc["delta_magnitude"] = delta;
  doc["duration_ms"] = dur;
  doc["package_id"] = packageId;
  doc["device"] = "sahra001";
  doc["ville"] = derniereVille;
  doc["is_anomaly"] = anomaly;

  String payload;
  serializeJson(doc, payload);
  mqttPublish(MQTT_TOPIC_SENSOR, payload);

  if (anomaly) {
    lastAnomaly = millis();
    Serial.println("→ 🚨 ANOMALIE DÉTECTÉE");
    Serial.printf("[SLEEP] lastAnomaly mis à jour → %lu ms\n", lastAnomaly);

    StaticJsonDocument<256> aiDoc;
    aiDoc["type"] = "motion_anomaly";
    aiDoc["ax"] = ax; aiDoc["ay"] = ay; aiDoc["az"] = az;
    aiDoc["magnitude"] = magnitude;
    aiDoc["delta_magnitude"] = delta;
    aiDoc["duration_ms"] = dur;
    aiDoc["device"] = "sahra001";
    aiDoc["ville"] = derniereVille;
    aiDoc["package_id"] = packageId;
    aiDoc["timestamp"] = millis();
    String aiPayload;
    serializeJson(aiDoc, aiPayload);
    mqttPublish("sahra/ai", aiPayload);
    Serial.println("🚨 ANOMALIE ENVOYÉE À GROQ AI");
  } else {
    Serial.println("→ 🟢 Normal");
  }

  gpsStartStream();
}

// ════════════════════════════════════════════════════════════
// DHT22
// ════════════════════════════════════════════════════════════
void publishDHT() {
  float temperature = dht.readTemperature();
  float humidity    = dht.readHumidity();

  if (isnan(temperature) || isnan(humidity)) {
    delay(250);
    temperature = dht.readTemperature();
    humidity    = dht.readHumidity();
  }
  if (isnan(temperature) || isnan(humidity)) {
    Serial.println("[DHT] ⚠️ Erreur lecture DHT22");
    return;
  }

  Serial.printf("[DHT] T=%.1f°C H=%.1f%%\n", temperature, humidity);

  if (!mqttConnecte) {
    if (!reopenMQTT()) { Serial.println("[MQTT] ❌ Reconnexion impossible"); return; }
  }

  StaticJsonDocument<256> doc;
  doc["temperature"] = temperature;
  doc["humidity"]    = humidity;
  doc["timestamp"]   = millis();
  doc["device"]      = "sahra001";
  doc["ville"]       = derniereVille;
  if (kitActif) doc["package_id"] = packageId;

  String payload;
  serializeJson(doc, payload);
  Serial.println("[MQTT] 📤 Envoi DHT");
  Serial.println("[MQTT] 📦 Payload: " + payload);
  mqttPublish(MQTT_TOPIC_DHT, payload);
  Serial.println("[DHT] ✅ Données envoyées");
}

// ════════════════════════════════════════════════════════════
// Traitement MQTT entrant (commandes)
// ════════════════════════════════════════════════════════════
void processMqttPacket() {
  if ((mqttInBuf[0] & 0xF0) != 0x30) return;
  if (mqttInLen < 6) return;

  uint16_t remLen;
  uint8_t  hdrBytes;
  if (mqttInBuf[1] & 0x80) {
    remLen   = (mqttInBuf[2] << 7) | (mqttInBuf[1] & 0x7F);
    hdrBytes = 2;
  } else {
    remLen   = mqttInBuf[1];
    hdrBytes = 1;
  }

  uint8_t* ptr = mqttInBuf + 1 + hdrBytes;
  uint16_t tLen = ((uint16_t)ptr[0] << 8) | ptr[1];
  ptr += 2;
  if (tLen < 5 || tLen >= MQTT_IN_BUF_SIZE) return;

  String topic = "";
  for (uint16_t i = 0; i < tLen; i++) topic += (char)ptr[i];
  ptr += tLen;
  if (topic != String(MQTT_TOPIC_CMD)) return;

  uint16_t payloadLen = remLen - 2 - tLen;
  String payload = "";
  for (uint16_t i = 0; i < payloadLen; i++) payload += (char)ptr[i];

  Serial.println("[CMD] Reçu → " + payload);

  if (payload.indexOf("\"assign\"") != -1) {
    int idx   = payload.indexOf("\"package_id\"");
    if (idx != -1) {
      int colon = payload.indexOf(":", idx);
      int q1    = payload.indexOf("\"", colon + 1);
      int q2    = payload.indexOf("\"", q1 + 1);
      packageId  = payload.substring(q1 + 1, q2);
      kitActif   = true;
      kitDelivre = false;
      Serial.println("╔══════════════════════════════════╗");
      Serial.println("║  KIT ASSIGNÉ → " + packageId);
      Serial.println("╚══════════════════════════════════╝");
      char msg[128];
      snprintf(msg, sizeof(msg),
        "{\"device\":\"sahra001\",\"event\":\"assigned\","
        "\"package_id\":\"%s\",\"timestamp\":%lu}",
        packageId.c_str(), millis());
      mqttPublish(MQTT_TOPIC_STATUS, String(msg));
    }
    return;
  }

  if (payload.indexOf("\"deliver\"") != -1) {
    kitDelivre = true; kitActif = false;
    Serial.println("╔══════════════════════════════════╗");
    Serial.println("║  LIVRAISON CONFIRMÉE → " + packageId);
    Serial.println("╚══════════════════════════════════╝");
    char msg[128];
    snprintf(msg, sizeof(msg),
      "{\"device\":\"sahra001\",\"event\":\"delivered\","
      "\"package_id\":\"%s\",\"timestamp\":%lu}",
      packageId.c_str(), millis());
    mqttPublish(MQTT_TOPIC_STATUS, String(msg));
    delay(500);
    Serial.println("[SLEEP] 💤 Deep sleep PERMANENT — livraison confirmée");
    esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
    esp_deep_sleep_start();
  }

  if (payload.indexOf("\"reset\"") != -1) {
    Serial.println("╔══════════════════════════════════╗");
    Serial.println("║  KIT RÉINITIALISÉ — LIBRE        ║");
    Serial.println("╚══════════════════════════════════╝");
    char msg[128];
    snprintf(msg, sizeof(msg),
      "{\"device\":\"sahra001\",\"event\":\"free\","
      "\"package_id\":\"%s\",\"timestamp\":%lu}",
      packageId.c_str(), millis());
    mqttPublish(MQTT_TOPIC_STATUS, String(msg));
    packageId = ""; kitActif = false; kitDelivre = false;
    return;
  }
}

// ════════════════════════════════════════════════════════════
// Lecture Serial1 — NMEA + MQTT
// ════════════════════════════════════════════════════════════
void readSerial1() {
  while (Serial1.available()) {
    char c = Serial1.read();

    if ((uint8_t)c == 0x30 && !gpsBuffer.length()) {
      mqttInMode = true;
      mqttInLen  = 0;
      mqttInBuf[mqttInLen++] = (uint8_t)c;
      continue;
    }

    if (mqttInMode) {
      if (mqttInLen < MQTT_IN_BUF_SIZE) mqttInBuf[mqttInLen++] = (uint8_t)c;
      if (mqttInLen >= 2) {
        uint16_t remLen;
        uint8_t  hdrBytes;
        if (mqttInBuf[1] & 0x80) {
          if (mqttInLen < 3) continue;
          remLen   = (mqttInBuf[2] << 7) | (mqttInBuf[1] & 0x7F);
          hdrBytes = 2;
        } else {
          remLen   = mqttInBuf[1];
          hdrBytes = 1;
        }
        uint16_t totalExpected = 1 + hdrBytes + remLen;
        if (mqttInLen >= totalExpected) {
          processMqttPacket();
          mqttInMode = false;
          mqttInLen  = 0;
        }
      }
      continue;
    }

    if (c == '\n') {
      gpsBuffer.trim();
      if (gpsBuffer.startsWith("$GPRMC")) processNMEA_RMC(gpsBuffer);
      gpsBuffer = "";
    } else {
      gpsBuffer += c;
    }
  }
}

// ════════════════════════════════════════════════════════════
// Deep Sleep — Scénario 1
// ════════════════════════════════════════════════════════════
void enterDeepSleep(uint32_t seconds) {
  Serial.printf("[SLEEP] 💤 Veille %d s...\n", seconds);
  gpsStopStream();
  delay(300);
  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  esp_deep_sleep_start();
}

// ════════════════════════════════════════════════════════════
// Setup
// ════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  Serial1.begin(9600, SERIAL_8N1, RXD2, TXD2);

  // Raison du réveil (après deep sleep)
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  if (cause == ESP_SLEEP_WAKEUP_TIMER) {
    Serial.println("\n[WAKE] ⏰ Réveil après deep sleep timer");
  } else {
    Serial.println("\n[WAKE] 🔌 Démarrage initial (cold boot)");
  }

  delay(3000);

#if TEST_MODE
  Serial.println("╔══════════════════════════════════════════════╗");
  Serial.println("║  ⚠️  MODE TEST ACTIF                         ║");
  Serial.println("║  Sleep cycle  : 30s  (prod: 120s)           ║");
  Serial.println("║  Anomalie stay: 60s  (prod: 180s)           ║");
  Serial.println("║  DHT interval : 10s  (prod: 30s)            ║");
  Serial.println("╚══════════════════════════════════════════════╝");
#endif

  Wire.begin(SDA_PIN, SCL_PIN);
  mpu.initialize();
  if (mpu.testConnection()) Serial.println("[MPU] ✓ Connecté");
  else { Serial.println("[MPU] ✗ ÉCHEC"); while (1); }
  mpu.setDLPFMode(MPU6050_DLPF_BW_42);

  dht.begin();
  delay(2000);
  for (int i = 0; i < 3; i++) {
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    Serial.printf("Essai %d → Temp: %.1f°C | Hum: %.1f%%\n", i+1, t, h);
    delay(2000);
  }
  Serial.println("[DHT] ✓ Initialisé");

  Serial.println("[GPS] Allumage...");
  Serial1.println("AT+CGPSPWR=1");
  delay(1000);
  while (Serial1.available()) Serial1.read();
  sendAT("AT+CGPSOUT=255", "OK", 3000);
  flushSerial1();
  gpsStopStream();

  if (!initGPRS()) { gpsStartStream(); while (1) delay(1000); }
  Serial.println("[GPRS] ✓ Connecté !");
  if (!initMQTT()) { gpsStartStream(); while (1) delay(1000); }
  Serial.println("[MQTT] ✓ Connecté !");

  gpsStartStream();
  lastWakeUp = millis();

  Serial.println("\n╔════════════════════════════════════════════╗");
  Serial.println("║  SAHRA v3.2 — Scénario 1 actif !          ║");
  Serial.println("║  Attendre 30s sans anomalie → veille       ║");
  Serial.println("║  Secouer MPU → blocage veille 60s          ║");
  Serial.println("║  Envoyer {\"cmd\":\"deliver\"} → veille perm  ║");
  Serial.println("╚════════════════════════════════════════════╝\n");
}

// ════════════════════════════════════════════════════════════
// Loop principal — Scénario 1
// ════════════════════════════════════════════════════════════
void loop() {
  readSerial1();

  if (!gpsFixed) {
    delay(100);
    return;
  }

  unsigned long now = millis();

  // ── DHT ─────────────────────────────────────────────────
  if (now - dernierDHT > DHT_INTERVAL) {
    publishDHT();
    dernierDHT = now;
  }

  // ── MPU ─────────────────────────────────────────────────
  if (now - dernierSensor > MPU_INTERVAL) {
    publishMPUIfAnomaly();
    dernierSensor = now;
  }

  // ── Ping MQTT ───────────────────────────────────────────
  if (mqttConnecte && now - dernierPing > PING_INTERVAL) {
    mqttPing();
    dernierPing = now;
  }

  // ── Logique deep sleep cyclique ─────────────────────────
  if (now - lastWakeUp > SLEEP_INTERVAL) {

#if TEST_MODE
    unsigned long sinceAnomaly = (lastAnomaly > 0) ? (now - lastAnomaly) : 999999;
    Serial.printf("[SLEEP] Cycle check — last anomaly: %lu ms ago (seuil: %d ms)\n",
                  sinceAnomaly, ANOMALY_STAY_MS);
#endif

    bool anomalieRecente = (lastAnomaly > 0 && (now - lastAnomaly) < ANOMALY_STAY_MS);

    if (!anomalieRecente) {
      Serial.println("[SLEEP] ✅ Pas d'anomalie récente → entrée en veille");
#if TEST_MODE
      enterDeepSleep(10);
#else
      enterDeepSleep(120);
#endif
      gpsStartStream();
      lastWakeUp = millis();
    } else {
      unsigned long resteActif = ANOMALY_STAY_MS - (now - lastAnomaly);
      Serial.printf("[SLEEP] ⚠️  Anomalie récente → reste actif encore %lu s\n",
                    resteActif / 1000);
      lastWakeUp = now;
    }
  }

  delay(2);
}