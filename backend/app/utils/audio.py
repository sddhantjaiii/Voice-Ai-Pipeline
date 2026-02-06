"""Audio utilities for format conversion and buffering."""

import logging
import base64
from typing import Optional

logger = logging.getLogger(__name__)


def decode_audio_base64(audio_b64: str) -> Optional[bytes]:
    """
    Decode base64-encoded audio to bytes.
    
    Args:
        audio_b64: Base64-encoded audio string
        
    Returns:
        Audio bytes or None on error
    """
    try:
        return base64.b64decode(audio_b64)
    except Exception as e:
        logger.error(f"Failed to decode base64 audio: {e}")
        return None


def encode_audio_base64(audio_bytes: bytes) -> str:
    """
    Encode audio bytes to base64.
    
    Args:
        audio_bytes: Raw audio data
        
    Returns:
        Base64-encoded string
    """
    return base64.b64encode(audio_bytes).decode('utf-8')


class AudioBuffer:
    """
    Circular buffer for audio chunks with overflow protection.
    
    Max 30 seconds of audio at 16kHz mono (960KB).
    """

    def __init__(self, max_duration_seconds: int = 30, sample_rate: int = 16000):
        self.max_size = max_duration_seconds * sample_rate * 2  # 2 bytes per sample (16-bit)
        self.buffer: bytearray = bytearray()
        self.total_bytes_received = 0

    def add(self, audio_chunk: bytes):
        """
        Add audio chunk to buffer.
        
        If buffer exceeds max size, drops oldest data.
        
        Args:
            audio_chunk: Audio data to add
        """
        self.buffer.extend(audio_chunk)
        self.total_bytes_received += len(audio_chunk)

        # Drop oldest data if over limit
        if len(self.buffer) > self.max_size:
            overflow = len(self.buffer) - self.max_size
            self.buffer = self.buffer[overflow:]
            logger.warning(f"Audio buffer overflow: dropped {overflow} bytes")

    def get_all(self) -> bytes:
        """
        Get all buffered audio.
        
        Returns:
            All audio data as bytes
        """
        return bytes(self.buffer)

    def clear(self):
        """Clear the buffer."""
        self.buffer.clear()
        logger.debug("Audio buffer cleared")

    def size_bytes(self) -> int:
        """Get current buffer size in bytes."""
        return len(self.buffer)

    def duration_seconds(self, sample_rate: int = 16000) -> float:
        """
        Calculate duration of buffered audio.
        
        Args:
            sample_rate: Sample rate in Hz
            
        Returns:
            Duration in seconds
        """
        num_samples = len(self.buffer) // 2  # 16-bit = 2 bytes per sample
        return num_samples / sample_rate
