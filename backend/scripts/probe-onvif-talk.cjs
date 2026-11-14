// Read-only probe. Run from the backend directory, or pipe into `node -` in its container.
// Uses camera credentials from the existing DB; never prints URLs, passwords or raw SOAP/SDP.
const path = require('node:path');
const { Cam } = require('onvif');
const { parseStringPromise } = require('xml2js');
const { pool } = require(path.join(process.cwd(), 'dist/db'));
const { RtspTalk } = require(path.join(process.cwd(), 'dist/talk/rtsp'));

const MEDIA = 'http://www.onvif.org/ver10/media/wsdl';
const DEVICE_IO = 'http://www.onvif.org/ver10/deviceIO/wsdl';
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const escape = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const call = (camera, name, ...args) => new Promise((resolve, reject) => camera[name](...args, (error, data) => error ? reject(error) : resolve(data)));
const config = (profile, name) => profile[name] || profile.extension?.[name];
const errorInfo = error => ({
  error: /^[A-Z_0-9]+$/.test(error?.code || '') ? error.code : 'probe_failed',
  ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  ...(String(error?.message || '').includes('RTSP 551') ? { rtsp_status: 551 } : {}),
});

async function read(camera, operation, body = '', service = 'media', namespace = MEDIA) {
  if (!operation.startsWith('Get')) throw new Error('Read-only operations required');
  return new Promise(resolve => camera._request({
    service,
    body: camera._envelopeHeader() + `<${operation} xmlns="${namespace}">${body}</${operation}>` + camera._envelopeFooter(),
  }, async (error, _data, xml) => {
    if (error) { resolve(errorInfo(error)); return; }
    try {
      const parsed = await parseStringPromise(xml, { explicitArray: false, tagNameProcessors: [name => name.split(':').pop()] });
      resolve(parsed.Envelope.Body[operation + 'Response'] || {});
    } catch { resolve({ error: 'invalid_xml_response' }); }
  }));
}

function outputSummary(value) {
  if (!value) return null;
  return {
    token: value.$?.token,
    output_token: value.OutputToken,
    output_level: value.OutputLevel == null ? null : Number(value.OutputLevel),
    send_primacy: value.SendPrimacy || null,
  };
}

function mediaSummary(sdp) {
  const parts = sdp.split(/(?:^|\r?\n)m=/);
  const direction = part => part.match(/(?:^|\n)a=(recvonly|sendonly|sendrecv|inactive)\s*(?:\r?\n|$)/)?.[1];
  return parts.slice(1).map(part => {
    const media = part.split(/\s+/)[0];
    const codecs = [...part.matchAll(/(?:^|\n)a=rtpmap:\d+ ([^\r\n]+)/g)]
      .map(match => match[1].trim()).filter(codec => /^[\w.-]+\/\d+(?:\/\d+)?$/.test(codec));
    return { kind: ['video', 'audio', 'application'].includes(media) ? media : 'other', direction: direction(part) || direction(parts[0]) || 'unspecified', codecs };
  });
}

async function inspectRtsp(url) {
  // Deliberately instantiate RtspTalk directly: no TalkManager and no Tenda SDK fallback.
  const client = new RtspTalk(url), replies = [];
  let sdp = '';
  // Observe replies before request() maps camera errors. Header values and the body stay private.
  const consume = client.consume.bind(client), tapped = new WeakSet();
  client.consume = chunk => {
    const pending = client.pending;
    if (pending && !tapped.has(pending)) {
      tapped.add(pending);
      const resolve = pending.resolve;
      pending.resolve = reply => {
        replies.push(reply.code);
        if (reply.headers['content-type']?.includes('application/sdp')) sdp = reply.body;
        resolve(reply);
      };
    }
    consume(chunk);
  };
  try {
    const track = await client.describe();
    return { replies, explicit_backchannel: !!track, codec: track?.codec || null, media: mediaSummary(sdp) };
  } catch (error) { return { replies, ...errorInfo(error), explicit_backchannel: false }; }
  finally { client.close(); }
}

