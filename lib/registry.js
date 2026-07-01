/**
 * Registry Tools — Read, write, search, export Roku registry keys.
 * Includes community-mapped known keys for ad control, tracking,
 * updates, screensaver, audio, and network.
 *
 * @module lib/registry
 */
'use strict';

const http = require('http');

const ECP_PORT = 8060;

// ─── Known Registry Keys (community research) ────────────────────
// Format: { key: { section?, description, values?, type, readOnly? } }
const KNOWN_KEYS = {
  // ── Advertising ──
  'ad_measurement_enabled': {
    section: 'captions',
    description: 'Enable/disable targeted ad measurement',
    type: 'boolean',
    defaultValue: true,
    category: 'privacy',
  },
  'advertising_id': {
    section: 'captions',
    description: 'Roku Advertising ID (RAID)',
    type: 'string',
    readOnly: true,
    category: 'tracking',
  },
  'limit_ad_tracking': {
    section: 'captions',
    description: 'Limit ad tracking (like iOS limit ad tracking)',
    type: 'boolean',
    defaultValue: false,
    values: ['false', 'true'],
    category: 'privacy',
  },

  // ── Tracking & Analytics ──
  'tracking_enabled': {
    description: 'Master tracking/analytics switch',
    type: 'boolean',
    defaultValue: true,
    category: 'privacy',
  },
  'rcv_headers': {
    section: 'captions',
    description: 'Roku Channel View headers (telemetry)',
    type: 'string',
    readOnly: true,
    category: 'tracking',
  },
  'log_uploads_enabled': {
    description: 'Enable automatic log uploads to Roku',
    type: 'boolean',
    defaultValue: true,
    category: 'privacy',
  },

  // ── Updates ──
  'firmware_update_enabled': {
    description: 'Enable/disable automatic firmware updates',
    type: 'boolean',
    defaultValue: true,
    category: 'system',
  },
  'update_channel': {
    description: 'Update channel (stable, beta, etc.)',
    type: 'string',
    values: ['stable', 'beta'],
    defaultValue: 'stable',
    category: 'system',
  },
  'app_autoupdate_enabled': {
    description: 'Enable/disable automatic app updates',
    type: 'boolean',
    defaultValue: true,
    category: 'system',
  },

  // ── Screensaver ──
  'screensaver_timeout': {
    description: 'Screensaver activation timeout (seconds)',
    type: 'number',
    defaultValue: '600', // Roku default 10 min
    category: 'display',
  },
  'screensaver_type': {
    description: 'Current screensaver type/app ID',
    type: 'string',
    category: 'display',
  },
  'screensaver_delay': {
    description: 'Delay before screensaver starts (ms)',
    type: 'number',
    category: 'display',
  },

  // ── Display ──
  'display_type': {
    description: 'Current display resolution/type',
    type: 'string',
    readOnly: true,
    category: 'display',
  },
  'theme': {
    description: 'UI theme (light/dark)',
    type: 'string',
    values: ['light', 'dark'],
    defaultValue: 'dark',
    category: 'display',
  },
  'screensaver_random': {
    description: 'Randomize screensaver',
    type: 'boolean',
    defaultValue: true,
    category: 'display',
  },
  'wallpaper_theme': {
    description: 'Home screen wallpaper theme',
    type: 'string',
    category: 'display',
  },

  // ── Audio ──
  'audio_mode': {
    description: 'Audio output mode (stereo, auto, etc.)',
    type: 'string',
    values: ['stereo', 'auto', 'dolby'],
    defaultValue: 'auto',
    category: 'audio',
  },
  'volume_mode': {
    description: 'Volume leveling/night mode',
    type: 'string',
    values: ['off', 'leveling', 'night'],
    defaultValue: 'off',
    category: 'audio',
  },
  'audio_guide_enabled': {
    description: 'Screen reader / audio guide',
    type: 'boolean',
    defaultValue: false,
    category: 'accessibility',
  },
  'audio_guide_speed': {
    description: 'Screen reader speed',
    type: 'string',
    values: ['slow', 'normal', 'fast'],
    defaultValue: 'normal',
    category: 'accessibility',
  },

  // ── Network ──
  'wifi_power_save': {
    description: 'WiFi power saving mode',
    type: 'boolean',
    defaultValue: true,
    category: 'network',
  },
  'network_proxy_enabled': {
    description: 'Enable network proxy',
    type: 'boolean',
    defaultValue: false,
    category: 'network',
  },
  'network_proxy_host': {
    description: 'Network proxy host',
    type: 'string',
    category: 'network',
  },
  'network_proxy_port': {
    description: 'Network proxy port',
    type: 'number',
    category: 'network',
  },
  'dns_manual': {
    description: 'Use manual DNS servers',
    type: 'boolean',
    defaultValue: false,
    category: 'network',
  },

  // ── Developer ──
  'developer_mode': {
    description: 'Developer mode enabled status',
    type: 'boolean',
    readOnly: true,
    category: 'developer',
  },
  'developer_password': {
    description: 'Developer mode password (hashed)',
    type: 'string',
    readOnly: true,
    category: 'developer',
  },
  'sideload_channel': {
    description: 'Sideloaded app ID',
    type: 'string',
    readOnly: true,
    category: 'developer',
  },

  // ── Captions / Subtitles ──
  'captions_enabled': {
    section: 'captions',
    description: 'Closed captions enabled',
    type: 'boolean',
    defaultValue: false,
    category: 'accessibility',
  },
  'captions_text_size': {
    section: 'captions',
    description: 'Caption text size',
    type: 'string',
    values: ['small', 'medium', 'large'],
    defaultValue: 'medium',
    category: 'accessibility',
  },
  'captions_text_color': {
    section: 'captions',
    description: 'Caption text color',
    type: 'string',
    category: 'accessibility',
  },
  'captions_background_opacity': {
    section: 'captions',
    description: 'Caption background opacity',
    type: 'string',
    category: 'accessibility',
  },

  // ── Roku TV specific ──
  'tv_power_on_mode': {
    description: 'TV power-on behavior',
    type: 'string',
    values: ['home', 'last_input'],
    defaultValue: 'home',
    category: 'power',
  },
  'tv_fast_start': {
    description: 'Fast TV start (keeps TV warm)',
    type: 'boolean',
    defaultValue: true,
    category: 'power',
  },
  'tv_auto_power_off': {
    description: 'Auto power off after inactivity (minutes, 0=off)',
    type: 'number',
    defaultValue: '0',
    category: 'power',
  },
  'tv_brightness': {
    description: 'TV brightness level',
    type: 'number',
    category: 'display',
  },
  'tv_picture_mode': {
    description: 'TV picture mode',
    type: 'string',
    values: ['standard', 'movie', 'sport', 'vivid', 'game', 'low_power'],
    defaultValue: 'standard',
    category: 'display',
  },

  // ── System ──
  'locale': {
    description: 'System locale/region',
    type: 'string',
    category: 'system',
    readOnly: true,
  },
  'timezone': {
    description: 'System timezone',
    type: 'string',
    category: 'system',
  },
  'language': {
    description: 'System language',
    type: 'string',
    category: 'system',
  },
  'device_name': {
    description: 'Roku device friendly name',
    type: 'string',
    category: 'system',
  },
};

