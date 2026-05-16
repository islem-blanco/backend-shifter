'use strict';

const AIAlert              = require('../models/AIAlert');
const { loadOrBuildModel } = require('./lstm-model');
const { trainModel }       = require('./lstm-trainer');
const { pushAndPredict, resetBuffer, getBufferStatus, getBuffer } = require('./lstm-predictor');

// ── État interne ───────────────────────────────────────────────────────────────
let _model        = null;
let _initialized  = false;
let _retrainTimer = null;

const RETRAIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ── Initialisation ─────────────────────────────────────────────────────────────
async function init() {
  if (_initialized) return;

  console.log('[LSTM Service] Initialisation...');
  _model       = await loadOrBuildModel();
  _initialized = true;
  console.log('[LSTM Service] Modèle prêt ✓');

  _retrainTimer = setInterval(async () => {
    try {
      console.log('[LSTM Service] Ré-entraînement périodique...');
      const result = await trainModel(_model, { epochs: 20 });
      if (result.success) {
        console.log(`[LSTM Service] Ré-entraînement OK — loss: ${result.finalLoss?.toFixed(4)}`);
      }
    } catch (err) {
      console.error('[LSTM Service] Erreur ré-entraînement :', err.message);
    }
  }, RETRAIN_INTERVAL_MS);
}

// ── Analyse d'un nouveau point capteur ────────────────────────────────────────
async function analyze(deviceId, sensorDoc, io = null) {
  if (!_initialized) await init();

  // Push first, THEN check if buffer is full
  const result = await pushAndPredict(_model, deviceId, sensorDoc);

  const buf        = getBuffer(deviceId);
  const bufferSize = buf ? buf.length : 0;

  // Cold start — buffer not full yet → Groq continues alone
  if (!result || result.status === 'buffering') {
    console.log(`[LSTM Service] Cold start (${bufferSize}/20) → Groq actif`);
    return null;
  }

  console.log(
    `[LSTM Service] ${deviceId} — prob: ${(result.probability * 100).toFixed(1)}%` +
    (result.is_anomaly ? ' 🚨 ANOMALIE LSTM' : ' ✅ Normal')
  );

  // ── Anomalie détectée → sauvegarder une AIAlert ────────────────────────────
  if (result.is_anomaly) {
    await saveAlert(deviceId, sensorDoc, result);

    if (io) {
      io.emit('lstm_anomaly', {
        device     : deviceId,
        package_id : sensorDoc.package_id,
        probability: result.probability,
        timestamp  : new Date().toISOString(),
        sensor     : {
          ax         : sensorDoc.ax,
          ay         : sensorDoc.ay,
          az         : sensorDoc.az,
          temperature: sensorDoc.temperature,
          humidity   : sensorDoc.humidity,
        },
      });
    }
  }

  return result;
}

// ── Sauvegarde d'une alerte LSTM dans AIAlert ─────────────────────────────────
async function saveAlert(deviceId, sensorDoc, lstmResult) {
  try {
const alert = new AIAlert({
  type         : 'lstm_anomaly',
  event        : 'shock_detected',        // ← add this
  kit_id       : deviceId,                // ← add this  
  device       : deviceId,
  package_id   : sensorDoc.colis_id || sensorDoc.package_id,
  probability  : lstmResult.probability,
  window_size  : lstmResult.window_size,
  sensor_values: {
    ax         : sensorDoc.ax,
    ay         : sensorDoc.ay,
    az         : sensorDoc.az,
    temperature: sensorDoc.temperature,
    humidity   : sensorDoc.humidity,
    magnitude  : sensorDoc.magnitude,
  },
  ville     : sensorDoc.ville,
  created_at: new Date(),
});
    await alert.save();
    console.log('[LSTM Service] Alerte LSTM sauvegardée →', alert._id);
  } catch (err) {
    console.error('[LSTM Service] Erreur sauvegarde alerte :', err.message);
  }
}

// ── Déclenchement manuel de l'entraînement ────────────────────────────────────
async function triggerTraining(options = {}) {
  if (!_initialized) await init();
  return trainModel(_model, options);
}

// ── Réinitialisation d'un buffer appareil ─────────────────────────────────────
function handleDeviceReset(deviceId) {
  resetBuffer(deviceId);
}

// ── Statut (endpoint de monitoring) ───────────────────────────────────────────
function getStatus() {
  return {
    initialized       : _initialized,
    buffers           : getBufferStatus(),
    retrain_interval_h: RETRAIN_INTERVAL_MS / 3600000,
  };
}

// ── Arrêt propre ───────────────────────────────────────────────────────────────
function shutdown() {
  if (_retrainTimer) clearInterval(_retrainTimer);
  console.log('[LSTM Service] Arrêt propre');
}

module.exports = {
  init,
  analyze,
  triggerTraining,
  handleDeviceReset,
  getStatus,
  shutdown,
};