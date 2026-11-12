/** Captures only while the user holds Talk (or explicitly tests the mic).
 * Audio remains in memory; stopping during an unresolved permission prompt
 * also stops any stream returned by the browser afterwards. */
export class Microphone {
  private context?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private stopped = false;

  async start(onAudio: (pcm: ArrayBuffer) => void) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Mở web bằng HTTPS để sử dụng mic.');
    this.context = new AudioContext({ sampleRate: 8000, latencyHint: 'interactive' });
    await this.context.resume();
    if (this.stopped) throw new DOMException('Đã nhả nút nói', 'AbortError');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
    this.stream = stream;
    if (this.stopped) { this.stop(); throw new DOMException('Đã nhả nút nói', 'AbortError'); }
    await this.context.audioWorklet.addModule('/audio/pcm-capture.js');
    if (this.stopped) throw new DOMException('Đã nhả nút nói', 'AbortError');
    this.source = this.context.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.context, 'camera-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = event => { if (!this.stopped && event.data instanceof ArrayBuffer) onAudio(event.data); };
    this.source.connect(this.node); this.node.connect(this.context.destination);
  }

  stop() {
    this.stopped = true;
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node.port.close(); }
    this.source?.disconnect();
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => undefined);
  }
}
