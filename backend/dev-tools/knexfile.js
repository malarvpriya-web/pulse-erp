import dotenv from 'dotenv';
dotenv.config();

/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */
export default {
  development: {
    client: 'pg',
    connection: process.env.DATABASE_URL || {
      host:     process.env.DB_HOST || 'localhost',
      port:     process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'Pulse',
      user:     process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '1234567890',
    },
    migrations: {
      directory: './src/database/migrations',
      tableName: 'knex_migrations',
    },
    seeds: {
      directory: './src/database/seeds',
    },
  },

  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: {
      min: 2,
      max: 10
    },
    migrations: {
      directory: './src/database/migrations',
      tableName: 'knex_migrations',
    },
  }
};