// ─── HTTP helper ──────────────────────────────────────────────────
function ecpGet(host, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://${host}:${ECP_PORT}${path}`, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const xml = Buffer.concat(chunks).toString('utf8');
        resolve(xml);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── XML parser ───────────────────────────────────────────────────
function parseRegistryXML(xml) {
  if (!xml) return [];
  const entries = [];
  
  // Parse registry entries from ECP XML response
  // Format: <registry><entry key="..." value="..." section="..."/></registry>
  const entryRegex = /<entry\s+key="([^"]*)"\s+value="([^"]*)"(?:\s+section="([^"]*)")?/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    entries.push({
      key: match[1],
      value: match[2],
      section: match[3] || null,
    });
  }
  
  // Also try structured sections
  const sectionRegex = /<section\s+name="([^"]*)">([\s\S]*?)<\/section>/g;
  while ((match = sectionRegex.exec(xml)) !== null) {
    const sectionName = match[1];
    const sectionContent = match[2];
    const secEntryRegex = /<entry\s+key="([^"]*)"\s+value="([^"]*)"/g;
    let secMatch;
    while ((secMatch = secEntryRegex.exec(sectionContent)) !== null) {
      entries.push({
        key: secMatch[1],
        value: secMatch[2],
        section: sectionName,
      });
    }
  }
  
  return entries;
}

