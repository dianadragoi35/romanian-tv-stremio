module.exports = {
  apps: [{
    name: 'romanian-tv',
    script: 'addon.js',
    instances: 'max',
    exec_mode: 'cluster',
    max_memory_restart: '400M',
    exp_backoff_restart_delay: 100,
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000
  }]
};
