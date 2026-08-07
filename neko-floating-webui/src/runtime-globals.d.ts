declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(inputs: Float32Array[][]): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: typeof AudioWorkletProcessor,
): void;
