import express from 'express';
import { errorHandler } from '../../middlewares/errorHandler.js';

/**
 * Builds a minimal Express app mounting only the routes under test.
 * Does NOT start listeners, crons, or DB migrations.
 *
 * @param  {...[string, Router]} mounts  e.g. ['/api/auth', authRouter]
 */
export function buildApp(...mounts) {
  const app = express();
  app.use(express.json());
  for (const [path, ...middlewaresAndRouter] of mounts) {
    app.use(path, ...middlewaresAndRouter);
  }
  app.use(errorHandler);
  return app;
}
