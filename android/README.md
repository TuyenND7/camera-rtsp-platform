# Camera Station cho Android

## Widget trên launcher (0.4.0)

1. Đăng nhập Camera Station trên thiết bị, rồi trở về màn hình chính.
2. Trên Glass Launcher, chọn **Widget + → Camera Station**. Trên launcher Android khác, nhấn giữ màn hình chính → **Widget** → **Camera Station**.
3. Chọn camera trong danh sách. Có thể thêm nhiều widget, mỗi widget chọn riêng một camera; kéo/đổi kích thước theo khả năng của launcher.
4. Widget hiển thị ảnh từ đoạn Live đã có trên máy chủ. Chạm ảnh để mở Live đúng camera; chạm nút làm mới để tải ảnh mới. Widget tự yêu cầu cập nhật khoảng 15 phút, Android có thể trì hoãn để tiết kiệm pin. Đây là ảnh tĩnh, không phải video liên tục; nhãn **Cập nhật** là lúc tải ảnh về, có thể chậm hơn hình thực tế vài giây.

Widget dùng phiên đăng nhập của app và lấy dữ liệu qua địa chỉ máy chủ đã cấu hình; không mở phiên RTSP trực tiếp. Nếu camera offline, máy chủ đổi địa chỉ, phiên hết hạn hoặc mạng mất, widget hiện lý do và cần làm mới/đăng nhập lại. Hình có thể còn trên màn hình đến lượt cập nhật tiếp theo; lưu ý khi chia sẻ thiết bị. Khi đổi máy chủ, gỡ và thêm lại widget để chọn đúng camera. Widget cần máy chủ đang chạy và có kết nối mạng phù hợp.

App Android mở web Camera Station trọn màn hình, không có thanh tiêu đề riêng. Từ bản 0.2.2, thanh trạng thái và thanh điều hướng Android tự ẩn ngay khi mở app và khi quay lại app; vuốt từ cạnh màn hình để hiện tạm các nút hệ thống. Thoát chế độ phóng to video vẫn giữ app toàn màn hình. Bàn phím và vùng khuyết màn hình vẫn được chừa chỗ. Giao diện vẫn được tải từ máy chủ: cập nhật web rồi tải lại trang là thấy UI mới, không phải build lại APK.

