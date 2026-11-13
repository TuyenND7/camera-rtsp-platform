# Camera RTSP Platform

Nền tảng self-hosted để một máy chủ kết nối nhiều kênh từ NVR/camera qua RTSP, ghi hình liên tục, xem live/playback và nhận dạng người/xe. Toàn bộ chạy bằng Docker Compose.

## Luồng hoạt động

```text
NVR main stream ──> backend + FFmpeg ──┬─> HLS live ──> web admin
                                       └─> recording gốc (.ts) ──> playback
NVR sub-stream ──> AI worker (YOLO) ─────> event + snapshot
                                             │
                                      PostgreSQL + storage
```

- Main stream: ghi nguyên codec/chất lượng gốc.
- H.264 live: copy, ít tốn CPU. H.265 live: transcode H.264 để trình duyệt phát được.
- AI: nên dùng sub-stream 640p, 1–5 FPS để không ảnh hưởng recording.
- Event AI: mặc định nhận `person`, `car`, `motorcycle`, có ảnh snapshot và trang lọc sự kiện. Cần bật AI cho từng camera; phiên bản hiện tại chưa vẽ khung nhận dạng trên Live.

## Thành phần

| Service | Vai trò |
|---|---|
| `postgres` | User, camera, metadata recording và event AI |
| `backend` | API JWT, quản lý FFmpeg, retention recording |
| `web` | Web admin React: camera, live, playback, grid, sự kiện AI |
| `nginx` | Cổng web/API và phân phối HLS/recording/snapshot |
| `ai` | Python + YOLO, nhận dạng từ sub-stream |

## Giao diện Camera Station

Web admin dùng giao diện sáng, tiếng Việt, font Be Vietnam Pro được đóng gói cục bộ để không phụ thuộc dịch vụ font bên ngoài.
Logo và icon ứng dụng được tạo bằng Imagegen, dùng cùng một biểu tượng ở sidebar, trang đăng nhập và favicon. Bản gốc nằm trong `design/camera-logo-master.png`, prompt trong `design/camera-logo-prompt.txt`; các PNG đã thu nhỏ và giữ alpha nằm trong `web/public/brand/`.
Bộ 40 icon điều khiển dùng atlas Imagegen nét regular cân bằng (~1,8–2 px ở cỡ 24 px), nhẹ hơn bản medium khoảng 20–25%, giữ màu `currentColor` của giao diện và micro dạng fill. PNG nguyên bản nằm ở `web/public/brand/camera-icons-balanced.png`, prompt đầy đủ ở `web/public/brand/camera-icons-balanced.prompt.txt`; tọa độ glyph được đo alpha trong `web/src/regularIconAtlas.ts` mà không sửa pixel ảnh gốc.


- **Khẩn cấp:** vùng viền đỏ gọn trên một hàng ở tiêu đề **Live view**, có trong cả chế độ toàn màn hình. Bấm **Khẩn cấp** để mở popup, tick **Tất cả camera** hoặc chọn riêng một số camera, rồi **Áp dụng**. Lựa chọn được nhớ trên thiết bị theo tài khoản; nút **Báo động** và **Nói** chỉ tác động tới camera đã chọn, trực tuyến và có hỗ trợ. Camera bị bỏ qua hoặc gửi lệnh lỗi được nêu rõ. Bật còi luôn mở hộp xác nhận camera và thời lượng; **Cài đặt → Báo động** cho chọn 10/15/30/60 giây hoặc đến khi người dùng tắt (mặc định 30 giây). **Dừng còi** gửi lệnh ngay, không hỏi lại; mic nhấn để nói, nhấn lại để dừng, im lặng 5 giây sẽ tự kết thúc (tối đa 16 camera đồng thời). Dừng phiên hiện tại trước khi đổi lựa chọn. Khi chuyển sang báo động sẽ đóng mic; khi chuyển sang nói sẽ dừng còi trước. Thông báo trạng thái hiển thị riêng, không làm vùng điều khiển xuống dòng. Chỉ quản trị viên, qua HTTPS.
- **Mic từng camera:** nút mic đỏ ở góc phải mỗi ô Live (cả lưới và chế độ một camera). Nhấn một lần để mở mic/nói, nhấn lại để kết thúc hoặc hủy lúc đang kết nối. Khi kênh camera sẵn sàng, 5 giây không phát hiện giọng nói sẽ tự kết thúc và giải phóng mic; âm nền nhỏ không đặt lại thời gian này. Mic tự tắt khi rời trang/ẩn ứng dụng, bỏ camera khỏi Live hoặc camera mất kết nối. Mỗi lần nói riêng một camera; nút đàm thoại phía trên vẫn dùng cho nhiều camera. Cần HTTPS và quyền mic trên thiết bị đang xem.
- **Live view:** mặc định chia lưới 2×2; các ô tự co theo kích thước cửa sổ để không phải cuộn trang, giữ nguyên tỷ lệ video. Khoảng cách giữa các ô 4px, khung không có đệm bên trong, lề ngoài gọn để dành diện tích cho camera. Có thể chuyển sang một camera, 3×3 hoặc 4×4; chọn thiết bị và điều khiển PTZ nếu camera hỗ trợ. Link mở riêng một camera vẫn dùng chế độ một ô. Video tự phát, không có thanh pause/tải lại hay dòng chữ trạng thái phát; nút kết nối lại chỉ xuất hiện khi camera offline. Thanh Live view không có nút phóng to/thu nhỏ; app Android tự chạy toàn màn hình, ẩn thanh hệ thống.
- **Âm thanh:** mỗi ô Live có nút loa ở góc dưới bên trái để bật/tắt tiếng riêng, gồm cả chế độ một camera. Mặc định tắt tiếng; camera ngoại tuyến hoặc luồng không có audio sẽ vô hiệu hóa nút. FFmpeg chuyển audio camera (ví dụ G.711) sang AAC cho Live và recording mới; video recording vẫn copy codec gốc. Playback có nút loa riêng. Các bản ghi cũ đã bị loại audio không thể khôi phục tiếng.
- **Mic/đàm thoại:** dùng nút mic riêng từng ô hoặc **Khẩn cấp → chọn camera → Nói** để nói tới nhóm. Nhấn một lần bắt đầu, nhấn lại kết thúc; im lặng 5 giây tự dừng. Cần HTTPS, quyền mic và RTSP backchannel hoặc adapter SDK Tenda trên Windows.
- **Còi và đèn camera:** chạm một ô Live rồi mở nút chuông để điều khiển còi/đèn riêng; nút **Báo động** trên thanh Khẩn cấp tác động nhóm đã tick. Mọi nút bật còi đều cần xác nhận; hủy hoặc Esc không gửi lệnh và không dừng mic đang dùng. Thời lượng dùng chung lấy từ **Cài đặt → Báo động**: 10/15/30/60 giây hoặc **Đến khi người dùng tắt**. Thời lượng đã xác nhận được giữ cố định cho phiên đó. Chế độ thủ công vẫn có nút dừng khi tải lại trang, không cần quyền mic; trạng thái lệnh độc lập với phản hồi âm thanh thực tế của loa. Chỉ admin qua HTTPS; camera đang đàm thoại cần đóng mic trước khi bật còi.
- **Sửa thiết bị:** có ba tab **Kết nối / Xem trước / Cài đặt**. Xem trước dùng HLS đang có trên máy chủ; zoom số 1–4×, kéo ảnh khi phóng to và bật/tắt tiếng. PTZ giữ để quay, thả để dừng, preset và zoom camera chỉ dùng khi ONVIF công bố hỗ trợ. Hai CT3 đang dùng không có PTZ trong media profile; zoom xem trước vẫn dùng được.
- **Cài đặt video camera:** đọc luồng và tùy chọn độ phân giải/FPS/bitrate trực tiếp qua ONVIF; luồng video, độ phân giải, FPS và bitrate mở hộp thoại chọn riêng, dùng thẻ lớn có dấu chọn và nhãn thông số đang dùng. Các lựa chọn nằm trong giới hạn thiết bị công bố. Nhấn **Chọn** để cập nhật lựa chọn trong form; **Hủy**, Esc hoặc chạm bên ngoài để bỏ lựa chọn của hộp thoại. Không cần nhập số thủ công. Nút **Áp dụng vào camera** lưu độc lập với thông tin kết nối rồi đọc lại để xác nhận. Cấu hình thay đổi từ phiên khác sẽ bị từ chối cho tới khi đọc lại. Đổi độ phân giải ảnh hưởng live và recording mới của luồng đó. Camera không kết nối/không cung cấp cài đặt được báo rõ; bộ ghi không tự bị thay thông số khi chỉ mở tab. Cấu hình codec H.265 vẫn đọc được, nhưng thao tác ghi encoder chỉ bật với cấu hình tương thích setter ONVIF đang dùng (H.264/JPEG/MPEG4).
- **Cài đặt camera theo TDSEE:** trong tab Cài đặt, chọn **Cài đặt camera** để mở nhóm hình ảnh/nhìn đêm, riêng tư, phát hiện/báo động, âm thanh và thẻ nhớ. Các lựa chọn lấy từ camera đã liên kết SDK, chỉ hiện khi thiết bị báo thuộc tính tương ứng. Có bước **Chọn → Áp dụng cài đặt camera**, đọc lại để xác nhận và chống ghi đè cấu hình đã thay đổi ở TDSEE. Thẻ nhớ SD trong camera độc lập với storage trên máy chủ. Thông báo TDSEE là thông báo ứng dụng hãng; không tự bật cảnh báo web mới.

