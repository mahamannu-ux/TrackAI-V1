import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { authenticateJWT } from './middleware/auth';
import itemsRouter from './routes/items';
import dotenv from 'dotenv';

// MUST BE FIRST - before any process.env references
dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

// ---------------------------------------------------------------------------
// CORS Configuration
// ---------------------------------------------------------------------------
// Allow cross-origin requests from the frontend.
// FRONTEND_URL is configurable per environment:
//   - Local dev: http://localhost:3000
//   - Production: https://your-app.vercel.app or your custom domain
// This decoupled approach ensures the backend doesn't hardcode any frontend URL.
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',');

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));



// Parse JSON request bodies
app.use(express.json());

// ---------------------------------------------------------------------------
// Health Check (unauthenticated)
// ---------------------------------------------------------------------------
// Cloud Run uses this to determine if the container is ready to serve traffic.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Protected API Routes
// ---------------------------------------------------------------------------
// All /api/* routes require a valid Supabase JWT.
// The authenticateJWT middleware verifies the token before any route handler runs.
app.use('/api/items', authenticateJWT, itemsRouter);


// Fixed Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("❌ Caught Backend Error:", err.message);
  console.error(err.stack);

  // Re-verify the origin header to prevent the browser from masking the error
  const origin = req.headers.origin;
  if (origin && (process.env.FRONTEND_URL || '').includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.status(500).json({
    error: "Internal Server Error",
    details: err.message
  });
});


// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 TrackAI API server running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   CORS allowed origins: ${allowedOrigins.join(', ')}`);

  console.log("=== API CONFIG CHECK ===");
  console.log("Loaded FRONTEND_URL:", process.env.FRONTEND_URL);
  console.log("Allowed Origins Array:", allowedOrigins);
});
