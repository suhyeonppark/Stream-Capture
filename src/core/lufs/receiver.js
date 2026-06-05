const dgram = require('dgram');
const EventEmitter = require('events');

class LufsReceiver extends EventEmitter {
  constructor({ enabled = true, host = '0.0.0.0', port = 49152 } = {}) {
    super();
    this.enabled = enabled;
    this.host = host || '0.0.0.0';
    this.port = Number(port) || 49152;
    this.socket = null;
  }

  start() {
    if (!this.enabled || this.socket) return;

    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.bind(this.port, this.host, () => {
      this.emit('ready', { host: this.host, port: this.port });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.socket) {
        resolve();
        return;
      }

      const socket = this.socket;
      this.socket = null;
      socket.close(() => resolve());
    });
  }

  handleMessage(msg, rinfo) {
    let payload;
    const text = msg.toString('utf8').trim();
    try {
      payload = JSON.parse(text);
    } catch {
      payload = parseTextPayload(text);
    }

    const state = {
      ts: normalizeTimestamp(payload.ts),
      momentary: normalizeNumber(firstDefined(
        findMetric(payload, ['momentary']),
        payload.momentary,
        payload.momentaryLufs,
        payload.momentary_lufs,
        payload.momentaryLUFS,
      )),
      shortTerm: normalizeNumber(firstDefined(
        findMetric(payload, ['short', 'term']),
        payload.shortTerm,
        payload.shortTermLufs,
        payload.short_term,
        payload.short_term_lufs,
        payload.shortterm,
        payload.shortterm_lufs,
        payload.shortTermLUFS,
      )),
      integrated: normalizeNumber(firstDefined(
        findMetric(payload, ['integrated']),
        payload.integrated,
        payload.integratedLufs,
        payload.integrated_lufs,
        payload.integratedLUFS,
      )),
      remote: `${rinfo.address}:${rinfo.port}`,
    };

    if (state.momentary == null && state.shortTerm == null && state.integrated == null) return;
    this.emit('state', state);
  }
}

function normalizeNumber(value) {
  const n = typeof value === 'string'
    ? Number(value.match(/-?\d+(?:\.\d+)?/)?.[0])
    : Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function findMetric(value, tokens) {
  const stack = [{ key: '', value }];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item.value)) {
      item.value.forEach((child, index) => stack.push({ key: `${item.key}_${index}`, value: child }));
      continue;
    }
    if (item.value && typeof item.value === 'object') {
      for (const [key, child] of Object.entries(item.value)) {
        stack.push({ key: item.key ? `${item.key}_${key}` : key, value: child });
      }
      continue;
    }

    const normalizedKey = item.key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const matches = tokens.every((token) => normalizedKey.includes(token));
    if (matches && normalizeNumber(item.value) != null) return item.value;
  }
  return null;
}

function parseTextPayload(text) {
  const payload = {};
  const patterns = [
    ['shortTerm', /(?:short[\s_-]*term|shortterm|st)[^\d-]*(-?\d+(?:\.\d+)?)/i],
    ['momentary', /(?:momentary|momentary[\s_-]*lufs|m)[^\d-]*(-?\d+(?:\.\d+)?)/i],
    ['integrated', /(?:integrated|integrated[\s_-]*lufs|i)[^\d-]*(-?\d+(?:\.\d+)?)/i],
  ];
  for (const [key, pattern] of patterns) {
    const match = text.match(pattern);
    if (match) payload[key] = Number(match[1]);
  }

  if (payload.shortTerm == null && payload.momentary == null && payload.integrated == null) {
    const nums = text.match(/-?\d+(?:\.\d+)?/g);
    if (nums?.length === 1) payload.shortTerm = Number(nums[0]);
  }
  return payload;
}

function normalizeTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

module.exports = LufsReceiver;