- **Chụp ảnh Live:** chạm ô camera để hiện điều khiển, bấm biểu tượng máy ảnh để xem ảnh PNG của khung hình đang phát, tải ảnh hoặc sao chép nếu trình duyệt hỗ trợ. Giữ nguyên độ phân giải khung hình và không mở lại RTSP; thao tác tải file phụ thuộc khả năng trình duyệt/WebView.

- **Cài đặt ngay trên Live:** chạm ô camera để hiện nút bánh răng, mở cài đặt đúng camera trong hộp thoại trên màn Live, giữ nguyên lưới và các luồng đang xem. Có cả Luồng video và Cài đặt camera; chế độ xem một camera có nút Cài đặt bên cạnh PTZ.
- **Flash ngay trên Live:** biểu tượng mặt trời cạnh bánh răng bật/tắt đèn trắng riêng cho camera, màu vàng khi camera báo đang bật. Chỉ đọc trạng thái khi hiện điều khiển ô, khóa lúc gửi lệnh; sau thao tác dùng phản hồi thật thay vì tự đổi trạng thái. Nếu đèn bị tự bật bởi chế độ nhìn đêm, chọn Đen trắng trong cài đặt.

- **Điều khiển ô camera:** các nút mặc định ẩn, chạm/nhấn ô để hiện; chạm lại, chạm bên ngoài hoặc chờ 5 giây để ẩn. Các nút cùng kích thước 44×44, icon 20px. Với bàn phím, Tab tới ô rồi nhấn Enter/Space để hiện nút; nút đang được bàn phím chọn không tự ẩn.
- **Chọn camera vào ô:** chạm ô để hiện **×** ở góc phải, bấm để bỏ camera khỏi ô xem, giữ nguyên vị trí các ô còn lại và không dừng ghi hình. Bấm **+** ở ô trống để mở danh sách tất cả camera; camera đang hiển thị có nhãn **Đang xem**, camera chưa chọn có nút **Chọn** để đưa vào đúng ô vừa bấm. Có tìm kiếm theo tên/IP. Đóng hết camera vẫn giữ các ô trống để chọn lại; khi giảm bố cục, camera ngoài các ô còn hiển thị được bỏ khỏi lựa chọn.
- **Không gian xem:** nút menu cạnh tiêu đề ẩn/hiện thanh điều hướng và ghi nhớ lựa chọn trên trình duyệt.
- **Cài đặt:** trang `/settings` nằm trên web, sử dụng được từ máy tính, tablet và trình duyệt điện thoại. Có chuyển Sáng/Tối (ghi nhớ trên từng trình duyệt), kiểm tra máy chủ hiện tại và cấu hình lưu trữ dùng chung. App Android tiếp tục chỉ hiển thị web.
- **Bố cục chung:** Live view, Playback, Thiết bị và Sự kiện dùng chung lề nội dung, hàng tiêu đề và khoảng cách tới nội dung. Tiêu đề chính 24px trên desktop/tablet, 22px trên màn hình nhỏ; nút menu và hàng thao tác cao 44px. Các panel nội dung dùng đệm 12px, riêng ô video không có đệm để tối đa diện tích xem.
- **Tên camera và trạng thái:** nằm ở góc dưới bên phải của từng ô Live, cả chế độ lưới và một camera. Chừa khoảng cho nút loa bên trái và giữ phần trên cho ngày giờ có sẵn trong video. Tên dài rút gọn bằng dấu ba chấm. Camera đang hoạt động chỉ hiện tên và chấm xanh; ẩn chữ Trực tuyến. Các trạng thái mất kết nối, đang kết nối lại và đã dừng vẫn hiển thị, kể cả trên điện thoại.
- **Playback:** chọn ngày và tốc độ ở cụm điều khiển phía dưới video. Vùng xem tự co giãn theo cửa sổ, không kéo cuộn cả trang; khi chữ lớn hoặc mở thông tin bản ghi, phần cấu hình cuộn riêng. Toàn màn hình giữ cả video, nút phát và timeline. Nút Phát/Tạm dừng giữ đúng lựa chọn khi bản ghi đang tải; hết video có thể bấm Phát để xem lại từ đầu. Kéo hoặc nhấn dòng thời gian để tua; dùng ←/→ để tua 10 giây, Shift để tua 1 phút, Home/End để đến đầu/cuối recording. Có ảnh preview, tốc độ 1×/2×/4×/8× và thông tin lưu trữ, lịch sử dọn dữ liệu.
- **Thiết bị:** danh sách camera, tìm theo tên/IP và lọc trạng thái. Bấm **Dò thiết bị** để tìm camera/NVR trong mạng; **Thêm thủ công** khi đã có RTSP hoặc URL ONVIF. Các tùy chọn codec, PTZ và AI nằm trong **Nâng cao**.
- **Dò thiết bị:** tự đề xuất dải mạng nội bộ /24 từ địa chỉ máy chủ hoặc camera đã lưu. Dò WS-Discovery đồng thời kiểm tra RTSP/ONVIF bằng kết nối trực tiếp để dùng được cả trong Docker Desktop. Có tiến độ, nút Dừng và đánh dấu thiết bị đã thêm. Một lượt tối đa 254 địa chỉ, giới hạn 40 giây; không tự lưu camera, đổi cấu hình hay khởi động lại luồng hiện có.
- **ONVIF:** chọn thiết bị tìm thấy, nhập tài khoản/mật khẩu của **camera hoặc NVR**, bấm **Lấy luồng video**, chọn profile rồi **Thêm**. Cảnh báo và chặn thêm lại cùng RTSP trong giao diện. NVR có thể thêm từng kênh từ các profile trả về; chưa có thao tác nhập hàng loạt tất cả kênh.
- **Sự kiện nhận dạng:** lọc theo camera và loại đối tượng, xem ảnh và mở recording của ngày phát hiện. Nếu chưa bật AI, trang hiển thị hướng dẫn cấu hình.

