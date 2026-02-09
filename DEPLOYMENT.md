# Docker Deployment (Hetzner + Ubuntu)

## 1. Install Docker

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

(Optional) allow your user to run Docker without sudo:

```bash
sudo usermod -aG docker $USER
```

Log out/in after this.

## 2. Copy the app

```bash
rsync -av /home/kagabu/sales-dashboard/ ubuntu@<VPS_IP>:/home/ubuntu/sales-dashboard
```

## 3. Configure env

Create `/home/ubuntu/sales-dashboard/.env` with your MySQL and Postgres settings.

## 4. Build & run

```bash
cd /home/ubuntu/sales-dashboard
sudo docker compose up -d --build
```

This starts:
- `app` on port 3000
- `sync` worker (runs every 2 minutes)

## 5. Nginx reverse proxy

```bash
sudo apt install -y nginx
sudo cp /home/ubuntu/sales-dashboard/nginx.conf /etc/nginx/sites-available/sales-dashboard
sudo ln -s /etc/nginx/sites-available/sales-dashboard /etc/nginx/sites-enabled/sales-dashboard
sudo nginx -t && sudo systemctl reload nginx
```

## 6. SSL (recommended)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d dash.zenjji.com
```

## 7. Logs

```bash
sudo docker logs -f sales-dashboard
sudo docker logs -f sales-sync
```
