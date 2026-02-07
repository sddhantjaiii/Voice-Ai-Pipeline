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
 * 
 * iOS Strategy:
 * - Collect ALL MP3 chunks (partial MP3 fails decodeAudioData on Safari)
 * - On finalize, combine into complete MP3 and decode via Web Audio API
 * - If decodeAudioData fails, fall back to HTMLAudioElement with Blob URL
 * - AudioContext is unlocked once during user gesture, stays unlocked forever
 */
export class AudioPlayer {
  private useMediaSource: boolean;
  
  // MediaSource implementation (Chrome, Firefox, etc.)
  private audioElement: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  
  // iOS implementation
  // Primary: Web Audio API (AudioContext stays unlocked after initial gesture)
  // Fallback: HTMLAudioElement with Blob URL (unlocked during gesture)
  private iosAudioContext: AudioContext | null = null;
  private iosGainNode: GainNode | null = null;
  private iosCurrentSource: AudioBufferSourceNode | null = null;
  private iosUnlockedAudio: HTMLAudioElement | null = null; // Fallback element
  private iosRawChunks: Uint8Array[] = []; // Raw decoded bytes (not base64)
  private iosTotalBytes = 0;
  
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
   * Unlock iOS audio during a user gesture (tap/click).
   * Must be called from a direct user interaction event handler.
   * 
   * Creates:
   * 1. AudioContext (stays unlocked forever after resume)
   * 2. HTMLAudioElement that plays silent audio (fallback, also stays unlocked)
   */
  async unlockIOSAudio(): Promise<void> {
    if (this.useMediaSource) return;
    
    // Unlock AudioContext (primary playback path)
    if (!this.iosAudioContext || this.iosAudioContext.state !== 'running') {
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        this.iosAudioContext = new AudioContextClass();
        
        if (this.iosAudioContext.state === 'suspended') {
          await this.iosAudioContext.resume();
        }
        
        this.iosGainNode = this.iosAudioContext.createGain();
        this.iosGainNode.gain.value = 1.0;
        this.iosGainNode.connect(this.iosAudioContext.destination);
        
        // Play silent buffer to fully activate audio path
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
    
    // Also unlock an HTMLAudioElement as fallback
    // (in case decodeAudioData fails with this MP3 format)
    // Don't await this - let it happen in background to avoid blocking mic permission
    if (!this.iosUnlockedAudio) {
      (async () => {
        try {
          const audio = new Audio();
          audio.setAttribute('playsinline', '');
          audio.setAttribute('webkit-playsinline', '');
          // Shortest valid MP3 - plays ~0ms of silence
          audio.src = 'data:audio/mpeg;base64,/+NIxAAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
          await audio.play();
          this.iosUnlockedAudio = audio;
          console.log('🔓 iOS HTMLAudioElement unlocked (fallback)');
        } catch (e) {
          console.warn('⚠️ iOS HTMLAudioElement unlock failed:', e);
        }
      })();
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
      // iOS: stop current playback and clear accumulated chunks
      if (this.iosCurrentSource) {
        try { this.iosCurrentSource.stop(); } catch (e) { /* ignore */ }
        this.iosCurrentSource = null;
      }
      if (this.iosUnlockedAudio) {
        this.iosUnlockedAudio.pause();
        this.iosUnlockedAudio.removeAttribute('src');
      }
      this.iosRawChunks = [];
      this.iosTotalBytes = 0;
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
      // iOS: Decode base64 and store raw bytes
      // We MUST collect ALL chunks before playing — iOS Safari's decodeAudioData()
      // cannot handle partial/truncated MP3 streams (fails with "Decoding failed").
      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      this.iosRawChunks.push(bytes);
      this.iosTotalBytes += bytes.length;
      
      // Mark as playing immediately to prevent premature turn completion
      if (!this.isPlaying) {
        this.isPlaying = true;
      }
    }
  }

  finalize(): void {
    this.isFinalized = true;
    console.log(`🎧 FINALIZE: useMediaSource=${this.useMediaSource}, chunks=${this.iosRawChunks.length}, bytes=${this.iosTotalBytes}, isPlaying=${this.isPlaying}`);
    
    if (this.useMediaSource) {
      this.flushQueue();
    } else {
      // iOS: Now we have the COMPLETE MP3 stream — play it
      if (this.iosRawChunks.length > 0) {
        this.playCompleteIOSAudio();
      } else {
        this.isPlaying = false;
        if (this.onComplete) this.onComplete();
      }
    }
  }
  
  /**
   * Play the complete MP3 audio on iOS.
   * Strategy:
   * 1. Try Web Audio API (decodeAudioData) — works without user gesture
   * 2. If fails, try HTMLAudioElement with Blob URL — needs unlocked element
   */
  private async playCompleteIOSAudio(): Promise<void> {
    // Combine all chunks into one ArrayBuffer
    const combinedBytes = new Uint8Array(this.iosTotalBytes);
    let offset = 0;
    for (const chunk of this.iosRawChunks) {
      combinedBytes.set(chunk, offset);
      offset += chunk.length;
    }
    
    // Log first bytes for debugging (MP3 should start with 0xFF 0xFB or ID3 header)
    const header = Array.from(combinedBytes.slice(0, 4)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
    console.log(`🎧 iOS: Complete MP3: ${this.iosRawChunks.length} chunks, ${this.iosTotalBytes} bytes, header: [${header}]`);
    
    // Clear chunks to free memory
    this.iosRawChunks = [];
    this.iosTotalBytes = 0;
    
    // Attempt 1: Web Audio API (preferred — no gesture needed)
    if (this.iosAudioContext && this.iosAudioContext.state === 'running') {
      try {
        console.log('🎧 iOS: Trying decodeAudioData...');
        const arrayBuffer = combinedBytes.buffer.slice(
          combinedBytes.byteOffset,
          combinedBytes.byteOffset + combinedBytes.byteLength
        );
        
        const audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
          // Use callback API for maximum Safari compatibility
          this.iosAudioContext!.decodeAudioData(
            arrayBuffer,
            (buffer) => resolve(buffer),
            (err) => reject(err)
          );
        });
        
        console.log(`🎧 iOS: ✅ Decoded: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz`);
        
        const source = this.iosAudioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.iosGainNode || this.iosAudioContext.destination);
        this.iosCurrentSource = source;
        
        source.addEventListener('ended', () => {
          console.log('🎧 iOS: Web Audio playback complete');
          this.iosCurrentSource = null;
          this.isPlaying = false;
          if (this.onComplete) this.onComplete();
        });
        
        source.start(0);
        console.log('🎧 iOS: ▶️ Playing via Web Audio API');
        return; // Success!
        
      } catch (e: any) {
        console.warn(`🎧 iOS: decodeAudioData failed: ${e.message || e}, trying HTMLAudioElement fallback...`);
      }
    }
    
