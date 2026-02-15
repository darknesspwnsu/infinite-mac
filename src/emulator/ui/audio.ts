import {
    type EmulatorAudioProcessorOptions,
    type EmulatorWorkerAudioConfig,
    type EmulatorWorkerFallbackAudioConfig,
    type EmulatorWorkerSharedMemoryAudioConfig,
} from "@/emulator/common/common";
import audioWorkletPath from "@/emulator/emulator-audio-worklet?worker&url";
import {type EmulatorInput} from "@/emulator/ui/input";
import {RingBuffer} from "ringbuf.js";

export interface EmulatorAudioDelegate {
    emulatorAudioDidOpen?(
        sampleRate: number,
        sampleSize: number,
        channels: number
    ): void;
    emulatorAudioDidRun?(): void;
    emulatorAudioDidBlock?(): void;
    emulatorAudioDidReportActivity?(bytesPerSecond: number): void;
    emulatorAudioDidProbe?(
        probe: {
            bytesPerSecond: number;
            rms: number;
            clipped: boolean;
            source: "shared" | "fallback";
        }
    ): void;
    emulatorAudioDidQueueStats?(
        stats: {
            bufferedMs: number;
            droppedChunks: number;
            mode: "shared" | "fallback";
        }
    ): void;
}

export abstract class EmulatorAudio {
    #input: EmulatorInput;
    #audioContext?: AudioContext;
    #delegate?: EmulatorAudioDelegate;
    #debugInterval?: number;
    #activityInterval?: number;
    #probeInterval?: number;
    #activityBytes = 0;
    #lastReportedBytesPerSecond = 0;
    #audioRunning = false;
    #sampleRate = 0;
    #sampleSize = 0;
    #channels = 0;
    #queueBufferedMs = 0;
    #queueDroppedChunks = 0;
    #analyser?: AnalyserNode;
    #analyserFrame?: Float32Array;
    protected emulatorPlaybackNode?: AudioWorkletNode;

    constructor(input: EmulatorInput, delegate?: EmulatorAudioDelegate) {
        this.#input = input;
        this.#delegate = delegate;
    }

