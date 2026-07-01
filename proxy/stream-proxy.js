/**
 * Stream Proxy — HLS/DASH manifest interception, ad removal,
 * quality manipulation, segment proxying, and stream recording.
 *
 * Run as: node proxy/stream-proxy.js
 * Then configure Roku to proxy through http://YOUR_IP:9090/
 *
 * @module proxy/stream-proxy
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Configuration ────────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.STREAM_PROXY_PORT || 9090,
  HOST: process.env.STREAM_PROXY_HOST || '0.0.0.0',
  RECORD_DIR: process.env.RECORD_DIR || path.join(__dirname, '..', 'data', 'recordings'),
  MAX_RECORD_SIZE: parseInt(process.env.MAX_RECORD_MB || '500') * 1024 * 1024,
  LOG_STREAMS: process.env.LOG_STREAMS !== 'false',
  
  // Ad detection patterns
  adPatterns: {
    // Common ad keyword patterns in manifests
    manifestKeywords: [
      /advertisement/i, /advert/i, /preroll/i, /midroll/i, /postroll/i,
      /doubleclick/i, /ads\./i, /adserver/i, /videoads/i,
      /googleads/i, /adform/i, /adtech/i, /openx/i, /pubmatic/i,
      /rubicon/i, /criteo/i, /appnexus/i, /adsrvr/i, /adnxs/i,
      /yieldmo/i, /amazon-adsystem/i, /advertising/i,
      /brightline/i, /innovid/i, /truex/i, /spotx/i,
      /freewheel/i, /adap\.tv/i,
    ],
    // Segment size patterns (ad segments often have specific durations)
    adSegmentPatterns: /#EXT-X-CUE-OUT|#EXT-X-CUE-IN|#EXT-X-DISCONTINUITY|#EXT-X-SCTE35/,
  },

  // Quality manipulation
  quality: {
    enabled: true,
    maxBitrate: 8000000, // 8 Mbps max (0 = no limit)
    minBitrate: 100000,  // 100 Kbps min
    forceResolution: null, // e.g., '1920x1080', '1280x720', null = no forcing
    maxResolution: '1920x1080', // null = no cap
    forceAudioBitrate: null, // e.g., 128000, null = no forcing
  },

  // Content injection
  injection: {
    enabled: false,
    // Inject a custom segment into the stream
    customPreroll: null, // URL to a video file to inject before the main content
    watermark: null, // Text overlay (if supported by player)
    headerInjection: null, // Custom headers to add to requests
  },
};

// ─── Stats ────────────────────────────────────────────────────────
const stats = {
  totalRequests: 0,
  manifestRequests: 0,
  segmentRequests: 0,
  adsBlocked: 0,
  bytesProxied: 0,
  activeStreams: 0,
  errors: 0,
  startTime: new Date(),
  streamLog: [], // Last 100 stream events
};

function logStreamEvent(type, data) {
  if (!CONFIG.LOG_STREAMS) return;
  const event = {
    timestamp: new Date().toISOString(),
    type,
    ...data,
  };
  stats.streamLog.unshift(event);
  if (stats.streamLog.length > 100) stats.streamLog.length = 100;
}

// ─── Recording ────────────────────────────────────────────────────
const activeRecordings = new Map();

class StreamRecorder {
  constructor(streamId, url) {
    this.streamId = streamId;
    this.url = url;
    this.bytesWritten = 0;
    this.segmentsRecorded = 0;
    this.startTime = Date.now();

    const dir = path.join(CONFIG.RECORD_DIR, streamId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.manifestPath = path.join(dir, 'manifest.m3u8');
    this.segmentsDir = path.join(dir, 'segments');
    if (!fs.existsSync(this.segmentsDir)) fs.mkdirSync(this.segmentsDir, { recursive: true });
  }

  writeManifest(data) {
    if (this.bytesWritten > CONFIG.MAX_RECORD_SIZE) return;
    fs.writeFileSync(this.manifestPath, data);
    this.bytesWritten += Buffer.byteLength(data);
  }

  writeSegment(seq, data) {
    if (this.bytesWritten > CONFIG.MAX_RECORD_SIZE) return;
    const segPath = path.join(this.segmentsDir, `segment_${seq}.ts`);
    fs.writeFileSync(segPath, data);
    this.bytesWritten += Buffer.byteLength(data);
    this.segmentsRecorded++;
  }

  getInfo() {
    return {
      streamId: this.streamId,
      url: this.url,
      bytesWritten: this.bytesWritten,
      segmentsRecorded: this.segmentsRecorded,
      duration: Date.now() - this.startTime,
    };
  }
}

// ─── Manifest Processing ──────────────────────────────────────────
class ManifestProcessor {
  /**
   * Process an HLS manifest (.m3u8) — detect and remove ads,
   * filter quality levels, inject custom content.
   */
  static processHLS(content, targetUrl, originalUrl) {
    const lines = content.split('\n');
    const output = [];
    let inAdBlock = false;
    let adSegmentsRemoved = 0;
    let currentBitrate = null;
    let qualityFiltered = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // ── Ad Detection in URIs ──
      if (trimmed.startsWith('#') === false && trimmed.length > 0) {
        const isAd = CONFIG.adPatterns.manifestKeywords.some(pattern => pattern.test(trimmed));
        if (isAd) {
          adSegmentsRemoved++;
          stats.adsBlocked++;
          logStreamEvent('ad_blocked', { url: trimmed, manifest: targetUrl });
          continue;
        }
      }

      // ── SCTE-35 / Ad markers in HLS ──
      if (CONFIG.adPatterns.adSegmentPatterns.test(trimmed)) {
        // Check if this is a CUE-OUT (start of ad)
        if (trimmed.includes('CUE-OUT')) {
          inAdBlock = true;
          adSegmentsRemoved++;
          stats.adsBlocked++;
          logStreamEvent('ad_blocked', { marker: 'CUE-OUT', manifest: targetUrl });
          continue;
        }
        if (trimmed.includes('CUE-IN')) {
          inAdBlock = false;
          continue;
        }
        // DISCONTINUITY near ad markers
        if (inAdBlock && trimmed.includes('DISCONTINUITY')) {
          continue;
        }
      }

      // If we're in an ad block, skip segments
      if (inAdBlock && !trimmed.startsWith('#') && trimmed.length > 0) {
        adSegmentsRemoved++;
        continue;
      }

      // ── Quality/Bitrate Filtering ──
      if (CONFIG.quality.enabled) {
        // HLS: #EXT-X-STREAM-INF:BANDWIDTH=XXXX,RESOLUTION=WxH
        if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
          const bwMatch = trimmed.match(/BANDWIDTH=(\d+)/);
          const resMatch = trimmed.match(/RESOLUTION=(\d+x\d+)/);

          if (bwMatch) {
            currentBitrate = parseInt(bwMatch[1]);
            const maxBw = CONFIG.quality.maxBitrate;
            const minBw = CONFIG.quality.minBitrate;

            // Filter by bitrate
            if ((maxBw > 0 && currentBitrate > maxBw) ||
                currentBitrate < minBw) {
              qualityFiltered++;
              i++; // Skip the URI line following this STREAM-INF
              continue;
            }

            // Filter by resolution
            if (resMatch && CONFIG.quality.maxResolution) {
              const [w, h] = resMatch[1].split('x').map(Number);
              const [maxW, maxH] = CONFIG.quality.maxResolution.split('x').map(Number);
              if (h > maxH || w > maxW) {
                qualityFiltered++;
                i++; // Skip the URI line following this STREAM-INF
                continue;
              }
            }

            // Force specific resolution
            if (CONFIG.quality.forceResolution && resMatch) {
              const lineParts = line.split(',');
              const newParts = lineParts.map(p => {
                if (p.startsWith('RESOLUTION=')) {
                  return `RESOLUTION=${CONFIG.quality.forceResolution}`;
                }
                return p;
              });
              output.push(newParts.join(','));
              continue;
            }
          }
        }

        // DASH: <Representation bandwidth="XXXX" width="..." height="...">
        if (CONFIG.quality.forceResolution) {
          const resMatch = trimmed.match(/width="(\d+)"\s+height="(\d+)"/);
          if (resMatch) {
            const [fw, fh] = CONFIG.quality.forceResolution.split('x');
            const replacement = `width="${fw}" height="${fh}"`;
            output.push(trimmed.replace(resMatch[0], replacement));
            continue;
          }
        }
      }

      output.push(line);
    }

    // ── Content Injection ──
    if (CONFIG.injection.enabled && CONFIG.injection.customPreroll) {
      // Insert preroll at beginning of manifest
      output.unshift('', '#EXT-X-CUSTOM-PREROLL');
    }

    return {
      content: output.join('\n'),
      adsRemoved: adSegmentsRemoved,
      qualityFiltered,
      originalLines: lines.length,
      outputLines: output.length,
    };
  }

  /**
   * Process a DASH manifest (.mpd) — remove ad periods, filter representations.
   */
  static processDASH(content, targetUrl) {
    // DASH manifests are XML — more complex processing
    let adsRemoved = 0;

    // Remove <Period> elements that contain ad content
    content = content.replace(/<Period[^>]*>[\s\S]*?<\/Period>/g, (match) => {
      const isAd = CONFIG.adPatterns.manifestKeywords.some(p => p.test(match));
      if (isAd) {
        adsRemoved++;
        stats.adsBlocked++;
        logStreamEvent('ad_blocked_dash', { period: match.substring(0, 100), manifest: targetUrl });
        return '';
      }
      return match;
    });

    // Remove <SupplementalProperty> with ad-related schemeIdUri
    content = content.replace(/<SupplementalProperty\s+schemeIdUri="urn:scte:dash:cta:2015"[^>]*\/>/g, '');

    return {
      content,
      adsRemoved,
    };
  }
}