Sau khi chỉ thay đổi giao diện, build và cập nhật riêng web để không ngắt tiến trình ghi hình:

```powershell
docker compose build web
docker compose up -d --no-deps --force-recreate web
docker compose exec -T nginx nginx -s reload
```

Tải lại trang bằng `Ctrl + Shift + R` nếu trình duyệt vẫn giữ giao diện cũ. URL đăng nhập và tài khoản trong `.env` được giữ nguyên.

Nếu cập nhật cả API dò thiết bị, build và khởi động lại `backend web`, rồi reload nginx. Việc khởi động lại backend khiến các camera kết nối lại trong chốc lát:

```powershell
docker compose build backend web
docker compose up -d --no-deps --force-recreate backend web
docker compose exec -T nginx nginx -s reload
```

Nếu build qua SSH trên Windows gặp lỗi Docker **“A specified logon session does not exist”**, credential helper không truy cập được phiên đăng nhập Windows. Mở một cửa sổ PowerShell mới dành cho build, dùng cấu hình riêng cho các base image công khai của project:

```powershell
$cameraBuildConfig = Join-Path $env:TEMP 'camera-rtsp-docker-build'
New-Item -ItemType Directory -Force $cameraBuildConfig | Out-Null
$cameraDockerEndpoint = (docker context inspect (docker context show) | ConvertFrom-Json)[0].Endpoints.docker.Host
'{"auths":{"https://index.docker.io/v1/":{}},"credsStore":"","cliPluginsExtraDirs":["C:\\Program Files\\Docker\\Docker\\resources\\cli-plugins"]}' | Set-Content -Encoding ASCII (Join-Path $cameraBuildConfig 'config.json')
$env:DOCKER_CONFIG = $cameraBuildConfig
$env:DOCKER_HOST = $cameraDockerEndpoint
Remove-Item Env:DOCKER_CONTEXT -ErrorAction SilentlyContinue
docker compose build backend web
```

Sau khi build thành công, chạy lệnh cập nhật container và reload nginx ở trên trong cùng cửa sổ. Cấu hình riêng không chứa thông tin đăng nhập registry; đóng cửa sổ PowerShell để kết thúc các biến môi trường tạm thời. Khi chạy build qua SSH, giữ phiên kết nối mở đến khi lệnh hoàn thành.

Kiểm tra code sau khi cài dependency: `npm run build --prefix backend`, `node --test backend/test/*.test.cjs`, `npm run build --prefix web`.

### Cài đặt máy chủ trên web

Quản trị viên mở **Cài đặt** để sửa địa chỉ web dùng chia sẻ trong LAN/VPN, tên ổ lưu trữ, số giờ giữ bản ghi (0 = chỉ dọn theo dung lượng), ngưỡng bắt đầu dọn (mặc định 90%), mức dung lượng sau khi dọn (85%) và chu kỳ kiểm tra. Nút **Kiểm tra kết nối** kiểm tra backend của trang đang mở; địa chỉ chia sẻ không thay đổi IP, DNS hay cổng lắng nghe của máy chủ.

Cấu hình được lưu vào bảng `application_settings` của PostgreSQL, tự nạp khi backend khởi động lại và ghi nhận tài khoản sửa gần nhất. `.env` cung cấp giá trị ban đầu; cấu hình đã lưu trên web được ưu tiên. Chính sách mới có hiệu lực ở các lần kiểm tra tiếp theo, không khởi động lại camera. Job kiểm tra lại chu kỳ mỗi phút, chỉ xóa các ngày cũ đã kết thúc, giữ ngày đang ghi. API `GET/PUT /api/settings` yêu cầu phiên admin; thao tác lưu giữ bảo vệ CSRF và cùng nguồn như các API khác.

Thư mục gốc hiển thị trong Cài đặt là volume đang được gắn. Đổi ổ/thư mục vật lý vẫn thực hiện qua `STORAGE_HOST_DIR`/Docker khi triển khai theo hướng dẫn Windows bên dưới; trang web không tự di chuyển recording. Không lưu khóa JWT, mật khẩu DB hay mật khẩu camera trong cấu hình này.

Sau khi cập nhật source, build lại `backend web` và reload nginx theo lệnh ở trên. Schema mới tự tạo bảng cài đặt khi backend khởi động, không cần xóa DB.

### Giao diện và icon

Trong **Cài đặt → Giao diện → Cỡ chữ**, chọn **Bình thường (100%)**, **Lớn (125%)**, **Rất lớn (150%)** hoặc **Lớn nhất (200%)** để người lớn tuổi dễ đọc. Cỡ chữ áp dụng ngay cho menu, tiêu đề, tên camera, nút, biểu mẫu, popup và nhãn thời gian Playback; được ghi nhớ riêng trên từng trình duyệt, không cần bấm Lưu cấu hình máy chủ. Video vẫn giữ bố cục lưới hiện tại.

Chế độ Sáng/Tối áp dụng trên Live, Playback, Thiết bị, Sự kiện, Cài đặt và popup. Lựa chọn nằm ở localStorage của từng trình duyệt, được áp dụng trước lần render đầu tiên và giữ khi tải lại/chuyển trang; không cần đổi app Android.

Bộ 36 icon nét mảnh được tạo bằng **Imagegen tích hợp**, giữ màu xanh xám/xanh dương theo trạng thái hiện có bằng CSS alpha mask. File gốc: [`design/camera-icons-master.png`](design/camera-icons-master.png); atlas dùng trong web: [`web/public/brand/camera-icons.png`](web/public/brand/camera-icons.png); prompt đầy đủ: [`design/camera-icons-prompt.txt`](design/camera-icons-prompt.txt). `web/src/iconAtlas.ts` lưu giới hạn nét để các hình có kích thước nhìn đồng đều. Icon âm thanh dùng atlas Imagegen riêng tại `web/public/brand/camera-audio-icons.png`, bản gốc `design/camera-audio-icons-master.png` và prompt `design/camera-audio-icons-prompt.txt`. Mic dùng biểu tượng **đặc (fill)** ở ngoài cùng bên phải của thanh Live: [`web/public/brand/microphone-filled.png`](web/public/brand/microphone-filled.png), bản gốc `design/microphone-filled-master.png`, prompt [`design/microphone-filled-prompt.txt`](design/microphone-filled-prompt.txt); được tạo bằng Imagegen tích hợp và giữ nguyên alpha gốc.

