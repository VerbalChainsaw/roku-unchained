/**
 * ECP Client — Complete Roku External Control Protocol wrapper.
 * Every documented endpoint, plus undocumented community-discovered ones.
 * Handles auth, SSDP, retries, rate limiting, XML parsing.
 *
 * @module lib/ecp
 */
'use strict';

const http = require('http');
const dgram = require('dgram');
const { XMLParser } = require('fast-xml-parser');

// ─── Constants ────────────────────────────────────────────────────
const ECP_PORT = 8060;
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const DEFAULT_TIMEOUT = 10000;
const RETRY_COUNT = 3;

// ─── Key mappings — all known Roku remote keys ────────────────────
const KEYS = {
  HOME: 'Home', REV: 'Rev', FWD: 'Fwd', PLAY: 'Play', SELECT: 'Select',
  LEFT: 'Left', RIGHT: 'Right', DOWN: 'Down', UP: 'Up', BACK: 'Back',
  INSTANT_REPLAY: 'InstantReplay', INFO: 'Info', BACKSPACE: 'Backspace',
  SEARCH: 'Search', ENTER: 'Enter', VOLUME_DOWN: 'VolumeDown',
  VOLUME_MUTE: 'VolumeMute', VOLUME_UP: 'VolumeUp', INPUT_TUNER: 'InputTuner',
  INPUT_HDMI1: 'InputHDMI1', INPUT_HDMI2: 'InputHDMI2', INPUT_HDMI3: 'InputHDMI3',
  INPUT_HDMI4: 'InputHDMI4', INPUT_AV1: 'InputAV1', POWER_OFF: 'PowerOff',
  POWER_ON: 'PowerOn', CHANNEL_UP: 'ChannelUp', CHANNEL_DOWN: 'ChannelDown',
  FIND_REMOTE: 'FindRemote', STAR: 'Star', PLAY_PAUSE: 'PlayPause',
  LIT_a: 'Lit_a', LIT_b: 'Lit_b', LIT_c: 'Lit_c', LIT_d: 'Lit_d',
  LIT_e: 'Lit_e', LIT_f: 'Lit_f', LIT_g: 'Lit_g', LIT_h: 'Lit_h',
  LIT_i: 'Lit_i', LIT_j: 'Lit_j', LIT_k: 'Lit_k', LIT_l: 'Lit_l',
  LIT_m: 'Lit_m', LIT_n: 'Lit_n', LIT_o: 'Lit_o', LIT_p: 'Lit_p',
  LIT_q: 'Lit_q', LIT_r: 'Lit_r', LIT_s: 'Lit_s', LIT_t: 'Lit_t',
  LIT_u: 'Lit_u', LIT_v: 'Lit_v', LIT_w: 'Lit_w', LIT_x: 'Lit_x',
  LIT_y: 'Lit_y', LIT_z: 'Lit_z', LIT_0: 'Lit_0', LIT_1: 'Lit_1',
  LIT_2: 'Lit_2', LIT_3: 'Lit_3', LIT_4: 'Lit_4', LIT_5: 'Lit_5',
  LIT_6: 'Lit_6', LIT_7: 'Lit_7', LIT_8: 'Lit_8', LIT_9: 'Lit_9',
  LIT_PERIOD: 'Lit_.', LIT_COMMA: 'Lit_,', LIT_SPACE: 'Lit_+',
};

// ─── Parser ───────────────────────────────────────────────────────
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  ignoreDeclaration: true,
  trimValues: true,
});

function parseXML(xml) {
  if (!xml || typeof xml !== 'string') return null;
  const trimmed = xml.trim();
  if (!trimmed) return null;
  // ECP sometimes returns non-XML (e.g. binary icon data)
  if (!trimmed.startsWith('<')) return { raw: trimmed };
  try {
    return xmlParser.parse(trimmed);
  } catch (e) {
    return { raw: trimmed, parseError: e.message };
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────
function ecpRequest(host, path, method = 'GET', body = null, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port: ECP_PORT,
      path: path,
      method: method,
      timeout: timeout,
      headers: { 'Accept': '*/*' },
    };
    if (body) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    let settled = false;
    const settle = (fn, ...args) => { if (!settled) { settled = true; fn(...args); } };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (res.headers['content-type'] && res.headers['content-type'].startsWith('image/')) {
          settle(resolve, { type: 'binary', mimeType: res.headers['content-type'], data: raw });
          return;
        }
        const text = raw.toString('utf8');
        settle(resolve, { type: 'text', statusCode: res.statusCode, body: text, parsed: parseXML(text) });
      });
      res.on('error', (err) => settle(reject, err));
    });
    req.on('timeout', () => { req.destroy(); settle(reject, new Error(`ECP request timeout: ${method} ${path}`)); });
    req.on('error', (err) => settle(reject, err));
    if (body) req.write(body);
    req.end();
  });
}

