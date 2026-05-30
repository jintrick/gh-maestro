module.exports = {
  apps: [{
    name: 'agent-runtime',
    script: 'src/daemon.js',
    watch: false,
    autorestart: true,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
