const dgram = require('dgram');
const os = require('os');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_TYPE = '_streamwatcher._tcp.local';

class MobileDiscovery {
  constructor({ getInfo }) {
    this.getInfo = getInfo;
    this.socket = null;
  }

  async start() {
    await this.stop();
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
    this.socket.on('error', () => {});

    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(MDNS_PORT, () => {
        try {
          this.socket.addMembership(MDNS_ADDR);
          this.socket.setMulticastTTL(255);
          this.socket.setMulticastLoopback(true);
        } catch {}
        this.socket.off('error', reject);
        resolve();
      });
    });

    this.announce();
  }

  async stop() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    await new Promise((resolve) => socket.close(resolve));
  }

  announce() {
    this.sendResponse();
  }

  handleMessage(msg) {
    const questions = parseQuestions(msg);
    if (!questions.length) return;
    const shouldAnswer = questions.some((q) => {
      const name = q.name.toLowerCase();
      return name === SERVICE_TYPE
        || name.includes('_streamwatcher._tcp.local')
        || name === '_services._dns-sd._udp.local';
    });
    if (shouldAnswer) this.sendResponse();
  }

  sendResponse() {
    if (!this.socket) return;
    const info = this.getInfo?.();
    if (!info?.port) return;

    const host = sanitizeDnsLabel(info.hostName || os.hostname() || 'stream-watcher');
    const instanceLabel = sanitizeDnsLabel(info.name || `Stream Watcher - ${host}`);
    const instance = `${instanceLabel}.${SERVICE_TYPE}`;
    const target = `${host}.local`;
    const ip = info.ip || getPrimaryLocalIp();
    const txt = {
      version: info.version || '0.1.0',
      schemaVersion: String(info.schemaVersion || 1),
      serverId: info.serverId || '',
      requiresPin: info.requiresPin ? 'true' : 'false',
    };

    const answers = [
      recordPtr(SERVICE_TYPE, instance),
      recordSrv(instance, target, Number(info.port)),
      recordTxt(instance, txt),
      recordA(target, ip),
    ];
    const packet = buildResponse(answers);
    this.socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDR);
  }
}

function parseQuestions(buf) {
  if (buf.length < 12) return [];
  const qdCount = buf.readUInt16BE(4);
  let offset = 12;
  const questions = [];
  for (let i = 0; i < qdCount; i++) {
    const parsed = readName(buf, offset);
    if (!parsed) break;
    offset = parsed.offset;
    if (offset + 4 > buf.length) break;
    const type = buf.readUInt16BE(offset);
    const cls = buf.readUInt16BE(offset + 2);
    offset += 4;
    questions.push({ name: parsed.name, type, cls });
  }
  return questions;
}

function readName(buf, offset, depth = 0) {
  if (depth > 8) return null;
  const labels = [];
  let cursor = offset;
  let jumped = false;
  let nextOffset = offset;

  while (cursor < buf.length) {
    const len = buf[cursor];
    if (len === 0) {
      cursor += 1;
      if (!jumped) nextOffset = cursor;
      return { name: labels.join('.'), offset: nextOffset };
    }
    if ((len & 0xc0) === 0xc0) {
      if (cursor + 1 >= buf.length) return null;
      const ptr = ((len & 0x3f) << 8) | buf[cursor + 1];
      const parsed = readName(buf, ptr, depth + 1);
      if (!parsed) return null;
      labels.push(parsed.name);
      cursor += 2;
      if (!jumped) nextOffset = cursor;
      jumped = true;
      return { name: labels.filter(Boolean).join('.'), offset: nextOffset };
    }
    cursor += 1;
    if (cursor + len > buf.length) return null;
    labels.push(buf.slice(cursor, cursor + len).toString('utf8'));
    cursor += len;
  }
  return null;
}

function buildResponse(records) {
  const parts = [header(records.length)];
  for (const record of records) parts.push(record);
  return Buffer.concat(parts);
}

function header(answerCount) {
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(0, 0);
  buf.writeUInt16BE(0x8400, 2);
  buf.writeUInt16BE(0, 4);
  buf.writeUInt16BE(answerCount, 6);
  buf.writeUInt16BE(0, 8);
  buf.writeUInt16BE(0, 10);
  return buf;
}

function recordPtr(name, target) {
  return record(name, 12, encodeName(target));
}

function recordSrv(name, target, port) {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(port, 4);
  return record(name, 33, Buffer.concat([head, encodeName(target)]));
}

function recordTxt(name, values) {
  const chunks = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const data = Buffer.from(`${key}=${value}`);
      return Buffer.concat([Buffer.from([Math.min(data.length, 255)]), data.slice(0, 255)]);
    });
  return record(name, 16, Buffer.concat(chunks));
}

function recordA(name, ip) {
  return record(name, 1, Buffer.from(ip.split('.').map((part) => Number(part) || 0)));
}

function record(name, type, data) {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt32BE(120, 4);
  fixed.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), fixed, data]);
}

function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.');
  const chunks = [];
  for (const part of parts) {
    const data = Buffer.from(part);
    chunks.push(Buffer.from([Math.min(data.length, 63)]), data.slice(0, 63));
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function sanitizeDnsLabel(value) {
  return String(value || 'stream-watcher')
    .replace(/[^\w가-힣 -]/g, '')
    .trim()
    .slice(0, 50) || 'stream-watcher';
}

function getPrimaryLocalIp() {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

module.exports = {
  MobileDiscovery,
  SERVICE_TYPE,
  getPrimaryLocalIp,
};
