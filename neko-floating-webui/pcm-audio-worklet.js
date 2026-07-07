class NekoPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 4096;
    this.buffer = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.sumSquares = 0;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) {
      for (let channelIndex = 0; channelIndex < output.length; channelIndex++) {
        output[channelIndex].fill(0);
      }
    }

    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) {
      return true;
    }

    for (let i = 0; i < channel.length; i++) {
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      this.sumSquares += clamped * clamped;
      this.buffer[this.offset] = clamped < 0
        ? Math.round(clamped * 32768)
        : Math.round(clamped * 32767);
      this.offset += 1;

      if (this.offset >= this.chunkSize) {
        const pcm16Buffer = this.buffer.buffer;
        const level = Math.sqrt(this.sumSquares / this.chunkSize);
        this.port.postMessage({
          pcm16Buffer,
          sampleRate,
          level
        }, [pcm16Buffer]);
        this.buffer = new Int16Array(this.chunkSize);
        this.offset = 0;
        this.sumSquares = 0;
      }
    }

    return true;
  }
}

registerProcessor('neko-pcm-capture', NekoPcmCaptureProcessor);