async function inspectCamera(row) {
  const result = { camera_id: row.id, status: row.status, enabled: row.enabled };
  if (!row.enabled) return { ...result, skipped: 'disabled' };
  const rtsp = new URL(row.rtsp_url);
  const endpoint = new URL(row.onvif_url || `http://${rtsp.hostname}/onvif/device_service`);
  const camera = new Cam({
    hostname: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    path: endpoint.pathname, useSecure: endpoint.protocol === 'https:', secureOpts: { rejectUnauthorized: false },
    username: decodeURIComponent(rtsp.username), password: decodeURIComponent(rtsp.password),
    timeout: 3500, preserveAddress: true, autoconnect: false,
  });
  const targets = new Map([['configured', row.rtsp_url]]);
  try {
    await call(camera, 'connect');
    const information = await call(camera, 'getDeviceInformation');
    result.device = { model: information.model, firmware: information.firmwareVersion };
    result.media2 = !!camera.media2Support;
    const profiles = (await call(camera, 'getProfiles')).slice(0, 6);
    result.profiles = profiles.map(profile => ({
      token: profile.$.token, fixed: profile.$.fixed,
      audio_output: config(profile, 'audioOutputConfiguration')?.$?.token || null,
      audio_decoder: config(profile, 'audioDecoderConfiguration')?.$?.token || null,
    }));
    const outputs = await read(camera, 'GetAudioOutputConfigurations');
    result.audio_output_configurations = outputs.error ? outputs : list(outputs.Configurations).map(outputSummary);
    const decoders = await read(camera, 'GetAudioDecoderConfigurations');
    result.audio_decoder_configurations = decoders.error ? decoders : list(decoders.Configurations).map(value => ({ token: value.$?.token }));

    // DeviceIO identifies a physical output, not a media ConfigurationToken.
    if (camera.uri?.deviceIO) {
      const physical = await read(camera, 'GetAudioOutputs', '', 'deviceIO', DEVICE_IO);
      result.device_io = [];
      for (const token of list(physical.Token).slice(0, 4)) {
        if (typeof token !== 'string') continue;
        const data = await read(camera, 'GetAudioOutputConfiguration', `<AudioOutputToken>${escape(token)}</AudioOutputToken>`, 'deviceIO', DEVICE_IO);
        result.device_io.push(data.error ? data : outputSummary(data.AudioOutputConfiguration));
      }
      if (physical.error) result.device_io = physical;
    }
    for (const profile of profiles) {
      try {
        const stream = await call(camera, 'getStreamUri', { protocol: 'RTSP', profileToken: profile.$.token });
        const url = new URL(stream.uri);
        if (url.protocol !== 'rtsp:' || url.hostname !== rtsp.hostname || (url.port || '554') !== (rtsp.port || '554')) continue;
        url.username = rtsp.username; url.password = rtsp.password;
        if (![...targets.values()].includes(url.href)) targets.set(profile.$.token, url.href);
      } catch { /* One unavailable profile does not prevent checking the configured stream. */ }
    }
  } catch (error) { result.onvif = errorInfo(error); }
  result.rtsp = [];
  for (const [profile, url] of targets) result.rtsp.push({ profile, ...await inspectRtsp(url) });
  return result;
}

(async () => {
  try {
    const selected = process.argv.slice(2).map(Number);
    if (selected.length > 16 || selected.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)) throw new Error('Invalid camera IDs');
    const query = selected.length
      ? await pool.query('SELECT id, rtsp_url, onvif_url, enabled, status FROM cameras WHERE id = ANY($1::int[]) ORDER BY id', [selected])
      : await pool.query('SELECT id, rtsp_url, onvif_url, enabled, status FROM cameras ORDER BY id LIMIT 64');
    const cameras = [];
    for (const row of query.rows) {
      try { cameras.push(await inspectCamera(row)); }
      catch (error) { cameras.push({ camera_id: row.id, ...errorInfo(error) }); }
    }
    console.log(JSON.stringify({ version: 1, read_only: true, sdk_used: false, audio_sent: false, generated_at: new Date().toISOString(), cameras }, null, 2));
  } finally { await pool.end(); }
})().catch(() => { console.error('ONVIF diagnostic failed; check connectivity and camera IDs.'); process.exitCode = 1; });
