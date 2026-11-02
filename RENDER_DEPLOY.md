# Deploying GST OneClick to Render.com (Fastest — For Testing)

This is the closest thing to a "1-click" deploy for this app. Good for
quickly testing that everything works live. Not recommended as your
permanent home once you have real users — see the note on storage below.

## Storage note (read this first)

Render's free tier does not include a persistent disk. Your SQLite
database will reset whenever the app redeploys or wakes up from being
asleep due to inactivity. Fine for testing the app end-to-end. Not fine
for keeping real client signups/history long-term — for that, use
`FLY_DEPLOY.md` or `ORACLE_DEPLOY.md` instead, both of which include
real persistent storage.

## 1. Push this project to GitHub

If you don't already have this project in a GitHub repo:

1. Go to https://github.com/new, create a new repository (e.g. `gst-oneclick`)
2. In your project folder:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/gst-oneclick.git
   git push -u origin main
   ```

## 2. Deploy on Render

1. Go to https://render.com and sign in with GitHub
2. Click **New +** → **Blueprint**
3. Select your `gst-oneclick` repository
4. Render detects the included `render.yaml` automatically and shows the
   service it's about to create — click **Apply**
5. It will ask you to fill in one value: `APP_URL` — leave it blank for now,
   we'll fill it in after the first deploy gives you the URL
6. Click **Deploy**

Render builds the Docker image and deploys it — takes 2-3 minutes the
first time. When done, it gives you a URL like:

```
https://gst-oneclick.onrender.com
```

## 3. Set APP_URL

Go to your service in the Render dashboard → **Environment** tab → set
`APP_URL` to the URL from step 2 → save. It'll redeploy automatically.

## 4. Open it

Visit your `.onrender.com` URL — the app is live.

## Free tier behavior to expect

- The app **sleeps after 15 minutes of inactivity**. The next visit after
  that will take ~30-50 seconds to "wake up" — this is normal, not a bug.
- **The database resets on sleep/wake and on every redeploy.** Great for
  quick functional testing, not for anything you want to keep.

## Updating the app later

Just push to GitHub — Render redeploys automatically:
```bash
git add .
git commit -m "Update"
git push
```

## When you're ready for something permanent

Once you've confirmed everything works the way you want, move to
`FLY_DEPLOY.md` or `ORACLE_DEPLOY.md` for a version where signups and
history actually stick around.
