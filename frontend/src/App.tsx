import { useState, useEffect, useRef } from 'react';
import type { TurnState, ConnectionStatus, ServerMessage } from './types';
import { AudioRecorder, AudioPlayer, float32ToInt16Base64 } from './audioUtils';
import DebugPanel from './DebugPanel';

// Frontend version for deployment tracking
const VERSION = 'v1.0.3-web-audio-api';

function App() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [currentState, setCurrentState] = useState<TurnState>('IDLE');
  const [sessionId, setSessionId] = useState<string>('');
  const [isRecording, setIsRecording] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [agentResponse, setAgentResponse] = useState('');
  const [error, setError] = useState<string>('');
  const [logs, setLogs] = useState<{timestamp: Date, type: 'partial' | 'final' | 'agent' | 'state', content: string}[]>([]);
  const [silenceDebounceMs, setSilenceDebounceMs] = useState(400);
  const [showSettings, setShowSettings] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [testInput, setTestInput] = useState('');

  // Refs for audio and WebSocket
  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);

  // WebSocket URL from environment
  const wsUrl = import.meta.env.VITE_WEBSOCKET_URL || 'ws://localhost:8000/ws/voice';

  // Unlock audio on iOS with user interaction
  // iOS Safari requires AudioContext.resume() from a user gesture.
  // AudioPlayer.unlockIOSAudio() creates & resumes an AudioContext that stays
  // unlocked forever — all subsequent AudioBufferSourceNode.start() calls work.
  const unlockAudio = async () => {
    if (audioUnlocked) return;
    
    try {
      // AudioPlayer handles the AudioContext creation and unlock
      if (playerRef.current) {
        await playerRef.current.unlockIOSAudio();
      }
      
      console.log('✅ iOS Audio unlocked successfully');
      setAudioUnlocked(true);
    } catch (e) {
      console.warn('⚠️ Audio unlock failed:', e);
      setAudioUnlocked(true);
    }
  };

  // Initialize audio player
  useEffect(() => {
    playerRef.current = new AudioPlayer();
    
    // Set callback for when audio playback completes
    playerRef.current.setOnComplete(() => {
      console.log('Audio playback complete - notifying backend');
      wsRef.current?.send(JSON.stringify({
        type: 'playback_complete',
        data: {
          timestamp: Date.now(),
        },
      }));
    });
    
    return () => {
      playerRef.current?.stop();
    };
  }, []);

  const handleUpdateSettings = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'update_settings',
        data: {
          silence_debounce_ms: silenceDebounceMs,
        },
      }));
      console.log('Settings updated:', { silence_debounce_ms: silenceDebounceMs });
    }
  };

  const handleConnect = () => {
    // Unlock audio on iOS first
    unlockAudio();
    
    setConnectionStatus('connecting');
    setError('');
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnectionStatus('connected');
      
      // Send connect message
      ws.send(JSON.stringify({
        type: 'connect',
        data: {}
      }));
    };

    ws.onmessage = (event) => {
      const message: ServerMessage = JSON.parse(event.data);
      console.log('>>> RECV:', message.type, JSON.stringify(message.data).substring(0, 100));

      switch (message.type) {
        case 'session_ready':
          setSessionId(message.data.session_id);
          console.log('Session ready:', message.data.session_id);
          break;
        
        case 'state_change':
          const fromState = message.data.from_state;
          const toState = message.data.to_state;
          setCurrentState(toState);
          console.log('State:', fromState, '->', toState);
          setLogs(prev => [...prev, {timestamp: new Date(), type: 'state', content: `State: ${fromState} → ${toState}`}]);
          
          // If transitioning from SPEAKING to LISTENING, user interrupted - stop audio
          if (fromState === 'SPEAKING' && toState === 'LISTENING') {
            console.log('User interrupted - stopping audio playback');
            playerRef.current?.stop();
          }
          
          // Clear transcripts when a new turn starts
          if (fromState === 'IDLE' && toState === 'LISTENING') {
            setFinalTranscript('');
            setPartialTranscript('');
            setAgentResponse('');
          }
          break;
        
        case 'transcript_partial':
          setPartialTranscript(message.data.text);
          setLogs(prev => [...prev, {timestamp: new Date(), type: 'partial', content: message.data.text}]);
          break;
        
        case 'transcript_final':
          setFinalTranscript(prev => prev ? `${prev} ${message.data.text}` : message.data.text);
          setPartialTranscript('');
          setLogs(prev => [...prev, {timestamp: new Date(), type: 'final', content: `[FINAL] ${message.data.text}`}]);
          break;
        
        case 'agent_audio_chunk':
          console.log(`🔊 AUDIO CHUNK #${message.data.chunk_index} final=${message.data.is_final} len=${message.data.audio?.length || 0}`);
          if (message.data.chunk_index === 0) {
            console.log('🔊 Resetting audio stream');
            playerRef.current?.resetStream();
          }
          if (message.data.audio && !message.data.is_final) {
            playerRef.current?.addChunk(message.data.audio);
          }
          if (message.data.is_final) {
            console.log('🔊 FINALIZE - starting playback');
            playerRef.current?.finalize();
          }
          break;
        
        case 'agent_text_fallback':
          setAgentResponse(message.data.text);
          setError(`TTS failed: ${message.data.reason}`);
          break;
        
        case 'turn_complete':
          console.log('Turn complete:', message.data);
          setAgentResponse(message.data.agent_text);
          setLogs(prev => [...prev, {timestamp: new Date(), type: 'agent', content: `[AGENT] ${message.data.agent_text}`}]);
          break;
        
        case 'error':
          console.error('Error:', message.data.message);
          setError(message.data.message);
          break;
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setConnectionStatus('disconnected');
      setError('WebSocket connection failed');
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setConnectionStatus('disconnected');
      setSessionId('');
      handleStopRecording();
    };
  };

  const handleStartRecording = async () => {
    // Unlock audio on iOS first — MUST await so it happens within gesture context
    await unlockAudio();
    
    if (!wsRef.current || connectionStatus !== 'connected') {
      setError('Not connected to server');
      return;
    }

    try {
      const recorder = new AudioRecorder();
      recorderRef.current = recorder;

      let chunkCount = 0;
      await recorder.start((audioData: Float32Array) => {
        // Convert to base64 PCM and send to backend
        const audioBase64 = float32ToInt16Base64(audioData);
        chunkCount++;
        // Only log every 20th chunk to reduce noise
        if (chunkCount % 20 === 1) {
          console.log(`[MIC] Chunk #${chunkCount} sent`);
        }
        
        wsRef.current?.send(JSON.stringify({
          type: 'audio_chunk',
          data: {
            audio: audioBase64,
            format: 'pcm',
            sample_rate: 16000,
          },
        }));
      });

      setIsRecording(true);
      setError('');
      console.log('Recording started');
    } catch (err) {
      console.error('Failed to start recording:', err);
      setError('Microphone access denied');
    }
  };

  const handleStopRecording = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setIsRecording(false);
    console.log('Recording stopped');
  };

  const handleTextSubmit = () => {
    if (!testInput.trim() || !wsRef.current) return;
    
    const text = testInput.trim();
    
    // Display in UI
    setFinalTranscript(text);
    setPartialTranscript('');
    setLogs(prev => [...prev, {timestamp: new Date(), type: 'final', content: `[TEXT MODE] ${text}`}]);
    
    // Send to backend as text_input message type
    wsRef.current.send(JSON.stringify({
      type: 'text_input',
      data: {
        text: text,
      },
    }));
    
    console.log('Text mode: Sent to backend:', text);
    
    // Clear input
    setTestInput('');
  };

  const handleInterrupt = () => {
    // Stop agent audio
    playerRef.current?.stop();
    
    // Send interrupt message
    wsRef.current?.send(JSON.stringify({
      type: 'interrupt',
      data: {
        timestamp: Date.now(),
      },
    }));
    
    console.log('Interrupted agent');
  };

  const handleDisconnect = () => {
    handleStopRecording();
    playerRef.current?.stop();
    
    wsRef.current?.send(JSON.stringify({
      type: 'disconnect',
      data: {},
    }));
    
    wsRef.current?.close();
    wsRef.current = null;
  };

  const getStateColor = (state: TurnState): string => {
    switch (state) {
      case 'IDLE':
        return '#9ca3af';
      case 'LISTENING':
        return '#3b82f6';
      case 'SPECULATIVE':
        return '#f59e0b';
      case 'COMMITTED':
        return '#8b5cf6';
      case 'SPEAKING':
        return '#22c55e';
      default:
        return '#6b7280';
    }
  };

  const getConnectionStatusColor = (status: ConnectionStatus): string => {
    switch (status) {
      case 'connected':
        return '#22c55e';
      case 'connecting':
        return '#f59e0b';
      case 'disconnected':
        return '#ef4444';
      default:
        return '#6b7280';
    }
  };

  return (
    <div style={{ 
      maxWidth: '900px', 
      margin: '0 auto', 
      padding: '2rem',
    }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ 
          fontSize: '2rem', 
          fontWeight: '700', 
          marginBottom: '0.5rem',
          color: '#111827',
        }}>
          Voice AI Pipeline <span style={{ 
            fontSize: '0.875rem', 
            color: '#10b981',
            fontWeight: '500',
            backgroundColor: '#d1fae5',
            padding: '0.25rem 0.5rem',
            borderRadius: '4px',
            marginLeft: '0.5rem'
          }}>
            {VERSION}
          </span>
        </h1>
        <p style={{ fontSize: '1rem', color: '#6b7280' }}>
          Real-time voice agent with deterministic state machine
        </p>
      </header>

      {/* Connection Panel */}
      <div style={{
        backgroundColor: '#f9fafb',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        padding: '1.5rem',
        marginBottom: '2rem',
      }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1rem' }}>
          Connection
        </h2>
        
        {/* iOS Audio Warning */}
        {!audioUnlocked && /iPad|iPhone|iPod/.test(navigator.userAgent) && (
          <div style={{
            backgroundColor: '#fef3c7',
            border: '1px solid #fbbf24',
            borderRadius: '6px',
            padding: '0.75rem',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            color: '#92400e',
          }}>
            🔊 <strong>iOS detected:</strong> Tap "Connect" or "Start Speaking" to enable audio playback.
          </div>
        )}
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
          <div style={{
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            backgroundColor: getConnectionStatusColor(connectionStatus),
          }} />
          <span style={{ fontWeight: '500', textTransform: 'capitalize' }}>
            {connectionStatus}
          </span>
        </div>

        {sessionId && (
          <div style={{ marginBottom: '1rem', fontSize: '0.875rem', color: '#6b7280' }}>
            Session: <code style={{ 
              backgroundColor: '#e5e7eb', 
              padding: '0.25rem 0.5rem', 
              borderRadius: '4px',
              fontFamily: 'monospace',
              fontSize: '0.75rem',
            }}>
              {sessionId.substring(0, 8)}...
            </code>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={handleConnect}
            disabled={connectionStatus === 'connected' || connectionStatus === 'connecting'}
            style={{
              backgroundColor: connectionStatus === 'connected' ? '#d1d5db' : '#3b82f6',
              color: 'white',
              padding: '0.5rem 1.5rem',
              borderRadius: '6px',
              border: 'none',
              fontSize: '1rem',
              fontWeight: '500',
              cursor: connectionStatus === 'connected' ? 'not-allowed' : 'pointer',
              opacity: connectionStatus === 'connected' ? 0.6 : 1,
            }}
          >
            {connectionStatus === 'connecting' ? 'Connecting...' : 
             connectionStatus === 'connected' ? 'Connected' : 'Connect'}
          </button>

          {connectionStatus === 'connected' && (
            <button
              onClick={handleDisconnect}
              style={{
                backgroundColor: '#ef4444',
                color: 'white',
                padding: '0.5rem 1.5rem',
                borderRadius: '6px',
                border: 'none',
                fontSize: '1rem',
                fontWeight: '500',
                cursor: 'pointer',
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {/* Voice Controls */}
      {connectionStatus === 'connected' && (
        <div style={{
          backgroundColor: '#f0f9ff',
          border: '2px solid #3b82f6',
          borderRadius: '8px',
          padding: '1.5rem',
          marginBottom: '2rem',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: '600', margin: 0 }}>
              {testMode ? 'Text Mode (Testing)' : 'Voice Controls'}
            </h2>
            <button
              onClick={() => setTestMode(!testMode)}
              style={{
                padding: '0.25rem 0.75rem',
                fontSize: '0.75rem',
                backgroundColor: testMode ? '#8b5cf6' : '#6b7280',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              {testMode ? '🎤 Switch to Voice' : '⌨️ Switch to Text'}
            </button>
          </div>

          {testMode ? (
            // Text input mode for testing
            <div>
              <div style={{
                backgroundColor: '#fef3c7',
                border: '1px solid #fbbf24',
                borderRadius: '6px',
                padding: '0.75rem',
                marginBottom: '1rem',
                fontSize: '0.875rem',
                color: '#92400e',
              }}>
                💡 <strong>Test Mode:</strong> Type your message to test without microphone (useful for BrowserStack testing)
              </div>
              
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleTextSubmit()}
                  placeholder="Type your message here..."
                  style={{
                    flex: 1,
                    padding: '0.75rem',
                    fontSize: '1rem',
                    border: '2px solid #3b82f6',
                    borderRadius: '6px',
                    outline: 'none',
                  }}
                />
                <button
                  onClick={handleTextSubmit}
                  disabled={!testInput.trim()}
                  style={{
                    backgroundColor: testInput.trim() ? '#3b82f6' : '#d1d5db',
                    color: 'white',
                    padding: '0.75rem 1.5rem',
                    borderRadius: '6px',
                    border: 'none',
                    fontSize: '1rem',
                    fontWeight: '600',
                    cursor: testInput.trim() ? 'pointer' : 'not-allowed',
                  }}
                >
                  Send
                </button>
              </div>
            </div>
          ) : (
            // Original voice controls
            <div>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            {!isRecording ? (
              <button
                onClick={handleStartRecording}
                style={{
                  backgroundColor: '#22c55e',
                  color: 'white',
                  padding: '0.75rem 2rem',
                  borderRadius: '6px',
                  border: 'none',
                  fontSize: '1.125rem',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                🎤 Start Speaking
              </button>
            ) : (
              <>
                <button
                  onClick={handleStopRecording}
                  style={{
                    backgroundColor: '#ef4444',
                    color: 'white',
                    padding: '0.75rem 2rem',
                    borderRadius: '6px',
                    border: 'none',
                    fontSize: '1.125rem',
                    fontWeight: '600',
                    cursor: 'pointer',
                  }}
                >
                  ⏹️ Stop
                </button>
                
                {currentState === 'SPEAKING' && (
                  <button
                    onClick={handleInterrupt}
                    style={{
                      backgroundColor: '#f59e0b',
                      color: 'white',
                      padding: '0.75rem 2rem',
                      borderRadius: '6px',
                      border: 'none',
                      fontSize: '1.125rem',
                      fontWeight: '600',
                      cursor: 'pointer',
                    }}
                  >
                    ✋ Interrupt
                  </button>
                )}
              </>
            )}
          </div>

          {isRecording && (
            <div style={{
              padding: '0.75rem',
              backgroundColor: '#fee2e2',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.875rem',
              color: '#991b1b',
            }}>
              <div style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#dc2626',
                animation: 'pulse 1.5s ease-in-out infinite',
              }} />
              Recording... Speak now
            </div>
          )}
            </div>
          )}
        </div>
      )}

      {/* Transcripts */}
      {(partialTranscript || finalTranscript) && (
        <div style={{
          backgroundColor: '#f9fafb',
          border: '1px solid #e5e7eb',
          borderRadius: '8px',
          padding: '1.5rem',
          marginBottom: '2rem',
        }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1rem' }}>
            You Said
          </h2>
          
          {finalTranscript && (
            <p style={{ 
              fontSize: '1rem', 
              lineHeight: '1.5',
              marginBottom: '0.5rem',
              color: '#111827',
            }}>
              {finalTranscript}
            </p>
          )}
          
          {partialTranscript && (
            <p style={{ 
              fontSize: '0.875rem', 
              color: '#6b7280',
              fontStyle: 'italic',
            }}>
              {partialTranscript}
            </p>
          )}
        </div>
      )}

      {/* Agent Response */}
      {agentResponse && (
        <div style={{
          backgroundColor: '#f0fdf4',
          border: '1px solid #86efac',
          borderRadius: '8px',
          padding: '1.5rem',
          marginBottom: '2rem',
        }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1rem', color: '#166534' }}>
            Agent Response
          </h2>
          <p style={{ fontSize: '1rem', lineHeight: '1.5', color: '#166534' }}>
            {agentResponse}
          </p>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div style={{
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '8px',
          padding: '1rem',
          marginBottom: '2rem',
          color: '#991b1b',
        }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* State Machine Display */}
      <div style={{
        backgroundColor: '#fafafa',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        padding: '1.5rem',
        marginBottom: '2rem',
      }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1rem' }}>
          State Machine
        </h2>
        
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          {(['IDLE', 'LISTENING', 'SPECULATIVE', 'COMMITTED', 'SPEAKING'] as TurnState[]).map((state) => (
            <div
              key={state}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: '6px',
                backgroundColor: state === currentState ? getStateColor(state) : '#f3f4f6',
                color: state === currentState ? 'white' : '#6b7280',
                fontWeight: state === currentState ? '600' : '400',
                fontSize: '0.875rem',
                border: state === currentState ? 'none' : '1px solid #e5e7eb',
                transition: 'all 0.3s ease',
              }}
            >
              {state}
            </div>
          ))}
        </div>
      </div>

      {/* Settings Panel */}
      <div style={{
        backgroundColor: '#f3f4f6',
        border: '1px solid #d1d5db',
        borderRadius: '8px',
        padding: '1rem',
        marginBottom: '2rem',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: '600', margin: 0 }}>
            ⚙️ Settings
          </h3>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{
              padding: '0.25rem 0.75rem',
              fontSize: '0.875rem',
              backgroundColor: '#6b7280',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            {showSettings ? 'Hide' : 'Show'}
          </button>
        </div>
        
        {showSettings && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: '500', marginBottom: '0.5rem' }}>
                Speculative Timing (Silence Debounce)
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <input
                  type="range"
                  min="200"
                  max="1200"
                  step="50"
                  value={silenceDebounceMs}
                  onChange={(e) => setSilenceDebounceMs(Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: '0.875rem', fontWeight: '600', minWidth: '60px' }}>
                  {silenceDebounceMs}ms
                </span>
              </div>
              <p style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '0.5rem' }}>
                Time to wait after user stops speaking before AI starts processing. Lower = faster response but more interruptions. Higher = more accurate but slower.
              </p>
            </div>
            
            <button
              onClick={handleUpdateSettings}
              disabled={connectionStatus !== 'connected'}
              style={{
                padding: '0.5rem 1rem',
                fontSize: '0.875rem',
                backgroundColor: connectionStatus === 'connected' ? '#3b82f6' : '#9ca3af',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: connectionStatus === 'connected' ? 'pointer' : 'not-allowed',
                fontWeight: '500',
              }}
            >
              Apply Settings
            </button>
          </div>
        )}
      </div>

      {/* Info Panel */}
      <div style={{
        backgroundColor: '#eff6ff',
        border: '1px solid #93c5fd',
        borderRadius: '8px',
        padding: '1rem',
        fontSize: '0.875rem',
        marginBottom: '2rem',
      }}>
        <p style={{ fontWeight: '500', marginBottom: '0.5rem' }}>
          ℹ️ How to Use
        </p>
        <ol style={{ color: '#1e40af', marginLeft: '1.5rem', lineHeight: '1.6' }}>
          <li>Click "Connect" to establish WebSocket connection</li>
          <li>Click "Start Speaking" and allow microphone access</li>
          <li>Speak your message (speech will be transcribed in real-time)</li>
          <li>Wait for silence detection (default 400ms, adjustable in Settings) to trigger AI response</li>
          <li>Listen to agent's response or interrupt with "Interrupt" button</li>
          <li>State machine shows current pipeline stage</li>

      {/* Transcript Logs */}
      {logs.length > 0 && (
        <div style={{
          backgroundColor: '#fafafa',
          border: '1px solid #e5e7eb',
          borderRadius: '8px',
          padding: '1.5rem',
          marginBottom: '2rem',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: '600', margin: 0 }}>
              Transcript Logs
            </h2>
            <button
              onClick={() => setLogs([])}
              style={{
                padding: '0.25rem 0.75rem',
                fontSize: '0.75rem',
                backgroundColor: '#ef4444',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Clear Logs
            </button>
          </div>
          
          <div style={{
            maxHeight: '400px',
            overflowY: 'auto',
            backgroundColor: '#111827',
            padding: '1rem',
            borderRadius: '6px',
            fontFamily: 'monospace',
            fontSize: '0.75rem',
            lineHeight: '1.5',
          }}>
            {logs.map((log, index) => (
              <div key={index} style={{
                marginBottom: '0.5rem',
                color: log.type === 'partial' ? '#9ca3af' : 
                       log.type === 'final' ? '#60a5fa' : 
                       log.type === 'agent' ? '#34d399' : 
                       '#fbbf24',
              }}>
                <span style={{ color: '#6b7280' }}>
                  [{log.timestamp.toLocaleTimeString()}]
                </span>{' '}
                {log.content}
              </div>
            ))}
          </div>
        </div>
      )}
        </ol>
      </div>

      {/* Debug Panel */}
      <DebugPanel
        wsUrl={wsUrl}
        connectionStatus={connectionStatus}
        currentState={currentState}
        error={error}
        logs={logs}
      />
    </div>
  );
}

export default App;
