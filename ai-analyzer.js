const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const CALL_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms)
    ),
  ]);
}

async function analyzeWithAI(topic, data, history) {

  const dhtHistory = history.dht.map((h, i) =>
    `  -${history.dht.length - i}: temp=${h.temperature}°C, hum=${h.humidity}%`
  ).join('\n');

  const gpsHistory = history.gps.map((h, i) =>
    `  -${history.gps.length - i}: vitesse=${h.vitesse}km/h, ville=${h.ville}`
  ).join('\n');

  const sensorHistory = history.sensor.map((h, i) =>
    `  -${history.sensor.length - i}: mag=${h.magnitude}g, delta=${h.delta_magnitude}g, dur=${h.duration_ms}ms`
  ).join('\n');

  let contextPrompt = '';

  if (topic.includes('sensor')) {
    contextPrompt = `
Données accéléromètre MPU6050 reçues :
- ax              : ${data.ax} g
- ay              : ${data.ay} g
- az              : ${data.az} g
- magnitude       : ${data.magnitude} g
- delta_magnitude : ${data.delta_magnitude} g
- duration_ms     : ${data.duration_ms} ms
- Package ID      : ${data.package_id || 'non assigné'}

Historique des 10 dernières mesures capteur :
${sensorHistory || 'Aucun'}

Historique GPS :
${gpsHistory || 'Aucun'}

RÈGLES IMPORTANTES :
- Une magnitude proche de 1g est NORMALE (gravité terrestre)
- Les petites variations entre 0.001 et 0.05 sont du bruit normal du MPU6050
- Ne jamais détecter un choc si duration_ms = 0
- Ne jamais détecter un choc si delta_magnitude < 0.2
- Ignorer les micro vibrations immobiles

RÈGLES DE DÉTECTION DE CHOC :
- VRAI CHOC :
  magnitude > 2.0
  ET delta_magnitude > 0.5
  ET duration_ms entre 20 et 800 ms

- CHOC SUSPECT :
  magnitude entre 1.6 et 2.0
  ET delta_magnitude > 0.3
  ET duration_ms > 15 ms

- FAUX POSITIF :
  magnitude < 1.5
  OU delta_magnitude < 0.2
  OU duration_ms < 15
  OU capteur immobile

RÈGLES DE SÉVÉRITÉ :
- light     = magnitude 2.0 à 2.5g
- moderate  = magnitude 2.5 à 3.5g
- severe    = magnitude > 3.5g
    `;
  }

  const prompt = `
Tu es un système intelligent de surveillance de colis en temps réel.
Analyse les données reçues et retourne une décision JSON.

IMPORTANT :
- Sois strict contre les faux positifs
- Une magnitude proche de 1g est normale
- Les petites variations MPU6050 ne sont PAS des chocs
- Si les conditions ne sont pas clairement remplies => NORMAL

${contextPrompt}

Réponds UNIQUEMENT en JSON valide :
{
  "event": "NORMAL | SHOCK_CONFIRMED | SHOCK_SUSPECTED | TEMP_WARNING | TEMP_CRITICAL | GPS_ANOMALY | ANOMALY",
  "shock_detected": false,
  "shock_severity": "none | light | moderate | severe",
  "temperature_status": "OK | WARNING | CRITICAL",
  "gps_status": "OK | ARRET_SUSPECT | VITESSE_ANORMALE",
  "confidence": 0.0,
  "reason": "explication courte en français max 10 mots",
  "alert_level": "none | low | medium | high",
  "package_id": "${data.package_id || 'non assigné'}"
}
`;


  const response = await withTimeout(
    groq.chat.completions.create({
      model:       process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      max_tokens:  150,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
    CALL_TIMEOUT_MS
  );

  const text = response.choices[0].message.content;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Groq na pas retourné de JSON valide : ' + text);
  }

  return JSON.parse(jsonMatch[0]);
}

module.exports = { analyzeWithAI };