# Deploying GST OneClick to Oracle Cloud (Always Free)

Oracle Cloud's "Always Free" tier gives you a real, permanent virtual
server — not a sandbox that sleeps or wipes itself. This guide sets it up
the same way as a paid VPS (PM2 + Nginx + HTTPS), just on Oracle's free
compute instance instead.

**Note:** Oracle requires a credit card at signup for identity verification.
You will not be charged as long as you stay within Always Free resources,
which this app comfortably fits inside.

## 1. Create your Oracle Cloud account

Go to https://signup.cloud.oracle.com and sign up. Verify your email and
phone number, and add a card (again — for verification only).

## 2. Create a compute instance

Once logged into the Oracle Cloud Console:

1. Go to **Compute → Instances → Create Instance**
2. Name it something like `gst-oneclick`
3. Under **Image and shape**:
   - Image: **Ubuntu 22.04**
   - Shape: click "Change shape" → choose **Ampere (ARM)** → select
     `VM.Standard.A1.Flex` → set **1 OCPU / 6 GB memory** (comfortably
     within the Always Free allowance)
4. Under **Add SSH keys**: choose "Generate a key pair for me" and
   **download both the private and public key** — you'll need the private
   key to connect.
5. Click **Create**. Wait a minute or two for it to show "Running."
6. Copy the instance's **Public IP address** from the instance details page.

## 3. Open the necessary ports (Security List)

By default, only SSH (port 22) is open. We need 80 and 443 too:

1. On the instance details page, click the **subnet** link (under
   "Primary VNIC")
2. Click the **Security List** attached to it (usually "Default Security List")
3. Click **Add Ingress Rules**, and add two rules:
   - Source CIDR: `0.0.0.0/0`, IP Protocol: TCP, Destination Port: `80`
   - Source CIDR: `0.0.0.0/0`, IP Protocol: TCP, Destination Port: `443`
4. Save.

## 4. Connect via SSH

Move the downloaded private key somewhere safe and fix its permissions:

**Mac/Linux:**
```bash
chmod 400 ~/Downloads/ssh-key-....key
ssh -i ~/Downloads/ssh-key-....key ubuntu@<your-instance-public-ip>
```

**Windows (PowerShell):**
```powershell
ssh -i "$HOME\Downloads\ssh-key-....key" ubuntu@<your-instance-public-ip>
```

## 5. Open the instance's own firewall too

Oracle's Ubuntu images also run `iptables`/`netfilter` locally, which
blocks 80/443 by default even after the Security List is opened:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```
(If `netfilter-persistent` isn't found: `sudo apt install -y iptables-persistent` first, then re-run the save command.)

## 6. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

## 7. Upload your project

From your **local machine** (not the server), zip your project folder if
you haven't already, then:

```bash
scp -i ~/Downloads/ssh-key-....key gst-oneclick-app.zip ubuntu@<your-instance-public-ip>:/home/ubuntu/
```

Back on the **server**:
```bash
sudo apt install -y unzip
unzip gst-oneclick-app.zip
cd gst-oneclick-app
```

## 8. Install dependencies and configure

```bash
npm install
```

Edit `.env`:
```bash
nano .env
```
Set a real secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Paste that as `JWT_SECRET=...`. Also set `APP_URL` once you know your
domain or IP (step 10), and SMTP details when you have them.

## 9. Run it permanently with PM2

```bash
sudo npm install -g pm2
pm2 start server.js --name gst-oneclick
pm2 save
pm2 startup
```
(Run the command it prints after `pm2 startup` — this makes it survive
server reboots.)

Quick test: visit `http://<your-instance-public-ip>:4000` — you should see
the app already.

## 10. Put Nginx + HTTPS in front of it (recommended)

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

If you have a domain, point its DNS **A record** at your instance's public
IP first. Then:

```bash
sudo nano /etc/nginx/sites-available/gst-oneclick
```
Paste:
```nginx
server {
    listen 80;
    server_name yourdomain.com;
    location / {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/gst-oneclick /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
sudo certbot --nginx -d yourdomain.com
```

Now `https://yourdomain.com` is live, free, and permanent.

**No domain yet?** You can skip Nginx/HTTPS for now and just use
`http://<your-instance-public-ip>:4000` — fine for testing, but not for
real users, since login credentials would travel unencrypted.

## Useful commands

```bash
pm2 status                # check it's running
pm2 logs gst-oneclick     # view logs
pm2 restart gst-oneclick  # restart after code changes
```

## Backups

The app already backs itself up automatically every 24 hours to the
`backups/` folder. Periodically copy that folder off the server too:
```bash
scp -i ~/Downloads/ssh-key-....key -r ubuntu@<your-instance-public-ip>:/home/ubuntu/gst-oneclick-app/backups ./oracle-backups
```
