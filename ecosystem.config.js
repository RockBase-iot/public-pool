module.exports = {
    apps: [
      // Master instance - handles ZMQ, block templates, bulk updates
      {
        name: 'master',
        script: './dist/main.js',
        instances: 1,
        max_memory_restart: process.env.PM2_MAX_MEMORY || '800M',
        node_args: `--max-old-space-size=${process.env.NODE_HEAP_MB || 512}`,
        kill_timeout: 30000,
        env: {
          MASTER: 'true',
          NODE_ENV: 'production'
        },
        time: true
      },
      // Worker instances - handle miner connections
      {
        name: 'workers',
        script: './dist/main.js',
        instances: parseInt(process.env.PM2_WORKERS) || 1,
        exec_mode: "cluster",
        max_memory_restart: process.env.PM2_MAX_MEMORY || '800M',
        node_args: `--max-old-space-size=${process.env.NODE_HEAP_MB || 512}`,
        kill_timeout: 30000,
        env: {
          MASTER: 'false',
          NODE_ENV: 'production'
        },
        time: true
      },
    ],
  };
