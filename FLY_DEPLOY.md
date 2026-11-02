# Deploying GST OneClick to Fly.io (Free)

Fly.io gives you a real, persistent disk on its free tier, so your SQLite
database survives restarts — unlike most other free hosts, which either
sleep your app or wipe the filesystem on every redeploy.

Free tier covers this comfortably: this app needs one small always-on
machine and a few GB of storage, both within Fly's free allowance.

## 1. Install the Fly CLI

**Mac:**
```bash
curl -L https://fly.io/install.sh | sh
```

**Windows (PowerShell):**
```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

**Linux:**
```bash
curl -L https://fly.io/install.sh | sh
```

Restart your terminal after installing, then confirm it worked:
```bash
fly version
```

## 2. Sign up / log in

```bash
fly auth signup
```
(or `fly auth login` if you already have a Fly.io account — you can sign up
with GitHub since you already have one)

## 3. Launch the app

From inside the `gst-oneclick-app` folder:

```bash
fly launch --no-deploy
```

- It will detect the existing `fly.toml` and `Dockerfile` — say **yes** to
  using the existing configuration.
- It will ask to pick an app name — accept the default or pick your own
  (this becomes `your-name.fly.dev`).
- It will ask about a Postgres/Redis database — say **No** to both, we're
  using SQLite on a mounted volume instead.

## 4. Create the persistent volume

This is the important step — it's what makes your database survive restarts:

```bash
fly volumes create gst_data --region bom --size 1
```

(`bom` = Mumbai. Change this if you'd prefer a different region — just make
sure it matches `primary_region` in `fly.toml`.)

`--size 1` means 1 GB, which is far more than this app needs and still
within the free allowance.

## 5. Set your secrets

These are environment variables Fly stores securely — never put real
secrets directly in `fly.toml`:

```bash
fly secrets set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
```

Once you know your app's URL (step 6 tells you what it is), also set:
```bash
fly secrets set APP_URL=https://your-app-name.fly.dev
```

And your SMTP details, once you have them (see main README for provider
options — Gmail App Password, SendGrid, Resend, etc.):
```bash
fly secrets set SMTP_HOST=smtp.yourprovider.com SMTP_PORT=587 SMTP_USER=youruser SMTP_PASS=yourpass SMTP_FROM="GST OneClick <no-reply@yourdomain.com>"
```

Until SMTP secrets are set, verification/reset emails will just appear in
your Fly logs (`fly logs`) instead of being sent — same fallback behavior
as running locally.

## 6. Deploy

```bash
fly deploy
```

This builds the Docker image and deploys it. When it finishes, it prints
your live URL — something like:

```
https://your-app-name.fly.dev
```

Open that in a browser — your app is now live, on HTTPS, for free, reachable
from any device anywhere.

## 7. Confirm the volume is actually mounted

```bash
fly ssh console
ls /app/data
```

You should see `gst_oneclick.db` (after you've signed up at least one user)
and a `backups/` folder. If this directory is empty after real use, the
volume isn't mounted correctly — check that the `[[mounts]]` section in
`fly.toml` matches the volume name from step 4.

## Making changes later

Edit files locally, then just run:
```bash
fly deploy
```
It rebuilds and redeploys — your database on the volume is untouched by this.

## Viewing logs

```bash
fly logs
```

Useful for seeing backup runs, errors, or logged verification/reset links if
SMTP isn't set up yet.

## Free tier limits to be aware of

- Fly's free allowance covers a small always-on machine (which is what
  `fly.toml` here requests) plus a few GB of storage — this app fits well
  within that.
- If you outgrow the free tier (many users, heavy traffic), Fly will prompt
  you to add a payment method rather than silently failing.