// ─── HTTP Proxy Server ────────────────────────────────────────────
function createStreamProxy() {
  const server = http.createServer(async (req, res) => {
    stats.totalRequests++;

    // Parse the target URL from the request path
    const urlPath = req.url.startsWith('/proxy/')
      ? decodeURIComponent(req.url.slice(7))
      : null;

    // Also support query parameter style: /proxy?url=XXX
    let targetUrl = urlPath;
    if (!targetUrl && req.url.startsWith('/')) {
      const queryUrl = new URL(req.url, `http://${req.headers.host}`).searchParams.get('url');
      if (queryUrl) targetUrl = queryUrl;
    }

    // Status endpoint
    if (req.url === '/status' || req.url === '/proxy/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uptime: Date.now() - stats.startTime.getTime(),
        ...stats,
        activeRecordings: Array.from(activeRecordings.values()).map(r => r.getInfo()),
        streamLog: stats.streamLog.slice(0, 20),
        config: {
          quality: CONFIG.quality,
          injection: CONFIG.injection.enabled,
          recordDir: CONFIG.RECORD_DIR,
        },
      }, null, 2));
      return;
    }

    // Recordings list
    if (req.url === '/proxy/recordings') {
      const recordingFiles = [];
      try {
        if (fs.existsSync(CONFIG.RECORD_DIR)) {
          for (const dir of fs.readdirSync(CONFIG.RECORD_DIR)) {
            const fullPath = path.join(CONFIG.RECORD_DIR, dir);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              recordingFiles.push({
                id: dir,
                size: getDirSize(fullPath),
                created: stat.birthtime,
              });
            }
          }
        }
      } catch (e) { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(recordingFiles));
      return;
    }

    // Health check
    if (req.url === '/proxy/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: Date.now() - stats.startTime.getTime() }));
      return;
    }

    // If no target URL, return help
    if (!targetUrl) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>Roku Stream Proxy</title></head>
