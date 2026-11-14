# Đàm thoại Tenda trên máy chủ Windows

Adapter này nối mic của website tới SDK LinkVisual được dùng trong TDSEE Studio. Tablet/iPhone vẫn mở website hiện có; không cần thêm giao diện native hoặc cắm mic vào máy chủ Windows. Live và recording tiếp tục dùng FFmpeg/RTSP.

Hai model được liên kết hiện tại là **CT3V1.0** và **RH7V2.0**. Ngày 13/11/2026, đường SDK đã phát được âm thử trên CT3 ngoài sân và được người dùng xác nhận nghe tại loa. Không suy rộng kết quả này sang mọi firmware/model Tenda.

## Điều kiện

- Windows 10/11 x64 với .NET Framework 4.8; script dùng compiler có sẵn của Framework, không cần cài .NET SDK hay Visual Studio.
- Máy chủ truy cập được Internet, có tài khoản TDSEE được phép đàm thoại với các camera. SDK có thể dùng P2P hoặc relay của nhà cung cấp; đây là đường riêng so với RTSP trong LAN.
- Web mở bằng HTTPS, đã cấp quyền mic. App Camera Station Android dùng URL HTTPS và bản có quyền thu âm.
- Runtime **TDSEE Studio 1.0.7** đúng các hash trong `RuntimeHashes.json`, cùng cấu hình SDK/tài khoản được cấp cho bản tích hợp. DLL, khóa ứng dụng và phiên đăng nhập không nằm trong Git.

