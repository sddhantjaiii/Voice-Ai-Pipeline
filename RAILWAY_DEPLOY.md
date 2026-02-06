# Railway Deployment Guide

## Environment Variables to Set in Railway

```bash
DEEPGRAM_API_KEY=your_deepgram_key
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-3.5-turbo
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
DATABASE_URL=your_railway_postgres_url
ENVIRONMENT=production
LOG_LEVEL=INFO
MIN_SILENCE_DEBOUNCE_MS=400
MAX_SILENCE_DEBOUNCE_MS=1200
CANCELLATION_RATE_THRESHOLD=0.30
HOST=0.0.0.0
PORT=8000
FRONTEND_URL=your_frontend_url
```

## Railway Setup Steps

1. **Connect GitHub Repository**
   - Go to Railway dashboard
   - Click "New Project" → "Deploy from GitHub repo"
   - Select `Voice-Ai-Pipeline` repository

2. **Configure Root Directory**
   - Railway will auto-detect Python
   - Root path: `/` (railway.json handles the backend subdirectory)

3. **Add PostgreSQL Database**
   - Click "New" → "Database" → "Add PostgreSQL"
   - Railway will auto-inject `DATABASE_URL`

4. **Set Environment Variables**
   - Go to project → Variables
   - Copy all variables from `.env` file
   - Change `ENVIRONMENT=production`
   - Update `FRONTEND_URL` to your deployed frontend URL

5. **Deploy**
   - Push changes to main branch
   - Railway will auto-deploy

## Verification

After deployment:
- Check logs: Railway dashboard → Deployments → View logs
- Test health: `https://your-app.railway.app/health`
- Test WebSocket: Connect to `wss://your-app.railway.app/ws/voice`

## Important Notes

- WebSocket connections work on Railway (no extra config needed)
- Database connection uses `asyncpg` for PostgreSQL
- Railway provides automatic HTTPS
- Set correct CORS `FRONTEND_URL` for production
