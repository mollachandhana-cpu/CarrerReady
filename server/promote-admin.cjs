const db=require('./database.cjs')
const email=(process.argv[2]||'').trim().toLowerCase()
if(!email){console.error('Usage: node server/promote-admin.cjs email@example.com');process.exit(1)}
const r=db.prepare("UPDATE users SET role='admin' WHERE email=?").run(email)
console.log(r.changes ? `Promoted ${email} to admin.` : `No user found for ${email}.`)
