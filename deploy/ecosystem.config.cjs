// PM2 app for the CRM API only. Name/port are CRM-specific so it cannot collide with other apps.
// The app loads backend/.env itself (dotenv, from cwd).
// IMPORTANT: keep instances at 1 / fork mode — the outbox publisher and Socket.IO rooms are in-process.
module.exports = {
  apps: [{
    name: 'piweb-crm-api',
    cwd: '/var/www/piweb-crm/backend',          // <-- adjust after inspecting the VPS
    script: 'src/server.js',
    exec_mode: 'fork',
    instances: 1,
    max_memory_restart: '400M',
    kill_timeout: 10000,
    autorestart: true,
  }],
};
