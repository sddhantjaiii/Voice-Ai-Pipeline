/**
 * Audio utilities for microphone capture and playback.
 * Handles WebRTC media streams, PCM encoding, and Web Audio API.
 */

export class AudioRecorder {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private isRecording = false;
  private onAudioData: ((audioData: Float32Array) => void) | null = null;

  /**
   * Start recording from microphone.
   * @param onAudioData Callback for audio chunks (Float32Array PCM)
   */
  async start(onAudioData: (audioData: Float32Array) => void): Promise<void> {
    if (this.isRecording) {
      console.warn('Already recording');
      return;
    }

    this.onAudioData = onAudioData;

    // Request microphone access
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Create audio context (use webkit prefix for older iOS)
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass({ sampleRate: 16000 });
      
      // iOS Safari: AudioContext starts in 'suspended' state, must resume
      if (this.audioContext.state === 'suspended') {
        console.log('AudioContext suspended, attempting to resume...');
        await this.audioContext.resume();
        console.log('AudioContext resumed:', this.audioContext.state);
      }
      
      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Create script processor for audio data
      // Buffer size: 4096 samples = ~256ms @ 16kHz
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (!this.isRecording) return;

        const inputData = e.inputBuffer.getChannelData(0);
        if (this.onAudioData) {
          this.onAudioData(inputData);
        }
      };

      // Connect nodes
      // Note: processor must be connected to destination for onaudioprocess to fire
      // But we use a gain node set to 0 to prevent audio feedback
      this.source.connect(this.processor);
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = 0; // Mute the output to prevent feedback
      this.processor.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      this.isRecording = true;
      console.log('Audio recording started');
    } catch (error) {
      console.error('Failed to start recording:', error);
      throw error;
    }
  }

  /**
   * Stop recording and release resources.
   */
  stop(): void {
    if (!this.isRecording) return;

    this.isRecording = false;

    // Disconnect and cleanup
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    console.log('Audio recording stopped');
  }

  getIsRecording(): boolean {
    return this.isRecording;
  }
}

/**
 * Convert Float32Array PCM to base64-encoded Int16Array (16-bit PCM).
 * Backend expects 16-bit PCM, but microphone gives Float32 (-1.0 to 1.0).
 */
