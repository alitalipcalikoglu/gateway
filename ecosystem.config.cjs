// PM2 process file for this service. CommonJS on purpose: PM2 loads config files with require().
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     # persist across reboots
// Environment comes from ./.env via Node's --env-file, so secrets never sit in this file.
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'gateway',
      cwd: __dirname,
      script: 'src/index.js',
      node_args: [`--env-file=${path.join(__dirname, '.env')}`],
      exec_mode: 'fork',
      instances: 1,             // run several instances behind a TCP balancer if needed; state is per-process (rate limits, cooldowns)
      autorestart: true,
      exp_backoff_restart_delay: 200,
      max_restarts: 20,
      max_memory_restart: '300M',
      wait_ready: true,         // process.send('ready') after listen()
      listen_timeout: 10000,
      kill_timeout: 40000,      // SIGTERM → finish in-flight proxied requests (UPSTREAM_TIMEOUT_MS + 5s) → exit
      merge_logs: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
