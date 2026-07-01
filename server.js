/**
 * Roku Dev Toolkit + Stream Proxy Server
 * 
 * Full orchestration server providing:
 * - REST API for all Roku ECP operations
 * - WebSocket for real-time device monitoring
 * - Dashboard web UI
 * - Stream proxy integration
 * - Network scanner with auto-discovery
 * - Registry explorer and privacy audit
 *
 * Start: node server.js
 * Dashboard: http://localhost:4700
 *
 * @module server
 */
'use strict';

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const { ECPClient, RokuDeviceManager, discover, KEYS } = require('./lib/ecp');
const { RegistryTool, KNOWN_KEYS } = require('./lib/registry');
const { fullAudit, quickScan, getLocalNetworks } = require('./lib/scanner');
const { createStreamProxy, stats: proxyStats, updateConfig: updateProxyConfig } = require('./proxy/stream-proxy');

// ─── Configuration ────────────────────────────────────────────────
const PORT = parseInt(process.env.TOOLKIT_PORT || '4700');
const STREAM_PROXY_PORT = parseInt(process.env.STREAM_PROXY_PORT || '9090');
const HOST = process.env.TOOLKIT_HOST || '127.0.0.1';

// ─── Express App ──────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Global State ─────────────────────────────────────────────────
const deviceManager = new RokuDeviceManager();
const clients = new Map(); // serial -> ECPClient
const registryTools = new Map(); // serial -> RegistryTool
const wsClients = new Set();
let streamProxyServer = null;

// ─── Static Files (Dashboard) ─────────────────────────────────────
app.use(express.static(path.join(__dirname, 'dashboard')));

// ─── WebSocket Server ─────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  
  // Send initial state
  ws.send(JSON.stringify({
    type: 'connected',
    devices: deviceManager.list(),
    proxyStats: getProxySnapshot(),
    timestamp: new Date().toISOString(),
  }));
});

function broadcast(data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const ws of wsClients) {
    try { ws.send(payload); } catch { wsClients.delete(ws); }
  }
}

function getProxySnapshot() {
  return {
    uptime: Date.now() - proxyStats.startTime.getTime(),
    totalRequests: proxyStats.totalRequests,
    adsBlocked: proxyStats.adsBlocked,
    activeStreams: proxyStats.activeStreams,
    bytesProxied: proxyStats.bytesProxied,
    manifestRequests: proxyStats.manifestRequests,
    segmentRequests: proxyStats.segmentRequests,
    errors: proxyStats.errors,
  };
}

// ═══════════════════════════════════════════════════════════════════
// REST API Routes
// ═══════════════════════════════════════════════════════════════════

// ─── Discovery ────────────────────────────────────────────────────