    async init(
        sampleRate: number,
        sampleSize: number,
        channels: number,
        debug: boolean
    ) {
        if (typeof AudioContext === "undefined") {
            console.warn("AudioContext not supported");
            return;
        }
        let verb = "Initializing";
        if (this.#audioContext) {
            verb = "Re-initializing";
            this.stop();
            this.resetAudioBuffer();
        }
        console.log(
            `${verb} audio (sampleRate=${sampleRate}, sampleSize=${sampleSize}, channels=${channels})`
        );
        this.#delegate?.emulatorAudioDidOpen?.(sampleRate, sampleSize, channels);
        this.#sampleRate = sampleRate;
        this.#sampleSize = sampleSize;
        this.#channels = channels;
        this.#audioContext = new AudioContext({
            latencyHint: "interactive",
            sampleRate,
        });
        if (
            !this.#audioContext.audioWorklet ||
            typeof AudioWorkletNode === "undefined"
        ) {
            console.warn("AudioWorklet not supported");
            return;
        }
        await this.#audioContext.audioWorklet.addModule(audioWorkletPath);
        this.emulatorPlaybackNode = new AudioWorkletNode(
            this.#audioContext,
            "emulator-playback-processor",
            {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [channels],
                channelCount: channels,
                processorOptions: {
                    sampleSize,
                    sampleRate,
                    channels,
                    debug,
                    config: this.workerConfig(),
                } as EmulatorAudioProcessorOptions,
            }
        );
        this.emulatorPlaybackNode.port.onmessage = event => {
            if (event.data?.type !== "queue-stats") {
                return;
            }
            const bufferedMs = Number(event.data.bufferedMs);
            const droppedChunks = Number(event.data.droppedChunks);
            if (!Number.isFinite(bufferedMs) || !Number.isFinite(droppedChunks)) {
                return;
            }
            this.#queueBufferedMs = Math.max(0, bufferedMs);
            this.#queueDroppedChunks = Math.max(0, Math.round(droppedChunks));
            this.#delegate?.emulatorAudioDidQueueStats?.({
                bufferedMs: this.#queueBufferedMs,
                droppedChunks: this.#queueDroppedChunks,
                mode: this.probeSource(),
            });
        };
        this.#analyser = this.#audioContext.createAnalyser();
        this.#analyser.fftSize = 1024;
        this.#analyser.smoothingTimeConstant = 0.2;
        this.#analyserFrame = new Float32Array(this.#analyser.fftSize);
        this.emulatorPlaybackNode.connect(this.#analyser);
        this.#analyser.connect(this.#audioContext.destination);

        // We can't start the audio context until there's a user gesture.
        if (this.#audioContext.state === "suspended") {
            window.addEventListener("pointerdown", this.#resumeOnGesture);
            this.#delegate?.emulatorAudioDidBlock?.();
            this.#audioContext?.addEventListener(
                "statechange",
                () => {
                    if (this.#audioContext?.state === "running") {
                        window.removeEventListener(
                            "pointerdown",
                            this.#resumeOnGesture
                        );
                        // Give the audio worklet some time to start processing
                        // before we signal the emulator to start emitting audio,
                        // so that the buffer doesn't get too full.
                        window.setTimeout(
                            () => this.#handleAudioContextRunning(),
                                250
                            );
                    } else if (this.#audioContext?.state === "suspended") {
                        this.#delegate?.emulatorAudioDidBlock?.();
                    }
                },
                {once: false}
            );
            this.#resumeOnGesture(); // Try resuming anyway, in case we get lucky.
        } else {
            this.#handleAudioContextRunning();
        }

        if (debug) {
            this.#debugInterval = window.setInterval(
                () => this.#debugLog(sampleRate, sampleSize, channels),
                100
            );
        }
    }

    #resumeOnGesture = () => {
        this.#audioContext?.resume();
    };

    #handleAudioContextRunning() {
        if (this.#audioRunning) {
            return;
        }
        this.#audioRunning = true;
        this.resetAudioBuffer();
        this.#input.handleInput({type: "audio-context-running"});
        this.#delegate?.emulatorAudioDidRun?.();
        if (this.#delegate?.emulatorAudioDidReportActivity || this.#delegate?.emulatorAudioDidProbe) {
            this.#activityInterval = window.setInterval(() => {
                const bytesPerSecond = this.#activityBytes;
                this.#activityBytes = 0;
                this.#lastReportedBytesPerSecond = bytesPerSecond;
                this.#delegate?.emulatorAudioDidReportActivity?.(bytesPerSecond);
            }, 1000);
        }
        if (this.#delegate?.emulatorAudioDidProbe) {
            this.#probeInterval = window.setInterval(() => {
                const metrics = this.#sampleAudioProbe();
                this.#delegate?.emulatorAudioDidProbe?.({
                    bytesPerSecond: this.#lastReportedBytesPerSecond,
                    rms: metrics.rms,
                    clipped: metrics.clipped,
                    source: this.probeSource(),
                });
            }, 1000);
        }
    }

    requestResume() {
        this.#resumeOnGesture();
    }

    flush(): number {
        const droppedAudioMs =
            this.probeSource() === "fallback"
                ? this.#queueBufferedMs
                : this.#currentBufferedMs();
        this.resetAudioBuffer();
        this.#queueBufferedMs = 0;
        this.#delegate?.emulatorAudioDidQueueStats?.({
            bufferedMs: 0,
            droppedChunks: this.#queueDroppedChunks,
            mode: this.probeSource(),
        });
        return Math.max(0, droppedAudioMs);
    }

    protected reportActivity(byteCount: number) {
        if (byteCount <= 0) {
            return;
        }
        this.#activityBytes += byteCount;
    }

    stop() {
        this.#audioContext?.close();
        window.removeEventListener("pointerdown", this.#resumeOnGesture);
        if (this.#activityInterval) {
            window.clearInterval(this.#activityInterval);
        }
        if (this.#probeInterval) {
            window.clearInterval(this.#probeInterval);
        }
        if (this.#debugInterval) {
            window.clearInterval(this.#debugInterval);
        }
        this.#audioRunning = false;
        this.#activityBytes = 0;
        this.#lastReportedBytesPerSecond = 0;
        this.#queueBufferedMs = 0;
        this.#queueDroppedChunks = 0;
        this.#sampleRate = 0;
        this.#sampleSize = 0;
        this.#channels = 0;
        this.#analyser = undefined;
        this.#analyserFrame = undefined;
    }

    #currentBufferedMs(): number {
        if (!this.#sampleRate || !this.#sampleSize || !this.#channels) {
            return 0;
        }
        const bufferedBytes = this.currentAudioBufferByteLength();
        if (bufferedBytes <= 0) {
            return 0;
        }
        const bytesPerSecond =
            this.#sampleRate * Math.max(1, this.#sampleSize >> 3) * this.#channels;
        if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
            return 0;
        }
        return (bufferedBytes / bytesPerSecond) * 1000;
    }

    #sampleAudioProbe(): {rms: number; clipped: boolean} {
        if (!this.#analyser || !this.#analyserFrame) {
            return {rms: 0, clipped: false};
        }

        this.#analyser.getFloatTimeDomainData(this.#analyserFrame);
        let sumSquares = 0;
        let clipped = false;
        for (const sample of this.#analyserFrame) {
            sumSquares += sample * sample;
            if (!clipped && Math.abs(sample) >= 0.985) {
                clipped = true;
            }
        }

        const rms = Math.sqrt(sumSquares / this.#analyserFrame.length);
        return {rms: Number.isFinite(rms) ? rms : 0, clipped};
    }

    #debugLog(sampleRate: number, sampleSize: number, channels: number) {
        const bufferByteLength = this.currentAudioBufferByteLength();
        if (bufferByteLength === 0) {
            return;
        }
        const bufferSampleLength =
            bufferByteLength / (sampleSize >> 3) / channels;
        const bufferMsLength = (bufferSampleLength / sampleRate) * 1000;
        console.log(
            "audio buffer:",
            ((bufferByteLength / AUDIO_BUFFER_SIZE) * 100).toFixed(1) +
                "% full - ",
            bufferByteLength,
            "bytes - ",
            bufferSampleLength,
            "samples - ",
            bufferMsLength.toFixed(1),
            "ms"
        );
    }

    abstract workerConfig(): EmulatorWorkerAudioConfig;

    protected abstract resetAudioBuffer(): void;
    protected abstract currentAudioBufferByteLength(): number;
    protected abstract probeSource(): "shared" | "fallback";
}

