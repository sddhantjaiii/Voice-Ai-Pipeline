"""
FastAPI application entry point.
Sets up CORS, health check, and WebSocket endpoint.
"""

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.websocket import connection_manager
from app.db.postgres import db
from app.orchestration.turn_controller import TurnController
from app.debug_logger import debug_logger
import time

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Application lifespan context manager.
    Handles startup and shutdown events.
    """
    # Startup
    logger.info("Voice AI Pipeline backend starting...")
    logger.info(f"Environment: {settings.environment}")
    logger.info(f"Host: {settings.host}:{settings.port}")
    logger.info(f"Frontend URL: {settings.frontend_url}")
    logger.info(f"OpenAI Model: {settings.openai_model}")
    logger.info(f"Min silence debounce: {settings.min_silence_debounce_ms}ms")
    logger.info(f"Max silence debounce: {settings.max_silence_debounce_ms}ms")
    logger.info(f"Cancellation threshold: {settings.cancellation_rate_threshold}")
    
    # Initialize database
    try:
        db.init_engine()
        db_healthy = await db.health_check()
        if db_healthy:
            logger.info("Database connection healthy")
        else:
            logger.warning("Database connection unhealthy - continuing without DB")
    except Exception as e:
        logger.error(f"Database initialization failed: {e}")
        logger.warning("Continuing without database connection")
    
    yield
    
    # Shutdown
    logger.info("Voice AI Pipeline backend shutting down...")
    await db.close()


# Create FastAPI application
app = FastAPI(
    title="Voice AI Pipeline API",
    description="Production-grade real-time voice agent system",
    version="0.1.0",
    lifespan=lifespan,
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check() -> JSONResponse:
    """
    Health check endpoint.
    Returns 200 OK if server is running.
    Includes database health status.
    """
    db_healthy = await db.health_check()
    
    return JSONResponse(
        status_code=200,
        content={
            "status": "healthy",
            "environment": settings.environment,
            "version": "0.1.0",
            "database": "healthy" if db_healthy else "unhealthy",
            "active_sessions": connection_manager.get_session_count(),
        }
    )


@app.post("/api/debug/report")
async def submit_debug_report(request: dict) -> JSONResponse:
    """
    Endpoint for clients to submit debug reports.
    Useful for remote debugging of mobile devices.
    """
    try:
        filename = debug_logger.log_client_report(request)
        logger.info(f"Debug report saved: {filename}")
        
        return JSONResponse(
            status_code=200,
            content={
                "status": "success",
                "message": "Debug report received",
                "filename": filename,
            }
        )
    except Exception as e:
        logger.error(f"Failed to save debug report: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "message": str(e),
            }
        )


@app.get("/api/debug/reports")
async def get_debug_reports(limit: int = 20, ios_only: bool = False) -> JSONResponse:
    """
    Get recent debug reports for analysis.
    """
    try:
        if ios_only:
            reports = debug_logger.get_ios_reports(limit)
        else:
            reports = debug_logger.get_recent_reports(limit)
        
        return JSONResponse(
            status_code=200,
            content={
                "status": "success",
                "count": len(reports),
                "reports": reports,
            }
        )
    except Exception as e:
        logger.error(f"Failed to retrieve debug reports: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "message": str(e),
            }
        )


@app.websocket("/ws/voice")
async def voice_websocket(websocket: WebSocket) -> None:
    """
    WebSocket endpoint for real-time voice communication.
    Handles all client-server messaging for the voice agent.
    
    Message flow:
    1. Client connects -> send session_ready
    2. Client sends audio chunks -> process STT
    3. STT final -> trigger LLM
    4. LLM complete -> trigger TTS
    5. TTS chunks -> stream to client
    6. Client can interrupt anytime
    """
    session_id = None
    turn_controller = None
    
    try:
        # Accept connection and create session
        session_id = await connection_manager.connect(websocket)
        logger.info(f"New voice session: {session_id}")
        
        # Initialize Turn Controller with callbacks
        turn_controller = TurnController(
            session_id=session_id,
            on_state_change=lambda from_state, to_state: connection_manager.send_state_change(
                session_id, from_state.value, to_state.value
            ),
            on_transcript_partial=lambda text, confidence: connection_manager.send_message(
                session_id,
                {
                    "type": "transcript_partial",
                    "data": {
                        "text": text,
                        "confidence": confidence,
                        "timestamp": int(time.time() * 1000)
                    }
                }
            ),
            on_transcript_final=lambda text, confidence: connection_manager.send_message(
                session_id,
                {
                    "type": "transcript_final",
                    "data": {
                        "text": text,
                        "confidence": confidence,
                        "timestamp": int(time.time() * 1000)
                    }
                }
            ),
            on_agent_audio=lambda audio_b64, chunk_index, is_final: connection_manager.send_message(
                session_id,
                {
                    "type": "agent_audio_chunk",
                    "data": {
                        "audio": audio_b64,
                        "chunk_index": chunk_index,
                        "is_final": is_final
                    }
                }
            ),
            on_agent_text_fallback=lambda text, reason: connection_manager.send_message(
                session_id,
                {
                    "type": "agent_text_fallback",
                    "data": {"text": text, "reason": reason}
                }
            ),
            on_turn_complete=lambda turn_id, user_text, agent_text, duration_ms, was_interrupted: connection_manager.send_message(
                session_id,
                {
                    "type": "turn_complete",
                    "data": {
                        "turn_id": turn_id,
                        "user_text": user_text,
                        "agent_text": agent_text,
                        "duration_ms": duration_ms,
                        "was_interrupted": was_interrupted,
                        "timestamp": int(time.time() * 1000)
                    }
                }
            ),
            on_error=lambda code, message, recoverable: connection_manager.send_error(
                session_id, code, message, recoverable
            ),
        )
        
        # Start Turn Controller
        await turn_controller.start()
        logger.info(f"Turn Controller started for session {session_id}")
        
        # Message handling loop
        while True:
            # Receive message from client
            data = await websocket.receive_json()
            message_type = data.get("type", "unknown")
            message_data = data.get("data", {})
            
            logger.debug(f"Session {session_id} received: {message_type}")
            
            # Update heartbeat
            connection_manager.update_heartbeat(session_id)
            
            # Route message by type
            if message_type == "ping":
                # Respond to ping with pong
                await websocket.send_json({
                    "type": "pong",
                    "data": {}
                })
            
            elif message_type == "pong":
                # Client responded to our ping - heartbeat already updated
                pass
            
            elif message_type == "disconnect":
                # Client requested disconnect
                logger.info(f"Session {session_id} requested disconnect")
                break
            
            elif message_type == "audio_chunk":
                # Forward to Turn Controller
                await turn_controller.handle_audio_chunk(
                    audio_base64=message_data.get("audio", ""),
                    format=message_data.get("format", "pcm"),
                    sample_rate=message_data.get("sample_rate", 16000)
                )
            
            elif message_type == "interrupt":
                # User interrupted agent speech
                logger.info(f"Session {session_id} interrupted")
                await turn_controller._handle_interrupt()
            
            elif message_type == "playback_complete":
                # Frontend finished playing all audio
                logger.info(f"Session {session_id} playback complete")
                await turn_controller.handle_playback_complete()
            
            elif message_type == "update_settings":
                # Update controller settings
                turn_controller.update_settings(
                    silence_debounce_ms=message_data.get("silence_debounce_ms"),
                    cancellation_threshold=message_data.get("cancellation_threshold"),
                    adaptive_debounce_enabled=message_data.get("adaptive_debounce_enabled"),
                )
            
            elif message_type == "text_input":
                # Handle text input (for testing without microphone)
                text = message_data.get("text", "")
                if text:
                    logger.info(f"Session {session_id} text input: {text}")
                    await turn_controller.handle_final_transcript(text, confidence=1.0)
            
            elif message_type == "connect":
                # Client sent connect message - already handled during connection
                pass
            
            else:
                logger.warning(f"Session {session_id} sent unknown message type: {message_type}")
    
    except WebSocketDisconnect:
        logger.info(f"Session {session_id} disconnected")
    
    except Exception as e:
        logger.error(f"Session {session_id} error: {e}", exc_info=True)
        if session_id:
            await connection_manager.send_error(
                session_id,
                code="WS_INTERNAL_ERROR",
                message_text=f"Internal error: {str(e)}",
                recoverable=False
            )
    
    finally:
        # Cleanup session
        if turn_controller:
            await turn_controller.stop()
        if session_id:
            await connection_manager.disconnect(session_id)
            logger.info(f"Session {session_id} cleaned up")


if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.is_development,
        log_level=settings.log_level.lower(),
    )
