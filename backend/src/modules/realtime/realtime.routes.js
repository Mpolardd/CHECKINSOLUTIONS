const express = require('express');
const router = express.Router();
const realtimeService = require('./realtime.service');

// SSE Stream Endpoint
router.get('/stream', (req, res) => {
  realtimeService.addClient(res, req);
});

// SSE Status Endpoint
router.get('/status', (req, res) => {
  res.json({
    status: 'operational',
    connectedClients: realtimeService.getClientCount(),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