const AUDIO_BUFFER_SIZE = 2 * 22050; // 1 second of 16-bit mono audio at 22050 Hz

export class SharedMemoryEmulatorAudio extends EmulatorAudio {
    #audioBuffer = new SharedArrayBuffer(AUDIO_BUFFER_SIZE);
    #audioRingBuffer = new RingBuffer(this.#audioBuffer, Uint8Array);

    workerConfig(): EmulatorWorkerSharedMemoryAudioConfig {
        return {
            type: "shared-memory",
            audioBuffer: this.#audioBuffer,
        };
    }

    protected resetAudioBuffer() {
        const buffer = new Uint8Array(this.#audioRingBuffer.available_read());
        this.#audioRingBuffer.pop(buffer);
    }

    protected currentAudioBufferByteLength(): number {
        return this.#audioRingBuffer.available_read();
    }

    protected probeSource(): "shared" | "fallback" {
        return "shared";
    }
}

export class FallbackEmulatorAudio extends EmulatorAudio {
    workerConfig(): EmulatorWorkerFallbackAudioConfig {
        return {type: "fallback"};
    }

    handleData(data: Uint8Array) {
        this.emulatorPlaybackNode?.port.postMessage({type: "data", data});
        this.reportActivity(data.byteLength);
    }

    protected resetAudioBuffer() {
        this.emulatorPlaybackNode?.port.postMessage({type: "reset"});
    }

    protected currentAudioBufferByteLength(): number {
        return 0;
    }

    protected probeSource(): "shared" | "fallback" {
        return "fallback";
    }
}
