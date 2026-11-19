require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to a Neon PostgreSQL connection string before starting PharmaTrack.');
  process.exit(1);
}

require('./server');