Bản runtime tham chiếu lấy từ [trang tải chính thức của Tenda](https://www.tendacn.com/material/show/664454441640005?proPath=CP7V10). Tài liệu [SDK đàm thoại PC](https://help.aliyun.com/zh/linkvisual/video-multimedia-sdk), [xác thực OAuth](https://help.aliyun.com/zh/linkvisual/account-and-user-sdk-2) và [cấp SDK](https://help.aliyun.com/zh/linkvisual/get-the-app-s-sdk) mô tả API/điều kiện của nhà cung cấp. Bộ cài ứng dụng không chứa đầy đủ header phát triển; lớp interop trong repo khóa đúng ABI/runtime đã thử. Thay DLL phiên bản khác sẽ bị từ chối thay vì gọi nhầm interface.

## Cài trên máy chủ

Máy CAMERA hiện tại được provision riêng bằng phiên tài khoản TDSEE của chủ thiết bị. Với máy mới, chuẩn bị runtime và provisioning riêng trước khi chạy script; không dùng mật khẩu RTSP thay cho tài khoản TDSEE.

Provisioning là JSON bên ngoài repo, gồm:

| Trường | Nội dung |
| --- | --- |
| `appKey`, `encryptedAppSecret` | Thông số ứng dụng SDK được cấp cho bản tích hợp. |
| `region` | Vùng tài khoản TDSEE: `sa`, `cn`, `eu` hoặc `us`; chọn đúng tài khoản đang dùng. |
| `accessToken` | Phiên TDSEE chủ thiết bị để cấp authorization code khi SDK chưa có phiên hợp lệ. |
| `cloudSignatureSalt`, `cloudHeaders` | Thông số ký request của client tương thích; headers gồm Terminal/App-Id/Project-Id/AppSource và thông tin phiên phù hợp. |
| `ipcDirectory` | Đường dẫn Windows tới `<storage>\.tenda-talk`, cùng storage đã mount vào backend. |
| `bindings` | Danh sách `{ id, model, iotId, url_hash }`. `id` là ID trong DB; `iotId` là ID cloud đúng camera; `url_hash` là SHA-256 của chuỗi RTSP URL hiện tại trong DB. |

Không đưa provisioning vào log, Git hoặc thư mục web. Nếu chuyển máy, cấp lại phiên hoặc import provisioning được quản lý riêng; file DPAPI của máy cũ không giải mã được trên máy mới.

Mở **PowerShell Run as administrator**, từ thư mục project:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\tenda-talk\Install.ps1 `
  -RuntimeDirectory 'C:\SDK\TDSEE_Studio_1.0.7' `
  -ProvisioningFile 'C:\Private\tenda-account.private.json' `
  -StorageAccount 'Tuyen'
```

`StorageAccount` là tài khoản Windows chạy Docker Desktop và truy cập storage. Script kiểm tra hash runtime, biên dịch agent, mã hóa cấu hình bằng DPAPI LocalMachine, đặt ACL cho SYSTEM/Administrators, cấp tài khoản storage quyền trên IPC, rồi tạo task **Camera Station Tenda Talk** chạy SYSTEM khi Windows khởi động. Chỉ process chạy script dùng tùy chọn execution policy ở trên; script không thay policy toàn máy.

Sau khi kiểm tra agent hoạt động, cất/xóa provisioning dạng rõ theo quy trình quản lý tài khoản. File đang dùng là `C:\ProgramData\CameraStation\TendaTalk\config.bin`. Không cần mở TDSEE trên tablet thường trực.

Backend tự nhận agent qua storage đã mount, không cần mở thêm cổng hoặc đổi URL web. Khi camera đổi RTSP URL/mật khẩu, phải cập nhật fingerprint liên kết rồi provision lại; adapter không tự gán loa của camera cũ cho một thiết bị mới.

## Kiểm tra và khởi chạy

```powershell
Get-ScheduledTask -TaskName 'Camera Station Tenda Talk'
Get-ScheduledTaskInfo -TaskName 'Camera Station Tenda Talk'
Get-Content 'C:\Users\Tuyen\Documents\CameraRTSP\storage\.tenda-talk\status.json'
Get-Content 'C:\ProgramData\CameraStation\TendaTalk\agent.log' -Tail 10
```

`status.json` chỉ có trạng thái, generation và fingerprint liên kết; `authenticated` phải là `true`, `updated_at` cập nhật liên tục. Sau đó mở Live → mic đỏ → chọn camera → giữ để nói. Thử từng loa trước khi chọn nhiều camera. Popup vẫn phân biệt **đang gửi tiếng** với việc đã nghe được âm thanh thực tế.

Dừng sạch rồi khởi động lại:

```powershell
New-Item -ItemType File -Force 'C:\ProgramData\CameraStation\TendaTalk\stop-agent'
Start-Sleep -Seconds 2
Stop-ScheduledTask -TaskName 'Camera Station Tenda Talk'
Remove-Item 'C:\ProgramData\CameraStation\TendaTalk\stop-agent'
Start-ScheduledTask -TaskName 'Camera Station Tenda Talk'
```

Lỗi `sdk_account_relink_required` yêu cầu cấp lại phiên TDSEE phù hợp. Lỗi `sdk_runtime_version_mismatch` yêu cầu runtime đúng phiên bản. Agent tự khởi chạy lại với thời gian chờ tăng dần khi process lỗi; lỗi đàm thoại không dừng FFmpeg/recording.

### Đăng nhập và tự gia hạn trên web

Đường đàm thoại không chuyển tiếp từng gói tiếng qua app TDSEE trên tablet và không cần giữ app hãng mở thường xuyên. Khi SDK đã có phiên cache hợp lệ, agent có thể dùng lại. Khi SDK phải đăng nhập lại, agent dùng access token TDSEE đã provision trên PC để xin authorization code từ cloud hãng.

Mở **Cài đặt → Tài khoản Tenda → Đăng nhập**, nhập email hoặc số điện thoại và mật khẩu TDSEE đang sở hữu camera. Chỉ admin qua HTTPS được dùng chức năng này. Không nhập mật khẩu RTSP vào đây. Vùng đăng ký được giữ theo tài khoản đã provision; tính năng này gia hạn tài khoản hiện có, không tự tìm hoặc chuyển camera sang chủ tài khoản khác.

Backend mã hóa mật khẩu bằng RSA-OAEP-SHA256 trước khi chuyển qua IPC. Khóa riêng và access token chỉ lưu trong thư mục adapter, được Windows DPAPI bảo vệ. Mật khẩu dùng cho lần đăng nhập, không lưu vào cấu hình, database hoặc log. Kết quả web chỉ có trạng thái, tên tài khoản đã che và hạn phiên. Khi đóng hộp thoại hoặc phiên admin bị thu hồi, heartbeat yêu cầu dừng; adapter kiểm tra lại trước khi lưu.

Adapter gọi `index/login/check/v2` trước để lấy email/số điện thoại chuẩn và chế độ mật khẩu của tài khoản. Theo luồng TDSEE, mật khẩu UTF-8 được đệm byte 0 tới bội số 4, ghép SHA-1 của định danh chuẩn rồi MD5 năm lần trước khi gọi `login/password/v2`; không gửi mật khẩu gốc tới endpoint đăng nhập. Tài khoản liên kết cả email và số điện thoại dùng định danh theo `encrypt_mode`/`se_encrypt_mode` do Tenda trả về. Không gửi token cũ trong bước đăng nhập mới. Lỗi trả về chỉ giữ mã số và bước xử lý, không lưu phản hồi thô; web phân biệt không tìm thấy tài khoản, sai mật khẩu và yêu cầu xác minh thiết bị.

Số điện thoại Việt Nam chấp nhận đầu `0`, `84`, `+84` và dấu cách/dấu phân cách. Giữ cách đăng nhập cũ nếu Tenda nhận đúng định danh ban đầu; chỉ khi trả `100421` mới thử thêm một dạng bỏ tiền tố `0`/`84`. Bước đăng nhập dùng đúng định danh vừa tìm thấy, còn băm mật khẩu dùng email/số chuẩn do Tenda trả về. Không thử lại mật khẩu hoặc dò email/tài khoản khác; lỗi khác và yêu cầu xác minh được trả ngay. Nếu vẫn báo không tìm thấy, đối chiếu số/email và cách đăng nhập trong TDSEE, kể cả Apple/Google, trước khi đổi mật khẩu.

Sau khi đăng nhập thành công, máy chủ tự gọi API refresh trước hạn khoảng hai phút; API của phiên bản TDSEE tham chiếu dùng access token hiện tại và terminal, không có refresh token riêng. Lỗi mạng được thử lại với thời gian chờ tăng dần; khi Tenda từ chối phiên, web báo cần đăng nhập lại. Không lưu mật khẩu để tự đăng nhập vô hạn. Thao tác đăng nhập mới bị chặn khi mic/còi/điều khiển đang chạy; gia hạn cùng chủ tài khoản không dừng các worker đang hoạt động.

Máy chủ dùng terminal riêng và xác minh lại authorization code với hãng, UID và project trước khi thay cấu hình. Cả ba liên kết camera và kho recording được giữ nguyên. Phiên cũ đã provision vẫn dùng được theo cache SDK; cần đăng nhập một lần trên web để bật tự gia hạn. Sau đó không cần lấy phiên từ app TDSEE trên tablet, nhưng vẫn phụ thuộc dịch vụ xác thực/SDK Tenda và có thể cần đăng nhập lại khi hãng thu hồi phiên.

Các endpoint đăng nhập/refresh tham chiếu từ client TDSEE; đây chưa phải bộ SDK đăng nhập có hợp đồng API công khai ổn định. Nhà cung cấp đổi giao thức, yêu cầu xác minh bổ sung hoặc đổi vùng có thể cần cập nhật adapter. Kiểm thử giả lập xác nhận luồng dữ liệu/quyền/mã hóa; đăng nhập và gia hạn tài khoản thật cần được kiểm tra sau khi chủ tài khoản nhập trực tiếp trên web.

Cập nhật adapter hiện có mà không provision lại (PowerShell admin):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\tenda-talk\Test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\tenda-talk\Update.ps1
```

Script biên dịch trước khi dừng task, kiểm hash runtime, giữ `config.bin`, khóa tài khoản và cache SDK. Bản executable trước được giữ trong thư mục riêng để khôi phục. Backend/web cũng cần build và cập nhật bằng Docker Compose như README gốc.

Ngày 14/11/2026, đã kiểm tra mở kênh/gửi PCM im lặng/đóng kênh qua HTTPS trên Lenovo: hai CT3 đồng thời và RH7 riêng đều trả `201`/`204`/`204`. RH7 đã bật lại; cả ba Live tiếp tục phát. Lần kiểm tra này chưa xác nhận giọng nói thực tế tại loa. Xem [sơ đồ các luồng và phụ thuộc](../../docs/he-thong-camera.html).

## Đường âm thanh và bảo vệ phiên

Web gửi PCM mono 16-bit 8 kHz qua API HTTPS/admin/CSRF hiện có. Backend tạo phiên UUID trong `/storage/.tenda-talk`; agent Windows xác minh generation, tuổi lệnh, ID và fingerprint trước khi mở SDK. SDK phải báo đầu camera sẵn sàng, recorder sẵn sàng và có callback PCM thì backend mới cho gửi tiếng.

Agent dùng nguồn PCM riêng trong process của nó để thay input thiết bị của SDK, cùng output sink im lặng. Phần thay factory COM chỉ áp dụng cho module SDK đã kiểm hash; không cài audio driver và không sửa DLL trên đĩa hay audio của ứng dụng khác. SDK vẫn thực hiện xác thực, kết nối, mã hóa và gửi âm thanh tới camera.

IPC không có listening port và không nằm dưới các alias HTTP `/live`, `/rec`, `/playback`, `/thumbs` hay `/events`. Gói mic tạm được xóa sau cuộc gọi; agent dọn phiên bỏ lại khi process/backend chết. Agent đóng loa khi heartbeat mất hơn 1,5 giây, SDK lỗi hoặc đạt giới hạn thời gian. Backend vẫn kiểm tra quyền đăng nhập/cấu hình camera trong suốt cuộc gọi.

Backend và nguồn PCM SDK giữ mốc thời gian tuyệt đối cho frame 20 ms, bù những lần timer chạy chậm để bộ đệm không tăng dần. Khi Windows/Docker tạm khóa file đang thay thế, chỉ bản trạng thái đã kiểm tra còn trong thời hạn gốc được dùng lại; việc đọc hụt không gia hạn phiên. Trạng thái thu hồi tài khoản hoặc đổi generation vẫn vô hiệu hóa ngay khi đọc được.

Kiểm thử lỗi tranh chấp file và thu hồi trạng thái, không cần runtime hay tài khoản TDSEE:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\tenda-talk\Test.ps1
```

## Kết quả kiểm tra trên máy CAMERA ngày 13/11/2026

- Backend và web đã build bằng Docker và triển khai trên Windows; task SDK đang chạy và tự khởi động cùng máy.
- App Camera Station trên Lenovo mở HTTPS qua Tailscale: mic thật truyền được tới hai CT3 đồng thời trong hai phiên liên tiếp, mỗi phiên hơn 20 giây. API tạo phiên trả `201`, các gói audio trả `204`; nhả tay trả `204` và hai worker SDK đóng kênh. Gọi riêng camera ngoài sân cũng đã kiểm tra hơn 20 giây.
- Hai SDK báo đầu camera/recorder sẵn sàng và tiêu thụ PCM; Live tiếp tục cập nhật playlist, recording tiếp tục tạo segment. Đây là xác nhận đường truyền, không thay thế nghe tại loa. Người dùng đã xác nhận âm bíp SDK ở camera ngoài sân trước đó; giọng nói từ web ở từng loa cần được nghe thử thực tế.
- RH7 đã liên kết cấu hình nhưng đang tắt theo xác nhận của chủ thiết bị; chưa kiểm tra lại đàm thoại web trong lần triển khai này.
- Build backend/web, 32 kiểm thử đàm thoại/bảo mật/IPC backend và kiểm thử tranh chấp file trên Windows đạt. Web còn cảnh báo kích thước chunk Vite hiện có.

## Nút còi và đèn trên web

Mở **Live → Khẩn cấp** để chọn nhóm camera và bấm **Báo động**, hoặc chạm một ô rồi chọn biểu tượng chuông để điều khiển từng camera. Mọi lần bật còi cần xác nhận camera/thời lượng; dừng còi gửi ngay. Cài đặt thời lượng dùng chung trên web: 10, 15, 30, 60 giây hoặc đến khi người dùng tắt. Chế độ thủ công có `duration_seconds: 0`, lease không có deadline; worker phát heartbeat mỗi giây và được broker cho chạy quá 70 giây khi lease/binding/generation/heartbeat còn hợp lệ. Worker hết heartbeat hoặc agent dừng/mất xác thực được dừng và lease mồ côi được phục hồi bằng lệnh tắt. Còi thủ công tiếp tục khi đóng web nhưng dừng khi nhấn Dừng còi hoặc máy chủ/adapter kết thúc phiên. Không bật nhận dạng/cảnh báo chuyển động tự động.

Đường này dùng [SDK vật mô hình PC của LinkVisual](https://help.aliyun.com/zh/linkvisual/object-model-sdk-2) trong `iottmp.dll`, cùng phiên SDK đã xác thực: gọi dịch vụ **oneKeyAlarm** với `operate=1/0` và thuộc tính **TurnLight=1/0**. DLL được kiểm SHA-256 như các thư viện hiện có. Không dùng phiên REST TDSEE đã hết hạn để điều khiển.

Backend chỉ cho phép hai thao tác này trên camera đã liên kết đúng ID/fingerprint; API không nhận tên dịch vụ, thuộc tính, URL hay thông tin đăng nhập tùy ý. Toàn bộ thuộc tính thiết bị được đọc trong worker Windows; chỉ cờ còi/đèn và thời gian được đưa ra IPC/web, không trả thông tin Wi-Fi hay khóa thiết bị.

CT3 đang dùng không cập nhật `AudibleStatus` cho lệnh còi thủ công dù đã phát tiếng. Vì vậy web hiển thị lệnh đã gửi và thời gian tự dừng; `alarm_active` để `null` khi không có phản hồi vật lý đáng tin cậy. `alarm_command_active` và `alarm_until_stopped` lấy từ lease đã kiểm tra, giúp web giữ nút Dừng còi cả khi không có deadline. Không coi ACK SDK là bằng chứng loa đã phát. Người dùng đã xác nhận nghe còi gốc trên CT3 ngoài sân trong lượt thử 5 giây. Đèn trắng ngoài sân đã kiểm tra trạng thái `TurnLight` đổi 0 → 1 → 0.

API dành cho admin:

- `GET /api/cameras/:id/controls`: đọc khả năng và trạng thái đã lọc.
- `POST /api/cameras/:id/controls`: HTTPS + phiên admin + CSRF; JSON `{ "action": "alarm" | "light", "enabled": true | false, "duration_seconds": 0 | 10 | 15 | 30 | 60 }`.

App Android vẫn chỉ hiển thị website. Snapshot PNG được tạo từ video đang phát trong trình duyệt; hỗ trợ lưu/chia sẻ file của từng WebView có thể khác Chrome/Safari.

## Cài đặt thiết bị theo TDSEE

Agent công bố thêm `settings_version: 1`. `DeviceSettings.cs` lọc các thuộc tính công khai theo danh sách cho phép, giữ nguyên những trường khác trong cấu trúc khi sửa nhìn đêm hoặc còi/đèn báo động. Revision tính trên các giá trị đã lọc; thay đổi bên TDSEE làm revision cũ bị từ chối. Mở tab cài đặt chỉ đọc, không tự đặt lại thông số.

Các request `settings` trong IPC yêu cầu binding/generation/tuổi lệnh như lệnh còi/đèn, chỉ nhận số nguyên và các trường đã khai báo. Không nhận tên thuộc tính/service/URL tùy ý, reset hoặc định dạng thẻ. Camera đang đàm thoại/còi sẽ từ chối cập nhật. Trạng thái đọc lại phải khớp mới xác nhận; không lộ các thuộc tính Wi-Fi hoặc khóa thiết bị. Cài đặt âm lượng chỉ được công bố nếu model thực sự trả về các thuộc tính volume.
