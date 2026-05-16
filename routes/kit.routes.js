// routes/kit.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/kit.controller');

// GET    /api/kits          → liste tous les kits + statut
// POST   /api/kits          → enregistrer un nouveau kit
// GET    /api/kits/:kit_id  → détail d'un kit
// DELETE /api/kits/:kit_id  → supprimer un kit (seulement si free)

router.get('/', ctrl.getAll);
router.get('/free', ctrl.getFree);   // ← NOUVELLE ROUTE
router.post('/', ctrl.create);
router.get('/:kit_id', ctrl.getOne);
router.delete('/:kit_id', ctrl.remove);

// ── Commandes MQTT ──────────────────────────────────────────
router.post('/:kit_id/assign',  ctrl.assign);
router.post('/:kit_id/deliver', ctrl.deliver);

module.exports = router;
