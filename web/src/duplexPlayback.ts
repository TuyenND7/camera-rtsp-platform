/** Feed decoded camera audio through a local WebRTC remote track. This gives
 * browser echo cancellation its standard far-end reference. SDP/ICE stay in
 * this page; no TURN service, public port, or extra credentials are needed. */
export class DuplexPlayback {
  private node?: AudioWorkletNode;
  private destination?: MediaStreamAudioDestinationNode;
  private sender?: RTCPeerConnection;
  private receiver?: RTCPeerConnection;
  private audio?: HTMLAudioElement;
  private stopped = false;
  private cancel?: (error: Error) => void;
  constructor(private context: AudioContext, private onError: (message: string) => void) {}

  async start() {
    await this.context.audioWorklet.addModule('/audio/pcm-playback.js');
    if (this.stopped) throw new DOMException('Đã dừng đàm thoại', 'AbortError');
    this.node = new AudioWorkletNode(this.context, 'camera-pcm-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    this.destination = this.context.createMediaStreamDestination(); this.destination.channelCount = 1; this.node.connect(this.destination);
    const sender = this.sender = new RTCPeerConnection({ iceServers: [] }), receiver = this.receiver = new RTCPeerConnection({ iceServers: [] });
    const audio = this.audio = document.createElement('audio'); audio.autoplay = true;
    const toSender: RTCIceCandidate[] = [], toReceiver: RTCIceCandidate[] = [];
    const transfer = (peer: RTCPeerConnection, queue: RTCIceCandidate[], candidate: RTCIceCandidate | null) => {
      if (!candidate || this.stopped) return;
      if (!peer.remoteDescription) queue.push(candidate);
      else void peer.addIceCandidate(candidate).catch(() => { if (!this.stopped) this.onError('Kênh nghe hai chiều bị gián đoạn.'); });
    };
    sender.onicecandidate = event => transfer(receiver, toReceiver, event.candidate);
    receiver.onicecandidate = event => transfer(sender, toSender, event.candidate);
    let checkReady = () => {};
    const changed = () => {
      if (!this.stopped && [sender.connectionState, receiver.connectionState].includes('failed')) this.onError('Chưa mở được kênh nghe hai chiều trên thiết bị này.');
      checkReady();
    };
    sender.onconnectionstatechange = changed; receiver.onconnectionstatechange = changed;
    let timer: number | undefined;
    const connected = new Promise<void>((resolve, reject) => {
      this.cancel = reject;
      timer = window.setTimeout(() => reject(new Error('Kênh nghe hai chiều chưa sẵn sàng.')), 10000);
      checkReady = () => { if (!this.stopped && receiver.connectionState === 'connected' && audio.srcObject) resolve(); };
      receiver.ontrack = event => {
        if (this.stopped) { event.track.stop(); return; }
        audio.srcObject = new MediaStream([event.track]);
        // play() can wait for audible RTP. Do not gate the incoming PCM fetch
        // on it: quiet cameras and Opus DTX may otherwise delay each other.
        void audio.play().catch(() => { if (!this.stopped) this.onError('Trình duyệt chưa cho phép phát tiếng đàm thoại. Nhấn mic để thử lại.'); });
        checkReady();
      };
    });
    // Attach a rejection handler while asynchronous SDP operations are running.
    void connected.catch(() => undefined);
    try {
      for (const track of this.destination.stream.getAudioTracks()) sender.addTrack(track, this.destination.stream);
      await sender.setLocalDescription(await sender.createOffer());
      if (this.stopped) throw new DOMException('Đã dừng đàm thoại', 'AbortError');
      await receiver.setRemoteDescription(sender.localDescription!);
      for (const candidate of toReceiver.splice(0)) await receiver.addIceCandidate(candidate);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await sender.setRemoteDescription(receiver.localDescription!);
      for (const candidate of toSender.splice(0)) await sender.addIceCandidate(candidate);
      await connected;
    } finally { window.clearTimeout(timer); this.cancel = undefined; }
  }
  push(cameraId: number, pcm: ArrayBuffer) { if (!this.stopped) this.node?.port.postMessage({ type: 'audio', cameraId, pcm }, [pcm]); }
  gain(cameraId: number, gain: number) { this.node?.port.postMessage({ type: 'gain', cameraId, gain }); }
  volume(gain: number) { this.node?.port.postMessage({ type: 'master', gain }); }
  stop() {
    if (this.stopped) return; this.stopped = true; this.cancel?.(new DOMException('Đã dừng đàm thoại', 'AbortError'));
    this.sender?.close(); this.receiver?.close(); this.node?.disconnect(); this.node?.port.close();
    this.destination?.stream.getTracks().forEach(track => track.stop());
    if (this.audio) { this.audio.pause(); (this.audio.srcObject as MediaStream | null)?.getTracks().forEach(track => track.stop()); this.audio.srcObject = null; }
  }
}