// ─── Registry API ─────────────────────────────────────────────────
class RegistryTool {
  constructor(host) {
    this.host = host;
  }

  /**
   * Read entire registry for a channel.
   * @param {string} channelId - 'dev' for sideloaded, or a channel ID
   * @returns {Array<{key, value, section}>}
   */
  async readAll(channelId = 'dev') {
    const xml = await ecpGet(this.host, `/query/registry/${channelId}`);
    return parseRegistryXML(xml);
  }

  /**
   * Find entries by key (partial match).
   * @param {string} keyPattern
   * @param {string} channelId
   */
  async find(keyPattern, channelId = 'dev') {
    const all = await this.readAll(channelId);
    const lower = keyPattern.toLowerCase();
    return all.filter(e => e.key.toLowerCase().includes(lower));
  }

  /**
   * Find entries by section.
   * @param {string} section
   * @param {string} channelId
   */
  async findBySection(section, channelId = 'dev') {
    const all = await this.readAll(channelId);
    return all.filter(e => e.section === section);
  }

  /**
   * Look up a known key with metadata.
   * @param {string} key
   * @returns {object|null} Key metadata from KNOWN_KEYS
   */
  lookupKey(key) {
    return KNOWN_KEYS[key] || null;
  }

  /**
   * Search known keys by description or category.
   * @param {string} query
   * @returns {object} Matched keys with metadata
   */
  searchKnownKeys(query) {
    const lower = query.toLowerCase();
    const results = {};
    for (const [key, meta] of Object.entries(KNOWN_KEYS)) {
      if (
        key.toLowerCase().includes(lower) ||
        meta.description.toLowerCase().includes(lower) ||
        meta.category?.toLowerCase().includes(lower)
      ) {
        results[key] = meta;
      }
    }
    return results;
  }

  /**
   * Get keys by category.
   * @param {string} category
   */
  getByCategory(category) {
    const results = {};
    for (const [key, meta] of Object.entries(KNOWN_KEYS)) {
      if (meta.category === category) {
        results[key] = meta;
      }
    }
    return results;
  }

  /**
   * Export registry augmented with known key metadata.
   * @param {string} channelId
   */
  async export(channelId = 'dev') {
    const entries = await this.readAll(channelId);
    return entries.map(e => ({
      ...e,
      known: KNOWN_KEYS[e.key] || null,
    }));
  }

  /**
   * Generate a privacy audit report.
   * @param {string} channelId
   */
  async privacyAudit(channelId = 'dev') {
    const entries = await this.readAll(channelId);
    const findings = [];
    
    const privacyKeys = Object.entries(KNOWN_KEYS)
      .filter(([_, m]) => m.category === 'privacy' || m.category === 'tracking');
    
    for (const [key, meta] of privacyKeys) {
      const entry = entries.find(e => e.key === key);
      findings.push({
        key,
        description: meta.description,
        currentValue: entry?.value || 'NOT SET',
        defaultValue: meta.defaultValue || 'unknown',
        status: entry ? (entry.value === 'false' || entry.value === '0' ? 'disabled' : 'enabled') : 'unknown',
        recommended: meta.category === 'privacy' ? 'disabled' : 'disabled',
      });
    }
    
    return findings;
  }

  /**
   * Get a sanitized device fingerprint (no tracking IDs).
   * @param {string} channelId
   */
  async deviceFingerprint(channelId = 'dev') {
    const entries = await this.readAll(channelId);
    const fp = {};
    
    // Collect non-sensitive info only
    const safeKeys = [
      'display_type', 'theme', 'language', 'locale', 'timezone',
      'audio_guide_enabled', 'captions_enabled', 'tv_picture_mode',
    ];
    
    for (const key of safeKeys) {
      const entry = entries.find(e => e.key === key);
      if (entry) {
        fp[key] = entry.value;
        const known = KNOWN_KEYS[key];
        if (known) fp[`${key}_description`] = known.description;
      }
    }
    
    return fp;
  }
}

// ─── Exports ──────────────────────────────────────────────────────
module.exports = {
  RegistryTool,
  KNOWN_KEYS,
  parseRegistryXML,
};
