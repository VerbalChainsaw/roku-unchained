// Quick proxy test — starts a local server with fake ad content,
// proxies through it, and verifies ads are stripped.
const http = require('http');
const { createStreamProxy, stats } = require('../proxy/stream-proxy');

// Start proxy
const proxy = createStreamProxy();
proxy.listen(9099, async () => {
  // Start a fake "CDN" serving test content with ads
  const fakeCDN = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000',
      'https://good.stream/clean.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160',
      'https://doubleclick.net/ad/preroll.m3u8',
      '#EXT-X-CUE-OUT',
      'https://adserver.com/ad-segment.ts',
      '#EXT-X-CUE-IN',
      'https://good.stream/real-content.ts',
    ].join('\n'));
  });
  await new Promise(r => fakeCDN.listen(3456, r));

  // Test: proxy through to our fake CDN
  const before = stats.adsBlocked;
  console.log('BEFORE: ads blocked =', before);

  const proxied = await new Promise((resolve, reject) => {
    http.get('http://localhost:9099/proxy/http://localhost:3456/test.m3u8', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });

  console.log('\nPROXIED OUTPUT:');
  console.log(proxied);
  console.log('\nAFTER: ads blocked =', stats.adsBlocked);

  // Check results
  const passed = stats.adsBlocked === 3
    && proxied.includes('clean.m3u8')
    && !proxied.includes('doubleclick')
    && !proxied.includes('adserver.com')
    && proxied.includes('real-content.ts');

  console.log(passed ? '\n✅ PROXY WORKS — 3 ads stripped, clean content preserved' : '\n❌ FAILED');

  proxy.close();
  fakeCDN.close();
  process.exit(passed ? 0 : 1);
});
