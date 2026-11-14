class CameraPcmPlayback extends AudioWorkletProcessor {
  constructor() {
    super(); this.channels = new Map(); this.master = 1;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'master') { if (Number.isFinite(data.gain)) this.master = Math.max(0, Math.min(1, data.gain)); return; }
      if (!Number.isSafeInteger(data.cameraId) || data.cameraId < 1) return;
      let channel = this.channels.get(data.cameraId);
      if (!channel) { if (this.channels.size >= 16) return; channel = { data: [], offset: 0, samples: 0, gain: 1, started: false, last: 0 }; this.channels.set(data.cameraId, channel); }
      if (data.type === 'gain') { if (Number.isFinite(data.gain)) channel.gain = Math.max(0, Math.min(1, data.gain)); return; }
      if (data.type !== 'audio' || !(data.pcm instanceof ArrayBuffer) || !data.pcm.byteLength || data.pcm.byteLength % 2 || data.pcm.byteLength > 6400) return;
      const pcm = new Int16Array(data.pcm).subarray(-1600); channel.data.push(pcm); channel.samples += pcm.length;
      while (channel.samples > 1600 && channel.data.length > 1) { const old = channel.data.shift(); channel.samples -= old.length - channel.offset; channel.offset = 0; }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0]?.[0]; if (!output) return true; output.fill(0);
    const active = [...this.channels.values()].filter(channel => channel.gain > 0).length;
    for (const channel of this.channels.values()) {
      if (!channel.started && channel.samples >= 640) channel.started = true;
      for (let n = 0; n < output.length; n++) {
        let value = 0;
        if (channel.started && channel.samples) {
          value = channel.data[0][channel.offset++] / 32768; channel.samples--;
          if (channel.offset === channel.data[0].length) { channel.data.shift(); channel.offset = 0; }
          channel.last = value;
        } else { channel.last *= .94; value = channel.last; if (channel.samples === 0) channel.started = false; }
        output[n] += value * channel.gain * this.master / Math.max(1, active);
      }
    }
    for (let n = 0; n < output.length; n++) output[n] = Math.max(-.95, Math.min(.95, output[n]));
    return true;
  }
}
registerProcessor('camera-pcm-playback', CameraPcmPlayback);