- Android 8.0 trở lên, hỗ trợ tablet dọc/ngang.
- Từ **0.3.1**, mặc định mở public HTTPS: `https://camera.taild8cb98.ts.net:8443/live`; thiết bị xem không cần Tailscale. Máy CAMERA vẫn cần chạy Tailscale/Funnel và có Internet.
- Khi nâng cấp, app chuyển một lần từ các địa chỉ CAMERA cũ (`camera.local:8081`, IP Windows đã dùng, hoặc link Tailscale riêng cổng 443) sang public, giữ đường dẫn/trang đang chọn. URL tùy chỉnh khác giữ nguyên. Sau lần nâng cấp này, nếu người dùng chọn lại LAN/VPN thì app giữ lựa chọn đó. Cookie và dữ liệu đăng nhập không bị xóa; nếu chuyển hostname cần đăng nhập web lại.
- Nhấn giữ biểu tượng **Camera Station** trong launcher → **Máy chủ** để thay URL LAN/VPN hoặc HTTPS. URL được giữ lại khi mở app lần sau.
- Nhấn giữ biểu tượng app → **Tải lại** để tải lại trang. Từ **0.3.2**, màn hình lỗi chỉ có nút **Tải lại trang** kèm icon Imagegen; không hiển thị URL hoặc nút Địa chỉ máy chủ. Muốn thay địa chỉ, dùng shortcut **Máy chủ** trong launcher. Hỗ trợ nút Back và video toàn màn hình.
- Trong web, dùng nút menu cạnh tiêu đề để ẩn/hiện điều hướng. App tự mở toàn màn hình; nút phóng to/thu nhỏ cạnh bố cục trên Live view mở riêng vùng xem ra toàn màn hình và dùng được cả khi mở web bằng trình duyệt. Video tự phát, không có thanh pause/tải lại.
- Các nút trong ô camera mặc định ẩn, chạm vào ô để hiện; chạm lại/bên ngoài hoặc chờ 5 giây để ẩn. Các nút cùng kích thước 44×44. Bấm **×** ở góc ô để bỏ khỏi màn hình xem, không dừng ghi hình. Bấm **+** ở ô trống để mở danh sách thiết bị: camera đang xem được đánh dấu, camera chưa chọn có nút **Chọn** để đưa vào đúng ô đó.
- Dùng logo hiện có của web. Đăng nhập bằng tài khoản web; APK không chứa mật khẩu camera hay tài khoản quản trị.
- Icon tải lại được tạo bằng công cụ imagegen tích hợp, bản gốc `design/android-reload-imagegen-v2.png`, prompt tại `design/android-reload-imagegen-v2.prompt.txt`; bản PNG thu nhỏ dùng trong app tại `app/src/main/res/drawable-nodpi/ic_reload_imagegen.png`. App tô theo màu nút, giữ alpha gốc.
- Cookie phiên nằm trong dữ liệu riêng của app, không cho cookie bên thứ ba; không bật file access hoặc `addJavascriptInterface`. Từ 0.3.0, kênh WebMessage chỉ cho phép trang chính ở đúng origin HTTPS đã cấu hình gửi các lệnh điều khiển thiết bị được giới hạn. Không bỏ qua lỗi chứng chỉ HTTPS. WebView debugging chỉ bật ở bản debug để chỉnh UI qua USB.
- Từ bản 0.2.1, app hỗ trợ quyền **mic** và quyền định tuyến audio (`MODIFY_AUDIO_SETTINGS`, cần cho Chromium mở nguồn mic) cho web ở đúng origin **HTTPS** của máy chủ đã cấu hình. Hệ thống xin quyền thu mic khi người dùng kiểm tra mic/nhấn nói; không cấp quyền camera. Rời app hoặc rời trang sẽ dừng đàm thoại. Chức năng và giao diện vẫn nằm trên web; app chỉ làm cầu nối quyền WebView với Android.
- Mic cần cả quyền thiết bị và camera có kênh nhận tiếng tương thích. Trong Live, nhấn mic đỏ ở từng ô, hoặc chọn camera trong vùng Khẩn cấp rồi nhấn Nói; nhấn lại để dừng, im lặng 5 giây tự kết thúc. Camera không tương thích hiện lý do và không được chọn để nói; việc TDSEE có nói được không đảm bảo RTSP/ONVIF có talkback. Xem hướng dẫn HTTPS/Tailscale và tình trạng các camera Tenda trong README chính.

## Âm lượng, độ sáng và màn hình tối (0.3.0)

Mở **Cài đặt → Thiết bị đang xem** trên web trong app:

- **Âm lượng thiết bị** điều chỉnh âm lượng media Android, độc lập với loa trên camera. Nút loa từng ô Live vẫn bật/tắt riêng từng camera.
- **Độ sáng màn hình** chỉ thay đổi đèn nền của cửa sổ app. Công tắc **Theo độ sáng hệ thống** nằm bên phải tiêu đề: bật để theo hệ thống, tắt để chỉnh thanh trượt từ mức sáng hiện tại. Không sửa độ sáng toàn hệ thống.
- Nút mặt trăng cạnh phóng to trên Live phủ màn hình đen và hạ đèn nền xuống mức thấp nhất. Chạm đúp để mở lại, khôi phục độ sáng trước đó. Back/Enter cũng mở được. Rời app hoặc tải lại trang tự mở lại màn hình.

Đây là chế độ màn hình tối trong app, **không phải tắt panel hoặc khóa Android bằng nút nguồn**. App vẫn thức để nhận chạm đúp. Mic kết thúc khi bật chế độ này; âm thanh camera đang chọn và ghi hình trên máy chủ không bị tắt. Không cần quyền quản trị thiết bị hoặc `WRITE_SETTINGS`.

Khi mở bằng trình duyệt thông thường hoặc app cũ, cùng nhóm cài đặt điều chỉnh âm lượng video và độ sáng nội dung web, không điều khiển đèn nền/âm lượng hệ thống. Màn hình đen vẫn mở lại bằng chạm đúp/nhấp đúp hoặc Enter/Esc. Cài đặt này lưu trên thiết bị, không thay cấu hình máy chủ hay gửi lệnh tới camera.

