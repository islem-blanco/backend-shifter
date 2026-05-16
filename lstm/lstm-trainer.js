/**
 * lstm-trainer.js
 * Convertit l'historique MongoDB en fenêtres temporelles et entraîne le LSTM.
 *
 * Utilisation manuelle :
 *   node lstm-trainer.js
 *
 * Ou depuis le service :
 *   const { trainModel } = require('./lstm-trainer');
 *   await trainModel(model);
 */
'use strict';
const tf = require('@tensorflow/tfjs');
const SensorData = require('../models/SensorData');
const { WINDOW_SIZE, N_FEATURES, saveModel, loadOrBuildModel } = require('./lstm-model');

// ── Normalisation min-max ──────────────────────────────────────────────────────
// Limites physiques attendues par feature :
// [ax, ay, az, temperature, humidity]
const FEATURE_RANGES = [
  { min: -6,  max: 6   },   // ax
  { min: -6,  max: 6   },   // ay
  { min: -6,  max: 6   },   // az
  { min: -10, max: 60  },   // temperature
  { min: 0,   max: 100 },   // humidity
];

function normalize(value, featureIndex) {
  const { min, max } = FEATURE_RANGES[featureIndex];
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

// ── Conversion d'un document SensorData en vecteur de features ────────────────
function docToFeatures(doc) {
  return [
    normalize(doc.ax          ?? 0, 0),
    normalize(doc.ay          ?? 0, 1),
    normalize(doc.az          ?? 0, 2),
    normalize(doc.temperature ?? 20, 3),
    normalize(doc.humidity    ?? 50, 4),
  ];
}

// ── Construction des fenêtres glissantes ──────────────────────────────────────
/**
 * @param {Array} docs         - Documents triés par timestamp ASC
 * @param {number} windowSize  - Taille de fenêtre (défaut WINDOW_SIZE)
 * @returns {{ X: number[][][], y: number[] }}
 *   X shape : [n_samples, WINDOW_SIZE, N_FEATURES]
 *   y shape : [n_samples] — 1 si la fenêtre contient une anomalie, 0 sinon
 */
function buildWindows(docs, windowSize = WINDOW_SIZE) {
  const X = [];
  const y = [];

  for (let i = 0; i <= docs.length - windowSize; i++) {
    const window = docs.slice(i, i + windowSize);
    const features = window.map(docToFeatures);

    // Label : 1 si au moins un point de la fenêtre est marqué anomalie
const shockCount = window.filter(d => d.shock === true).length;
const label = shockCount >= 6 ? 1 : 0; // 6 out of 20 = 30%
    X.push(features);
    y.push(label);
  }

  return { X, y };
}

// ── Chargement de l'historique depuis MongoDB ──────────────────────────────────
async function loadTrainingData(packageId = null, limit = 5000) {
 const query = packageId ? { colis_id: packageId } : {};

  const docs = await SensorData
    .find(query)
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  console.log(`[LSTM Trainer] ${docs.length} documents chargés depuis MongoDB`);
  return docs;
}

// ── Entraînement ───────────────────────────────────────────────────────────────
async function trainModel(model, options = {}) {
  const {
    packageId = null,
    epochs    = 30,
    batchSize = 32,
    limit     = 5000,
  } = options;

  const docs = await loadTrainingData(packageId, limit);

  if (docs.length < WINDOW_SIZE * 2) {
    console.warn('[LSTM Trainer] Pas assez de données pour l\'entraînement');
    return { success: false, reason: 'insufficient_data' };
  }

  const { X, y } = buildWindows(docs);
  console.log(`[LSTM Trainer] ${X.length} fenêtres de ${WINDOW_SIZE} pts construites`);

  const anomalyCount = y.filter(v => v === 1).length;
  console.log(`[LSTM Trainer] Distribution : ${anomalyCount} anomalies / ${y.length - anomalyCount} normaux`);

  // Conversion en tenseurs
  const xs = tf.tensor3d(X, [X.length, WINDOW_SIZE, N_FEATURES]);
  const ys = tf.tensor2d(y, [y.length, 1]);

  // Poids de classe pour compenser le déséquilibre anomalie/normal
  const posWeight = (y.length - anomalyCount) / Math.max(anomalyCount, 1);
  const classWeight = { 0: 1, 1: Math.min(posWeight, 10) };

  console.log(`[LSTM Trainer] Poids classe anomalie : ${classWeight[1].toFixed(2)}`);
  console.log('[LSTM Trainer] Entraînement...');

  const history = await model.fit(xs, ys, {
    epochs,
    batchSize,
    validationSplit: 0.15,
    classWeight,
    callbacks: {
      onEpochEnd: (epoch, logs) => {
        if ((epoch + 1) % 5 === 0) {
          console.log(
            `[LSTM Trainer] Epoch ${epoch + 1}/${epochs}` +
            ` — loss: ${logs.loss.toFixed(4)}` +
            ` — acc: ${logs.acc?.toFixed(4) ?? '?'}` +
            ` — val_loss: ${logs.val_loss?.toFixed(4) ?? '?'}`
          );
        }
      },
    },
  });

  // Nettoyage mémoire GPU/CPU
  xs.dispose();
  ys.dispose();

  await saveModel(model);

  const finalMetrics = history.history;
  return {
    success    : true,
    epochs     : epochs,
    samples    : X.length,
    finalLoss  : finalMetrics.loss[finalMetrics.loss.length - 1],
    finalAcc   : finalMetrics.acc?.[finalMetrics.acc.length - 1],
    finalValLoss: finalMetrics.val_loss?.[finalMetrics.val_loss.length - 1],
  };
}

// ── Point d'entrée script standalone ──────────────────────────────────────────
if (require.main === module) {
  (async () => {
    try {
      const mongoose = require('mongoose');
      await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/shiftterdb');
      console.log('[LSTM Trainer] MongoDB connecté');

      const model = await loadOrBuildModel();
      const result = await trainModel(model, { epochs: 50 });
      console.log('[LSTM Trainer] Résultat :', result);

      await mongoose.disconnect();
      process.exit(0);
    } catch (err) {
      console.error('[LSTM Trainer] Erreur :', err);
      process.exit(1);
    }
  })();
}

module.exports = { trainModel, buildWindows, docToFeatures, normalize, FEATURE_RANGES };
