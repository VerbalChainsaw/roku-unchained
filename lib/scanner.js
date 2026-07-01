/**
 * Network Scanner — Discover Roku devices and audit their network
 * services. SSDP discovery, port scanning, service identification,
 * and health monitoring.
 *
 * @module lib/scanner
 */
'use strict';

const dgram = require('dgram');
const net = require('net');
const http = require('http');
const os = require('os');

// ─── Constants ────────────────────────────────────────────────────
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const ECP_PORT = 8060;
const PLUGIN_PORT = 80;
const TELNET_PORT = 8085;

// ─── SSDP Discovery ───────────────────────────────────────────────
/**
 * Discover Roku devices via SSDP multicast.
 * @param {number} timeout - Wait time in ms
 * @returns {Promise<Array>} Discovered devices
 */
function discover(timeout = 5000) {
  return new Promise((resolve, reject) => {
    const devices = new Map();
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
      resolve(Array.from(devices.values()));
    }, timeout);

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const locationMatch = text.match(/Location:\s*(http:\/\/[^\r\n]+)/i);
      const usnMatch = text.match(/USN:\s*uuid:roku:ecp:([^\r\n]+)/i);
      const serverMatch = text.match(/Server:\s*([^\r\n]+)/i);
      const cacheMatch = text.match(/Cache-Control:\s*max-age=(\d+)/i);

      if (locationMatch && usnMatch) {
        const serial = usnMatch[1].trim();
        const ip = rinfo.address;

        if (!devices.has(serial)) {
          devices.set(serial, {
            serial,
            ip,
            url: locationMatch[1].trim(),
            server: serverMatch?.[1]?.trim() || null,
            cacheMaxAge: cacheMatch ? parseInt(cacheMatch[1]) : 3600,
            discoveredAt: new Date(),
            services: {},
          });
        }
      }
    });

    // Also handle NOTIFY messages (unsolicited advertisements)
    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });

    socket.bind({ port: 0 }, () => {
      socket.setMulticastTTL(4);
      
      // Send multiple M-SEARCH for reliability
      const send = () => {
        socket.send(msearch, 0, msearch.length, SSDP_PORT, SSDP_ADDR);
      };
      send();
      setTimeout(send, 1000);
      setTimeout(send, 2500);
    });
  });
}

// ─── Service Scanner ──────────────────────────────────────────────
/**
 * Check if a TCP port is open on a host.
 * @param {string} host
 * @param {number} port
 * @param {number} timeout
 * @returns {Promise<boolean>}
 */
function checkPort(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeout);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

/**
 * Scan all known Roku service ports.
 * @param {string} host
 * @returns {Promise<object>} Port status map
 */
async function scanServices(host) {
  const [ecp, plugin, telnet] = await Promise.all([
    checkPort(host, ECP_PORT),
    checkPort(host, PLUGIN_PORT),
    checkPort(host, TELNET_PORT),
  ]);

  const services = {
    ecp: { port: ECP_PORT, open: ecp },
    plugin: { port: PLUGIN_PORT, open: plugin },
    telnet: { port: TELNET_PORT, open: telnet },
  };

  // Try to fetch device info if ECP is open
  let deviceInfo = null;
  if (ecp) {
    try {
      deviceInfo = await new Promise((resolve, reject) => {
        http.get(`http://${host}:${ECP_PORT}/query/device-info`, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        }).on('error', reject).setTimeout(3000);
      });
    } catch {
      // Device info not available
    }
  }

  return { host, services, deviceInfo };
}

// ─── Network Interface Discovery ──────────────────────────────────
/**
 * Get local network interfaces suitable for scanning.
 */
function getLocalNetworks() {
  const interfaces = os.networkInterfaces();
  const networks = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const parts = addr.address.split('.');
        networks.push({
          name,
          address: addr.address,
          netmask: addr.netmask,
          cidr: `${parts[0]}.${parts[1]}.${parts[2]}.0/24`,
          broadcast: `${parts[0]}.${parts[1]}.${parts[2]}.255`,
        });
      }
    }
  }

  return networks;
}

/**
 * Quick scan a subnet for Roku devices (ECP port 8060).
 * @param {string} subnet - e.g., '192.168.1'
 * @param {number} timeout
 * @returns {Promise<Array>} Found hosts with ECP open
 */
async function quickScan(subnet, timeout = 1000) {
  const promises = [];
  for (let i = 1; i <= 254; i++) {
    const host = `${subnet}.${i}`;
    promises.push(
      checkPort(host, ECP_PORT, timeout).then(open => open ? host : null)
    );
  }

  // Batch in groups of 20 to avoid overwhelming the network
  const BATCH = 20;
  const results = [];
  for (let i = 0; i < promises.length; i += BATCH) {
    const batch = promises.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch);
    results.push(...batchResults.filter(Boolean));
    // Small delay between batches
    if (i + BATCH < promises.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return results;
}

/**
 * Full network audit — discover, scan services, get device info.
 * @returns {Promise<object>} Complete audit report
 */
async function fullAudit() {
  const networks = getLocalNetworks();
  const discovered = await discover(6000);

  // Scan services on each discovered device
  for (const dev of discovered) {
    const scan = await scanServices(dev.ip);
    dev.services = scan.services;
    dev.deviceInfo = scan.deviceInfo;
  }

  return {
    timestamp: new Date().toISOString(),
    networks,
    devices: discovered,
    summary: {
      total: discovered.length,
      online: discovered.filter(d => d.services.ecp.open).length,
      developerMode: discovered.filter(d => d.services.telnet.open).length,
    },
  };
}

/**
 * Continuous discovery — calls callback on each new device found.
 * @param {function} onDevice - Called with device object
 * @param {number} intervalMs - How often to scan
 * @returns {{ stop: function }} Handle to stop discovery
 */
function watch(onDevice, intervalMs = 30000) {
  const seen = new Set();
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        const devices = await discover(5000);
        for (const dev of devices) {
          if (!seen.has(dev.serial)) {
            seen.add(dev.serial);
            onDevice(dev);
          }
        }
      } catch {
        // Ignore errors during watch
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  };

  loop();

  return {
    stop: () => { running = false; },
  };
}

// ─── Exports ──────────────────────────────────────────────────────
module.exports = {
  discover,
  scanServices,
  checkPort,
  getLocalNetworks,
  quickScan,
  fullAudit,
  watch,
  ECP_PORT,
  SSDP_ADDR,
  SSDP_PORT,
  PLUGIN_PORT,
  TELNET_PORT,
};
