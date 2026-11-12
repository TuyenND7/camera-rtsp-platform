# Camera Station cho Android

App Android mở web Camera Station trọn khung, không có thanh tiêu đề riêng. Giao diện vẫn được tải từ máy chủ: cập nhật web rồi tải lại trang là thấy UI mới, không phải build lại APK.

- Android 8.0 trở lên, hỗ trợ tablet dọc/ngang.
- Mặc định mở `http://camera.local:8081/live`.
- Nhấn giữ biểu tượng **Camera Station** trong launcher → **Máy chủ** để thay URL LAN/VPN hoặc HTTPS. URL được giữ lại khi mở app lần sau.
- Nhấn giữ biểu tượng app → **Tải lại** để tải lại trang. Khi mất kết nối, màn hình lỗi cũng có nút thử lại và đổi máy chủ. Hỗ trợ nút Back và video toàn màn hình.
- Trong web, dùng nút menu cạnh tiêu đề để ẩn/hiện điều hướng. Nút phóng to ở thanh trên mở toàn bộ Live view ra toàn màn hình và đổi sang biểu tượng thu nhỏ; bố cục lưới/một camera được giữ nguyên. Bấm lại hoặc Back để thoát toàn màn hình. Video tự phát, không có thanh pause/tải lại.
- Các nút trong ô camera mặc định ẩn, chạm vào ô để hiện; chạm lại/bên ngoài hoặc chờ 5 giây để ẩn. Các nút cùng kích thước 44×44. Bấm **×** ở góc ô để bỏ khỏi màn hình xem, không dừng ghi hình. Bấm **+** ở ô trống để mở danh sách thiết bị: camera đang xem được đánh dấu, camera chưa chọn có nút **Chọn** để đưa vào đúng ô đó.
- Dùng logo hiện có của web. Đăng nhập bằng tài khoản web; APK không chứa mật khẩu camera hay tài khoản quản trị.
- Cookie phiên nằm trong dữ liệu riêng của app, không cho cookie bên thứ ba; không bật file access hoặc JavaScript bridge. Không bỏ qua lỗi chứng chỉ HTTPS. WebView debugging chỉ bật ở bản debug để chỉnh UI qua USB.

Tablet phải truy cập được máy chủ qua LAN/VPN. Chỉ cắm USB không tạo đường kết nối tới máy Windows. Nếu `.local` không phân giải được, nhập IP hoặc hostname VPN trong phần địa chỉ máy chủ. HTTP cần mạng tin cậy/VPN như web; app không tự thêm mã hóa cho HTTP.

## Build và cài đặt

Cần JDK 17 và Android SDK Platform 35. Khai báo SDK bằng biến `ANDROID_HOME` hoặc file `local.properties` (không đưa file này lên Git):

```properties
sdk.dir=/duong/dan/toi/Android/sdk
```

Tại thư mục `android`:

```bash
./gradlew :app:assembleDebug :app:lintDebug
adb devices -l
adb -s <SERIAL_LENOVO> install -r app/build/outputs/apk/debug/app-debug.apk
adb -s <SERIAL_LENOVO> shell am start -n vn.tuyen.camerastation/.MainActivity
```

Windows dùng `gradlew.bat` thay cho `./gradlew`. APK debug phục vụ phát triển/cài nội bộ, nằm tại `app/build/outputs/apk/debug/app-debug.apk`; bản phát hành cần ký bằng keystore riêng, không commit khóa ký.

## Chỉnh UI web qua USB

Khi tablet đang nối ADB với máy phát triển, có thể xem giao diện web qua USB mà không cần mở thêm cổng LAN. Tại thư mục `web`:

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 18173 --strictPort
```

Ở terminal khác:

```bash
adb -s <SERIAL_LENOVO> reverse tcp:18173 tcp:18173
```

Nhấn giữ biểu tượng **Camera Station** trong launcher → **Máy chủ**, nhập `http://127.0.0.1:18173/login`. Đây là trang đăng nhập từ source trên máy phát triển, có HMR khi sửa `web/src`. Muốn đăng nhập, xem Live/Playback và dữ liệu thật, cấu hình proxy trong `web/vite.config.ts` tới backend/nginx truy cập được; một frontend chạy riêng không thay thế máy chủ camera. Đổi địa chỉ app về `http://camera.local:8081/live` khi dùng máy chủ thật.

### Xem đầy đủ UI khi không có máy chủ

Thay lệnh `npm run dev` ở trên bằng `npm run dev:ui`. Giữ chuyển tiếp ADB cổng 18173 và mở `http://127.0.0.1:18173/live` trong app; không cần tài khoản/mật khẩu. Trang đăng nhập cũng có nút **Vào bản xem trước UI**.

Chế độ này có camera, video thử 120 giây, recording/timeline, dung lượng, sự kiện, ONVIF/PTZ mẫu. Các thao tác thêm/sửa/xóa chỉ thay đổi dữ liệu trong bộ nhớ của Vite; khởi động lại server sẽ reset. Nhãn **Xem trước UI · dữ liệu mẫu** phân biệt với camera thật. Mọi API được xử lý cục bộ, kể cả khi đã cấu hình `VITE_API_BASE` khác. Không gọi RTSP/ONVIF thật và không đọc DB hay `.env` của máy chủ Windows.

Sáu thiết bị mẫu gồm camera ONVIF có PTZ, camera chỉ RTSP không có ONVIF, camera mất kết nối, camera đang kết nối, camera đã dừng và camera ONVIF cố định không có PTZ. Mặc định lưới 2×2 hiển thị hai camera trực tuyến, một mất kết nối và một đang kết nối. Dùng nút chọn camera để xem đủ sáu thiết bị. Camera offline không phát video mẫu; PTZ trả đúng khả năng từng thiết bị. Nút kết nối lại giữ nguyên tình huống mất kết nối/đang kết nối để thử UI, còn camera đã dừng có thể bật lại. Dò thiết bị cũng có mẫu chỉ hỗ trợ RTSP.

Đây là chế độ **development-only**, không triển khai lên máy chủ camera. `npm run build` giữ xác thực như bình thường; build với `--mode ui-preview` bị chặn. Khi trở lại máy chủ thật, đăng nhập bằng tài khoản web như trước.

Kết thúc phiên phát triển, dừng Vite và gỡ chuyển tiếp USB:

```bash
adb -s <SERIAL_LENOVO> reverse --remove tcp:18173
```
