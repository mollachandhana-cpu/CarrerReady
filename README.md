# CareerReady — Real-World Career Platform

CareerReady is a React/Vite + Express + SQLite career-readiness platform with separate student and mentor workflows.

## What is real in this version
- Student accounts and persistent profiles
- Career assessment, role matching, roadmaps and readiness index
- Resume intelligence and job matching
- Project recommendations based on skill gaps
- AI interview evaluation through the OpenAI Responses API (optional key)
- Browser microphone transcription for interview answers when supported
- Human mentor applications, verification status, student connection requests, sessions, evaluations, tasks and resources
- Peer community with posts, replies, likes and reports
- Live jobs from public feeds
- Realtime browser updates through SSE

## Mentor workflow
1. A real person creates a normal CareerReady account.
2. They open Find a Mentor → Become a CareerReady mentor.
3. They submit expertise, experience, company, LinkedIn, rate and availability.
4. An administrator verifies the profile before it appears in the verified mentor directory.
5. Students request the mentor.
6. Mentor accepts the student.
7. Mentor reviews the student's profile, assessment evidence, resume and applications.
8. Mentor schedules a session, assigns tasks and writes scored evaluations.
9. Student sees tasks, sessions and feedback in their account.

The seeded internship/company data in the project is demo data. Mentor accounts are intended to be created by actual people; the app does not pretend demo mentors are real people.

## Run locally
```bash
npm install
cp .env.example .env
npm run dev:full
```
Open http://localhost:5173

Backend defaults to port 6000.

## Real AI
OpenAI API keys are server-side only. The current OpenAI quickstart uses the Responses API and environment variables for the key. Do not put the key in React code or GitHub.

Set:
```env
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-5.6-luna
```
If your API project does not expose that model ID, set OPENAI_MODEL to a model available to your project.

The AI interview evaluator measures observable answer quality and communication signals. It does not claim to measure consciousness, mental health, personality, or hidden mental state.

## Optional integrations
```env
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:6000/api/integrations/google/callback
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```
These variables are reserved for production communication, calendar and paid-mentor workflows. Do not commit secrets.

## Production
Set `NODE_ENV=production`, `DATA_DIR=/var/data` on a persistent disk, and configure the environment variables in your hosting provider. Run `npm run build` then `npm start`.


---

# Version 4: going live with real mentors

## What changed in v4
- **Mentor flow works end to end in the UI.** Mentors can accept/decline requests, review student evidence, publish availability, run sessions and leave feedback. Students see their sessions, tasks, evaluations and mentor resources.
- **Booking.** Mentors publish time slots; accepted students book them; a private video room (Jitsi, free, no account) is created and emailed to both.
- **Ratings.** Students rate finished sessions; mentors show average rating and review count.
- **Admin Panel.** Approve or reject mentor applications, create invite codes for people you trust, remove reported posts, suspend accounts.
- **Safer accounts.** Passwords need 8+ characters, email verification, password reset by email, rate limits on login/signup/AI, security headers, no mentor emails exposed to students, no role given before approval.
- **`.env` actually loads now** (`server/env.cjs`), so API keys work locally.

## Finding real mentors
The app cannot invent people; it gives you a safe pipeline to onboard them:
1. Ask your faculty, alumni cell, seniors working in industry, or LinkedIn contacts.
2. In the Admin Panel create an **invite code** (optionally locked to their email) and send it.
3. They sign up, open *Find a Mentor*, fill the form and enter the code. Uninvited applicants wait in the review queue until you approve them.

## Set up email (required for a real launch)
```bash
npm install            # installs nodemailer
```
Put `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` and `APP_URL` in `.env`. Without SMTP the app still runs locally: emails are printed in the server console and new accounts count as verified.

## Make yourself admin
```bash
npm run promote-admin -- you@example.com
```
Log out and back in, then open **Admin Panel**.

## Deploy on Render (steps)
1. Push the project to GitHub (never commit `.env`).
2. Render → New → Blueprint → pick the repo (uses `render.yaml`).
3. In the Render dashboard fill the secret variables: `APP_URL`, `MAIL_FROM`, and **either** `RESEND_API_KEY` (recommended: HTTPS, works where outbound SMTP is blocked) **or** `SMTP_*`; optionally `OPENAI_API_KEY`, `TWILIO_*`.
4. The persistent disk at `/var/data` holds the SQLite database. Keep it, and download backups regularly.
5. Check `https://your-app/api/health`.

## Not included yet
Online payments (Stripe) and Google Calendar sync are not built. `hourly_rate` is informational only until payments exist.


---

# Launch hardening (v4.1)
- Suspended accounts are rejected on every request and on the live-update stream; the stream also honours the 30-day session limit.
- Session tokens are stored hashed. **All existing logins are signed out once on first deploy.**
- Password hashing no longer blocks the server (async scrypt).
- Mentor tasks, evaluations and sessions can only target students connected to that mentor; meeting links must be https and times valid and in the future.
- Profile updates only change fields that were sent, with length and format checks.
- One like per person per post.
- Email: set `RESEND_API_KEY` to send over HTTPS instead of SMTP.
- Backups: a snapshot is written nightly to `$DATA_DIR/backups` (newest 7 kept). Admins can download a fresh one at `/api/admin/backup`. **Download one regularly: a copy on the same disk does not protect you if the disk is lost.**
- Static caching: HTML is never cached, hashed assets are cached for a year, so deploys take effect immediately.
- SQLite: busy timeout, indexes on hot columns, clean shutdown on Render's SIGTERM.
- Still true: one instance only (persistent disk), and a short outage on each deploy.
