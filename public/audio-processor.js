// AudioWorklet processor for microphone capture.
// Buffers 2048 samples (~128ms at 16kHz) before sending to reduce
// WebSocket message frequency from ~190/sec down to ~8/sec.
class MicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._bufferSize = 2048; // 128ms at 16kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];

    // Accumulate samples into buffer
    for (let i = 0; i < channelData.length; i++) {
      this._buffer.push(channelData[i]);
    }

    // Only send when buffer is full
    if (this._buffer.length >= this._bufferSize) {
      const chunk = new Float32Array(this._buffer.splice(0, this._bufferSize));

      // RMS for interruption detection
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
      const rms = Math.sqrt(sum / chunk.length);

      // Transfer buffer (zero-copy) instead of slice (copy)
      this.port.postMessage(
        { type: "audio", rms, channelData: chunk.buffer },
        [chunk.buffer]
      );
    }

    return true;
  }
}

registerProcessor("microphone-processor", MicrophoneProcessor);