export function float32ToInt16Base64(float32Array: Float32Array): string {
  const int16Array = new Int16Array(float32Array.length);

  for (let i = 0; i < float32Array.length; i++) {
    // Clamp to [-1.0, 1.0] and convert to 16-bit int
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  // Convert to base64
  const bytes = new Uint8Array(int16Array.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Check if MediaSource API is supported (not available on iOS Safari).
 */
function isMediaSourceSupported(): boolean {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');
}

/**
 * Audio player with queue for streaming playback.
 * Handles base64-encoded audio chunks from backend.
 * Uses MediaSource API on supported browsers, falls back to Web Audio API on iOS.
 */
export class AudioPlayer {
  private useMediaSource: boolean;
  
  // MediaSource implementation (Chrome, Firefox, etc.)
  private audioElement: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  
  // Web Audio API implementation for iOS
  // Once AudioContext is resumed from a user gesture, it stays unlocked forever.
  // Unlike HTMLAudioElement.play(), AudioBufferSourceNode.start() does NOT require
  // a new user gesture each time — this is the key insight for reliable iOS audio.
  private iosAudioContext: AudioContext | null = null;
  private iosGainNode: GainNode | null = null;
  private iosCurrentSource: AudioBufferSourceNode | null = null;
  private allChunks: string[] = [];
  
  private isPlaying = false;
  private onComplete: (() => void) | null = null;
  private isFinalized = false;

  constructor() {
    this.useMediaSource = isMediaSourceSupported();
    console.log(`AudioPlayer: Using ${this.useMediaSource ? 'MediaSource API' : 'iOS Web Audio API'}`);
    
    if (this.useMediaSource) {
      this.initMediaSource();
    }
  }

  /**
   * Unlock iOS audio by creating and resuming an AudioContext during user gesture.
   * This is the ONLY reliable way to enable programmatic audio on iOS Safari.
   * Once resumed, the AudioContext stays unlocked for the lifetime of the page.
   */
  async unlockIOSAudio(): Promise<void> {
    if (this.useMediaSource) return;
    if (this.iosAudioContext && this.iosAudioContext.state === 'running') {
      console.log('🔓 iOS AudioContext already unlocked');
      return;
    }
    
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.iosAudioContext = new AudioContextClass();
      
      // Resume must happen during user gesture
      if (this.iosAudioContext.state === 'suspended') {
        await this.iosAudioContext.resume();
      }
      
      // Create a gain node for volume control / muting on stop
      this.iosGainNode = this.iosAudioContext.createGain();
      this.iosGainNode.gain.value = 1.0;
      this.iosGainNode.connect(this.iosAudioContext.destination);
      
      // Play a tiny silent buffer to fully activate the audio path
      const silentBuffer = this.iosAudioContext.createBuffer(1, 1, 22050);
      const silentSource = this.iosAudioContext.createBufferSource();
      silentSource.buffer = silentBuffer;
      silentSource.connect(this.iosAudioContext.destination);
      silentSource.start(0);
      
      console.log(`🔓 iOS AudioContext unlocked: state=${this.iosAudioContext.state}`);
    } catch (e) {
      console.error('⚠️ iOS AudioContext unlock failed:', e);
    }
  }

  private initMediaSource(): void {
    this.audioElement = new Audio();
    this.audioElement.preload = 'auto';
    this.audioElement.addEventListener('ended', () => {
      this.isPlaying = false;
      if (this.onComplete) {
        this.onComplete();
      }
    });

    this.resetStream();
  }

  resetStream(): void {
    this.isPlaying = false;
    this.isFinalized = false;
    
    if (this.useMediaSource) {
      this.queue = [];

      if (this.audioElement) {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;
      }

      if (this.sourceBuffer && this.sourceBuffer.updating) {
        try {
          this.sourceBuffer.abort();
        } catch (e) {
          // ignore
        }
      }

      this.sourceBuffer = null;
      this.mediaSource = new MediaSource();
      if (this.audioElement) {
        this.audioElement.src = URL.createObjectURL(this.mediaSource);
      }

      this.mediaSource.addEventListener('sourceopen', () => {
        if (!this.mediaSource) return;
        try {
          this.sourceBuffer = this.mediaSource.addSourceBuffer('audio/mpeg');
          this.sourceBuffer.mode = 'sequence';
          this.sourceBuffer.addEventListener('updateend', () => {
            this.flushQueue();
            if (this.isFinalized && this.queue.length === 0 && this.sourceBuffer && !this.sourceBuffer.updating) {
              try {
                this.mediaSource?.endOfStream();
              } catch (e) {
                // ignore
              }
            }
          });
        } catch (e) {
          console.error('Failed to create SourceBuffer:', e);
        }
      });
    } else {
      // iOS Web Audio API: clear chunk queue and stop current source
      if (this.iosCurrentSource) {
        try { this.iosCurrentSource.stop(); } catch (e) { /* ignore */ }
        this.iosCurrentSource = null;
      }
      this.allChunks = [];
    }
  }

  /**
   * Add audio chunk to queue and start playback if not already playing.
   * @param base64Audio Base64-encoded audio data (MP3 from ElevenLabs)
   */
  async addChunk(base64Audio: string): Promise<void> {
    if (!base64Audio) return;

    if (this.useMediaSource) {
      if (!this.mediaSource) return;
      
      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      this.queue.push(bytes);
      this.flushQueue();

      if (!this.isPlaying && this.audioElement) {
        try {
          await this.audioElement.play();
          this.isPlaying = true;
        } catch (e) {
          console.warn('Audio playback failed to start:', e);
        }
      }
    } else {
      // iOS Web Audio API: collect chunks
      this.allChunks.push(base64Audio);
      
      // Start playback early after buffering ~1 second of audio (first 3 chunks)
      const EARLY_PLAY_CHUNKS = 3;
      if (this.allChunks.length === EARLY_PLAY_CHUNKS && !this.isPlaying) {
        console.log(`🎧 iOS: Early play after ${EARLY_PLAY_CHUNKS} chunks`);
        this.isPlaying = true;
        this.scheduleIOSPlayback();
      }
    }
  }

  private iosPlaybackScheduled = false;
  
  private scheduleIOSPlayback(): void {
    if (this.iosPlaybackScheduled) return;
    this.iosPlaybackScheduled = true;
    this.playNextIOSBatch();
  }
  
  private async playNextIOSBatch(): Promise<void> {
    if (this.allChunks.length === 0) {
      if (!this.isFinalized) {
        // Wait a bit for more chunks to arrive
        setTimeout(() => this.playNextIOSBatch(), 200);
        return;
      }
      console.log('🎧 iOS: All playback complete');
      this.isPlaying = false;
      this.iosPlaybackScheduled = false;
      if (this.onComplete) {
        this.onComplete();
      }
      return;
    }
    
    // Take all current chunks and play them as one batch
    const chunksToPlay = [...this.allChunks];
    this.allChunks = [];
    
    console.log(`🎧 iOS: Playing batch of ${chunksToPlay.length} chunks`);
    await this.playIOSChunksWebAudio(chunksToPlay);
  }

  finalize(): void {
    this.isFinalized = true;
    console.log(`🎧 FINALIZE: useMediaSource=${this.useMediaSource}, chunks=${this.allChunks.length}, isPlaying=${this.isPlaying}`);
    
    if (this.useMediaSource) {
      this.flushQueue();
    } else {
      // iOS: If not already playing (short responses < 3 chunks), start now
      if (!this.isPlaying && this.allChunks.length > 0) {
        console.log('🎧 iOS: Starting playback on finalize (short response)');
        this.isPlaying = true;
        this.scheduleIOSPlayback();
      }
      // If already playing, playNextIOSBatch will handle remaining chunks
    }
  }
  
  /**
   * Play MP3 chunks using Web Audio API (decodeAudioData + AudioBufferSourceNode).
   * This does NOT require a user gesture — only AudioContext.resume() does,
   * and that was already called during the initial tap.
   */
  private async playIOSChunksWebAudio(chunks: string[]): Promise<void> {
    if (chunks.length === 0) {
      this.playNextIOSBatch();
      return;
    }

    if (!this.iosAudioContext || this.iosAudioContext.state !== 'running') {
      console.error('🎧 iOS: AudioContext not available or not running!', 
        this.iosAudioContext?.state);
      // Try to resume it
      if (this.iosAudioContext && this.iosAudioContext.state === 'suspended') {
        try {
          await this.iosAudioContext.resume();
          console.log('🎧 iOS: AudioContext resumed');
        } catch (e) {
          console.error('🎧 iOS: Failed to resume AudioContext:', e);
          this.isPlaying = false;
          this.iosPlaybackScheduled = false;
          if (this.onComplete) this.onComplete();
          return;
        }
      }
    }

    try {
      // Decode base64 chunks and combine into one ArrayBuffer
      const decodedChunks: Uint8Array[] = [];
      let totalLength = 0;
      
      for (const base64Chunk of chunks) {
        const binaryString = atob(base64Chunk);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        decodedChunks.push(bytes);
        totalLength += bytes.length;
      }
      
      const combinedBytes = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of decodedChunks) {
        combinedBytes.set(chunk, offset);
        offset += chunk.length;
      }
      
      console.log(`🎧 iOS: Decoding ${chunks.length} chunks, ${totalLength} bytes via Web Audio API`);
      
      // Decode MP3 → AudioBuffer (this is the magic — works without user gesture)
      const audioBuffer = await this.iosAudioContext!.decodeAudioData(
        combinedBytes.buffer.slice(0) // Must pass a copy, decodeAudioData detaches the buffer
      );
      
      console.log(`🎧 iOS: Decoded to AudioBuffer: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz`);
      
      // Create a source node and play it
      const source = this.iosAudioContext!.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.iosGainNode || this.iosAudioContext!.destination);
      this.iosCurrentSource = source;
      
      // When this batch ends, play the next one
      source.addEventListener('ended', () => {
        this.iosCurrentSource = null;
        this.playNextIOSBatch();
      });
      
      source.start(0);
      console.log('🎧 iOS: ▶️ Playing via Web Audio API');
      
    } catch (e: any) {
      console.error('🎧 iOS: Web Audio playback failed:', e.message);
      // Try next batch despite error
      this.iosCurrentSource = null;
      this.playNextIOSBatch();
    }
  }

  private flushQueue(): void {
    if (!this.sourceBuffer || !this.mediaSource) return;
    if (this.sourceBuffer.updating) return;
    if (this.queue.length === 0) return;

    const next = this.queue.shift()!;
    try {
      const buffer = next.buffer.slice(next.byteOffset, next.byteOffset + next.byteLength) as ArrayBuffer;
      this.sourceBuffer.appendBuffer(buffer);
    } catch (e) {
      console.error('Failed to append audio buffer:', e);
    }
  }

  /**
   * Stop playback immediately and clear queue.
   * Does NOT trigger onComplete callback.
   */
  stop(): void {
    if (this.useMediaSource) {
      this.resetStream();
    } else {
      // iOS Web Audio: stop current source and clear queue
      if (this.iosCurrentSource) {
        try { this.iosCurrentSource.stop(); } catch (e) { /* ignore */ }
        this.iosCurrentSource = null;
      }
      this.allChunks = [];
      this.isPlaying = false;
      this.iosPlaybackScheduled = false;
      // Note: Do NOT close iosAudioContext — it stays unlocked for reuse
    }
  }

  /**
   * Set callback for when playback completes.
   */
  setOnComplete(callback: () => void): void {
    this.onComplete = callback;
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  getQueueLength(): number {
    return this.useMediaSource ? this.queue.length : this.allChunks.length;
  }
}
