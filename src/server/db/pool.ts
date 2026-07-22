import 'dotenv/config';
import { Pool } from 'pg';

export const databaseUrl = process.env.DATABASE_URL
  ?? 'postgresql://edubench:edubench@localhost:54329/edubench';

export const db = new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  application_name: process.env.DATABASE_APPLICATION_NAME ?? 'edubench',
});

