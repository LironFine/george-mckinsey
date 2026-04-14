// AudioWorklet processor for microphone capture.
// Replaces the deprecated ScriptProcessorNode.
class MicrophoneProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];

    // RMS calculation for interruption detection
    let sum = 0;
    for (let i = 0; i < channelData.length; i++) {
      sum += channelData[i] * channelData[i];
    }
    const rms = Math.sqrt(sum / channelData.length);

    this.port.postMessage({
      type: "audio",
      rms,
      // Transfer the buffer for zero-copy performance
      channelData: channelData.slice(),
    });

    return true;
  }
}

registerProcessor("microphone-processor", MicrophoneProcessor);
