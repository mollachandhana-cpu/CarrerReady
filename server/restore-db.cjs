// Runs before the server (see "start" in package.json). Always exits 0 so the site still boots.
require('./env.cjs')
require('./remote-backup.cjs').restore().then(() => process.exit(0), (e) => { console.error('[restore] unexpected error:', e); process.exit(0) })
