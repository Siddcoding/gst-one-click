# Deploying GST OneClick to Your Own Private VPS (DigitalOcean)

This is the recommended setup for a real company product: your own
dedicated virtual server, your own domain, real HTTPS, and full control —
not a shared free tier. ~$6/month. Steps are nearly identical on Linode or
AWS Lightsail if you prefer those instead.

## 1. Create the Droplet (DigitalOcean's term for a VPS)

1. Go to https://cloud.digitalocean.com and sign up / log in
2. Click **Create → Droplets**
3. **Image:** Ubuntu 22.04 (LTS)
4. **Plan:** Basic → Regular → $6/mo (1 GB RAM / 1 vCPU) — comfortably
   enough for this app
5. **Datacenter region:** Bangalore (closest to India, lowest latency for
   most of your clients)
6. **Authentication:** SSH Key (recommended over password)
   - If you don't have one yet, DigitalOcean's page has a "New SSH Key"
     button with instructions to generate one on your own machine first
7. **Hostname:** something like `mfintech-gst-prod`
8. Click **Create Droplet**. Wait ~1 minute. Copy its **public IP address**
   once it's ready.

## 2. Point your domain at it

Go to wherever you bought your domain (GoDaddy, Namecheap, etc.) → DNS
settings → add an **A record**:

| Type | Host | Value (points to) |
|------|------|---------------------|
| A    | `gst` (or `@` for root domain) | your Droplet's IP |

This makes `gst.yourdomain.com` (or `yourdomain.com` if you used `@`)
point at your server. DNS changes can take a few minutes to a few hours
to fully propagate.

## 3. SSH into your Droplet

```bash
ssh root@<your-droplet-ip>
```

## 4. Basic server hardening (do this before anything else)

Create a non-root user (best practice — don't run everything as root):
```bash
adduser mfintech
usermod -aG sudo mfintech
```
Copy your SSH key to the new user so you can still log in:
```bash
rsync --archive --chown=mfintech:mfintech ~/.ssh /home/mfintech
```
From now on, log in as this user instead of root:
```bash
ssh mfintech@<your-droplet-ip>
```

Set up a firewall — only allow SSH, HTTP, and HTTPS:
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 5. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

## 6. Upload your project

From your **local machine**:
```bash
scp -r gst-oneclick-app.zip mfintech@<your-droplet-ip>:/home/mfintech/
```
Back on the **server**:
```bash
sudo apt install -y unzip
unzip gst-oneclick-app.zip
cd gst-oneclick-app
npm install
```

## 7. Configure for production

```bash
nano .env
```

Set these properly:
```
JWT_SECRET=<generate with the command below>
APP_URL=https://gst.yourdomain.com
CORS_ORIGIN=https://gst.yourdomain.com
NODE_ENV=production
```
Generate a real secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Also fill in your real SMTP details here so verification/reset emails
actually send (see main README for provider options).

## 8. Run it permanently with PM2

```bash
sudo npm install -g pm2
pm2 start server.js --name gst-oneclick
pm2 save
pm2 startup
```
Run whatever command `pm2 startup` prints out — this makes the app
survive server reboots.

## 9. Install Nginx + free HTTPS

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/gst-oneclick
```
Paste:
```nginx
server {
    listen 80;
    server_name gst.yourdomain.com;
    location / {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/gst-oneclick /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
sudo certbot --nginx -d gst.yourdomain.com
```

Certbot auto-renews the certificate — nothing more to do for HTTPS.

## 10. Go live

Visit `https://gst.yourdomain.com` — this is now your permanent, private,
professional server, fully under your control.

## Ongoing maintenance

```bash
pm2 status                 # check it's running
pm2 logs gst-oneclick      # view logs
pm2 restart gst-oneclick   # restart after deploying new code
```

**Updating the app later:**
```bash
# on your local machine, zip the updated project, then:
scp gst-oneclick-app.zip mfintech@<your-droplet-ip>:/home/mfintech/
# on the server:
cd ~ && unzip -o gst-oneclick-app.zip -d gst-oneclick-app-new
cp gst-oneclick-app-new/.env gst-oneclick-app/.env  # keep your real secrets
rsync -a --exclude=data --exclude=backups --exclude=node_modules --exclude=.env gst-oneclick-app-new/ gst-oneclick-app/
cd gst-oneclick-app && npm install
pm2 restart gst-oneclick
```

**Off-server backups (important):** the app backs up its own database
daily to `backups/` on the same disk — good for accidental deletion, not
for disk failure. Periodically copy backups elsewhere:
```bash
# from your local machine
scp -r mfintech@<your-droplet-ip>:/home/mfintech/gst-oneclick-app/backups ./mfintech-backups-$(date +%F)
```
For real production use, automate this with a scheduled task that
uploads to something like an S3 bucket or Google Drive, rather than
copying manually.

## Monitoring uptime

Consider a free service like https://uptimerobot.com to ping your live
URL every few minutes and email/SMS you if it ever goes down — cheap
peace of mind for a real client-facing product.
