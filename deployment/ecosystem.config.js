// PM2 process config for the Scholarship API on a Hostinger VPS.
// Usage (on the server, inside this repo's deployment folder):
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup systemd
//
// The server calls require('dotenv').config() itself, so it picks up
// /var/www/scholarship/server/.env automatically because `cwd` points there.

module.exports = {
  apps: [
    {
      name: 'scholarship-api',
      cwd: '/var/www/scholarship/server',
      script: 'src/server.js',
      interpreter: 'node',

      // Single instance is fine for a small/medium system. The app uses an
      // in-process hourly timer (award sweep), so keep exec_mode = 'fork'.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      watch: false,

      env: {
        NODE_ENV: 'production',
      },

      // Logs (create the logs dir beforehand or PM2 will create the files)
      out_file: '/var/www/scholarship/logs/api-out.log',
      error_file: '/var/www/scholarship/logs/api-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