    // Attempt 2: HTMLAudioElement with Blob URL (fallback)
    try {
      console.log('🎧 iOS: Trying HTMLAudioElement fallback...');
      const blob = new Blob([combinedBytes], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      
      // Use the unlocked audio element if available, otherwise create new
      const audio = this.iosUnlockedAudio || new Audio();
      audio.setAttribute('playsinline', '');
      audio.setAttribute('webkit-playsinline', '');
      audio.src = url;
      
      audio.addEventListener('ended', () => {
        console.log('🎧 iOS: HTMLAudioElement playback complete');
        URL.revokeObjectURL(url);
        this.isPlaying = false;
        if (this.onComplete) this.onComplete();
      }, { once: true });
      
      audio.addEventListener('error', () => {
        console.error('🎧 iOS: HTMLAudioElement error:', audio.error?.message);
        URL.revokeObjectURL(url);
        this.isPlaying = false;
        if (this.onComplete) this.onComplete();
      }, { once: true });
      
      await audio.play();
      console.log('🎧 iOS: ▶️ Playing via HTMLAudioElement');
      
    } catch (e: any) {
      console.error('🎧 iOS: All playback methods failed:', e.message);
      this.isPlaying = false;
      if (this.onComplete) this.onComplete();
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
      // iOS: stop any active playback and clear chunks
      if (this.iosCurrentSource) {
        try { this.iosCurrentSource.stop(); } catch (e) { /* ignore */ }
        this.iosCurrentSource = null;
      }
      if (this.iosUnlockedAudio) {
        this.iosUnlockedAudio.pause();
        this.iosUnlockedAudio.removeAttribute('src');
      }
      this.iosRawChunks = [];
      this.iosTotalBytes = 0;
      this.isPlaying = false;
      // Do NOT close iosAudioContext — it stays unlocked for reuse
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
    return this.useMediaSource ? this.queue.length : this.iosRawChunks.length;
  }
}
