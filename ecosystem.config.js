module.exports = {
  apps: [{
    name: 'public-pool',
    script: 'dist/main.js',
    instances: parseInt(process.env.PM2_INSTANCES) || 5,
    exec_mode: 'cluster',
    max_memory_restart: '2500M',
    node_args: '--max-old-space-size=2048',
    // Graceful shutdown
    kill_timeout: 30000,
    listen_timeout: 10000,
    // Restart policy
    max_restarts: 10,
    min_uptime: '10s',
    // Logging
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
