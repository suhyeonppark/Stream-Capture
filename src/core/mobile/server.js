const http = require('http');
const os = require('os');
const { MobileDiscovery, SERVICE_TYPE, getPrimaryLocalIp } = require('./discovery');

class MobileServer {
  constructor({ getStatus, getScenario, onAck, onPair, onScenarioStage, isAuthorized, hasPairedDevices, getDiscoveryInfo }) {
    this.getStatus = getStatus;
    this.getScenario = getScenario;
    this.onAck = onAck;
    this.onPair = onPair;
    this.onScenarioStage = onScenarioStage;
    this.isTokenAuthorized = isAuthorized;
    this.hasPairedDevices = hasPairedDevices;
    this.getDiscoveryInfo = getDiscoveryInfo;
    this.server = null;
    this.settings = null;
    this.discovery = null;
    this.eventClients = new Set();
    this.pingTimer = null;
  }

  async start(settings = {}) {
    await this.stop();
    if (!settings.enabled) return;

    this.settings = {
      host: settings.host || '0.0.0.0',
      port: Number.isFinite(Number(settings.port)) ? Number(settings.port) : 53683,
      token: settings.token || '',
    };

    this.server = http.createServer((req, res) => this.handle(req, res));

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.settings.port, this.settings.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });

    if (settings.discoveryEnabled !== false) {
      this.discovery = new MobileDiscovery({
        getInfo: () => ({
          name: `Stream Watcher - ${os.hostname()}`,
          hostName: os.hostname(),
          ip: this.getLocalIp(),
          port: this.settings.port,
          serviceType: SERVICE_TYPE,
          ...(this.getDiscoveryInfo?.() || {}),
        }),
      });
      try {
        await this.discovery.start();
      } catch {
        this.discovery = null;
      }
    }
  }

  async stop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const client of this.eventClients) {
      try { client.end(); } catch {}
    }
    this.eventClients.clear();
    if (this.discovery) {
      try { await this.discovery.stop(); } catch {}
      this.discovery = null;
    }
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }

  isRunning() {
    return !!this.server?.listening;
  }

  getLocalIp() {
    return getPrimaryLocalIp();
  }

  getPublicUrl() {
    if (!this.settings || !this.isRunning()) return null;
    return `http://${this.getLocalIp()}:${this.settings.port}`;
  }

  async handle(req, res) {
    try {
      if (req.method === 'OPTIONS') {
        return sendJson(res, 200, { ok: true });
      }

      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/api/mobile/health') {
        return sendJson(res, 200, {
          ok: true,
          name: 'Stream Watcher',
          version: getAppVersion(),
          schemaVersion: 1,
          serviceType: SERVICE_TYPE,
          discoveryEnabled: !!this.discovery,
          ...(this.getDiscoveryInfo?.() || {}),
          serverTime: Date.now(),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/mobile/pair') {
        const body = await readJsonBody(req);
        const result = this.onPair?.(body) || { ok: false, error: 'pairing_unavailable' };
        // PIN 오류는 인증 실패(401)가 아니라 요청 오류(400) — 앱이 구체적 PIN 메시지를 보이도록
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'GET' && url.pathname === '/api/mobile/status') {
        if (!this.isAuthorized(req)) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        return sendJson(res, 200, this.getStatus?.() || {});
      }

      if (req.method === 'GET' && url.pathname === '/api/mobile/scenario') {
        if (!this.isAuthorized(req)) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        return sendJson(res, 200, this.getScenario?.() || {});
      }

      if (req.method === 'POST' && url.pathname === '/api/mobile/scenario/stage') {
        if (!this.isAuthorized(req)) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        const body = await readJsonBody(req);
        const result = this.onScenarioStage?.(body) || { ok: false, error: 'scenario_unavailable' };
        return sendJson(res, result.ok === false ? 400 : 200, result);
      }

      if (req.method === 'GET' && url.pathname === '/api/mobile/events') {
        if (!this.isAuthorized(req)) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        return this.openEventStream(req, res);
      }

      if (req.method === 'POST' && url.pathname === '/api/mobile/ack') {
        if (!this.isAuthorized(req)) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        const body = await readJsonBody(req);
        const result = this.onAck?.(body) || { ok: true };
        return sendJson(res, result.ok === false ? 409 : 200, result);
      }

      return sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  isAuthorized(req) {
    const token = this.settings?.token;
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (token && bearer === token) return true;
    if (bearer && this.isTokenAuthorized?.(bearer)) return true;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const queryToken = url.searchParams.get('token') || '';
    if (token && queryToken === token) return true;
    if (queryToken && this.isTokenAuthorized?.(queryToken)) return true;
    // 유효한 토큰/기기 인증이 없으면 거부한다.
    // (기기 초기화 시 옛 토큰이 오픈 모드로 통과하던 문제 방지 → 폰이 401을 받아 PIN 화면으로 복귀)
    return false;
  }

  openEventStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    this.eventClients.add(res);
    this.sendEvent(res, 'status', this.getStatus?.() || {});

    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => {
        this.broadcast('ping', { serverTime: Date.now() });
      }, 25000);
    }

    req.on('close', () => {
      this.eventClients.delete(res);
      if (!this.eventClients.size && this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
    });
  }

  broadcast(type, payload) {
    for (const client of this.eventClients) {
      this.sendEvent(client, type, payload);
    }
  }

  broadcastStatus() {
    if (!this.eventClients.size) return;
    this.broadcast('status', this.getStatus?.() || {});
  }

  sendEvent(res, type, payload) {
    try {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      this.eventClients.delete(res);
    }
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 64) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
}

function getAppVersion() {
  try {
    return require('../../../package.json').version || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

module.exports = MobileServer;
module.exports.getPrimaryLocalIp = getPrimaryLocalIp;
module.exports.SERVICE_TYPE = SERVICE_TYPE;
