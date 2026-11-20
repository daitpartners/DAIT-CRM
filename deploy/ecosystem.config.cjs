// PM2 apps for the CRM: an api and a worker per environment. Started by deploy/release.sh.
// RELEASE_ROOT overrides /home/daitcrm (tests only).
const fs = require('node:fs');
const root = process.env.RELEASE_ROOT || '/home/daitcrm';

function release(cwd) {
  try { return fs.readFileSync(`${cwd}/RELEASE`, 'utf8').trim() || 'dev'; } catch { return 'dev'; }
}

function app(env, kind, port) {
  const cwd = `${root}/${env}/current`;
  const worker = kind === 'worker';
  return {
    name: worker ? `crm-${env}-worker` : `crm-${env}`,
    cwd,
    script: worker ? 'apps/worker/dist/main.js' : 'apps/api/dist/server.js',
    node_args: `--env-file=${root}/${env}/shared/.env`,
    env: {
      NODE_ENV: 'production',
      ...(worker ? {} : { PORT: String(port), HOST: '127.0.0.1' }),
      WEB_DIST: `${cwd}/apps/web/dist`,
      RELEASE: release(cwd),
    },
    max_memory_restart: '400M',
    // A worker may be mid-send when it is told to stop; the api only has to finish requests.
    kill_timeout: worker ? 30000 : 10000,
  };
}

module.exports = {
  apps: [
    app('live', 'api', 3090),
    app('live', 'worker'),
    app('test', 'api', 3091),
    app('test', 'worker'),
  ],
};