<body style="font-family:monospace;padding:20px;background:#111;color:#0f0">
<h1>Roku Stream Proxy</h1>
<p>Usage: <code>http://${req.headers.host}/proxy/STREAM_URL</code></p>
<p>or: <code>http://${req.headers.host}/?url=STREAM_URL</code></p>
<hr>
<h2>Status</h2>
<pre>Uptime: ${Math.floor((Date.now()-stats.startTime.getTime())/1000)}s
Requests: ${stats.totalRequests}
Ads Blocked: ${stats.adsBlocked}
Active Streams: ${stats.activeStreams}</pre>
<p><a href="/proxy/status">Full Status JSON</a></p>
<p><a href="/proxy/recordings">Recordings</a></p>
</body></html>`);
      return;
    }

    // ── Proxy the request ──
    try {
      let parsedUrl;
      try {
        parsedUrl = new URL(targetUrl);
      } catch {
        if (!targetUrl.startsWith('http')) {
          targetUrl = 'https://' + targetUrl;
          parsedUrl = new URL(targetUrl);
        } else {
          throw new Error('Invalid URL');
        }
      }

      let requestSettled = false;
      const decrementStreams = () => {
        if (!requestSettled) { requestSettled = true; stats.activeStreams--; }
      };
      stats.activeStreams++;

      const isHttps = parsedUrl.protocol === 'https:';
      const transportFunc = isHttps ? https : http;

      const proxyReq = transportFunc.request(
        targetUrl,
        {
          method: req.method,
          headers: {
            ...req.headers,
            host: parsedUrl.host,
            ...(CONFIG.injection.headerInjection || {}),
          },
          rejectUnauthorized: false,
        },
        (proxyRes) => {
          const chunks = [];
          proxyRes.on('data', (chunk) => {
            chunks.push(chunk);
            stats.bytesProxied += chunk.length;
          });

          proxyRes.on('end', () => {
            let content = Buffer.concat(chunks);
            const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();

            const encoding = proxyRes.headers['content-encoding'];
            if (encoding === 'gzip') {
              content = zlib.gunzipSync(content);
            } else if (encoding === 'deflate') {
              content = zlib.inflateSync(content);
            } else if (encoding === 'br') {
              try { content = zlib.brotliDecompressSync(content); } catch { /* can't decompress */ }
            }

            let contentStr = content.toString('utf8');
            let processed = false;

            if (contentType.includes('vnd.apple.mpegurl') ||
                contentType.includes('application/x-mpegurl') ||
                targetUrl.endsWith('.m3u8') ||
                contentStr.includes('#EXTM3U')) {
              stats.manifestRequests++;
              const result = ManifestProcessor.processHLS(contentStr, targetUrl, req.url);
              contentStr = result.content;
              processed = true;
              logStreamEvent('manifest_processed', {
                url: targetUrl,
                adsRemoved: result.adsRemoved,
                qualityFiltered: result.qualityFiltered,
              });
              for (const [id, recorder] of activeRecordings) {
                if (targetUrl.includes(id)) recorder.writeManifest(contentStr);
              }
            }

            if (targetUrl.endsWith('.mpd') || contentType.includes('application/dash+xml')) {
              stats.manifestRequests++;
              const result = ManifestProcessor.processDASH(contentStr, targetUrl);
              contentStr = result.content;
              processed = true;
            }

            if (targetUrl.endsWith('.ts') || targetUrl.endsWith('.m4s') ||
                targetUrl.endsWith('.mp4') && contentType.includes('video')) {
              stats.segmentRequests++;
            }

            const finalHeaders = { ...proxyRes.headers };
            if (processed) {
              delete finalHeaders['content-length'];
              finalHeaders['content-length'] = Buffer.byteLength(contentStr);
              delete finalHeaders['content-encoding'];
            }

            res.writeHead(proxyRes.statusCode || 200, finalHeaders);
            res.end(processed ? contentStr : content);
            decrementStreams();
          });

          proxyRes.on('error', (err) => {
            stats.errors++;
            decrementStreams();
            logStreamEvent('error', { url: targetUrl, error: err.message });
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'text/plain' });
              res.end(`Proxy error: ${err.message}`);
            }
          });
        }
      );

      proxyReq.on('error', (err) => {
        stats.errors++;
        decrementStreams();
        logStreamEvent('error', { url: targetUrl, error: err.message });
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Upstream error: ${err.message}`);
        }
      });

      proxyReq.setTimeout(30000, () => {
        proxyReq.destroy();
        stats.errors++;
        decrementStreams();
      });

      req.pipe(proxyReq);

    } catch (err) {
      stats.errors++;
      stats.activeStreams--;
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`Bad request: ${err.message}`);
      }
    }
  });

  // Add WebSocket upgrade for real-time stats streaming
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/proxy/ws') {
      // Simple WebSocket for stats streaming
      const key = req.headers['sec-websocket-key'];
      const acceptKey = require('crypto')
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
      );

      const interval = setInterval(() => {
        const msg = JSON.stringify({
          type: 'stats',
          uptime: Date.now() - stats.startTime.getTime(),
          totalRequests: stats.totalRequests,
          adsBlocked: stats.adsBlocked,
          activeStreams: stats.activeStreams,
          bytesProxied: stats.bytesProxied,
        });
        const payload = Buffer.from(msg, 'utf8');
        let frame;
        if (payload.length <= 125) {
          frame = Buffer.alloc(2 + payload.length);
          frame[0] = 0x81;
          frame[1] = payload.length;
          payload.copy(frame, 2);
        } else if (payload.length <= 65535) {
          frame = Buffer.alloc(4 + payload.length);
          frame[0] = 0x81;
          frame[1] = 126;
          frame.writeUInt16BE(payload.length, 2);
          payload.copy(frame, 4);
        } else {
          frame = Buffer.alloc(10 + payload.length);
          frame[0] = 0x81;
          frame[1] = 127;
          frame.writeBigUInt64BE(BigInt(payload.length), 2);
          payload.copy(frame, 10);
        }
        try { socket.write(frame); } catch { clearInterval(interval); }
      }, 1000);

      socket.on('close', () => clearInterval(interval));
      socket.on('error', () => clearInterval(interval));
    } else {
      socket.destroy();
    }
  });

  return server;
}

