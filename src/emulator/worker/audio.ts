import {RingBuffer} from "ringbuf.js";
import {
    type EmulatorWorkerFallbackAudioConfig,
    type EmulatorWorkerSharedMemoryAudioConfig,
} from "@/emulator/common/common";

export interface EmulatorWorkerAudio {
    audioBufferSize(): number;
    enqueueAudio(newAudio: Uint8Array): void;
    setAudioFormat?(sampleRate: number, sampleSize: number, channels: number): void;
}

export class SharedMemoryEmulatorWorkerAudio implements EmulatorWorkerAudio {
    #audioRingBuffer: RingBuffer<Uint8Array>;

    constructor(config: EmulatorWorkerSharedMemoryAudioConfig) {
        this.#audioRingBuffer = new RingBuffer(config.audioBuffer, Uint8Array);
    }

    audioBufferSize(): number {
        return this.#audioRingBuffer.available_read();
    }

    enqueueAudio(newAudio: Uint8Array): void {
        const availableWrite = this.#audioRingBuffer.available_write();
        if (availableWrite < newAudio.byteLength) {
            console.warn(
                `Audio buffer cannot fit new audio (${newAudio.byteLength} bytes), only ${availableWrite} bytes available.`
            );
            return;
        }

        this.#audioRingBuffer.push(newAudio);
    }
}

export type EmulatorWorkerAudioFallbackSender = (data: Uint8Array) => void;

export class FallbackEmulatorWorkerAudio implements EmulatorWorkerAudio {
    #sender: EmulatorWorkerAudioFallbackSender;
    #bytesPerSecond = 22050 * 2 * 4;
    #estimatedBufferedBytes = 0;
    #lastEstimateAt = performance.now();

    constructor(
        config: EmulatorWorkerFallbackAudioConfig,
        sender: EmulatorWorkerAudioFallbackSender
    ) {
        this.#sender = sender;
    }

    setAudioFormat(sampleRate: number, sampleSize: number, channels: number): void {
        const bytesPerSecond = sampleRate * Math.max(1, sampleSize >> 3) * channels;
        if (Number.isFinite(bytesPerSecond) && bytesPerSecond > 0) {
            this.#bytesPerSecond = bytesPerSecond;
        }
    }

    #drainEstimate() {
        const now = performance.now();
        const elapsedSeconds = (now - this.#lastEstimateAt) / 1000;
        this.#lastEstimateAt = now;
        if (elapsedSeconds <= 0 || this.#estimatedBufferedBytes <= 0) {
            return;
        }
        const drained = Math.floor(this.#bytesPerSecond * elapsedSeconds);
        this.#estimatedBufferedBytes = Math.max(0, this.#estimatedBufferedBytes - drained);
    }

    audioBufferSize(): number {
        this.#drainEstimate();
        return this.#estimatedBufferedBytes;
    }

    enqueueAudio(newAudio: Uint8Array): number {
        this.#drainEstimate();
        // Can't send the Wasm memory directly, need to make a copy. It's net
        // neutral because we can use a Transferable for it.
        this.#sender(new Uint8Array(newAudio));
        this.#estimatedBufferedBytes += newAudio.byteLength;
        return newAudio.length;
    }
}
