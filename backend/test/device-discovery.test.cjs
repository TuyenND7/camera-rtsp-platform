const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { normalizeDiscoverySubnet, deviceFromProbe, isOnvifReply, probeRtsp, probeOnvifEndpoint, deviceDiscovery } = require('../dist/deviceDiscovery');

const SOAP = '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><s:Body><tds:GetSystemDateAndTimeResponse /></s:Body></s:Envelope>';

async function withServer(server, run) {
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await run(server.address().port); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
}

test('discovery accepts only bounded private IPv4 networks', () => {
  for (const [value, expected] of [['192.168.0.101/24', '192.168.0.0/24'], ['10.22.33.4', '10.22.33.0/24'], ['172.16.1.0/24', '172.16.1.0/24'], ['172.31.255.1', '172.31.255.0/24']]) assert.equal(normalizeDiscoverySubnet(value), expected);
  for (const value of ['8.8.8.0/24', '127.0.0.1/24', '169.254.0.0/24', '172.32.0.0/24', '192.168.0.0/16', '192.168.00.0/24', '192.168.0.0/24/1', '::1', 'localhost', 'http://192.168.0.1', null]) assert.equal(normalizeDiscoverySubnet(value), null);
  assert.throws(() => deviceDiscovery.start('8.8.8.0/24', []));
});

test('WS-Discovery ignores external, spoofed and credential-bearing addresses', () => {
  const raw = (url) => ({ probeMatches: { probeMatch: { XAddrs: url, scopes: 'onvif://www.onvif.org/name/C%E1%BB%ADa%20ch%C3%ADnh' } } });
  const device = deviceFromProbe(raw('http://192.168.0.100/onvif/device_service'), '192.168.0.100', '192.168.0.0/24');
  assert.equal(device.ip, '192.168.0.100'); assert.equal(device.name, 'Cửa chính');
  for (const url of ['http://8.8.8.8/onvif', 'http://192.168.0.101/onvif', 'http://user:secret@192.168.0.100/onvif', 'file:///etc/passwd', 'not a url']) assert.equal(deviceFromProbe(raw(url), '192.168.0.100', '192.168.0.0/24'), null);
  assert.equal(deviceFromProbe(raw('http://192.168.0.100/onvif'), '10.0.0.5', '192.168.0.0/24'), null);
  assert.equal(deviceFromProbe(raw({ toString: 'not callable' }), '192.168.0.100', '192.168.0.0/24'), null);
});

test('a generic HTTP authentication page is not labeled ONVIF', () => {
  assert.equal(isOnvifReply(200, SOAP, ''), true);
  assert.equal(isOnvifReply(401, '', 'Digest realm="ONVIF"'), true);
  assert.equal(isOnvifReply(401, '<html>Sign in</html>', 'Basic realm="Router"'), false);
  assert.equal(isOnvifReply(200, '<html>onvif camera settings</html>', ''), false);
});

test('RTSP detection accepts authentication challenges without trying credentials', async () => {
  await withServer(net.createServer((socket) => socket.once('data', (data) => { assert.match(data.toString(), /^OPTIONS rtsp:/); assert.doesNotMatch(data.toString(), /Authorization:/); socket.end('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n'); })), async (port) => assert.equal(await probeRtsp('127.0.0.1', port), true));
  await withServer(net.createServer((socket) => socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\n\r\n'))), async (port) => assert.equal(await probeRtsp('127.0.0.1', port), false));
});

test('a device sending endless partial data cannot keep a scan alive', async () => {
  await withServer(net.createServer((socket) => { const timer = setInterval(() => socket.write('x'), 5); socket.once('close', () => clearInterval(timer)); }), async (port) => {
    const start = Date.now(); assert.equal(await probeRtsp('127.0.0.1', port, 90), false); assert.ok(Date.now() - start < 800);
  });
});

test('ONVIF probe reads SOAP and rejects HTML or oversized responses', async () => {
  await withServer(http.createServer((req, res) => { assert.equal(req.method, 'POST'); assert.equal(req.url, '/onvif/device_service'); res.end(SOAP); }), async (port) => assert.equal(await probeOnvifEndpoint('127.0.0.1', port), `http://127.0.0.1:${port}/onvif/device_service`));
  await withServer(http.createServer((_req, res) => res.end('<html>Router</html>')), async (port) => assert.equal(await probeOnvifEndpoint('127.0.0.1', port), null));
  await withServer(http.createServer((_req, res) => res.end('x'.repeat(40_000))), async (port) => assert.equal(await probeOnvifEndpoint('127.0.0.1', port), null));
});
