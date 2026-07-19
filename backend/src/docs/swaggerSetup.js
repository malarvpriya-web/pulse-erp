// backend/src/docs/swaggerSetup.js
import { swaggerSpec } from './swagger.js';

/**
 * setupSwagger(app)
 * Mounts Swagger UI at GET /api/docs
 * and raw OpenAPI JSON at GET /api/docs/json
 *
 * Requires: npm install swagger-ui-express
 * (optional — gracefully skips if not installed)
 */
export async function setupSwagger(app) {
  let swaggerUi;
  try {
    swaggerUi = (await import('swagger-ui-express')).default;
  } catch {
    console.warn('[Swagger] swagger-ui-express not installed. Run: npm install swagger-ui-express');
    // Serve raw JSON only
    app.get('/api/docs/json', (_req, res) => res.json(swaggerSpec));
    app.get('/api/docs', (_req, res) => res.send(`
      <html><head><title>Pulse API Docs</title></head>
      <body style="font-family:sans-serif;padding:40px;background:#f5f3ff">
        <h2 style="color:#7c3aed">Pulse ERP API Documentation</h2>
        <p>swagger-ui-express is not installed. Install it to view the interactive UI:</p>
        <pre style="background:#1e1e2e;color:#cdd6f4;padding:16px;border-radius:8px">npm install swagger-ui-express</pre>
        <p><a href="/api/docs/json" style="color:#7c3aed">View raw OpenAPI JSON →</a></p>
      </body></html>
    `));
    return;
  }

  // Custom CSS to match Pulse purple theme
  const customCss = `
    .swagger-ui .topbar { background-color: #7c3aed !important; }
    .swagger-ui .topbar-wrapper .link { display: none; }
    .swagger-ui .topbar::before { content: '⚡ Pulse ERP API'; color: #fff; font-size: 18px; font-weight: 700; padding-left: 24px; line-height: 50px; }
    .swagger-ui .btn.authorize { background: #7c3aed; border-color: #7c3aed; color: #fff; }
    .swagger-ui .btn.authorize svg { fill: #fff; }
    .swagger-ui .opblock.opblock-post .opblock-summary-method { background: #7c3aed; }
    .swagger-ui section.models { border: 1px solid #e9e4ff; }
    .swagger-ui section.models h4 { background: #f5f3ff; }
    body { background: #f5f3ff; }
  `;

  const swaggerOptions = {
    explorer: true,
    swaggerOptions: {
      persistAuthorization: true,
      tryItOutEnabled: true,
      displayRequestDuration: true,
      defaultModelsExpandDepth: 2,
      defaultModelExpandDepth: 2,
      onComplete: () => {
        // Pre-populate Authorization header from localStorage
        const token = typeof window !== 'undefined' && window.localStorage?.getItem('token');
        if (token) {
          try {
            window.ui.preauthorizeApiKey('BearerAuth', `Bearer ${token}`);
          } catch (_) {}
        }
      },
    },
    customCss,
    customSiteTitle: 'Pulse ERP — API Docs',
    customfavIcon: '/favicon.ico',
  };

  // Mount swagger UI
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, swaggerOptions)
  );

  // Raw OpenAPI JSON
  app.get('/api/docs/json', (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="pulse-erp-openapi.json"');
    res.json(swaggerSpec);
  });

  console.log('[Swagger] UI available at /api/docs');
  console.log('[Swagger] Raw JSON at /api/docs/json');
}