## App Android cho tablet

Thư mục [`android/`](android/README.md) chứa app **Camera Station** mở web trọn khung, không có thanh tiêu đề riêng, mặc định `http://camera.local:8081/live`. Nhấn giữ biểu tượng app trong launcher để tải lại hoặc đổi máy chủ; hỗ trợ video toàn màn hình. UI tải trực tiếp từ máy chủ nên cập nhật web không cần cài lại APK. Xem hướng dẫn build, cài qua ADB và xem trước UI qua USB trong [android/README.md](android/README.md).

Khi chưa kết nối được máy chủ, chạy `npm run dev:ui` trong `web`, chuyển tiếp cổng 18173 qua ADB và mở `http://127.0.0.1:18173/live` trong app. Chế độ xem trước không cần mật khẩu, dùng API/video mẫu cục bộ để chỉnh Live, Playback, Thiết bị và Sự kiện; không bỏ xác thực ở backend thật và không được dùng để build production.

Dữ liệu mẫu có đủ camera ONVIF/PTZ, chỉ RTSP không có ONVIF, ONVIF cố định không có PTZ, mất kết nối, đang kết nối và đã dừng. Lưới mặc định có cả camera online/offline; các ô offline không phát video. Popup chọn thiết bị và trang Thiết bị hiển thị đủ sáu camera để thử các tình huống này.

Khi kết nối lại thất bại, lỗi hiện ngay trong khung trạng thái offline, cạnh nút **Kết nối lại**; thông báo giữ nguyên đến lần thử tiếp theo hoặc khi camera online.

## Bảo mật và phiên đăng nhập

- Nginx kiểm tra phiên với backend cho **từng playlist, đoạn video, ảnh sự kiện và ảnh preview** tại `/live/`, `/rec/`, `/playback/`, `/events/`, `/thumbs/`. Biết URL hoặc ở cùng LAN không đủ quyền truy cập. Không có ngoại lệ cho IP Docker/LAN, không truyền token trong URL, không cache kết quả xác thực.
- Trình duyệt dùng cookie **HttpOnly, SameSite=Strict**; không lưu token vào localStorage. Phiên được ký HS256 và lưu SHA-256 của token trong bảng `auth_sessions`. Đăng xuất thu hồi phiên trên máy chủ, nên bản sao cookie hoặc bearer token của phiên đó cũng bị từ chối. Các token của bản cũ không còn dùng được; cập nhật xong cần đăng nhập lại.
- Mỗi thao tác thay đổi dùng token CSRF gắn với phiên. API từ chối Origin khác và không cung cấp CORS công khai. Đăng nhập giới hạn 10 lần/IP/phút; tên tài khoản không tồn tại cũng trả cùng lỗi đăng nhập. Cấu hình thiết bị, dò mạng và PTZ chỉ dành cho admin.
- Production từ chối khởi động với JWT secret mặc định hoặc ngắn hơn 32 ký tự. Không đưa `.env`, chứng chỉ riêng hay dữ liệu recording lên Git. Thay đổi `ADMIN_PASSWORD` trong `.env` chỉ có tác dụng **khởi tạo user mới**, không tự đổi mật khẩu user đã có trong DB.
- AI dùng RTSP sub-stream có tài khoản hoặc đọc `/storage/live/...` qua volume nội bộ; không cần bỏ xác thực web để AI hoạt động.

Đây là bảo vệ quyền truy cập của ứng dụng. **HTTP vẫn không mã hóa mật khẩu/video trên đường truyền.** Chỉ dùng HTTP trong mạng tin cậy hoặc bên trong VPN; dùng HTTPS cho truy cập thường xuyên và không mở cổng web/camera trực tiếp ra Internet. Bật xác thực ONVIF/RTSP, mật khẩu riêng mạnh và firmware mới trên từng camera/NVR. Dò mạng vẫn có thể thấy IP/dịch vụ; muốn hạn chế máy khác chạm tới camera cần tách VLAN và cấu hình firewall chỉ cho máy chủ kết nối.

### Bật HTTPS khi đã có chứng chỉ tin cậy

1. Đặt chứng chỉ cho **đúng hostname truy cập** tại `certs/server.crt` (full chain) và khóa riêng tại `certs/server.key`. Có thể dùng CA nội bộ đã được máy khách tin cậy hoặc chứng chỉ hợp lệ cho tên miền của bạn; không tải khóa riêng lên Git.
2. Đặt `COOKIE_SECURE=true` trong `.env`. DNS của hostname phải trỏ đến máy chủ. Cổng HTTPS của cấu hình này là 443; HTTP cũ sẽ chuyển sang HTTPS.
3. Trong PowerShell tại thư mục project, chạy:

```powershell
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build backend web ai nginx
docker compose -f docker-compose.yml -f docker-compose.https.yml exec -T nginx nginx -t
```

Từ lúc bật HTTPS, các lệnh cập nhật/khởi chạy phải giữ cả hai `-f` ở trên. Đăng xuất các phiên HTTP cũ và đăng nhập lại bằng `https://<hostname>` để nhận cookie Secure. Không bỏ qua cảnh báo chứng chỉ của trình duyệt. Không bật `COOKIE_SECURE=true` khi vẫn dùng HTTP vì trình duyệt sẽ không gửi cookie phiên.

### HTTPS và mic qua Tailscale trên Windows

Đây là lựa chọn thay thế cho cấu hình chứng chỉ riêng ở trên. Máy chủ và thiết bị xem phải kết nối vào tailnet đã được cấp quyền; không mở cổng router hoặc bật Funnel.

1. Cập nhật và khởi chạy Compose thông thường. Nginx tạo upstream HTTPS tại `127.0.0.1:8083`, chỉ nhận kết nối trên loopback của máy chủ. Có thể thay `HTTPS_UPSTREAM_PORT` trong `.env` nếu cổng đang bận; đổi cả địa chỉ đích trong lệnh Serve tương ứng.
2. Trong PowerShell của **người dùng đang đăng nhập Tailscale** trên Windows, chạy:

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg --https=443 http://127.0.0.1:8083
& 'C:\Program Files\Tailscale\tailscale.exe' serve status
```

3. Nếu CLI đưa một liên kết để bật Serve, mở liên kết bằng tài khoản quản lý tailnet và bật tính năng. CLI sẽ in địa chỉ `https://<ten-may>.<tailnet>.ts.net/`; dùng đúng địa chỉ này, không thay hostname HTTPS bằng IP. Trên máy CAMERA đã cấu hình: `https://camera.taild8cb98.ts.net/live`.
4. Mở địa chỉ HTTPS trên tablet/điện thoại và đăng nhập web. Trong app Android, nhấn giữ biểu tượng app → **Máy chủ**, thay URL bằng địa chỉ HTTPS vừa nhận. Cài APK 0.2.1 trở lên để có quyền mic và định tuyến audio cho WebView. App chỉ cấp audio cho đúng origin HTTPS đang cấu hình, không cấp camera hay bỏ qua lỗi TLS.
5. Trong Live, nhấn **mic đỏ** cạnh nút phóng to → **Kiểm tra mic**, cho phép quyền mic nếu hệ thống hỏi. Thanh mức âm thanh phản ứng khi nói. Chọn các camera có trạng thái **Sẵn sàng**, sau đó giữ nút nói. Khi hộp thoại cấp quyền làm ngắt thao tác giữ, nhấn giữ lại sau khi cấp quyền.