/** GET /api/discover — SSDP device discovery */
app.get('/api/discover', async (req, res) => {
  try {
    const devices = await deviceManager.discover();

    // If SSDP found nothing, try active scanning on common subnets
    if (devices.length === 0 && req.query.scan !== 'false') {
      const nets = getLocalNetworks();
      for (const net of nets) {
        const subnet = net.address.split('.').slice(0, 3).join('.');
        const hosts = await quickScan(subnet, 500);
        for (const ip of hosts) {
          const client = new ECPClient(ip);
          try {
            const info = await client.deviceInfo();
            const serial = info?.['serial-number']?.['#text'] || info?.['serial-number'] || ip;
            devices.push({ serial: String(serial), ip, url: `http://${ip}:8060/`, healthy: true, server: info?.['model-name']?.['#text'] || 'Roku', discoveredAt: new Date().toISOString() });
          } catch { /* not a Roku or not responding */ }
        }
      }
    }

    for (const dev of devices) {
      if (!clients.has(dev.serial)) clients.set(dev.serial, new ECPClient(dev.ip));
      if (!registryTools.has(dev.serial)) registryTools.set(dev.serial, new RegistryTool(dev.ip));
    }
    broadcast({ type: 'devices', devices: deviceManager.list() });
    res.json({ success: true, devices, count: devices.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/device/add — Add a device by IP directly (bypasses discovery) */
app.post('/api/device/add', async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ success: false, error: 'ip required' });
    const client = new ECPClient(ip);
    let serial, info;
    try {
      info = await client.deviceInfo();
      serial = info?.['serial-number']?.['#text'] || info?.['serial-number'] || ip;
    } catch {
      serial = ip; // Accept it anyway — might just not respond to device-info
    }
    if (!clients.has(serial)) clients.set(serial, client);
    if (!registryTools.has(serial)) registryTools.set(serial, new RegistryTool(ip));
    const healthy = await client.ping().catch(() => false);
    const device = { serial: String(serial), ip, url: `http://${ip}:8060/`, healthy, server: info?.['model-name']?.['#text'] || 'Manual', discoveredAt: new Date().toISOString() };
    // Add to device manager too
    const devMap = deviceManager.devices;
    devMap.set(String(serial), { ...device, client, lastSeen: new Date() });
    broadcast({ type: 'devices', devices: deviceManager.list() });
    res.json({ success: true, device });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/discover/quick — Quick port scan on subnet */
app.post('/api/discover/quick', async (req, res) => {
  try {
    const { subnet } = req.body;
    if (!subnet) {
      return res.status(400).json({ success: false, error: 'subnet required (e.g., 192.168.1)' });
    }
    const hosts = await quickScan(subnet);
    res.json({ success: true, subnet, hosts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/network — Get local network info */
app.get('/api/network', (req, res) => {
  res.json({ success: true, networks: getLocalNetworks() });
});

// ─── Device Management ────────────────────────────────────────────

/** GET /api/devices — List all discovered/managed devices */
app.get('/api/devices', (req, res) => {
  res.json({ success: true, devices: deviceManager.list() });
});

/** GET /api/device/:serial — Get device details */
app.get('/api/device/:serial', async (req, res) => {
  const dev = deviceManager.get(req.params.serial);
  if (!dev) return res.status(404).json({ success: false, error: 'Device not found' });
  
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client for device' });

  try {
    const deviceInfo = await client.deviceInfo();
    const apps = await client.apps();
    const active = await client.activeApp();
    res.json({ success: true, serial: req.params.serial, ip: dev.ip, deviceInfo, apps, activeApp: active });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/device/:serial/snapshot — Full device snapshot */
app.post('/api/device/:serial/snapshot', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client for device' });

  try {
    const snapshot = await client.getAllInfo();
    res.json({ success: true, snapshot });
    broadcast({ type: 'snapshot', serial: req.params.serial, snapshot });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/device/:serial/ping — Health check */
app.get('/api/device/:serial/ping', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client for device' });

  const healthy = await client.ping();
  res.json({ success: true, healthy });
});

// ─── ECP Operations ───────────────────────────────────────────────

/** GET /api/device/:serial/device-info */
app.get('/api/device/:serial/device-info', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const info = await client.deviceInfo();
    res.json({ success: true, info });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/device/:serial/apps */
app.get('/api/device/:serial/apps', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const apps = await client.apps();
    res.json({ success: true, apps });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/device/:serial/active-app */
app.get('/api/device/:serial/active-app', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const active = await client.activeApp();
    res.json({ success: true, active });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/device/:serial/media-player */
app.get('/api/device/:serial/media-player', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const player = await client.mediaPlayer();
    res.json({ success: true, player });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/device/:serial/graphics-fps */
app.get('/api/device/:serial/graphics-fps', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const gfx = await client.graphicsFrameRate();
    res.json({ success: true, gfx });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/device/:serial/chanperf */
app.get('/api/device/:serial/chanperf', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const channelId = req.query.channelId || null;
    const duration = req.query.duration ? parseInt(req.query.duration) : null;
    const perf = await client.chanperf(channelId, duration);
    res.json({ success: true, perf });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/device/:serial/sgnodes — SceneGraph node explorer */
app.get('/api/device/:serial/sgnodes', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const { scope, nodeId, countOnly, sizes } = req.query;
    let result;
    if (scope === 'roots') {
      result = await client.sgnodesRoots(countOnly === 'true', sizes === 'true');
    } else if (scope === 'node' && nodeId) {
      result = await client.sgnodesById(nodeId, countOnly === 'true', sizes === 'true');
    } else {
      result = await client.sgnodesAll(countOnly === 'true', sizes === 'true');
    }
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/device/:serial/bitmaps — Texture memory analysis */
app.get('/api/device/:serial/bitmaps', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const bitmaps = await client.r2d2Bitmaps();
    res.json({ success: true, bitmaps });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Remote Control ───────────────────────────────────────────────

/** POST /api/device/:serial/sequence — Run a sequence of keys */
app.post('/api/device/:serial/sequence', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const { keys, delay_ms } = req.body;
    if (!keys || !Array.isArray(keys) || keys.length === 0)
      return res.status(400).json({ success: false, error: 'keys array required' });
    const delay = Math.min(Math.max(parseInt(delay_ms || '180', 10) || 180, 50), 1000);
    for (let i = 0; i < keys.length; i++) {
      await client.keypress(keys[i]);
      if (i < keys.length - 1) await new Promise(r => setTimeout(r, delay));
    }
    res.json({ success: true, keys, count: keys.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/device/:serial/deeplink — Deep-link launch with contentId */
app.post('/api/device/:serial/deeplink', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const { appId, content_id, media_type, source } = req.body;
    if (!appId || !content_id || !media_type)
      return res.status(400).json({ success: false, error: 'appId, content_id, and media_type required' });
    const params = { contentId: content_id, mediaType: media_type };
    if (source) params.source = source;
    await client.launchApp(appId, params);
    res.json({ success: true, appId, content_id, media_type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/device/:serial/keypress */
app.post('/api/device/:serial/keypress', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ success: false, error: 'key required' });
    await client.keypress(key);
    res.json({ success: true, key });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/device/:serial/keydown */
app.post('/api/device/:serial/keydown', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const { key } = req.body;
    await client.keydown(key);
    res.json({ success: true, key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/device/:serial/keyup */
app.post('/api/device/:serial/keyup', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const { key } = req.body;
    await client.keyup(key);
    res.json({ success: true, key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/device/:serial/type — Type text on the Roku */
app.post('/api/device/:serial/type', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ success: false, error: 'text required' });
    await client.typeText(text);
    res.json({ success: true, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/device/:serial/launch — Launch an app */
app.post('/api/device/:serial/launch', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const { appId, params } = req.body;
    if (!appId) return res.status(400).json({ success: false, error: 'appId required' });
    await client.launchApp(appId, params);
    res.json({ success: true, appId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/device/:serial/exit-app */
app.post('/api/device/:serial/exit-app', async (req, res) => {
  const client = clients.get(req.params.serial);
  if (!client) return res.status(404).json({ success: false, error: 'No client' });
  try {
    const { appId, force } = req.body;
    await client.exitApp(appId || 'dev', force);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Registry ─────────────────────────────────────────────────────

/** GET /api/device/:serial/registry — Read registry */
app.get('/api/device/:serial/registry', async (req, res) => {
  const tool = registryTools.get(req.params.serial);
  if (!tool) return res.status(404).json({ success: false, error: 'No registry tool' });
  try {
    const { channelId, search, section, export: exp, audit } = req.query;
    
    if (audit === 'privacy') {
      const report = await tool.privacyAudit(channelId || 'dev');
      return res.json({ success: true, audit: report });
    }
    
    let entries;
    if (search) {
      entries = await tool.find(search, channelId || 'dev');
    } else if (section) {
      entries = await tool.findBySection(section, channelId || 'dev');
    } else {
      entries = await tool.readAll(channelId || 'dev');
    }
    
    if (exp === 'true') {
      // Augment with known key metadata
      entries = entries.map(e => ({
        ...e,
        known: tool.lookupKey(e.key),
      }));
    }
    
    res.json({ success: true, count: entries.length, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/registry/known-keys — List known registry keys */
app.get('/api/registry/known-keys', (req, res) => {
  const { category, search } = req.query;
  let keys = { ...KNOWN_KEYS };
  
  if (category) {
    keys = Object.fromEntries(
      Object.entries(keys).filter(([_, m]) => m.category === category)
    );
  }
  
  if (search) {
    const lower = search.toLowerCase();
    keys = Object.fromEntries(
      Object.entries(keys).filter(([k, m]) =>
        k.toLowerCase().includes(lower) ||
        m.description.toLowerCase().includes(lower)
      )
    );
  }
  
  res.json({ success: true, count: Object.keys(keys).length, keys });
});

/** GET /api/registry/categories */
app.get('/api/registry/categories', (req, res) => {
  const categories = new Map();
  for (const [_, meta] of Object.entries(KNOWN_KEYS)) {
    const cat = meta.category || 'unknown';
    categories.set(cat, (categories.get(cat) || 0) + 1);
  }
  res.json({ success: true, categories: Object.fromEntries(categories) });
});

// ─── Stream Proxy ─────────────────────────────────────────────────

/** GET /api/proxy/status */
app.get('/api/proxy/status', (req, res) => {
  res.json({ success: true, ...getProxySnapshot() });
});

/** POST /api/proxy/config — Update proxy config */
app.post('/api/proxy/config', (req, res) => {
  try {
    updateProxyConfig(req.body);
    res.json({ success: true, message: 'Config updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/proxy/test?url=... — Test proxy with a URL via this server (no cross-port issues) */
app.get('/api/proxy/test', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ success: false, error: 'url query param required' });
  try {
    const { get } = http;
    const proxyResp = await new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${STREAM_PROXY_PORT}/proxy/${encodeURIComponent(targetUrl)}`, (r) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
        r.on('error', reject);
      }).on('error', reject).setTimeout(10000);
    });
    const stats = getProxySnapshot();
    res.json({ success: true, result: proxyResp, proxyStats: stats });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// ─── Key Reference ────────────────────────────────────────────────

/** GET /api/keys — List all known remote control keys */
app.get('/api/keys', (req, res) => {
  res.json({ success: true, keys: KEYS });
});

// ─── System ───────────────────────────────────────────────────────

/** GET /api/status — Overall system status */
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    uptime: process.uptime(),
    devicesTracked: deviceManager.list().length,
    activeWsClients: wsClients.size,
    proxyRunning: proxyStats.startTime !== null,
    proxySnapshot: getProxySnapshot(),
    memory: process.memoryUsage(),
  });
});

// ─── Periodic broadcast ───────────────────────────────────────────
let monitorInterval = null;

function startMonitor(intervalMs = 5000) {
  if (monitorInterval) return;
  monitorInterval = setInterval(async () => {
    try {
      const devices = deviceManager.list();
      // Ping each device
      for (const dev of devices) {
        const client = clients.get(dev.serial);
        if (client) {
          const healthy = await client.ping().catch(() => false);
          broadcast({
            type: 'health',
            serial: dev.serial,
            healthy,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch { /* ignore */ }
  }, intervalMs);
}

// ═══════════════════════════════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════════════════════════════

async function startup() {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       Roku Unchained v1.0           ║');
  console.log('  ║    Hardware freedom for your TV     ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');

  // Start stream proxy with port conflict retry
  let proxyPort = STREAM_PROXY_PORT;
  streamProxyServer = createStreamProxy();
  while (true) {
    try {
      await new Promise((r, j) => {
        streamProxyServer.once('error', j);
        streamProxyServer.listen(proxyPort, '0.0.0.0', () => { streamProxyServer.removeAllListeners('error'); r(); });
      });
      break;
    } catch (e) {
      if (e.code === 'EADDRINUSE') {
        console.log(`  Port ${proxyPort} in use, trying ${proxyPort + 1}...`);
        proxyPort++;
      } else throw e;
    }
  }
  console.log(`  Stream Proxy   →  http://0.0.0.0:${proxyPort}`);
  
  // Start main server with port conflict retry
  let mainPort = PORT;
  while (true) {
    try {
      await new Promise((r, j) => {
        server.once('error', j);
        server.listen(mainPort, HOST, () => { server.removeAllListeners('error'); r(); });
      });
      break;
    } catch (e) {
      if (e.code === 'EADDRINUSE') {
        console.log(`  Port ${mainPort} in use, trying ${mainPort + 1}...`);
        mainPort++;
      } else throw e;
    }
  }
  console.log(`  Dashboard      →  http://${HOST}:${mainPort}`);
  console.log(`  API            →  http://${HOST}:${mainPort}/api`);
  console.log(`  PID            →  ${process.pid}`);
  console.log('');

  // Auto-discover
  process.stdout.write('  Scanning network...');
  await deviceManager.discover().catch(() => {});
  const found = deviceManager.list();
  
  if (found.length > 0) {
    console.log(` found ${found.length} device(s)`);
    for (const d of found) {
      console.log(`    ${d.serial} @ ${d.ip}${d.healthy ? ' ✓' : ''}`);
      if (!clients.has(d.serial)) clients.set(d.serial, new ECPClient(d.ip));
      if (!registryTools.has(d.serial)) registryTools.set(d.serial, new RegistryTool(d.ip));
    }
    await deviceManager.healthCheckAll().catch(() => {});
  } else {
    console.log(' no devices found (will keep scanning)');
  }

  console.log('');
  console.log('  Ready. Open the dashboard to get started.');
  console.log(`  Press Ctrl+C to stop.`);
  console.log('');

  startMonitor(10000);
  deviceManager.startAutoDiscovery(60000);
}

// ─── Graceful Shutdown ───────
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  
  deviceManager.stopAutoDiscovery();
  if (monitorInterval) clearInterval(monitorInterval);
  
  // Close all WebSocket clients
  for (const ws of wsClients) {
    try { ws.close(); } catch {}
  }
  wsClients.clear();
  
  // Close stream proxy
  if (streamProxyServer) {
    streamProxyServer.close(() => console.log('Stream proxy stopped.'));
  }
  
  // Close main server
  server.close(() => {
    console.log('Server stopped. Goodbye.');
    process.exit(0);
  });
  
  // Force exit after 5s if graceful close fails
  setTimeout(() => { console.log('Forced exit.'); process.exit(1); }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException');
});

// Start if run directly
if (require.main === module) {
  startup().catch(err => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
}

// ─── Exports ──────────────────────────────────────────────────────
module.exports = { app, server, startup, broadcast, deviceManager };
