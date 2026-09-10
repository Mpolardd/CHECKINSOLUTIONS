const { EventEmitter } = require('events');

class RealtimeService extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
    this.keepAliveInterval = null;
    this.startKeepAlive();
  }

  startKeepAlive() {
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
    this.keepAliveInterval = setInterval(() => {
      this.sendComment('ping');
    }, 25000);
  }

  addClient(res, req) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering for nginx / load balancers

    // Initial greeting event
    res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString(), message: 'SFMI Realtime Stream Active' })}\n\n`);

    this.clients.add(res);

    const cleanup = () => {
      this.clients.delete(res);
      try { res.end(); } catch (e) {}
    };

    req.on('close', cleanup);
    req.on('end', cleanup);
    res.on('error', cleanup);
  }

  sendComment(comment) {
    const payload = `: ${comment}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch (err) {
        this.clients.delete(client);
      }
    }
  }

  broadcast(eventType, data = {}) {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify({ ...data, timestamp: Date.now() })}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch (err) {
        this.clients.delete(client);
      }
    }
    this.emit(eventType, data);
  }

  getClientCount() {
    return this.clients.size;
  }
}

const realtimeService = new RealtimeService();
module.exports = realtimeService;
