"""
Deepgram streaming STT client with automatic reconnection and error recovery.

This module provides a persistent WebSocket connection to Deepgram's streaming API
with exponential backoff retry logic (5 attempts: 0s, 1s, 2s, 4s, 8s).
"""

import asyncio
import json
import logging
from typing import Callable, Optional, Awaitable
from websockets import connect, WebSocketClientProtocol
from websockets.exceptions import WebSocketException

from app.config import settings

logger = logging.getLogger(__name__)


class DeepgramClient:
    """
    Manages streaming connection to Deepgram for real-time transcription.
    
    Features:
    - Automatic reconnection with exponential backoff
    - Separate callbacks for partial vs final transcripts
    - Audio format configuration (16kHz mono PCM by default)
    - Connection health monitoring
    """

    def __init__(
        self,
        on_partial_transcript: Callable[[str, float], Awaitable[None]],
        on_final_transcript: Callable[[str, float], Awaitable[None]],
        on_error: Optional[Callable[[str], Awaitable[None]]] = None,
    ):
        """
        Initialize Deepgram client.

        Args:
            on_partial_transcript: Callback for interim results (text, confidence)
            on_final_transcript: Callback for final results (text, confidence)
            on_error: Optional callback for error handling
        """
        self.api_key = settings.deepgram_api_key
        self.on_partial_transcript = on_partial_transcript
        self.on_final_transcript = on_final_transcript
        self.on_error = on_error

        self.ws: Optional[WebSocketClientProtocol] = None
        self.is_connected = False
        self.is_closing = False
        self._receive_task: Optional[asyncio.Task] = None
        self._send_task: Optional[asyncio.Task] = None
        self._audio_queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._reconnect_attempts = 0
        self._max_reconnect_attempts = 5

    async def connect(self) -> bool:
        """
        Establish WebSocket connection to Deepgram.

        Returns:
            True if connection successful, False otherwise
        """
        if self.is_connected:
            logger.warning("Already connected to Deepgram")
            return True

        # Deepgram streaming API configuration
        params = {
            "encoding": "linear16",
            "sample_rate": 16000,
            "channels": 1,
            "interim_results": "true",
            "punctuate": "true",
            "utterance_end_ms": 1000,
            "vad_events": "true",
        }
        query_string = "&".join(f"{k}={v}" for k, v in params.items())
        url = f"wss://api.deepgram.com/v1/listen?{query_string}"

        try:
            self.ws = await connect(
                url,
                extra_headers={"Authorization": f"Token {self.api_key}"},
                ping_interval=10,
                ping_timeout=5,
            )
            self.is_connected = True
            self._reconnect_attempts = 0
            logger.info("Connected to Deepgram streaming API")

            # Start receiving messages
            self._receive_task = asyncio.create_task(self._receive_loop())
            # Start audio send loop
            self._send_task = asyncio.create_task(self._send_loop())
            return True

        except Exception as e:
            logger.error(f"Failed to connect to Deepgram: {e}")
            if self.on_error:
                self.on_error(f"Connection failed: {str(e)}")
            return False

    async def disconnect(self):
        """Gracefully close the Deepgram connection."""
        if not self.is_connected:
            return

        self.is_closing = True
        self.is_connected = False

        # Send close frame to Deepgram
        if self.ws:
            try:
                await self.ws.send(json.dumps({"type": "CloseStream"}))
                await self.ws.close()
            except Exception as e:
                logger.warning(f"Error during Deepgram disconnect: {e}")

        # Cancel receive task
        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass

        # Cancel send task
        if self._send_task and not self._send_task.done():
            self._send_task.cancel()
            try:
                await self._send_task
            except asyncio.CancelledError:
                pass

        logger.info("Disconnected from Deepgram")

    async def send_audio(self, audio_data: bytes):
        """
        Queue audio chunk for sending to Deepgram.

        Args:
            audio_data: Raw PCM audio bytes (16kHz mono)
        """
        if not self.is_connected:
            logger.warning("Cannot send audio: not connected to Deepgram")
            return

        try:
            # Non-blocking put with timeout
            await asyncio.wait_for(self._audio_queue.put(audio_data), timeout=0.1)
        except asyncio.TimeoutError:
            logger.warning("Audio queue full - dropping chunk to prevent blocking")
        except Exception as e:
            logger.error(f"Error queuing audio: {e}")

    async def _send_loop(self):
        """
        Continuously send audio from queue to Deepgram.
        
        This prevents overwhelming the WebSocket with rapid sends.
        """
        try:
            while not self.is_closing:
                try:
                    # Get audio chunk from queue (blocks until available)
                    audio_data = await asyncio.wait_for(
                        self._audio_queue.get(),
                        timeout=5.0
                    )
                    
                    if self.ws and self.is_connected:
                        await self.ws.send(audio_data)
                        
                except asyncio.TimeoutError:
                    # No audio for 5 seconds - send keepalive
                    if self.ws and self.is_connected:
                        try:
                            await self.ws.send(json.dumps({"type": "KeepAlive"}))
                        except Exception:
                            pass
                except WebSocketException as e:
                    logger.error(f"Error sending audio to Deepgram: {e}")
                    self.is_connected = False
                    asyncio.create_task(self._reconnect())
                    break
                except Exception as e:
                    logger.error(f"Unexpected error in send loop: {e}")
                    
        except asyncio.CancelledError:
            logger.debug("Send loop cancelled")

    async def _receive_loop(self):
        """
        Continuously receive and process messages from Deepgram.
        
        Handles:
        - Transcript results (partial and final)
        - Error messages
        - Connection keepalive
        """
        try:
            async for message in self.ws:
                if self.is_closing:
                    break

                try:
                    data = json.loads(message)
                    await self._handle_message(data)
                except json.JSONDecodeError as e:
                    logger.error(f"Invalid JSON from Deepgram: {e}")
                except Exception as e:
                    logger.error(f"Error handling Deepgram message: {e}")

        except asyncio.CancelledError:
            logger.debug("Receive loop cancelled")
        except WebSocketException as e:
            logger.error(f"WebSocket error in receive loop: {e}")
            if not self.is_closing:
                asyncio.create_task(self._reconnect())
        except Exception as e:
            logger.error(f"Unexpected error in receive loop: {e}")

    async def _handle_message(self, data: dict):
        """
        Process a single message from Deepgram.

        Args:
            data: Parsed JSON message from Deepgram
        """
        # Check for errors
        if "error" in data:
            error_msg = data["error"]
            logger.error(f"Deepgram error: {error_msg}")
            if self.on_error:
                await self.on_error(error_msg)
            return

        # Extract transcript data
        if "channel" not in data:
            return

        channel = data["channel"]
        if "alternatives" not in channel or not channel["alternatives"]:
            return

        alternative = channel["alternatives"][0]
        transcript = alternative.get("transcript", "").strip()
        confidence = alternative.get("confidence", 0.0)

        # Ignore empty transcripts
        if not transcript:
            return

        # Determine if this is a final transcript
        is_final = data.get("is_final", False)
        speech_final = data.get("speech_final", False)

        if is_final or speech_final:
            # Final transcript - send to buffer for LLM input
            logger.debug(f"Final transcript: {transcript} (confidence: {confidence:.2f})")
            await self.on_final_transcript(transcript, confidence)
        else:
            # Partial transcript - UI display only
            logger.debug(f"Partial transcript: {transcript} (confidence: {confidence:.2f})")
            await self.on_partial_transcript(transcript, confidence)

    async def _reconnect(self):
        """
        Attempt to reconnect with exponential backoff.
        
        Backoff schedule: 0s, 1s, 2s, 4s, 8s
        After 5 failed attempts, stop trying and notify error callback.
        """
        if self.is_closing or self._reconnect_attempts >= self._max_reconnect_attempts:
            logger.error("Max reconnection attempts reached")
            if self.on_error:
                self.on_error("Connection lost - max retries exceeded")
            return

        # Exponential backoff: 2^attempt seconds
        delay = 2 ** self._reconnect_attempts if self._reconnect_attempts > 0 else 0
        self._reconnect_attempts += 1

        logger.info(f"Reconnecting to Deepgram (attempt {self._reconnect_attempts}/{self._max_reconnect_attempts}) in {delay}s")
        await asyncio.sleep(delay)

        success = await self.connect()
        if not success and not self.is_closing:
            # Try again
            asyncio.create_task(self._reconnect())

    @property
    def connection_status(self) -> str:
        """Get current connection status."""
        if self.is_closing:
            return "closing"
        elif self.is_connected:
            return "connected"
        elif self._reconnect_attempts > 0:
            return "reconnecting"
        else:
            return "disconnected"
