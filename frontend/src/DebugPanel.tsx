import { useState, useEffect } from 'react';

// Frontend version for deployment tracking
const VERSION = 'v1.0.3-web-audio-api';

interface DebugInfo {
  userAgent: string;
  platform: string;
  screenSize: string;
  isIOS: boolean;
  isSafari: boolean;
  hasMediaDevices: boolean;
  hasWebSocket: boolean;
  hasAudioContext: boolean;
  orientation: string;
  isStandalone: boolean;
  connectionType: string;
  permissions: {
    microphone: string;
    notifications: string;
  };
}

interface DebugPanelProps {
  wsUrl: string;
  connectionStatus: string;
  currentState: string;
  error: string;
  logs: Array<{ timestamp: Date; type: string; content: string }>;
}

export default function DebugPanel({ wsUrl, connectionStatus, currentState, error, logs }: DebugPanelProps) {
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [shareUrl, setShareUrl] = useState('');

  useEffect(() => {
    collectDebugInfo();
    captureConsoleLogs();
  }, []);

  const collectDebugInfo = async () => {
    const info: DebugInfo = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      screenSize: `${window.screen.width}x${window.screen.height}`,
      isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent),
      isSafari: /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
      hasMediaDevices: !!navigator.mediaDevices,
      hasWebSocket: 'WebSocket' in window,
      hasAudioContext: 'AudioContext' in window || 'webkitAudioContext' in window,
      orientation: window.screen.orientation?.type || 'unknown',
      isStandalone: (window.navigator as any).standalone === true || window.matchMedia('(display-mode: standalone)').matches,
      connectionType: (navigator as any).connection?.effectiveType || 'unknown',
      permissions: {
        microphone: 'unknown',
        notifications: 'unknown',
      },
    };

    // Check microphone permission
    try {
      const micPermission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      info.permissions.microphone = micPermission.state;
    } catch (e) {
      info.permissions.microphone = 'error: ' + (e as Error).message;
    }

    // Check notification permission
    if ('Notification' in window) {
      info.permissions.notifications = Notification.permission;
    }

    setDebugInfo(info);
  };

  const captureConsoleLogs = () => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    console.log = (...args: any[]) => {
      setDebugLogs(prev => [...prev, `[LOG] ${new Date().toISOString().substr(11, 12)} - ${args.join(' ')}`].slice(-50));
      originalLog(...args);
    };

    console.error = (...args: any[]) => {
      setDebugLogs(prev => [...prev, `[ERROR] ${new Date().toISOString().substr(11, 12)} - ${args.join(' ')}`].slice(-50));
      originalError(...args);
    };

    console.warn = (...args: any[]) => {
      setDebugLogs(prev => [...prev, `[WARN] ${new Date().toISOString().substr(11, 12)} - ${args.join(' ')}`].slice(-50));
      originalWarn(...args);
    };

    // Capture global errors
    window.addEventListener('error', (event) => {
      setDebugLogs(prev => [...prev, `[GLOBAL ERROR] ${event.message} at ${event.filename}:${event.lineno}`].slice(-50));
    });

    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      setDebugLogs(prev => [...prev, `[UNHANDLED REJECTION] ${event.reason}`].slice(-50));
    });
  };

  const generateDebugReport = () => {
    const report = {
      timestamp: new Date().toISOString(),
      debugInfo,
      connectionStatus,
      currentState,
      wsUrl,
      error,
      recentLogs: logs.slice(-10),
      consoleLogs: debugLogs.slice(-20),
    };
    return JSON.stringify(report, null, 2);
  };

  const copyDebugReport = () => {
    const report = generateDebugReport();
    navigator.clipboard.writeText(report).then(() => {
      alert('Debug report copied to clipboard!');
    }).catch(() => {
      // Fallback for iOS
      const textarea = document.createElement('textarea');
      textarea.value = report;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      alert('Debug report copied to clipboard!');
    });
  };

  const sendDebugReport = async () => {
    const report = JSON.parse(generateDebugReport());
    
    // Try to send to your backend first
    try {
      const apiUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
      const response = await fetch(`${apiUrl}/api/debug/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(report),
      });
      
      if (response.ok) {
        const data = await response.json();
        alert(`✅ Debug report sent successfully! Saved as: ${data.filename}`);
        return;
      }
    } catch (e) {
      console.error('Failed to send to backend:', e);
    }
    
    // Fallback: Create a shareable link using a paste service
    try {
      const response = await fetch('https://api.paste.ee/v1/pastes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sections: [{
            name: 'Voice AI Pipeline Debug Report',
            contents: generateDebugReport(),
          }],
        }),
      });
      
      if (response.ok) {
        const data = await response.json();
        const url = `https://paste.ee/p/${data.id}`;
        setShareUrl(url);
        alert(`Debug report uploaded! Share this link: ${url}`);
      } else {
        throw new Error('Failed to upload');
      }
    } catch (e) {
      // Final fallback: just copy to clipboard
      copyDebugReport();
      alert('Could not upload report. It has been copied to your clipboard instead.');
    }
  };

  const testMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      alert('✅ Microphone access granted!');
      stream.getTracks().forEach(track => track.stop());
    } catch (e) {
      alert(`❌ Microphone error: ${(e as Error).message}`);
    }
  };

  const testWebSocket = () => {
    try {
      const testWs = new WebSocket(wsUrl);
      testWs.onopen = () => {
        alert('✅ WebSocket connection successful!');
        testWs.close();
      };
      testWs.onerror = (e) => {
        alert(`❌ WebSocket error: ${e}`);
      };
      testWs.onclose = (e) => {
        if (e.code !== 1000) {
          alert(`⚠️ WebSocket closed with code: ${e.code}, reason: ${e.reason}`);
        }
      };
    } catch (e) {
      alert(`❌ WebSocket test failed: ${(e as Error).message}`);
    }
  };

  if (!showDebug) {
    return (
      <button
        onClick={() => setShowDebug(true)}
        style={{
          position: 'fixed',
          bottom: '10px',
          right: '10px',
          padding: '10px 15px',
          backgroundColor: '#1f2937',
          color: 'white',
          border: 'none',
          borderRadius: '6px',
          fontSize: '12px',
          cursor: 'pointer',
          zIndex: 1000,
          boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
        }}
      >
        🐛 Debug
      </button>
    );
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.9)',
      zIndex: 9999,
      overflow: 'auto',
      padding: '20px',
      color: 'white',
      fontFamily: 'monospace',
      fontSize: '12px',
    }}>
      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
          <h2>🐛 Debug Panel <span style={{ fontSize: '14px', color: '#10b981', marginLeft: '10px' }}>({VERSION})</span></h2>
          <button
            onClick={() => setShowDebug(false)}
            style={{
              padding: '5px 15px',
              backgroundColor: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
          <button onClick={testMicrophone} style={buttonStyle}>Test Microphone</button>
          <button onClick={testWebSocket} style={buttonStyle}>Test WebSocket</button>
          <button onClick={copyDebugReport} style={buttonStyle}>Copy Report</button>
          <button onClick={sendDebugReport} style={buttonStyle}>Share Report</button>
        </div>

        {shareUrl && (
          <div style={{ backgroundColor: '#065f46', padding: '10px', borderRadius: '4px', marginBottom: '20px' }}>
            Share this URL: <a href={shareUrl} target="_blank" style={{ color: '#6ee7b7' }}>{shareUrl}</a>
          </div>
        )}

        {/* Device Info */}
        {debugInfo && (
          <div style={{ marginBottom: '20px' }}>
            <h3 style={{ color: '#60a5fa' }}>Device Information</h3>
            <div style={{ backgroundColor: '#1f2937', padding: '15px', borderRadius: '6px' }}>
              <p>🖥️ <strong>Platform:</strong> {debugInfo.platform}</p>
              <p>📱 <strong>User Agent:</strong> {debugInfo.userAgent}</p>
              <p>📏 <strong>Screen:</strong> {debugInfo.screenSize}</p>
              <p>🧭 <strong>Orientation:</strong> {debugInfo.orientation}</p>
              <p>🍎 <strong>iOS Device:</strong> {debugInfo.isIOS ? '✅ Yes' : '❌ No'}</p>
              <p>🧭 <strong>Safari Browser:</strong> {debugInfo.isSafari ? '✅ Yes' : '❌ No'}</p>
              <p>📱 <strong>Standalone Mode:</strong> {debugInfo.isStandalone ? '✅ Yes' : '❌ No'}</p>
              <p>📶 <strong>Connection:</strong> {debugInfo.connectionType}</p>
            </div>
          </div>
        )}

        {/* Feature Support */}
        {debugInfo && (
          <div style={{ marginBottom: '20px' }}>
            <h3 style={{ color: '#60a5fa' }}>Feature Support</h3>
            <div style={{ backgroundColor: '#1f2937', padding: '15px', borderRadius: '6px' }}>
              <p>🎤 <strong>MediaDevices API:</strong> {debugInfo.hasMediaDevices ? '✅ Supported' : '❌ Not Supported'}</p>
              <p>🔌 <strong>WebSocket:</strong> {debugInfo.hasWebSocket ? '✅ Supported' : '❌ Not Supported'}</p>
              <p>🔊 <strong>AudioContext:</strong> {debugInfo.hasAudioContext ? '✅ Supported' : '❌ Not Supported'}</p>
              <p>🎤 <strong>Microphone Permission:</strong> {debugInfo.permissions.microphone}</p>
              <p>🔔 <strong>Notification Permission:</strong> {debugInfo.permissions.notifications}</p>
            </div>
          </div>
        )}

        {/* Current Status */}
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ color: '#60a5fa' }}>Current Status</h3>
          <div style={{ backgroundColor: '#1f2937', padding: '15px', borderRadius: '6px' }}>
            <p>🔗 <strong>WebSocket URL:</strong> {wsUrl}</p>
            <p>📡 <strong>Connection:</strong> {connectionStatus}</p>
            <p>🎯 <strong>State:</strong> {currentState}</p>
            {error && <p style={{ color: '#ef4444' }}>❌ <strong>Error:</strong> {error}</p>}
          </div>
        </div>

        {/* Console Logs */}
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ color: '#60a5fa' }}>Console Logs</h3>
          <div style={{
            backgroundColor: '#111827',
            padding: '15px',
            borderRadius: '6px',
            maxHeight: '300px',
            overflow: 'auto',
          }}>
            {debugLogs.length === 0 ? (
              <p style={{ color: '#6b7280' }}>No logs yet...</p>
            ) : (
              debugLogs.map((log, i) => (
                <div key={i} style={{
                  color: log.includes('[ERROR]') ? '#ef4444' : log.includes('[WARN]') ? '#f59e0b' : '#10b981',
                  marginBottom: '5px',
                }}>
                  {log}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: '8px 16px',
  backgroundColor: '#3b82f6',
  color: 'white',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '12px',
};
