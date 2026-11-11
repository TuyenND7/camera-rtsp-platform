server_name _;
server_tokens off;
client_max_body_size 16k;

# Inherited by every location, including denied requests and media files.
add_header Cache-Control "private, no-store" always;
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options DENY always;
add_header Referrer-Policy no-referrer always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" always;

# Web admin (React static build served by 'web' service)
location / {
    proxy_pass http://web:80;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
}

# Backend API
location /api/ {
    proxy_pass http://backend:4000/api/;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    # Replace untrusted client headers; backend trusts exactly this proxy hop.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_hide_header Cache-Control;
}

# No IP/subnet bypass, URL tokens or successful-auth cache. Logout revokes
# the next file request, including URLs copied from an authenticated browser.
location = /_media_auth {
    internal;
    proxy_pass http://backend:4000/api/auth/media;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Host $http_host;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# HLS live streams (served directly from storage volume)
location /live/ {
    auth_request /_media_auth;
    limit_except GET { deny all; }
    alias /storage/live/;
    types {
        application/vnd.apple.mpegurl m3u8;
        video/mp2t ts;
    }
}

# Recording playback (HLS index + ts segments)
location /rec/ {
    auth_request /_media_auth;
    limit_except GET { deny all; }
    alias /storage/rec/;
    types {
        application/vnd.apple.mpegurl m3u8;
        video/mp2t ts;
        video/mp4 mp4;
    }
}

# HLS H.264 tương thích browser, được tạo từ recording HEVC khi cần.
# Chỉ khớp file .m3u8/.ts: đường dẫn /playback/<id> còn là route của web
# (React), nếu dùng prefix /playback/ thì F5 trang Playback bị nginx redirect sai.
location ~ ^/playback/.+\.(m3u8|ts)$ {
    auth_request /_media_auth;
    limit_except GET { deny all; }
    root /storage;
    types {
        application/vnd.apple.mpegurl m3u8;
        video/mp2t ts;
    }
}

# Ảnh preview timeline Playback (sprite JPEG do backend tạo từ recording).
location /thumbs/ {
    auth_request /_media_auth;
    limit_except GET { deny all; }
    alias /storage/thumbs/;
    types {
        image/jpeg jpg;
    }
}

# Ảnh snapshot do AI tạo; metadata/event list vẫn phải đi qua API có JWT.
location /events/ {
    auth_request /_media_auth;
    limit_except GET { deny all; }
    alias /storage/events/;
    types {
        image/jpeg jpg jpeg;
        image/png png;
    }
}
