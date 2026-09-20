const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '../../database/migrations');

const runMigration = (file) => {
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  console.log(Running migration: );
  execSync(mysql -u  -p -h   < , { stdio: 'inherit' });
};

const migrate = () => {
  const files = fs.readdirSync(migrationsDir).sort();
  files.forEach(file => {
    if (file.endsWith('.sql')) {
      runMigration(file);
    }
  });
};

migrate();
