'use strict';
const { ManifestProcessor } = require('../proxy/stream-proxy');

// Test 1: HLS manifest ad removal + quality filtering
const hlsManifest = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080
https://good.stream/variant.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160
https://high.bitrate.too.much/variant.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
https://doubleclick.net/ad/ad.mp4
#EXT-X-CUE-OUT
https://adserver.com/ad.ts
#EXT-X-CUE-IN
https://good.stream/segment.ts
`;

const result = ManifestProcessor.processHLS(hlsManifest, 'https://example.com/stream.m3u8');
console.log('HLS ad removal:', result.adsRemoved, '(expected: 3)');
console.log('HLS quality filtered:', result.qualityFiltered, '(expected: 1)');
console.log('Good segments preserved:', result.content.includes('good.stream/segment.ts'));
console.log('Ad server excluded:', !result.content.includes('adserver.com'));
console.log('High bitrate excluded:', !result.content.includes('high.bitrate'));

// Test 2: DASH ad removal
const dashManifest = `<MPD><Period><AdaptationSet><Representation bandwidth="5000000" width="1920" height="1080"><BaseURL>good.mp4</BaseURL></Representation></AdaptationSet></Period><Period><Representation><BaseURL>https://doubleclick.net/ad/123</BaseURL></Representation></Period></MPD>`;
const dashResult = ManifestProcessor.processDASH(dashManifest, 'test.mpd');
console.log('\nDASH ad removal:', dashResult.adsRemoved, '(expected: 1)');
console.log('Good period preserved:', dashResult.content.includes('good.mp4'));
console.log('Ad period removed:', !dashResult.content.includes('doubleclick.net'));

// Test 3: WebSocket frame encoding for >125 byte payload
const { Buffer } = require('buffer');
const payload = Buffer.from('A'.repeat(200), 'utf8');
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
console.log('\nWS frame header byte:', frame[0], '(expected: 129)');
console.log('WS frame len byte:', frame[1], '(expected: 126 for 200-byte payload)');
console.log('WS frame extended len:', frame.readUInt16BE(2), '(expected: 200)');

let passed = true;
if (result.adsRemoved !== 3) { console.log('FAIL: HLS ad removal'); passed = false; }
if (result.qualityFiltered !== 1) { console.log('FAIL: HLS quality filter'); passed = false; }
if (!result.content.includes('good.stream/segment.ts')) { console.log('FAIL: Good segments lost'); passed = false; }
if (result.content.includes('adserver.com')) { console.log('FAIL: Ad not removed'); passed = false; }
if (dashResult.adsRemoved !== 1) { console.log('FAIL: DASH ad removal'); passed = false; }
if (!dashResult.content.includes('good.mp4')) { console.log('FAIL: Good DASH content lost'); passed = false; }
if (frame[0] !== 129) { console.log('FAIL: WS frame header'); passed = false; }
if (frame[1] !== 126) { console.log('FAIL: WS length byte'); passed = false; }
if (frame.readUInt16BE(2) !== 200) { console.log('FAIL: WS extended length'); passed = false; }

if (passed) {
  console.log('\n✅ ALL TESTS PASSED');
} else {
  console.log('\n❌ SOME TESTS FAILED');
  process.exit(1);
}
