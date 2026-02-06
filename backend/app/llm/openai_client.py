"""
OpenAI GPT streaming client for agent responses.

Supports:
- Cancellation via asyncio.Event for speculative execution
- Sentence-level streaming for faster TTS handoff
"""

import asyncio
import logging
import re
from typing import AsyncGenerator, Optional, Callable
import json
from websockets import connect, WebSocketClientProtocol
from websockets.exceptions import WebSocketException

from app.config import settings

logger = logging.getLogger(__name__)

# Sentence boundary pattern: ends with .!? followed by space or end
SENTENCE_END_PATTERN = re.compile(r'[.!?](?:\s|$)')


class OpenAIClient:
    """
    Manages streaming connection to OpenAI for LLM responses.
    
    Features:
    - Streaming token generation with cancellation support
    - Punctuation detection for TTS handoff
    - Token counting for cost tracking
    - Single retry on failure (5s timeout)
    """

    def __init__(self):
        self.api_key = settings.openai_api_key
        self.model = settings.openai_model
        self.base_url = "https://api.openai.com/v1/chat/completions"
        self.organization_id = settings.openai_organization_id
        self.project_id = settings.openai_project_id
        self.use_priority_api = settings.openai_use_priority_api

    async def generate_response(
        self,
        messages: list[dict],
        cancel_event: asyncio.Event,
        on_token: Optional[Callable[[str], None]] = None,
    ) -> Optional[tuple[str, int, int]]:
        """
        Generate streaming response from OpenAI GPT.

        Args:
            messages: Full chat message list (system/user/assistant)
            cancel_event: Event to signal cancellation
            on_token: Optional callback for each token (for streaming to TTS)

        Returns:
            Tuple of (full_response, prompt_tokens, completion_tokens) or None if cancelled
        """
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "temperature": 0.7,
            "max_tokens": 200,
        }

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        
        # Add priority API headers
        if self.use_priority_api:
            headers["x-stainless-priority"] = "high"
        
        # Add organization and project IDs if provided
        if self.organization_id:
            headers["OpenAI-Organization"] = self.organization_id
        if self.project_id:
            headers["OpenAI-Project"] = self.project_id

        full_response = ""
        prompt_tokens = 0
        completion_tokens = 0
        first_token_received = False

        try:
            # Use aiohttp or httpx for streaming
            import aiohttp
            
            timeout = aiohttp.ClientTimeout(total=30, connect=5)
            
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    self.base_url,
                    headers=headers,
                    json=payload
                ) as response:
                    
                    if response.status != 200:
                        error_text = await response.text()
                        logger.error(f"OpenAI API error {response.status}: {error_text}")
                        return None

                    # Stream tokens
                    async for line in response.content:
                        # Check for cancellation
                        if cancel_event.is_set():
                            logger.info("LLM generation cancelled")
                            return None

                        line = line.decode('utf-8').strip()
                        if not line or not line.startswith('data: '):
                            continue

                        data_str = line[6:]  # Remove 'data: ' prefix
                        
                        if data_str == '[DONE]':
                            break

                        try:
                            data = json.loads(data_str)
                            
                            # Extract token
                            if 'choices' in data and len(data['choices']) > 0:
                                delta = data['choices'][0].get('delta', {})
                                content = delta.get('content', '')
                                
                                if content:
                                    full_response += content
                                    completion_tokens += 1
                                    
                                    # Log first token to verify streaming
                                    if not first_token_received:
                                        first_token_received = True
                                        logger.info(f"✅ LLM streaming: First token received ('{content}')")
                                    
                                    # Stream token to TTS
                                    if on_token:
                                        on_token(content)

                            # Extract usage info (sent in last chunk)
                            if 'usage' in data:
                                prompt_tokens = data['usage'].get('prompt_tokens', 0)
                                completion_tokens = data['usage'].get('completion_tokens', completion_tokens)

                        except json.JSONDecodeError as e:
                            logger.warning(f"Failed to parse SSE data: {e}")
                            continue

            logger.info(f"LLM generation complete: {len(full_response)} chars, {completion_tokens} tokens")
            return (full_response, prompt_tokens, completion_tokens)

        except asyncio.CancelledError:
            logger.info("LLM generation task cancelled")
            return None
        except Exception as e:
            logger.error(f"Error during LLM generation: {e}")
            return None

    async def stream_sentences(
        self,
        messages: list[dict],
        cancel_event: asyncio.Event,
    ) -> AsyncGenerator[tuple[str, bool], None]:
        """
        Stream sentences from OpenAI as they complete.
        
        Yields sentences as soon as sentence-ending punctuation is detected,
        enabling TTS to start before full response completes.
        
        Args:
            messages: Full chat message list (system/user/assistant)
            cancel_event: Event to signal cancellation
            
        Yields:
            Tuple of (sentence_text, is_final) - is_final=True on last sentence
        """
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "temperature": 0.7,
            "max_tokens": 200,
        }

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        
        # Add priority API headers
        if self.use_priority_api:
            headers["x-stainless-priority"] = "high"
        
        # Add organization and project IDs if provided
        if self.organization_id:
            headers["OpenAI-Organization"] = self.organization_id
        if self.project_id:
            headers["OpenAI-Project"] = self.project_id

        sentence_buffer = ""
        first_token_received = False
        total_tokens = 0

        try:
            import aiohttp
            
            timeout = aiohttp.ClientTimeout(total=30, connect=5)
            
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    self.base_url,
                    headers=headers,
                    json=payload
                ) as response:
                    
                    if response.status != 200:
                        error_text = await response.text()
                        logger.error(f"OpenAI API error {response.status}: {error_text}")
                        return

                    # Stream tokens and yield sentences
                    async for line in response.content:
                        # Check for cancellation
                        if cancel_event.is_set():
                            logger.info("LLM sentence streaming cancelled")
                            return

                        line = line.decode('utf-8').strip()
                        if not line or not line.startswith('data: '):
                            continue

                        data_str = line[6:]  # Remove 'data: ' prefix
                        
                        if data_str == '[DONE]':
                            break

                        try:
                            data = json.loads(data_str)
                            
                            if 'choices' in data and len(data['choices']) > 0:
                                delta = data['choices'][0].get('delta', {})
                                content = delta.get('content', '')
                                
                                if content:
                                    sentence_buffer += content
                                    total_tokens += 1
                                    
                                    # Log first token
                                    if not first_token_received:
                                        first_token_received = True
                                        logger.info(f"✅ LLM streaming: First token received ('{content}')")
                                    
                                    # Check for sentence boundary
                                    # Look for .!? followed by space or at end of buffer
                                    match = SENTENCE_END_PATTERN.search(sentence_buffer)
                                    if match:
                                        # Extract complete sentence(s)
                                        end_pos = match.end()
                                        sentence = sentence_buffer[:end_pos].strip()
                                        sentence_buffer = sentence_buffer[end_pos:].lstrip()
                                        
                                        if sentence:
                                            logger.info(f"📝 Yielding sentence ({len(sentence)} chars): {sentence[:50]}...")
                                            yield (sentence, False)  # Not final yet

                        except json.JSONDecodeError as e:
                            logger.warning(f"Failed to parse SSE data: {e}")
                            continue

            # Yield any remaining text as final sentence
            if sentence_buffer.strip():
                final_sentence = sentence_buffer.strip()
                logger.info(f"📝 Yielding final sentence ({len(final_sentence)} chars): {final_sentence[:50]}...")
                yield (final_sentence, True)
            
            logger.info(f"LLM sentence streaming complete: {total_tokens} tokens")

        except asyncio.CancelledError:
            logger.info("LLM sentence streaming task cancelled")
            return
        except Exception as e:
            logger.error(f"Error during LLM sentence streaming: {e}")
            return

    async def detect_sentence_boundary(self, text: str) -> bool:
        """
        Check if text contains sentence-ending punctuation.
        
        Used to determine when to start TTS (wait for first complete sentence).
        
        Args:
            text: Accumulated text to check
            
        Returns:
            True if contains sentence boundary (.?!)
        """
        return any(punct in text for punct in ['.', '?', '!'])

    def estimate_prompt_tokens(self, text: str) -> int:
        """
        Rough estimation of token count (1 token ≈ 4 chars).
        
        Args:
            text: Text to estimate
            
        Returns:
            Estimated token count
        """
        return len(text) // 4