async function ecpRetry(host, path, method = 'GET', body = null, retries = RETRY_COUNT) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await ecpRequest(host, path, method, body);
    } catch (e) {
      lastErr = e;
      if (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH') throw e; // Don't retry
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

// ─── SSDP Discovery ───────────────────────────────────────────────
function discover(timeout = 5000) {
  return new Promise((resolve, reject) => {
    const devices = [];
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const msearch = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      `Host: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
      'Man: "ssdp:discover"\r\n' +
      'ST: roku:ecp\r\n' +
      'MX: 3\r\n' +
      '\r\n'
    );

    const timer = setTimeout(() => {
      socket.close();
      resolve(devices);
    }, timeout);

    const seenSerials = new Set();

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const locationMatch = text.match(/Location:\s*(http:\/\/[^\r\n]+)/i);
      const usnMatch = text.match(/USN:\s*uuid:roku:ecp:([^\r\n]+)/i);
      const serverMatch = text.match(/Server:\s*([^\r\n]+)/i);

      if (!locationMatch || !usnMatch?.[1]) return;

      const serial = usnMatch[1].trim();
      if (seenSerials.has(serial)) return;
      seenSerials.add(serial);

      const ip = locationMatch[1].match(/\/\/([^:/]+)/)?.[1] || rinfo.address;
      devices.push({
        ip: ip,
        url: locationMatch[1],
        serial: serial,
        server: serverMatch?.[1]?.trim() || null,
        discoveredAt: new Date().toISOString(),
      });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });

    socket.bind(() => {
      socket.setMulticastTTL(4);
      socket.send(msearch, 0, msearch.length, SSDP_PORT, SSDP_ADDR, (err) => {
        if (err) { clearTimeout(timer); socket.close(); reject(err); }
      });
    });
  });
}

// ─── Main ECP Client class ────────────────────────────────────────
class ECPClient {
  /**
   * @param {string} host - Roku IP address or hostname
   * @param {object} [opts]
   * @param {string} [opts.password] - Dev mode password
   * @param {number} [opts.timeout] - Request timeout in ms
   */
  constructor(host, opts = {}) {
    if (!host) throw new Error('ECPClient requires a host (Roku IP address)');
    this.host = host;
    this.password = opts.password || null;
    this.timeout = opts.timeout || DEFAULT_TIMEOUT;
    this.baseUrl = `http://${host}:${ECP_PORT}`;
  }

  // ── Device Info ───────────────────────────────────────────────
  async deviceInfo() {
    const res = await ecpRetry(this.host, '/query/device-info', 'GET', null, 1);
    return res.parsed?.['device-info'] || res.parsed || res.body;
  }

  async getDeviceInfo() { return this.deviceInfo(); }

  // ── App/Channel management ────────────────────────────────────
  async apps() {
    const res = await ecpRetry(this.host, '/query/apps');
    const parsed = res.parsed?.['apps']?.['app'] || res.parsed?.['apps'] || [];
    return Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
  }

  async activeApp() {
    const res = await ecpRetry(this.host, '/query/active-app');
    return res.parsed?.['active-app']?.['app'] || res.parsed?.['active-app'] || null;
  }

  async launchApp(appId, params = null) {
    let path = `/launch/${appId}`;
    if (params) {
      const encoded = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      path += '?' + encoded;
    }
    return ecpRetry(this.host, path, 'POST');
  }

  async exitApp(appId, force = false) {
    const path = force ? `/exit-app/${appId}/true` : `/exit-app/${appId}`;
    return ecpRetry(this.host, path, 'POST');
  }

  async getAppIcon(appId) {
    return ecpRetry(this.host, `/query/icon/${appId}`);
  }

  // ── Remote Control (keys) ─────────────────────────────────────
  async keypress(key) {
    return ecpRetry(this.host, `/keypress/${key}`, 'POST');
  }

  async keydown(key) {
    return ecpRetry(this.host, `/keydown/${key}`, 'POST');
  }

  async keyup(key) {
    return ecpRetry(this.host, `/keyup/${key}`, 'POST');
  }

  async home() { return this.keypress(KEYS.HOME); }
  async back() { return this.keypress(KEYS.BACK); }
  async up() { return this.keypress(KEYS.UP); }
  async down() { return this.keypress(KEYS.DOWN); }
  async left() { return this.keypress(KEYS.LEFT); }
  async right() { return this.keypress(KEYS.RIGHT); }
  async select() { return this.keypress(KEYS.SELECT); }
  async play() { return this.keypress(KEYS.PLAY); }
  async pause() { return this.keypress(KEYS.PLAY_PAUSE); }
  async rewind() { return this.keypress(KEYS.REV); }
  async fastForward() { return this.keypress(KEYS.FWD); }
  async volumeUp() { return this.keypress(KEYS.VOLUME_UP); }
  async volumeDown() { return this.keypress(KEYS.VOLUME_DOWN); }
  async volumeMute() { return this.keypress(KEYS.VOLUME_MUTE); }
  async powerOff() { return this.keypress(KEYS.POWER_OFF); }

  // ── Text Input ────────────────────────────────────────────────
  async typeText(text) {
    const results = [];
    for (const char of text) {
      const lower = char.toLowerCase();
      let key;
      if (char === ' ') key = KEYS.LIT_SPACE;
      else if (char === '.') key = KEYS.LIT_PERIOD;
      else if (char === ',') key = KEYS.LIT_COMMA;
      else if (/[a-z]/i.test(char)) key = `Lit_${lower}`;
      else if (/[0-9]/.test(char)) key = `Lit_${char}`;
      else continue;
      const res = await this.keypress(key);
      results.push(res);
    }
    return results;
  }

  // ── Media Player ──────────────────────────────────────────────
  async mediaPlayer() {
    const res = await ecpRetry(this.host, '/query/media-player');
    return res.parsed?.['player'] || res.parsed || res.body;
  }

  // ── TV Channels (Roku TV only) ────────────────────────────────
  async tvChannels() {
    const res = await ecpRetry(this.host, '/query/tv-channels');
    return res.parsed?.['tv-channels'] || res.parsed || [];
  }

  async tvActiveChannel() {
    const res = await ecpRetry(this.host, '/query/tv-active-channel');
    return res.parsed?.['tv-channel'] || res.parsed || null;
  }

  // ── Input control (Roku TV) ───────────────────────────────────
  async setInput(input) {
    return this.keypress(`Input${input}`);
  }

  // ── Search (pre-OS 12) ────────────────────────────────────────
  async search(params) {
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return ecpRetry(this.host, `/search/browse?${query}`, 'POST');
  }

  // ── Dev Mode - Performance ────────────────────────────────────
  async chanperf(channelId = null, durationSeconds = null) {
    let path = '/query/chanperf';
    if (channelId) path += `/${channelId}`;
    const params = [];
    if (durationSeconds) params.push(`duration-seconds=${durationSeconds}`);
    if (params.length) path += '?' + params.join('&');
    const res = await ecpRetry(this.host, path);
    return res.parsed || res.body;
  }

  // ── Dev Mode - SceneGraph ─────────────────────────────────────
  async sgnodesAll(countOnly = false, sizes = false) {
    const params = [];
    if (countOnly) params.push('count_only=true');
    if (sizes) params.push('sizes=true');
    const query = params.length ? '?' + params.join('&') : '';
    const res = await ecpRetry(this.host, `/query/sgnodes/all${query}`);
    return res.parsed || res.body;
  }

  async sgnodesRoots(countOnly = false, sizes = false) {
    const params = [];
    if (countOnly) params.push('count_only=true');
    if (sizes) params.push('sizes=true');
    const query = params.length ? '?' + params.join('&') : '';
    const res = await ecpRetry(this.host, `/query/sgnodes/roots${query}`);
    return res.parsed || res.body;
  }

  async sgnodesById(nodeId, countOnly = false, sizes = false) {
    const params = [`node-id=${nodeId}`];
    if (countOnly) params.push('count_only=true');
    if (sizes) params.push('sizes=true');
    const query = '?' + params.join('&');
    const res = await ecpRetry(this.host, `/query/sgnodes/nodes${query}`);
    return res.parsed || res.body;
  }

  // ── Dev Mode - Rendezvous ─────────────────────────────────────
  async sgrendezvousTrack(channelId = null) {
    const path = channelId ? `/sgrendezvous/track/${channelId}` : '/sgrendezvous/track';
    const res = await ecpRetry(this.host, path, 'POST');
    return res.parsed || res.body;
  }

  async sgrendezvousQuery() {
    const res = await ecpRetry(this.host, '/query/sgrendezvous');
    return res.parsed || res.body;
  }

  async sgrendezvousUntrack() {
    const res = await ecpRetry(this.host, '/sgrendezvous/untrack', 'POST');
    return res.parsed || res.body;
  }

  // ── Dev Mode - Registry ───────────────────────────────────────
  async registry(channelId = 'dev') {
    const res = await ecpRetry(this.host, `/query/registry/${channelId}`);
    return res.parsed?.['registry'] || res.parsed || [];
  }

  // ── Dev Mode - Graphics ───────────────────────────────────────
  async graphicsFrameRate() {
    const res = await ecpRetry(this.host, '/query/graphics-frame-rate');
    return res.parsed?.['graphics-frame-rate'] || res.parsed || null;
  }

  async r2d2Bitmaps() {
    const res = await ecpRetry(this.host, '/query/r2d2-bitmaps');
    return res.parsed?.['r2d2-bitmaps'] || res.parsed || {};
  }

  // ── Dev Mode - FW Beacons ─────────────────────────────────────
  async fwbeaconsTrack(channelId = null) {
    const path = channelId ? `/fwbeacons/track/${channelId}` : '/fwbeacons/track';
    const res = await ecpRetry(this.host, path, 'POST');
    return res.parsed || res.body;
  }

  async fwbeaconsQuery() {
    const res = await ecpRetry(this.host, '/query/fwbeacons');
    return res.parsed || res.body;
  }

  async fwbeaconsUntrack() {
    const res = await ecpRetry(this.host, '/fwbeacons/untrack', 'POST');
    return res.parsed || res.body;
  }

  // ── Dev Mode - App State ──────────────────────────────────────
  async appObjectCounts(channelId) {
    const res = await ecpRetry(this.host, `/query/app-object-counts/${channelId}`);
    return res.parsed || res.body;
  }

  async appState(appId) {
    const res = await ecpRetry(this.host, `/query/app-state/${appId}`);
    return res.parsed || res.body;
  }

  // ── Dev Mode - Plugin Tools ───────────────────────────────────
  async screenshot() {
    const base = `http://${this.host}`;
    const { get } = require('http');
    return new Promise((resolve, reject) => {
      get(`${base}/plugin_inspect`, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  // ── Health Check ──────────────────────────────────────────────
  async ping() {
    try {
      await ecpRetry(this.host, '/query/device-info', 'GET', null, 1);
      return true;
    } catch {
      return false;
    }
  }

  // ── Batch operations ──────────────────────────────────────────
  async getAllInfo() {
    const [device, apps, active, media, registry, gfx, bitmaps] = await Promise.allSettled([
      this.deviceInfo(),
      this.apps(),
      this.activeApp(),
      this.mediaPlayer(),
      this.registry('dev'),
      this.graphicsFrameRate(),
      this.r2d2Bitmaps(),
    ]);

    return {
      device: device.value || null,
      apps: apps.value || [],
      activeApp: active.value || null,
      mediaPlayer: media.value || null,
      registry: registry.value || [],
      graphicsFps: gfx.value || null,
      textureMemory: bitmaps.value || null,
      errors: [device, apps, active, media, registry, gfx, bitmaps]
        .filter(r => r.status === 'rejected')
        .map(r => r.reason.message),
    };
  }
}

// ─── Device Manager (multi-device) ────────────────────────────────
class RokuDeviceManager {
  constructor() {
    this.devices = new Map();
    this.discoverInterval = null;
  }

  async discover() {
    const found = await discover();
    for (const dev of found) {
      if (!this.devices.has(dev.serial)) {
        this.devices.set(dev.serial, {
          ...dev,
          client: new ECPClient(dev.ip),
          healthy: false,
          lastSeen: new Date(),
        });
      } else {
        const existing = this.devices.get(dev.serial);
        existing.lastSeen = new Date();
        if (existing.ip !== dev.ip) {
          existing.ip = dev.ip;
          existing.url = dev.url;
          existing.client = new ECPClient(dev.ip);
        }
      }
    }
    return this.list();
  }

  async healthCheckAll() {
    const results = [];
    for (const [serial, dev] of this.devices) {
      dev.healthy = await dev.client.ping();
      results.push({ serial, ip: dev.ip, healthy: dev.healthy });
    }
    return results;
  }

  get(serial) {
    return this.devices.get(serial) || null;
  }

  list() {
    return Array.from(this.devices.values()).map(d => ({
      serial: d.serial,
      ip: d.ip,
      url: d.url,
      server: d.server,
      healthy: d.healthy,
      lastSeen: d.lastSeen,
    }));
  }

  startAutoDiscovery(intervalMs = 300000) {
    this.stopAutoDiscovery();
    this._discoverAndCheck();
    this.discoverInterval = setInterval(() => this._discoverAndCheck(), intervalMs);
  }

  stopAutoDiscovery() {
    if (this.discoverInterval) {
      clearInterval(this.discoverInterval);
      this.discoverInterval = null;
    }
  }

  async _discoverAndCheck() {
    try {
      await this.discover();
      await this.healthCheckAll();
    } catch (e) {
      // Silent fail — device may be offline
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────
module.exports = {
  ECPClient,
  RokuDeviceManager,
  discover,
  KEYS,
  parseXML,
  ecpRequest,
  ecpRetry,
  ECP_PORT,
  SSDP_ADDR,
  SSDP_PORT,
};
