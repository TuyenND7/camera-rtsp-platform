# UI preview data

`npm run dev:ui` bật Vite middleware trong `uiPreview.ts`. Dữ liệu chỉ tồn tại trong bộ nhớ, mọi API chưa có mẫu trả 404 cục bộ, không chuyển tiếp tới backend. Chế độ bình thường và production build không cài middleware này. Validator cài đặt dùng chung với backend được nạp qua Vite SSR khi bật preview; build Docker của web không cần thư mục backend trong build context.

`media/sample.mp4` là video test pattern tự tạo, 640×360, H.264, 10 fps, 120 giây, không có audio hay cảnh quay camera riêng tư. Dùng chung cho các ô Live và Playback; video có thể pause/seek/đổi tốc độ để kiểm tra UI. Ảnh sự kiện và thumbnail là SVG minh họa do middleware tạo.

Có thể tạo lại video bằng FFmpeg (không cần FFmpeg để chạy preview sau khi đã có file):

```bash
ffmpeg -nostdin -hide_banner -f lavfi -i 'testsrc=size=640x360:rate=10:duration=120' -c:v libx264 -preset veryfast -crf 32 -profile:v baseline -g 20 -pix_fmt yuv420p -movflags +faststart dev/media/sample.mp4
```
