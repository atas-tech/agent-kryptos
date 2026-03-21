import pkg from 'pg';
const { Pool } = pkg;
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DATABASE_URL = "postgresql://blindpass:localdev@127.0.0.1:5433/agent_blindpass";
const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

async function resetDb() {
  console.log('🚀 Resetting Database...');
  console.log(`🔗 Connecting to ${databaseUrl.replace(/:[^:]+@/, ':****@')}`);

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1
  });

  try {
    const client = await pool.connect();
    try {
      console.log('🗑️  Dropping and recreating public schema...');
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');
      await client.query('GRANT ALL ON SCHEMA public TO public');
      await client.query('COMMENT ON SCHEMA public IS \'standard public schema\'');
      console.log('✅ Schema reset successful.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ Failed to reset schema:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }

  console.log('🏃 Running migrations...');
  const migrateCmd = spawn('npm', ['run', 'db:migrate', '--workspace=packages/sps-server'], {
    stdio: 'inherit',
    shell: true,
    cwd: path.join(__dirname, '..')
  });

  migrateCmd.on('close', (code) => {
    if (code === 0) {
      console.log('✨ Database reset and migrations complete!');
    } else {
      console.error(`❌ Migrations failed with code ${code}`);
      process.exit(1);
    }
  });
}

resetDb().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
