/**
 * lstm-model.js
 * Définition et persistance du modèle LSTM avec TensorFlow.js
 *
 * Installation : npm install @tensorflow/tfjs-node
 */
const tf = require('@tensorflow/tfjs');
'use strict';

const path = require('path');
const fs   = require('fs');
// ── Hyperparamètres ────────────────────────────────────────────────────────────
const MODEL_DIR    = path.join(__dirname, 'saved_model');
const WINDOW_SIZE  = 20;     // Nombre de pas de temps par fenêtre
const N_FEATURES   = 5;      // ax, ay, az, temperature, humidity
const LSTM_UNITS   = 64;     // Cellules LSTM par couche
const DROPOUT_RATE = 0.2;

// ── Construction du modèle ─────────────────────────────────────────────────────
function buildModel() {
  const model = tf.sequential();

  // Couche LSTM 1 — extrait les patterns temporels grossiers
  model.add(tf.layers.lstm({
    units         : LSTM_UNITS,
    inputShape    : [WINDOW_SIZE, N_FEATURES],
    returnSequences: true,   // passer la séquence complète à la couche suivante
    dropout       : DROPOUT_RATE,
    recurrentDropout: DROPOUT_RATE,
    name          : 'lstm_1',
  }));

  // Couche LSTM 2 — raffine l'abstraction temporelle
  model.add(tf.layers.lstm({
    units         : LSTM_UNITS / 2,
    returnSequences: false,  // résumé vectoriel final
    dropout       : DROPOUT_RATE,
    recurrentDropout: DROPOUT_RATE,
    name          : 'lstm_2',
  }));

  // Couche dense intermédiaire
  model.add(tf.layers.dense({ units: 32, activation: 'relu', name: 'dense_1' }));
  model.add(tf.layers.dropout({ rate: 0.1, name: 'dropout_out' }));

  // Sortie : 1 neurone sigmoid → probabilité d'anomalie [0, 1]
  model.add(tf.layers.dense({ units: 1, activation: 'sigmoid', name: 'output' }));

  model.compile({
    optimizer: tf.train.adam(0.001),
    loss     : 'binaryCrossentropy',
    metrics  : ['accuracy'],
  });

  return model;
}

// ── Sauvegarde ─────────────────────────────────────────────────────────────────


async function saveModel(model) {
  const dir = path.resolve(__dirname, 'saved_model');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Save as JSON instead of file:// (doesn't require tfjs-node)
  const saveResult = await model.save(tf.io.withSaveHandler(async (artifacts) => {
    fs.writeFileSync(
      path.join(dir, 'model.json'),
      JSON.stringify({ modelTopology: artifacts.modelTopology, weightsManifest: [] })
    );
    fs.writeFileSync(
      path.join(dir, 'weights.bin'),
      Buffer.from(artifacts.weightData)
    );
    fs.writeFileSync(
      path.join(dir, 'weight_specs.json'),
      JSON.stringify(artifacts.weightSpecs)
    );
    return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
  }));

  console.log('[LSTM Model] Modèle sauvegardé dans', dir);
}
// ── Chargement (ou création) ───────────────────────────────────────────────────
async function loadOrBuildModel() {
  const modelJsonPath = path.join(MODEL_DIR, 'model.json');

  if (fs.existsSync(modelJsonPath)) {
    try {
      const model = await tf.loadLayersModel(`file://${modelJsonPath}`);
      model.compile({
        optimizer: tf.train.adam(0.001),
        loss     : 'binaryCrossentropy',
        metrics  : ['accuracy'],
      });
      console.log('[LSTM Model] Modèle chargé depuis le disque ✓');
      return model;
    } catch (err) {
      console.warn('[LSTM Model] Échec chargement, reconstruction →', err.message);
    }
  }

  console.log('[LSTM Model] Construction d\'un nouveau modèle...');
  return buildModel();
}

module.exports = {
  buildModel,
  loadOrBuildModel,
  saveModel,
  WINDOW_SIZE,
  N_FEATURES,
};