Nginx tự đánh dấu đúng HTTPS cho backend trên upstream loopback; cookie được đặt Secure theo từng kết nối HTTPS. HTTP LAN hiện có vẫn hoạt động với `COOKIE_SECURE=false`; nếu chỉ dùng HTTPS có thể bật `COOKIE_SECURE=true`. Cổng HTTP thường luôn ghi đè header `X-Forwarded-Proto` từ máy khách, không chấp nhận header giả mạo để mở đàm thoại.

Để tắt proxy HTTPS, chạy `tailscale serve --https=443 off` trong phiên người dùng sở hữu Tailscale. Tham khảo [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

### Tương thích đàm thoại và giới hạn hiện tại

- Backend xác thực RTSP với tài khoản camera, kiểm tra SDP có audio **recvonly** rõ ràng dành cho loa, rồi mở SETUP/PLAY qua TCP và gửi RTP G.711. Luồng audio đầu vào thông thường không được coi là kênh loa. Không gửi URL/mật khẩu camera trong API đàm thoại.
- Chọn tối đa 16 camera; một camera chỉ nhận một cuộc đàm thoại cùng lúc. Âm thanh được phát theo frame 20 ms; hàng đợi giới hạn 500 ms; khi gói bị dồn do mạng chập chờn, bỏ frame cũ để ưu tiên giọng nói hiện tại, không đưa mic vào kho recording; recording vẫn giữ audio do camera gửi về. Adapter Windows dùng gói PCM tạm trong thư mục IPC riêng và tự xóa sau cuộc gọi. Khi nhả nút, rời trang, ẩn app, mất mạng, thay cấu hình, đăng xuất hoặc hết 60 giây, phiên và hàng đợi bị đóng. Nếu trình duyệt mất kết nối đột ngột, máy chủ tự đóng khi không có audio trong 1,5 giây.
- Các endpoint mic yêu cầu phiên admin và CSRF như phần cấu hình. Máy chủ xác minh lại quyền/cấu hình camera trong cuộc gọi. Live tạm tắt tiếng các ô trong lúc gửi giọng nói để hạn chế vọng, rồi khôi phục lựa chọn nghe trước đó.
- **Tenda CT3V1.0/RH7V2.0 có adapter SDK riêng trên Windows:** xem [cài đặt và vận hành SDK Tenda](windows/tenda-talk/README.md). Các firmware đang dùng không cung cấp RTSP backchannel hoạt động; adapter dùng thư viện LinkVisual của TDSEE và tài khoản chủ thiết bị. Ngày 13/11/2026 đã phát âm thử qua SDK tới CT3 ngoài sân và người dùng xác nhận nghe tiếng bíp. Chỉ bật adapter cho camera đã liên kết đúng ID và cấu hình; ONVIF có audio output không tự được coi là hỗ trợ đàm thoại.
- Bản Windows đã triển khai ngày 13/11/2026: mic thật trên Lenovo qua HTTPS/Tailscale truyền tới hai CT3 đồng thời trong hai phiên liên tiếp hơn 20 giây, nhả tay đóng kênh; gọi riêng cũng đã kiểm tra. RH7 hiện đang tắt nên chưa kiểm tra lại trong lần này. Xem kết quả và giới hạn xác nhận loa trong README của adapter.
- Trong popup mic, từng camera đang truyền hiển thị **Đang gửi tiếng** kèm **chưa xác nhận loa đã phát**; chỉ gắn trạng thái gửi cho đúng các camera trong phiên đang hoạt động. Muốn xác nhận âm thanh thực tế cần nghe tại camera hoặc có phản hồi từ thiết bị.
- Luồng G.711/RTSP, IPC SDK, broadcast, ngắt mic và giới hạn quyền có kiểm thử riêng. Kiểm thử giao thức không thay thế việc nghe thử tại loa thật; sự kiện SDK sẵn sàng cũng không phải xác nhận âm thanh đã phát ra ngoài.

Build và chạy kiểm thử backend từ thư mục project:

```bash
cd backend
npm run build
node --test test/*.test.cjs
```

### Cập nhật bản bảo mật trên Windows

Sao lưu `.env`, DB và recording trước khi cập nhật. Giữ nguyên `.env` hiện có. Bản này thêm volume `nginx/app.inc`, vì vậy phải tạo lại cả nginx, không chỉ reload cấu hình cũ:

```powershell
docker compose build backend web ai
docker compose up -d --no-deps --force-recreate backend web ai nginx
docker compose exec -T nginx nginx -t
docker compose cp backend/test backend:/app/test
docker compose exec -T backend node --test test/security.test.cjs
```

Các kiểm thử dùng DB giả trong bộ nhớ, không sửa DB camera thật. Backend khởi động lại làm RTSP kết nối lại trong chốc lát. Truy cập ẩn danh một URL Live đã biết phải trả `401`; đăng nhập thì phát được, đăng xuất rồi dùng lại cookie cũ phải tiếp tục bị chặn. Kiểm thử API `/api/cameras` đơn lẻ chưa đủ xác nhận video đã được bảo vệ.

## Triển khai trên Windows 11 Pro với Docker Desktop

Đây là cách phù hợp khi máy chủ camera chạy Windows 10/11 Pro. Docker Desktop phải dùng **Linux containers** và WSL 2; không chuyển sang Windows containers vì stack này dùng Alpine/Node/Python Linux.

### 1. Cài Docker Desktop và kiểm tra

Mở PowerShell **Run as Administrator**, cài WSL 2 nếu máy chưa có rồi khởi động lại khi Windows yêu cầu:

```powershell
wsl --install
```

Cài Docker Desktop, chọn backend **WSL 2** và Linux containers. Sau khi Docker Desktop báo `Engine running`, kiểm tra:

```powershell
docker version
docker compose version
```

Trong Docker Desktop > Settings > General, bật **Start Docker Desktop when you sign in**. Các container của project dùng `restart: unless-stopped`, nên chúng sẽ tự chạy lại khi Docker Desktop khởi động.

### 2. Clone code và tạo cấu hình

Dùng ổ còn nhiều dung lượng cho recording (ví dụ `D:` nếu có). Ví dụ dưới đặt code ở `C:\CameraRTSP` và dữ liệu video ở **Documents** của tài khoản Windows đang chạy Docker Desktop:

```powershell
git clone https://github.com/TuyenND7/camera-rtsp-platform.git C:\CameraRTSP
Set-Location C:\CameraRTSP
Copy-Item .env.example .env
$StorageDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CameraRTSP\storage'
New-Item -ItemType Directory -Force $StorageDir, models | Out-Null
notepad .env
```

Trong `.env`, đổi tối thiểu `POSTGRES_PASSWORD`, `DATABASE_URL` (chứa đúng cùng mật khẩu DB), `JWT_SECRET` và `ADMIN_PASSWORD` thành giá trị mạnh. Thêm hoặc giữ các dòng sau (đổi `Tuyen` thành đúng thư mục user nếu khác):

```dotenv
STORAGE_HOST_DIR=C:/Users/Tuyen/Documents/CameraRTSP/storage
STORAGE_LABEL=Documents/CameraRTSP/storage
RECORD_RETENTION_HOURS=0
STORAGE_CLEANUP_THRESHOLD_PERCENT=90
STORAGE_CLEANUP_TARGET_PERCENT=85
STORAGE_CLEANUP_INTERVAL_MINUTES=10
```

`RECORD_RETENTION_HOURS=0` nghĩa là không xoá theo số ngày cố định. Khi phân vùng chứa `Documents/CameraRTSP/storage` đạt **90%**, backend xoá **nguyên ngày recording cũ nhất đã hoàn tất** cho đến khi còn 85%. Nó không xoá live stream, snapshot AI hoặc ngày đang ghi. Không commit file `.env` lên Git. Giữ `AI_DEVICE=cpu` nếu chưa chuẩn bị NVIDIA Container Toolkit/CUDA cho WSL 2.

Nếu bản cũ đã có dữ liệu tại `C:\CameraRTSP\storage`, dừng stack, copy dữ liệu sang Documents trước rồi mới bật cấu hình mới; chỉ xoá thư mục cũ sau khi đã mở Playback kiểm tra:

```powershell
docker compose down
$StorageDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CameraRTSP\storage'
robocopy C:\CameraRTSP\storage $StorageDir /E /COPY:DAT
docker compose up -d --build
```

Mặc định web dùng `HTTP_PORT=8080`. Nếu cổng này đã được chương trình khác dùng, chọn cổng trống như `HTTP_PORT=8081` và dùng cổng đó ở các bước sau.

### 3. Khởi chạy, kiểm tra và chỉ mở LAN

```powershell
Set-Location C:\CameraRTSP
docker compose config --quiet
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://localhost:8080/api/health
```

Kết quả mong đợi là `{"ok":true}`, năm service `postgres`, `backend`, `web`, `nginx`, `ai` đang `Up`, và PostgreSQL là `healthy`. Lần đầu AI tải model `yolov8n.pt` vào `models`.

Chỉ cho thiết bị trong LAN tin cậy truy cập web. Ví dụ LAN là `192.168.0.0/24` và đang dùng cổng 8080:

```powershell
New-NetFirewallRule -Name CameraRTSP-Web-LAN -DisplayName 'Camera RTSP Platform (LAN)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 -RemoteAddress 192.168.0.0/24 -Profile Private
```

Mở `http://<IP-may-Windows>:8080` từ máy cùng LAN và đăng nhập bằng `ADMIN_USERNAME`/`ADMIN_PASSWORD` trong `.env`. Không public cổng này trực tiếp ra Internet; dùng VPN như WireGuard/Tailscale nếu cần truy cập ngoài site.

### Truy cập bằng tên máy trong LAN

Khi các thiết bị trong LAN hỗ trợ mDNS, có thể dùng tên máy thay cho IP DHCP. Xem tên hiện tại bằng `hostname`. Ví dụ máy tên `CAMERA`, cấu hình `HTTP_PORT=8081` thì mở `http://camera.local:8081/live` từ máy tính/tablet cùng mạng.

Để đổi tên máy, chạy PowerShell Administrator: `Rename-Computer -NewName CAMERA`. Tên mới có hiệu lực sau khi khởi động lại Windows; chọn thời điểm phù hợp vì ghi hình sẽ tạm ngắt. Sau khi máy khởi động lại, kiểm tra Docker Desktop đang chạy, `docker compose ps` và `/api/health` trước khi mở Live. Không cần sửa RTSP camera khi chỉ đổi tên máy chủ. Nếu thiết bị không phân giải được `.local`, dùng DHCP reservation trên router để giữ IP máy chủ cố định.

## Triển khai production trên Windows Server

Project dùng **Linux containers** (Alpine, Node, Python). Không cài Docker Desktop trực tiếp trên Windows Server: Docker xác nhận Docker Desktop không được hỗ trợ trên Windows Server, và Docker Engine native Windows chỉ chạy Windows containers, không chạy được stack này. Xem [Docker Desktop FAQ](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/windowsfaqs/) và [Docker Engine trên Windows](https://docs.docker.com/engine/install/binaries/).

Phương án ổn định là:

```text
Windows Server 2022/2025 (Hyper-V host)
└── Ubuntu Server 24.04 LTS VM, external vSwitch, IP LAN cố định
    └── Docker Engine + Camera RTSP Platform (Linux containers)
```

VM phải dùng **External virtual switch** và một IP LAN riêng. Như vậy NVR, người xem và VM thấy nhau trực tiếp; tránh dùng Hyper-V Default Switch/NAT cho production.

### 1. Chuẩn bị Windows Server

Trên PowerShell chạy với quyền Administrator:

```powershell
Install-WindowsFeature -Name Hyper-V -IncludeManagementTools -Restart
```

Sau khi máy khởi động lại, tạo external vSwitch. Liệt kê đúng tên card mạng trước, rồi thay `<TEN_CARD_MANG>`:

```powershell
Get-NetAdapter
New-VMSwitch -Name "CameraLAN" -NetAdapterName "<TEN_CARD_MANG>" -AllowManagementOS $true
```

Trong Hyper-V Manager, tạo Ubuntu Server 24.04 LTS VM với:

- Generation 2, gắn ISO Ubuntu Server.
- Network Adapter nối vào `CameraLAN`.
- Tối thiểu 4 vCPU, 8 GB RAM; tăng theo số camera/transcode/AI.
- VHDX hệ điều hành riêng; gắn thêm VHDX lớn hoặc disk passthrough cho recording.
- Đặt DHCP reservation trên router cho VM, ví dụ `192.168.1.20`.

Windows Server 2022/2025 có thể cài WSL bằng `wsl --install`, nhưng WSL2 dùng NAT và IP có thể đổi. Dùng Ubuntu VM với external switch cho server camera sẽ dễ vận hành và kết nối NVR ổn định hơn. Tham khảo [hướng dẫn WSL cho Windows Server](https://learn.microsoft.com/en-us/windows/wsl/install-on-server).

### 2. Cài Docker Engine trong Ubuntu VM

SSH vào Ubuntu VM hoặc mở console Hyper-V. Các lệnh dưới đây theo [Docker Engine cho Ubuntu](https://docs.docker.com/engine/install/ubuntu/):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
newgrp docker
docker run --rm hello-world
docker compose version
```

### 3. Đặt code và storage trên ổ dữ liệu

Không lưu recording dài hạn vào disk hệ điều hành. Ví dụ đã mount ổ dữ liệu của VM tại `/srv/camera-data`:

```bash
sudo mkdir -p /srv/camera-rtsp-platform /srv/camera-data/{storage,models}
sudo chown -R "$USER":"$USER" /srv/camera-rtsp-platform /srv/camera-data
cd /srv/camera-rtsp-platform
git clone https://github.com/TuyenND7/camera-rtsp-platform.git .
ln -s /srv/camera-data/storage storage
ln -s /srv/camera-data/models models
```

`storage/` chứa recording/live/snapshot. `models/` giữ weight AI đã tải để lần sau không phải tải lại. PostgreSQL nằm trong Docker volume; backup riêng ở bước bên dưới.

### 4. Tạo cấu hình production

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Ít nhất phải đổi các giá trị sau bằng chuỗi hex dài (không dùng ký tự `@`, `:`, `/` trong `POSTGRES_PASSWORD` vì nó xuất hiện trong URL DB):

```bash
openssl rand -hex 32   # POSTGRES_PASSWORD và ADMIN_PASSWORD
openssl rand -hex 48   # JWT_SECRET
```

Trong `.env`, đặt `POSTGRES_PASSWORD` và cập nhật **đúng cùng mật khẩu đó** vào `DATABASE_URL`. Ví dụ:

```dotenv
POSTGRES_USER=camadmin
POSTGRES_PASSWORD=<chuoi-hex-64-ky-tu>
POSTGRES_DB=camera_platform
DATABASE_URL=postgres://camadmin:<chuoi-hex-64-ky-tu>@postgres:5432/camera_platform
JWT_SECRET=<chuoi-hex-96-ky-tu>
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<mat-khau-admin-manh>
HTTP_PORT=8080
RECORD_RETENTION_HOURS=720
RECORD_TIMEZONE=Asia/Ho_Chi_Minh
```

Giữ `AI_DEVICE=cpu` cho cấu hình mặc định. GPU NVIDIA cần một image CUDA phù hợp driver/CUDA của Linux server; không chỉ đổi biến môi trường là đủ.

### 5. Khởi chạy và kiểm tra

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 backend ai
curl http://localhost:8080/api/health
```

Kết quả mong đợi: năm service `postgres`, `backend`, `web`, `nginx`, `ai` ở trạng thái `Up`; PostgreSQL là `healthy`; health trả `{"ok":true}`. Lần đầu worker AI tải `yolov8n.pt` vào `models/`.

Từ máy quản trị trong LAN, mở `http://<IP_VM>:8080` và đăng nhập bằng `ADMIN_USERNAME`/`ADMIN_PASSWORD` trong `.env`.

### 6. Mở firewall đúng phạm vi

Chỉ mở cổng web cho LAN hoặc VPN tin cậy; không mở RTSP từ NVR ra Internet. Ví dụ LAN là `192.168.1.0/24`:

```bash
sudo apt-get install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp
sudo ufw enable
sudo ufw status
```

Nginx yêu cầu phiên đăng nhập cho HLS/recording/snapshot. Vẫn phải giới hạn firewall/VPN và dùng HTTPS theo phần bảo mật ở trên. Khi camera ở site khác, ưu tiên WireGuard hoặc Tailscale giữa NVR và VM thay vì port-forward RTSP.

## Kết nối NVR từ đầu đến cuối

1. Bảo đảm Ubuntu VM/NVR có route mạng tới nhau. Tạo user RTSP riêng trên NVR, chỉ quyền xem.
2. Lấy hai URL cho từng channel NVR:
   - **Main stream**: dùng cho recording chất lượng gốc.
   - **Sub-stream**: dùng cho AI, nên 640p và 1–5 FPS.
3. Ngay trong VM, kiểm tra main-stream trước khi thêm vào web:

   ```bash
   docker compose exec backend ffprobe -v error -rtsp_transport tcp -select_streams v:0 -show_entries stream=codec_name,width,height -of default=nw=1 "rtsp://<user>:<password>@<ip-nvr>:554/<duong-dan-main>"
   ```

4. Mở web → **Cameras** → **Add Camera**:
   - Nếu camera bật ONVIF: nhập URL device service (ví dụ `http://<ip-camera>/onvif/device_service`) cùng tài khoản ONVIF, bấm **Dò profile ONVIF** để tự điền main/sub-stream. Credential ONVIF không được lưu riêng; RTSP đã chọn vẫn là cấu hình stream của camera.
   - `RTSP URL`: main-stream.
   - `Recording`: bật.
   - `Codec`: `Auto` trước; chỉ chọn H.264/H.265 khi đã biết codec.
   - Bật **Nhận dạng AI**, điền `AI RTSP URL` là sub-stream, chọn FPS/ngưỡng/nhãn.
5. Camera phải chuyển sang `online`. Mở **Live** để xem HLS, **Playback** chọn ngày đã ghi, **Sự kiện AI** để xem event/snapshot, và **Multi-view** để chọn nhiều camera.

Nếu camera `error`, xem hai log sau trước:

```bash
docker compose logs --tail=200 backend
docker compose logs --tail=200 ai
```

Các lỗi phổ biến: sai đường dẫn RTSP của NVR, VM không route tới NVR, NVR giới hạn số session, hoặc H.265 đang transcode quá nhiều luồng dẫn tới thiếu CPU.

## H.264, H.265 và AI

| Nguồn | Live web | Recording |
|---|---|---|
| H.264 | Copy | Copy codec gốc, phát/seek trực tiếp trên web |
| H.265/HEVC | Transcode sang H.264 | Giữ bản gốc + HLS H.264 tương thích web |

Recording luôn giữ bản copy codec gốc nên không mất chất lượng. Vì Chrome/Edge không phát hoặc seek HLS/HEVC ổn định, camera H.265 có thêm một archive H.264 chỉ phục vụ web Playback; tính năng này dùng thêm CPU/dung lượng. Khi archive đã phủ phần recording của ngày đó, Playback đọc thẳng archive local và nhảy tới mốc đã chọn, không cần chuyển đổi lại. Với recording H.265 cũ chưa có archive đầy đủ, lần đầu mở một mốc Playback hệ thống chuyển file local của chính mốc đó sang H.264, sau đó dùng lại bản cache; thao tác này không kết nối lại RTSP/camera. Mặc định recording chia thành segment 60 giây để lần chuẩn bị đầu tiên không phải chờ chuyển đổi một đoạn quá dài. AI đọc sub-stream độc lập, có cooldown để giảm event trùng lặp; đây là nhận dạng đối tượng, không phải nhận diện khuôn mặt/biển số.

## Dung lượng, hiệu năng và lưu trữ

Ước tính recording: **10,8 GB/ngày cho mỗi 1 Mbps** bitrate. Ví dụ 16 camera × 4 Mbps cần khoảng 691 GB/ngày hoặc 20,7 TB cho 30 ngày, chưa tính RAID/dự phòng.

- `STORAGE_HOST_DIR` là thư mục trên máy chủ được Docker bind mount vào `/storage`; với Windows Desktop, đặt tại `Documents/CameraRTSP/storage` như phần cài đặt ở trên.
- Mặc định không xóa theo ngày (`RECORD_RETENTION_HOURS=0`). Backend kiểm tra filesystem mỗi 10 phút; chỉ khi nó đạt `STORAGE_CLEANUP_THRESHOLD_PERCENT=90` mới xóa các **ngày recording đã kết thúc** từ cũ đến mới đến mức `STORAGE_CLEANUP_TARGET_PERCENT=85`.
- Có thể đặt `RECORD_RETENTION_HOURS` lớn hơn 0 nếu cần một giới hạn thời gian độc lập. Việc dọn theo quota vẫn là lớp bảo vệ cuối cùng khi ổ đĩa sắp đầy.
- Không dùng thư mục Documents làm nơi duy nhất cho dữ liệu quan trọng: nên có RAID và backup ngoài máy cho recording cần lưu lâu dài.
- Giảm bitrate main stream trước khi giảm retention nếu cần tiết kiệm dung lượng.
- Dùng sub-stream AI. Nhiều luồng AI hoặc nhiều live H.265 cần server Linux/NVIDIA chuyên dụng; cấu hình CPU mặc định phù hợp để bắt đầu, không phải cam kết hiệu năng cho số camera không giới hạn.

## Vận hành, backup và cập nhật

```bash
# Xem trạng thái/log
docker compose ps
docker compose logs -f backend ai

# Cập nhật code rồi build lại
git remote set-url origin https://github.com/TuyenND7/camera-rtsp-platform.git
git pull --ff-only
docker compose up -d --build

# Backup PostgreSQL (chạy trong thư mục project)
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backups/camera_platform-$(date +%F).sql

# Dừng (giữ DB và recording)
docker compose down

# NGUY HIỂM: xoá PostgreSQL volume, không xoá bind-mounted storage/
docker compose down -v
```

Backup `storage/` bằng công cụ backup filesystem/NAS theo lịch; không dùng `docker compose down -v` nếu chưa có backup DB.

## API

- `POST /api/talk/capabilities`: kiểm tra các `camera_ids` đã lưu, không sửa cấu hình camera.
- `POST /api/talk/sessions`: mở đàm thoại cho `camera_ids` (HTTPS, admin).
- `POST /api/talk/sessions/:id/audio`: PCM 16-bit LE mono 8 kHz, `application/octet-stream`, header `X-Audio-Sequence` bắt đầu từ 0; mỗi gói 20–400 ms, tối đa 6400 byte.
- `DELETE /api/talk/sessions/:id`: dừng ngay cuộc đàm thoại thuộc đúng phiên đăng nhập.

- `POST /api/auth/login`
- `GET /api/auth/session` — kiểm tra cookie và lấy user/token CSRF
- `POST /api/auth/logout` — thu hồi phiên hiện tại
- `GET/POST /api/cameras`, `GET/PUT/DELETE /api/cameras/:id`
- `POST /api/cameras/:id/start|stop`
- `POST /api/cameras/onvif/probe` — dò thông tin thiết bị, profile và RTSP URI qua ONVIF
- `GET /api/cameras/discovery/options` — dải mạng nội bộ được đề xuất
- `POST /api/cameras/discovery` — bắt đầu dò, body `{ "subnet": "192.168.0.0/24" }`
- `GET /api/cameras/discovery/:scanId` — tiến độ và các thiết bị tìm thấy
- `DELETE /api/cameras/discovery/:scanId` — dừng lượt dò, không xóa thiết bị
- `GET /api/recordings/:cameraId/days`
- `GET /api/recordings/:cameraId/:day`
- `GET /api/recordings/:cameraId/:day/playlist?from=<segment>` — playlist playback bắt đầu từ một mốc đã chọn
- `POST /api/recordings/:cameraId/:day/browser-playback` — tạo/kiểm tra HLS H.264 tương thích browser cho recording HEVC
- `GET /api/recordings/storage` — dung lượng volume storage và chính sách tự dọn
- `GET /api/events?cameraId=&from=&to=&label=&limit=`
- `GET /api/health`

Login dùng JSON và header `X-Requested-With: CameraStation`. Trình duyệt tự gửi cookie; thao tác thay đổi thêm `X-CSRF-Token` từ login/session. Client API có thể dùng `Authorization: Bearer <token>` được trả khi login; bearer cũng được kiểm tra trong DB và bị thu hồi khi logout. Không đặt token trong query string, URL video hoặc log.

## Cấu trúc dữ liệu

```text
storage/live/<cameraId>/              HLS live tạm thời
storage/rec/<cameraId>/<YYYYMMDD>/    Recording .ts và playlist
storage/events/<cameraId>/<YYYYMMDD>/ Snapshot AI
models/                               Weight YOLO
Docker volume pgdata                  PostgreSQL
```

### API cài đặt video thiết bị

- `GET /api/cameras/:id/video-settings`: admin, đọc cấu hình và các giới hạn ONVIF; không trả RTSP URL hay tài khoản.
- `PUT /api/cameras/:id/video-settings`: HTTPS + admin + CSRF, JSON `{ profile_token, revision, width, height, fps?, bitrate? }`. Profile được lấy lại từ đúng camera, kiểm tra revision và giới hạn trước khi ghi. `confirmed` chỉ là `true` khi thông số đọc lại khớp. Không thay tên dịch vụ/URL/codec tùy ý từ request.

Tham chiếu [ONVIF Media: Get/SetVideoEncoderConfiguration](https://www.onvif.org/ver10/media/wsdl/) và [PTZ: ContinuousMove/Stop](https://www.onvif.org/ver20/ptz/wsdl/).

### Các cài đặt TDSEE trên camera

Đã đối chiếu trang Settings của ứng dụng TDSEE đang đăng nhập trên Lenovo, dữ liệu CT3 thực tế và [hướng dẫn chính thức TDSEE](https://ma.tenda.com.cn/UserFiles/file/20241209/20241209175319_0973.pdf). Một số mục phụ thuộc model/firmware; không hiển thị nút giả cho chức năng camera chưa cung cấp.

- Đèn chiếu sáng (flash): bật/tắt đèn trắng; có thể mở cài đặt ngay từ biểu tượng bánh răng trên từng ô Live.
- Nhìn đêm: đen trắng / có màu / thông minh; hồng ngoại tự động / bật / tắt.
- Hướng lắp camera, đèn trạng thái và tần số chống nhấp nháy 50/60 Hz.
- Riêng tư: che hình camera; có thể tắt lại bằng SDK dù RTSP đang mất hình.
- Phát hiện chuyển động, độ nhạy, thông báo TDSEE, còi/đèn khi phát hiện. Không tự bật những mục này khi mở web.
- Chế độ đàm thoại; âm lượng micro/loa chỉ xuất hiện nếu thiết bị trả thuộc tính tương ứng (hai CT3 hiện không trả các mức âm lượng này).
- Trạng thái/dung lượng thẻ nhớ và chế độ không ghi / ghi báo động / ghi cả ngày. Chỉ ghi cấu hình thẻ khi thẻ sẵn sàng; hai CT3 hiện báo chưa có thẻ.
- Firmware, múi giờ và tín hiệu Wi-Fi hiện được đọc để xem thông tin.

Các thao tác đổi Wi-Fi, nâng firmware, reset, xóa liên kết, định dạng thẻ và dịch vụ cloud của hãng chưa đưa vào bản tích hợp này. Không sao chép toàn bộ thuộc tính SDK ra web: dữ liệu Wi-Fi/tài khoản/khóa thiết bị luôn bị lọc.

API admin: `GET/PUT /api/cameras/:id/device-settings`. Ghi qua HTTPS + CSRF, body `{ revision, changes: { indicator: 0 } }`; backend và worker Windows đều kiểm tra danh sách trường/giá trị cho phép, ID/fingerprint/generation, revision và khả năng thực tế. Adapter phải công bố `settings_version: 1`. Lệnh SDK ACK chưa khớp đọc lại trả `confirmed: false`.
