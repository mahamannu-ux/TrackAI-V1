import { createApp, getAllowedOrigins } from './app';

const app = createApp();
const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 TrackAI API server running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   CORS allowed origins: ${getAllowedOrigins().join(', ')}`);

  console.log("=== API CONFIG CHECK ===");
  console.log("Loaded FRONTEND_URL:", process.env.FRONTEND_URL);
  console.log("Allowed Origins Array:", getAllowedOrigins());
});
