"""
Turn Controller - Orchestrates the complete voice agent pipeline.

This is the most complex component, coordinating:
- State machine transitions
- STT (Deepgram) streaming
- Transcript buffering and silence detection
- LLM (OpenAI) generation with speculative execution
- TTS (ElevenLabs) audio streaming
- Interruption handling and cancellation

Critical: Input is conservative (buffered), output is aggressive (streamed/interruptible).
"""

import asyncio
import logging
from typing import Optional, Callable, Awaitable
from datetime import datetime

from app.state_machine import StateMachine, TurnState
from app.stt.deepgram import DeepgramClient
from app.llm.openai_client import OpenAIClient
from app.tts.elevenlabs import ElevenLabsClient
from app.orchestration.transcript_buffer import TranscriptBuffer
from app.orchestration.conversation_history import ConversationHistory
from app.orchestration.silence_timer import SilenceTimer
from app.utils.audio import AudioBuffer, decode_audio_base64

logger = logging.getLogger(__name__)


class TurnController:
    """
    Orchestrates turn-taking between user and AI agent.
    
    State Flow:
    IDLE → LISTENING → SPECULATIVE → COMMITTED → SPEAKING → IDLE
              ↑           ↓ cancel        ↓
            (new audio)  (timeout)    (LLM complete)
    
    State Meanings:
    - LISTENING: Actively receiving and transcribing user audio
    - SPECULATIVE: LLM is streaming response (output held internally)
    - COMMITTED: LLM generation complete, ready to send to TTS
    - SPEAKING: TTS (ElevenLabs) is streaming audio to client
    """

    def __init__(
        self,
        session_id: str,
        on_state_change: Callable[[TurnState, TurnState], Awaitable[None]],
        on_transcript_partial: Callable[[str, float], Awaitable[None]],
        on_transcript_final: Callable[[str, float], Awaitable[None]],
        on_agent_audio: Callable[[str, int, bool], Awaitable[None]],  # base64, chunk_index, is_final
        on_agent_text_fallback: Callable[[str, str], Awaitable[None]],  # text, reason
        on_turn_complete: Callable[[str, str, str, int, bool], Awaitable[None]],  # turn_id, user_text, agent_text, duration_ms, was_interrupted
        on_error: Callable[[str, str, bool], Awaitable[None]],  # code, message, recoverable
    ):
        self.session_id = session_id
        
        # Callbacks
        self.on_state_change = on_state_change
        self.on_transcript_partial = on_transcript_partial
        self.on_transcript_final = on_transcript_final
        self.on_agent_audio = on_agent_audio
        self.on_agent_text_fallback = on_agent_text_fallback
        self.on_turn_complete = on_turn_complete
        self.on_error = on_error

        # Core components
        self.state_machine = StateMachine()
        self.transcript_buffer = TranscriptBuffer()
        self.audio_buffer = AudioBuffer()
        self.conversation_history = ConversationHistory()

        # System prompt for LLM
        self._system_prompt = (
            "You are a helpful voice assistant. Keep responses concise and natural for speech. "
            "Use conversation history for context, but answer only the latest user request. "
            "Do NOT repeat or restate previous assistant replies."
        )

        # External clients (initialized on start)
        self.deepgram: Optional[DeepgramClient] = None
        self.openai = OpenAIClient()
        self.elevenlabs = ElevenLabsClient()

        # Silence timer
        self.silence_timer = SilenceTimer(
            on_silence_complete=self._on_silence_complete,
            initial_debounce_ms=400,
        )

        # Cancellation control
        self._llm_cancel_event = asyncio.Event()
        self._tts_cancel_event = asyncio.Event()

        # Turn tracking
        self._current_turn_id: Optional[str] = None
        self._turn_start_time: Optional[datetime] = None
        self._llm_response: str = ""
        self._llm_tokens_used = {"prompt": 0, "completion": 0}
        
        # Timing measurements (for bottleneck analysis)
        self._speech_end_time: Optional[datetime] = None
        self._llm_start_time: Optional[datetime] = None
        self._llm_complete_time: Optional[datetime] = None
        self._tts_start_time: Optional[datetime] = None
        self._first_audio_time: Optional[datetime] = None

        # Playback tracking
        self._waiting_for_playback = False
        self._playback_timeout_task: Optional[asyncio.Task] = None

        # Statistics for adaptive behavior
        self._total_turns = 0
        self._cancelled_turns = 0
        
        # Sentence queue for LLM→TTS streaming
        self._sentence_queue: asyncio.Queue[tuple[str, bool]] = asyncio.Queue()  # (sentence, is_final)
        self._tts_task: Optional[asyncio.Task] = None

        logger.info(f"TurnController initialized for session {session_id}")

    async def start(self):
        """Initialize external connections."""
        # Connect to Deepgram
        self.deepgram = DeepgramClient(
            on_partial_transcript=self._handle_partial_transcript,
            on_final_transcript=self._handle_final_transcript,
            on_error=self._handle_stt_error,
        )
        
        success = await self.deepgram.connect()
        if not success:
            await self.on_error("DEEPGRAM_CONNECTION_FAILED", "Failed to connect to Deepgram", recoverable=True)
            
        logger.info("TurnController started")

    async def stop(self):
        """Cleanup and disconnect."""
        if self.deepgram:
            await self.deepgram.disconnect()
        
        self.silence_timer.cancel()
        logger.info("TurnController stopped")

    async def handle_audio_chunk(self, audio_base64: str, format: str, sample_rate: int):
        """
        Process incoming audio from user.
        
        Args:
            audio_base64: Base64-encoded audio data
            format: Audio format (pcm, webm, wav)
            sample_rate: Sample rate in Hz
        """
        # Decode audio
        audio_bytes = decode_audio_base64(audio_base64)
        if not audio_bytes:
            logger.warning("Failed to decode audio or empty audio received")
            return
        
        current_state = self.state_machine.current_state
        logger.info(f"Received audio: {len(audio_bytes)} bytes, state: {current_state}")

        # Add to buffer only when listening to avoid overflow during SPECULATIVE/SPEAKING
        if current_state == TurnState.LISTENING:
            self.audio_buffer.add(audio_bytes)

        # State transitions
        logger.info(f"Current state before transition: {current_state}")
        
        # Log if we have an active Deepgram connection
        deepgram_connected = self.deepgram is not None and hasattr(self.deepgram, 'is_connected') and self.deepgram.is_connected
        logger.info(f"Deepgram connected: {deepgram_connected}")

        if current_state == TurnState.IDLE:
            # First audio → start listening
            logger.info("Transitioning from IDLE to LISTENING")
            await self._transition_to_listening()

        elif current_state == TurnState.SPECULATIVE:
            # Continue sending audio to Deepgram during speculation
            # Only cancel if NEW SPEECH is detected (handled in transcript callbacks)
            logger.info("In SPECULATIVE state - continuing to listen for new speech")

        elif current_state == TurnState.COMMITTED:
            # Continue sending audio to Deepgram during COMMITTED
            # User might interrupt before TTS starts speaking
            logger.info("In COMMITTED state - monitoring for user interruption")

        elif current_state == TurnState.SPEAKING:
            # Continue sending audio to Deepgram to detect interruptions
            # Only interrupt if NEW SPEECH is detected (handled in transcript callbacks)
            logger.info("In SPEAKING state - monitoring for user interruption")

        # Send audio to Deepgram (in all active states)
        if self.deepgram and current_state in [TurnState.LISTENING, TurnState.SPECULATIVE, TurnState.COMMITTED, TurnState.SPEAKING]:
            logger.info(f"Sending audio to Deepgram in state {current_state}")
            await self.deepgram.send_audio(audio_bytes)

    async def _handle_partial_transcript(self, text: str, confidence: float):
        """
        Handle partial transcript from Deepgram (UI display only).
        
        Args:
            text: Partial transcript text
            confidence: STT confidence score
        """
        current_state = self.state_machine.current_state
        
        # If we're in LISTENING state and get a partial, user is still speaking
        # → restart silence timer so we don't prematurely fire SPECULATIVE
        if current_state == TurnState.LISTENING:
            if self.silence_timer.is_running():
                logger.debug(f"Partial transcript during LISTENING - restarting silence timer: '{text[:40]}'")
                self.silence_timer.start()
        
        # If we're in SPECULATIVE state and get a NEW partial transcript,
        # it means user started speaking again → cancel speculation
        elif current_state == TurnState.SPECULATIVE:
            logger.info(f"New speech detected during SPECULATIVE: '{text}' - cancelling LLM")
            await self._cancel_speculation()
            await self._transition_to_listening()
        
        # If we're in COMMITTED state and get a NEW partial transcript,
        # user is speaking again → cancel TTS task and reset to IDLE
        elif current_state == TurnState.COMMITTED:
            logger.info(f"User interrupted during COMMITTED: '{text}' - cancelling TTS task")
            # Cancel TTS task if running
            if self._tts_task and not self._tts_task.done():
                self._tts_cancel_event.set()
                self._tts_task.cancel()
                try:
                    await self._tts_task
                except asyncio.CancelledError:
                    pass
            # Clear sentence queue
            while not self._sentence_queue.empty():
                try:
                    self._sentence_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            
            # Transition to IDLE (valid transition), then next audio will go IDLE → LISTENING
            await self.state_machine.transition(
                TurnState.IDLE,
                reason="User interrupted during COMMITTED - resetting"
            )
            await self._notify_state_change(TurnState.COMMITTED, TurnState.IDLE)
            
            # Unlock transcript buffer so new speech can be captured
            self.transcript_buffer.unlock()
            
            # Start new turn immediately since user is speaking
            await self._transition_to_listening()
        
        # If we're in SPEAKING state and get a NEW partial transcript,
        # it means user is interrupting (barge-in)
        elif current_state == TurnState.SPEAKING:
            logger.info(f"User barge-in detected during SPEAKING: '{text}' - interrupting agent")
            await self._handle_interrupt()
        
        self.transcript_buffer.add_partial(text, confidence)
        await self.on_transcript_partial(text, confidence)

    async def _handle_final_transcript(self, text: str, confidence: float):
        """
        Handle final transcript from Deepgram (LLM input).
        
        Args:
            text: Final transcript text
            confidence: STT confidence score
        """
        current_state = self.state_machine.current_state

        if current_state != TurnState.LISTENING:
            logger.warning(f"Received final transcript in {current_state} state - ignoring")
            return

        # Add to buffer
        self.transcript_buffer.add_final(text, confidence)
        await self.on_transcript_final(text, confidence)

        # Start silence timer
        self.silence_timer.start()
        logger.debug("Silence timer started after final transcript")

    async def _on_silence_complete(self):
        """
        Called when silence timer completes (user stopped speaking).
        
        Transitions LISTENING → SPECULATIVE and starts LLM.
        """
        current_state = self.state_machine.current_state

        if current_state != TurnState.LISTENING:
            logger.warning(f"Silence timer fired in {current_state} state - ignoring")
            return

        # Mark speech end time
        self._speech_end_time = datetime.now()
        logger.info(f"⏱️ TIMING: User speech ended at {self._speech_end_time.strftime('%H:%M:%S.%f')[:-3]}")

        # Transition to SPECULATIVE
        await self.state_machine.transition(
            TurnState.SPECULATIVE,
            reason="Silence detected - starting speculative LLM"
        )
        await self._notify_state_change(TurnState.LISTENING, TurnState.SPECULATIVE)

        # Lock buffer to prevent mutations
        self.transcript_buffer.lock()

        # Start LLM generation (output held until COMMITTED)
        asyncio.create_task(self._run_llm())

    async def _run_llm(self):
        """
        Run LLM generation with sentence-level streaming to TTS.
        
        Key improvement: TTS starts on FIRST SENTENCE, not after full LLM response.
        This reduces latency by starting speech while LLM continues generating.
        
        Flow:
        1. Start LLM sentence streaming
        2. On first sentence: SPECULATIVE → COMMITTED → Start TTS task
        3. Queue subsequent sentences for TTS while LLM continues
        4. LLM complete: Signal TTS with is_final=True
        """
        user_text = self.transcript_buffer.get_final_text()
        
        if not user_text:
            logger.warning("No user text for LLM - aborting")
            await self._reset_to_idle("No user input")
            return

        # Track LLM start time
        self._llm_start_time = datetime.now()
        if self._speech_end_time:
            silence_delay = (self._llm_start_time - self._speech_end_time).total_seconds() * 1000
            logger.info(f"⏱️ TIMING: LLM started {silence_delay:.0f}ms after speech end")
        logger.info(f"Starting LLM sentence streaming: {user_text[:50]}...")

        # Clear cancel event and sentence queue
        self._llm_cancel_event.clear()
        while not self._sentence_queue.empty():
            try:
                self._sentence_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

        # Build messages
        messages = [
            {"role": "system", "content": self._system_prompt},
            *self.conversation_history.get_messages(),
            {"role": "user", "content": user_text},
        ]

        # Stream sentences from LLM with timeout protection (15s total)
        first_sentence_started = False
        all_sentences = []
        completion_tokens = 0
        llm_timeout = 15.0  # Maximum time to wait for LLM response
        
        try:
            # Wrap the async generator iteration with timeout
            llm_gen = self.openai.stream_sentences(
                messages=messages,
                cancel_event=self._llm_cancel_event,
            )
            
            # Use asyncio.wait_for with async for loop workaround
            start_time = datetime.now()
            async for sentence, is_final in llm_gen:
                # Check timeout manually (wait_for doesn't work with async for)
                elapsed = (datetime.now() - start_time).total_seconds()
                if elapsed > llm_timeout:
                    logger.error(f"LLM timeout after {elapsed:.1f}s - aborting")
                    raise asyncio.TimeoutError("LLM streaming timeout")
                
                # Check if cancelled
                if self._llm_cancel_event.is_set():
                    logger.info("LLM generation was cancelled")
                    self._cancelled_turns += 1
                    # Signal TTS to stop if running
                    if self._tts_task and not self._tts_task.done():
                        await self._sentence_queue.put(("", True))  # Empty final to signal stop
                    return

                all_sentences.append(sentence)
                completion_tokens += len(sentence.split())  # Rough token estimate
                
                # On FIRST sentence: transition to COMMITTED and start TTS
                if not first_sentence_started:
                    first_sentence_started = True
                    
                    # Track first sentence time
                    first_sentence_time = datetime.now()
                    if self._speech_end_time:
                        time_to_first = (first_sentence_time - self._speech_end_time).total_seconds() * 1000
                        logger.info(f"⏱️ TIMING: First sentence ready {time_to_first:.0f}ms after speech end")
                    
                    # Transition SPECULATIVE → COMMITTED
                    current_state = self.state_machine.current_state
                    if current_state == TurnState.SPECULATIVE:
                        await self.state_machine.transition(
                            TurnState.COMMITTED,
                            reason="First sentence ready - starting TTS"
                        )
                        await self._notify_state_change(TurnState.SPECULATIVE, TurnState.COMMITTED)
                        logger.info(f"First sentence ready - transitioning to COMMITTED")
                    
                    # Start TTS consumer task (processes sentences from queue)
                    self._tts_task = asyncio.create_task(self._run_tts_streaming())
                
                # Queue sentence for TTS (TTS task will consume it)
                await self._sentence_queue.put((sentence, is_final))
                logger.info(f"📤 Queued sentence for TTS: {sentence[:40]}... (is_final={is_final})")

            # If no sentences were yielded, handle empty response
            if not first_sentence_started:
                logger.error("❌ LLM returned no sentences - possible API failure")
                await self.on_error(
                    "llm_no_response",
                    "AI did not generate a response",
                    recoverable=True
                )
                await self._reset_to_idle("Empty LLM response")
                return

            # Store full response for conversation history
            self._llm_response = ' '.join(all_sentences)
            self._llm_tokens_used = {"prompt": 0, "completion": completion_tokens}
            
            # Track LLM completion time
            self._llm_complete_time = datetime.now()
            if self._llm_start_time:
                llm_duration = (self._llm_complete_time - self._llm_start_time).total_seconds() * 1000
                logger.info(f"⏱️ TIMING: LLM completed in {llm_duration:.0f}ms (all sentences generated)")
            
            # Signal end of sentences if TTS didn't get a final yet
            # This handles cases where LLM ends without is_final=True
            if self._tts_task and not self._tts_task.done():
                # Check if we already sent a final
                if all_sentences and not all_sentences[-1].endswith(('.', '!', '?')):
                    await self._sentence_queue.put(("", True))  # Empty final marker
            
            # Wait for TTS to finish (it handles state transitions)
            if self._tts_task:
                await self._tts_task

        except asyncio.TimeoutError:
            logger.error("❌ LLM streaming timeout (15s) - API not responding")
            self._llm_cancel_event.set()
            # Cancel TTS if it was started
            if self._tts_task and not self._tts_task.done():
                self._tts_cancel_event.set()
                try:
                    await asyncio.wait_for(self._tts_task, timeout=2.0)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass
            await self.on_error(
                "llm_timeout",
                "AI response took too long (15s)",
                recoverable=True
            )
            await self._reset_to_idle("LLM timeout")
            
        except Exception as e:
            logger.error(f"❌ Error in LLM sentence streaming: {e}")
            # Cancel TTS if running
            if self._tts_task and not self._tts_task.done():
                self._tts_cancel_event.set()
                try:
                    await asyncio.wait_for(self._tts_task, timeout=2.0)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass
            await self.on_error(
                "llm_error",
                f"AI generation failed: {str(e)[:100]}",
                recoverable=True
            )
            await self._reset_to_idle(f"LLM error: {e}")

    async def _run_tts_streaming(self):
        """
        Consume sentences from queue and stream TTS audio.
        
        This runs concurrently with LLM generation, reducing total latency.
        Transitions COMMITTED → SPEAKING when first audio chunk is sent.
        """
        # Clear audio buffer to avoid overflow during SPEAKING
        self.audio_buffer.clear()
        
        # Track TTS start time
        self._tts_start_time = datetime.now()
        if self._speech_end_time:
            total_delay = (self._tts_start_time - self._speech_end_time).total_seconds() * 1000
            logger.info(f"⏱️ TIMING: TTS starting {total_delay:.0f}ms after speech end")
        
        # Clear cancel event
        self._tts_cancel_event.clear()
        
        chunk_index = 0
        first_audio_sent = False
        all_sentences_processed = False
        
        try:
            while not all_sentences_processed:
                # Get next sentence from queue (with timeout)
                try:
                    sentence, is_final = await asyncio.wait_for(
                        self._sentence_queue.get(),
                        timeout=20.0  # Safety timeout - LLM should complete within 15s
                    )
                except asyncio.TimeoutError:
                    logger.error("❌ TTS queue timeout (20s) - LLM likely stalled or failed")
                    # If stuck in COMMITTED, transition back to IDLE
                    current_state = self.state_machine.current_state
                    if current_state == TurnState.COMMITTED:
                        logger.error("System stuck in COMMITTED - forcing reset to IDLE")
                        await self.on_error(
                            "tts_queue_timeout",
                            "AI audio generation stalled",
                            recoverable=True
                        )
                        await self._reset_to_idle("TTS queue timeout - LLM stalled")
                    break
                
                # Empty sentence with is_final=True signals end
                if not sentence and is_final:
                    logger.info("Received end-of-sentences signal")
                    all_sentences_processed = True
                    break
                
                # Check for cancellation
                if self._tts_cancel_event.is_set():
                    logger.info("TTS streaming cancelled")
                    return
                
                # Generate audio for this sentence
                logger.info(f"🔊 TTS generating audio for: {sentence[:40]}...")
                
                async for audio_chunk in self.elevenlabs.generate_audio(
                    text=sentence,
                    cancel_event=self._tts_cancel_event,
                ):
                    if self._tts_cancel_event.is_set():
                        logger.info("TTS streaming cancelled mid-sentence")
                        return

                    # On first audio chunk: transition to SPEAKING and track latency
                    if not first_audio_sent:
                        first_audio_sent = True
                        
                        # Transition COMMITTED → SPEAKING
                        current_state = self.state_machine.current_state
                        if current_state == TurnState.COMMITTED:
                            await self.state_machine.transition(
                                TurnState.SPEAKING,
                                reason="TTS streaming started - agent speaking"
                            )
                            await self._notify_state_change(TurnState.COMMITTED, TurnState.SPEAKING)
                            logger.info("Transitioned to SPEAKING - ElevenLabs TTS streaming")
                        
                        # Track total latency
                        if self._speech_end_time:
                            self._first_audio_time = datetime.now()
                            total_latency = (self._first_audio_time - self._speech_end_time).total_seconds() * 1000
                            logger.info(f"⏱️ TIMING: First audio chunk at {total_latency:.0f}ms (TOTAL LATENCY)")

                    # Encode and send audio
                    audio_b64 = self.elevenlabs.encode_audio_base64(audio_chunk)
                    await self.on_agent_audio(audio_b64, chunk_index, False)
                    chunk_index += 1
                
                # Mark this sentence as done
                if is_final:
                    all_sentences_processed = True

            # Send final marker
            if chunk_index > 0:
                await self.on_agent_audio("", chunk_index, True)

            # TTS streaming complete - wait for frontend playback
            logger.info(f"TTS streaming done ({chunk_index} chunks sent) - waiting for frontend playback")
            self._waiting_for_playback = True
            
            # Send turn_complete for frontend to display agent text
            duration_ms = 0
            if self._turn_start_time:
                duration_ms = int((datetime.utcnow() - self._turn_start_time).total_seconds() * 1000)
            user_text = self.transcript_buffer.get_final_text()
            turn_id = f"{self.session_id}_{self._total_turns}"
            await self.on_turn_complete(turn_id, user_text, self._llm_response, duration_ms, False)
            
            # Safety timeout for playback_complete
            self._playback_timeout_task = asyncio.create_task(
                self._playback_timeout(timeout_s=15.0)
            )

        except asyncio.CancelledError:
            logger.info("TTS streaming cancelled by user interruption")
            raise
            
        except Exception as e:
            logger.error(f"❌ TTS streaming error: {e}")
            # Notify frontend of audio error
            await self.on_error(
                "tts_error",
                f"Audio generation failed: {str(e)[:100]}",
                recoverable=True
            )
            # Fallback to text-only if we have LLM response
            if hasattr(self, '_llm_response') and self._llm_response:
                await self.on_agent_text_fallback(self._llm_response, str(e))
            await self._complete_turn(was_interrupted=False)

    async def _run_tts(self):
        """
        DEPRECATED: Legacy non-streaming TTS.
        
        Kept for fallback if sentence streaming fails.
        Use _run_tts_streaming() for normal operation.
        """
        if not self._llm_response:
            logger.warning("No LLM response for TTS")
            await self._reset_to_idle("No LLM response")
            return

        # Clear audio buffer to avoid overflow during SPEAKING
        self.audio_buffer.clear()
        
        # Track TTS start time
        self._tts_start_time = datetime.now()
        if self._speech_end_time:
            total_delay = (self._tts_start_time - self._speech_end_time).total_seconds() * 1000
            logger.info(f"⏱️ TIMING: TTS starting {total_delay:.0f}ms after speech end")
        
        # Transition to SPEAKING exactly when TTS starts streaming
        await self.state_machine.transition(
            TurnState.SPEAKING,
            reason="TTS streaming started - agent speaking"
        )
        await self._notify_state_change(TurnState.COMMITTED, TurnState.SPEAKING)
        logger.info("Transitioned to SPEAKING - ElevenLabs TTS streaming")

        # Clear cancel event
        self._tts_cancel_event.clear()

        # Stream TTS audio
        chunk_index = 0
        try:
            async for audio_chunk in self.elevenlabs.generate_audio(
                text=self._llm_response,
                cancel_event=self._tts_cancel_event,
            ):
                if self._tts_cancel_event.is_set():
                    logger.info("TTS streaming cancelled")
                    return

                # Track first audio chunk (total latency)
                if chunk_index == 0 and self._speech_end_time:
                    self._first_audio_time = datetime.now()
                    total_latency = (self._first_audio_time - self._speech_end_time).total_seconds() * 1000
                    logger.info(f"⏱️ TIMING: First audio chunk at {total_latency:.0f}ms (TOTAL LATENCY)")

                # Encode and send
                audio_b64 = self.elevenlabs.encode_audio_base64(audio_chunk)
                is_final = False  # We don't know until stream ends
                await self.on_agent_audio(audio_b64, chunk_index, is_final)
                chunk_index += 1

            # Send final marker
            if chunk_index > 0:
                await self.on_agent_audio("", chunk_index, True)

            # TTS streaming complete - wait for frontend playback to finish
            # Stay in SPEAKING state until playback_complete message arrives
            logger.info(f"TTS streaming done ({chunk_index} chunks sent) - waiting for frontend playback to finish")
            self._waiting_for_playback = True
            
            # Send turn_complete now so frontend can display agent text immediately
            # But do NOT transition state yet - stay in SPEAKING
            duration_ms = 0
            if self._turn_start_time:
                duration_ms = int((datetime.utcnow() - self._turn_start_time).total_seconds() * 1000)
            user_text = self.transcript_buffer.get_final_text()
            turn_id = f"{self.session_id}_{self._total_turns}"
            await self.on_turn_complete(turn_id, user_text, self._llm_response, duration_ms, False)
            
            # Safety timeout: if playback_complete doesn't arrive within 15s, auto-complete
            self._playback_timeout_task = asyncio.create_task(
                self._playback_timeout(timeout_s=15.0)
            )

        except Exception as e:
            logger.error(f"TTS error: {e}")
            # Fallback to text-only
            await self.on_agent_text_fallback(self._llm_response, str(e))
            await self._complete_turn(was_interrupted=False)

    async def _complete_turn(self, was_interrupted: bool, notify: bool = True):
        """
        Complete the current turn and reset to IDLE.
        
        Args:
            was_interrupted: Whether turn was interrupted by user
            notify: Whether to send turn_complete message (False if already sent)
        """
        # Calculate duration
        duration_ms = 0
        if self._turn_start_time:
            duration_ms = int((datetime.utcnow() - self._turn_start_time).total_seconds() * 1000)

        # Log timing summary
        if self._speech_end_time and self._llm_start_time and self._llm_complete_time and self._tts_start_time and self._first_audio_time:
            silence_to_llm = (self._llm_start_time - self._speech_end_time).total_seconds() * 1000
            llm_duration = (self._llm_complete_time - self._llm_start_time).total_seconds() * 1000
            llm_to_tts = (self._tts_start_time - self._llm_complete_time).total_seconds() * 1000
            tts_to_audio = (self._first_audio_time - self._tts_start_time).total_seconds() * 1000
            total_latency = (self._first_audio_time - self._speech_end_time).total_seconds() * 1000
            
            logger.info(f"⏱️ TIMING SUMMARY:")
            logger.info(f"  Speech → LLM Start: {silence_to_llm:.0f}ms")
            logger.info(f"  LLM Generation: {llm_duration:.0f}ms ({self._llm_tokens_used.get('completion', 0)} tokens)")
            logger.info(f"  LLM → TTS Start: {llm_to_tts:.0f}ms")
            logger.info(f"  TTS → First Audio: {tts_to_audio:.0f}ms")
            logger.info(f"  TOTAL LATENCY: {total_latency:.0f}ms")

        # Get transcripts
        user_text = self.transcript_buffer.get_final_text()
        agent_text = self._llm_response

        # Append to conversation history (full turn-based context)
        if user_text or agent_text:
            self.conversation_history.add_turn(user_text, agent_text)

        # Generate turn ID
        turn_id = f"{self.session_id}_{self._total_turns}"
        self._total_turns += 1

        # Notify completion (skip if already sent, e.g. after TTS streaming)
        if notify:
            await self.on_turn_complete(turn_id, user_text, agent_text, duration_ms, was_interrupted)

        # Clear playback wait state
        self._waiting_for_playback = False
        if self._playback_timeout_task and not self._playback_timeout_task.done():
            self._playback_timeout_task.cancel()
            self._playback_timeout_task = None

        # Reset state
        await self._reset_to_idle("Turn complete")

        # Adjust silence debounce
        if self._total_turns > 0:
            cancellation_rate = self._cancelled_turns / self._total_turns
            self.silence_timer.adjust_debounce(cancellation_rate)

    async def _handle_interrupt(self):
        """
        Handle user interruption during agent speaking (barge-in).
        
        Cancels TTS and transitions SPEAKING → LISTENING.
        """
        logger.info("User interrupted agent")

        # Cancel TTS
        self._tts_cancel_event.set()
        
        # Cancel TTS task if running
        if self._tts_task and not self._tts_task.done():
            self._tts_task.cancel()
            try:
                await self._tts_task
            except asyncio.CancelledError:
                pass
        
        # Clear sentence queue
        while not self._sentence_queue.empty():
            try:
                self._sentence_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        
        # Cancel playback wait if active
        self._waiting_for_playback = False
        if self._playback_timeout_task and not self._playback_timeout_task.done():
            self._playback_timeout_task.cancel()
            self._playback_timeout_task = None

        # Transition to LISTENING
        await self.state_machine.transition(
            TurnState.LISTENING,
            reason="User interrupted"
        )
        await self._notify_state_change(TurnState.SPEAKING, TurnState.LISTENING)

        # Complete turn as interrupted
        await self._complete_turn(was_interrupted=True)

    async def handle_playback_complete(self):
        """
        Handle notification from frontend that audio playback has finished.
        
        This triggers the actual SPEAKING → IDLE transition.
        """
        if not self._waiting_for_playback:
            logger.debug("Received playback_complete but not waiting for playback - ignoring")
            return
        
        logger.info("Frontend playback complete - completing turn")
        self._waiting_for_playback = False
        
        # Cancel timeout
        if self._playback_timeout_task and not self._playback_timeout_task.done():
            self._playback_timeout_task.cancel()
            self._playback_timeout_task = None
        
        # Don't send turn_complete again - already sent after TTS streaming
        await self._complete_turn(was_interrupted=False, notify=False)

    async def _playback_timeout(self, timeout_s: float = 15.0):
        """
        Safety timeout: auto-complete turn if playback_complete never arrives.
        
        Args:
            timeout_s: Seconds to wait before auto-completing
        """
        try:
            await asyncio.sleep(timeout_s)
            if self._waiting_for_playback:
                logger.warning(f"Playback timeout after {timeout_s}s - auto-completing turn")
                self._waiting_for_playback = False
                await self._complete_turn(was_interrupted=False, notify=False)
        except asyncio.CancelledError:
            pass  # Normal cancellation when playback_complete arrives

    async def _cancel_speculation(self):
        """
        Cancel speculative LLM execution.
        
        Called when user speaks again before silence timer confirms intent.
        """
        logger.info("Cancelling speculation")

        # Cancel LLM
        self._llm_cancel_event.set()
        
        # Cancel TTS if running
        self._tts_cancel_event.set()
        if self._tts_task and not self._tts_task.done():
            self._tts_task.cancel()
            try:
                await self._tts_task
            except asyncio.CancelledError:
                pass
        
        # Clear sentence queue
        while not self._sentence_queue.empty():
            try:
                self._sentence_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

        # Cancel silence timer
        self.silence_timer.cancel()

        # Unlock buffer
        self.transcript_buffer.unlock()

        # Track cancellation
        self._cancelled_turns += 1

    async def _transition_to_listening(self):
        """Transition to LISTENING state and start turn tracking."""
        current = self.state_machine.current_state
        logger.info(f"_transition_to_listening called, current state: {current}")
        
        if current != TurnState.LISTENING:
            logger.info(f"Attempting transition from {current} to LISTENING")
            await self.state_machine.transition(
                TurnState.LISTENING,
                reason="User audio received"
            )
            logger.info(f"Transition complete, new state: {self.state_machine.current_state}")
            await self._notify_state_change(current, TurnState.LISTENING)
            
            # Start turn tracking
            if self._turn_start_time is None:
                self._turn_start_time = datetime.utcnow()
                logger.info("Started turn tracking")

    async def _reset_to_idle(self, reason: str):
        """
        Reset to IDLE state and clear all buffers.
        
        Args:
            reason: Reason for reset
        """
        current = self.state_machine.current_state
        
        if current != TurnState.IDLE:
            await self.state_machine.transition(TurnState.IDLE, reason=reason)
            await self._notify_state_change(current, TurnState.IDLE)

        # Clear buffers
        self.transcript_buffer.clear()
        self.audio_buffer.clear()
        
        # Reset turn state
        self._llm_response = ""
        self._turn_start_time = None

    async def _notify_state_change(self, from_state: TurnState, to_state: TurnState):
        """Notify state change via callback."""
        try:
            await self.on_state_change(from_state, to_state)
        except Exception as e:
            logger.error(f"Error in state change callback: {e}")

    async def _handle_stt_error(self, error_msg: str):
        """Handle STT errors."""
        await self.on_error("DEEPGRAM_ERROR", error_msg, recoverable=True)

    def update_settings(
        self,
        silence_debounce_ms: Optional[int] = None,
        cancellation_threshold: Optional[float] = None,
        adaptive_debounce_enabled: Optional[bool] = None,
    ):
        """
        Update controller settings at runtime.
        
        Args:
            silence_debounce_ms: New silence debounce duration
            cancellation_threshold: New cancellation rate threshold
            adaptive_debounce_enabled: Enable/disable adaptive debounce
        """
        if silence_debounce_ms is not None:
            self.silence_timer.set_debounce_ms(silence_debounce_ms)
            logger.info(f"Silence debounce updated: {silence_debounce_ms}ms")

        # Additional settings can be implemented as needed

    def get_telemetry(self) -> dict:
        """
        Get current telemetry metrics.
        
        Returns:
            Dict with metrics for monitoring
        """
        cancellation_rate = (
            self._cancelled_turns / self._total_turns
            if self._total_turns > 0
            else 0.0
        )

        return {
            "cancellation_rate": cancellation_rate,
            "avg_debounce_ms": self.silence_timer.get_current_debounce_ms(),
            "turn_latency_ms": 0,  # TODO: Calculate from turn timing
            "total_turns": self._total_turns,
            "tokens_wasted": self._llm_tokens_used["completion"] if self._llm_cancel_event.is_set() else 0,
            "interruption_count": self._cancelled_turns,
        }