Kênh native dùng AndroidX WebKit `addWebMessageListener`, chỉ nhận từ main frame của đúng origin HTTPS máy chủ. Từ chối iframe, origin khác, HTTP, trường lạ, giá trị ngoài giới hạn và lệnh không nằm trong danh sách `get/volume/brightness/sleep/wake`. Không mở API Java tổng quát cho website. Nếu WebView chưa hỗ trợ kênh này, web dùng chế độ nội dung thông thường.

Với link public, tablet chỉ cần Internet. Với địa chỉ LAN/VPN tự chọn, tablet vẫn cần ở trong đúng mạng/VPN. Chỉ cắm USB không tạo đường kết nối tới máy Windows. HTTP cần mạng tin cậy/VPN như web; app không tự thêm mã hóa cho HTTP. Nếu xem liên tục trong nhà, có thể chọn lại `http://camera.local:8081/live` để dùng LAN; mic cần link HTTPS.

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

Kiểm thử việc chuyển URL (Java thuần, không cần thiết bị):

```bash
# Từ thư mục project, chọn thư mục output tạm ngoài source:
javac -d /tmp/camera-server-test android/app/src/main/java/vn/tuyen/camerastation/ServerAddress.java android/tests/ServerAddressTest.java
java -cp /tmp/camera-server-test vn.tuyen.camerastation.ServerAddressTest
```

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

Nhấn giữ biểu tượng **Camera Station** trong launcher → **Máy chủ**, nhập `http://127.0.0.1:18173/login`. Đây là trang đăng nhập từ source trên máy phát triển, có HMR khi sửa `web/src`. Muốn đăng nhập, xem Live/Playback và dữ liệu thật, cấu hình proxy trong `web/vite.config.ts` tới backend/nginx truy cập được; một frontend chạy riêng không thay thế máy chủ camera. Đổi địa chỉ app về `https://camera.taild8cb98.ts.net:8443/live` khi dùng máy chủ thật.

### Xem đầy đủ UI khi không có máy chủ

Thay lệnh `npm run dev` ở trên bằng `npm run dev:ui`. Giữ chuyển tiếp ADB cổng 18173 và mở `http://127.0.0.1:18173/live` trong app; không cần tài khoản/mật khẩu. Trang đăng nhập cũng có nút **Vào bản xem trước UI**.

Chế độ này có camera, video thử 120 giây, recording/timeline, dung lượng, sự kiện, ONVIF/PTZ mẫu. Các thao tác thêm/sửa/xóa chỉ thay đổi dữ liệu trong bộ nhớ của Vite; khởi động lại server sẽ reset. Nhãn **Xem trước UI · dữ liệu mẫu** phân biệt với camera thật. Mọi API được xử lý cục bộ, kể cả khi đã cấu hình `VITE_API_BASE` khác. Không gọi RTSP/ONVIF thật và không đọc DB hay `.env` của máy chủ Windows.

Sáu thiết bị mẫu gồm camera ONVIF có PTZ, camera chỉ RTSP không có ONVIF, camera mất kết nối, camera đang kết nối, camera đã dừng và camera ONVIF cố định không có PTZ. Mặc định lưới 2×2 hiển thị hai camera trực tuyến, một mất kết nối và một đang kết nối. Dùng nút chọn camera để xem đủ sáu thiết bị. Camera offline không phát video mẫu; PTZ trả đúng khả năng từng thiết bị. Nút kết nối lại giữ nguyên tình huống mất kết nối/đang kết nối để thử UI, còn camera đã dừng có thể bật lại. Dò thiết bị cũng có mẫu chỉ hỗ trợ RTSP.

Đây là chế độ **development-only**, không triển khai lên máy chủ camera. `npm run build` giữ xác thực như bình thường; build với `--mode ui-preview` bị chặn. Khi trở lại máy chủ thật, đăng nhập bằng tài khoản web như trước.

Kết thúc phiên phát triển, dừng Vite và gỡ chuyển tiếp USB:

```bash
adb -s <SERIAL_LENOVO> reverse --remove tcp:18173
```