// ─── Recording Management ─────────────────────────────────────────
function startRecording(streamId, url) {
  if (activeRecordings.has(streamId)) return null;
  const recorder = new StreamRecorder(streamId, url);
  activeRecordings.set(streamId, recorder);
  logStreamEvent('recording_started', { streamId, url });
  return recorder;
}

function stopRecording(streamId) {
  const recorder = activeRecordings.get(streamId);
  if (recorder) {
    activeRecordings.delete(streamId);
    logStreamEvent('recording_stopped', { streamId, info: recorder.getInfo() });
    return recorder.getInfo();
  }
  return null;
}

function listRecordings() {
  return Array.from(activeRecordings.values()).map(r => r.getInfo());
}

// ─── Utility ──────────────────────────────────────────────────────
function getDirSize(dirPath) {
  let size = 0;
  try {
    for (const file of fs.readdirSync(dirPath)) {
      const fp = path.join(dirPath, file);
      const stat = fs.statSync(fp);
      size += stat.isDirectory() ? getDirSize(fp) : stat.size;
    }
  } catch { /* ignore */ }
  return size;
}

function updateConfig(newConfig) {
  Object.assign(CONFIG, newConfig);
}

// ─── Start (if run directly) ──────────────────────────────────────
if (require.main === module) {
  // Ensure record directory exists
  if (!fs.existsSync(CONFIG.RECORD_DIR)) {
    fs.mkdirSync(CONFIG.RECORD_DIR, { recursive: true });
  }

  const server = createStreamProxy();
  server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`🎬 Stream Proxy running on http://${CONFIG.HOST}:${CONFIG.PORT}`);
    console.log(`   Status:  http://localhost:${CONFIG.PORT}/proxy/status`);
    console.log(`   Proxy:   http://localhost:${CONFIG.PORT}/proxy/YOUR_STREAM_URL`);
    console.log(`   Quality: max bitrate ${(CONFIG.quality.maxBitrate/1000000).toFixed(1)}Mbps`);
    console.log(`   Ad block: ${CONFIG.adPatterns.manifestKeywords.length} patterns`);
    console.log(`   Recording: ${CONFIG.RECORD_DIR} (max ${CONFIG.MAX_RECORD_SIZE/1024/1024}MB)`);
  });
}

// ─── Exports ──────────────────────────────────────────────────────
module.exports = {
  createStreamProxy,
  ManifestProcessor,
  StreamRecorder,
  startRecording,
  stopRecording,
  listRecordings,
  updateConfig,
  CONFIG,
  stats,
};
