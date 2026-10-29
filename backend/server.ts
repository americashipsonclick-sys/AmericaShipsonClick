import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { closeDb, db, initDb, pingDb } from '../database';
import { apiRouter, serveUpload } from './routes';

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  // Body parsing middleware
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: true, limit: '256kb' }));

  // Connect, migrate, and seed before accepting traffic. A failure here is
  // fatal: serving requests without a schema just yields 500s on every route.
  const dbInfo = await initDb();

  if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  // Baseline response headers. In production, an HTTP hop behind the proxy
  // is sent to HTTPS before any page or API response is written.
  app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production') {
      const host = req.headers.host || '';
      const forwarded = req.headers['x-forwarded-proto'];
      const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded || '').split(',')[0].trim();
      const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
      if (!isLocal && proto === 'http') {
        res.redirect(301, `https://${host}${req.originalUrl}`);
        return;
      }
      if (!isLocal) {
        res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
      }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Uploaded documents are stored in Postgres (the container disk is wiped on
  // every deploy) and served back as downloads.
  app.get('/uploads/:name', serveUpload);

  // Health check (includes a live database round-trip)
  app.get('/api/health', async (req, res) => {
    const dbReachable = await pingDb();
    res.status(dbReachable ? 200 : 503).json({
      status: dbReachable ? 'ok' : 'degraded',
      service: 'America Ships On Click API',
      database: {
        driver: dbInfo.driver,
        target: dbInfo.description,
        reachable: dbReachable
      }
    });
  });

  // Mount API Routes FIRST
  app.use('/api', apiRouter);

  // Development vs Production static/Vite serving
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] America Ships On Click server running on http://0.0.0.0:${PORT}`);
    console.log(`[SERVER] Database: ${db.description} (driver: ${dbInfo.driver})`);
  });

  // Release pooled database connections on shutdown so Postgres does not keep
  // dead backends around across restarts and redeploys.
  const shutdown = (signal: string) => {
    console.log(`[SERVER] ${signal} received, shutting down...`);
    server.close(async () => {
      await closeDb().catch(err => console.error('[DB] Error closing pool:', err.message));
      process.exit(0);
    });
    // Don't hang forever on lingering SSE connections.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch(async err => {
  console.error('[SERVER] Fatal server error:', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
