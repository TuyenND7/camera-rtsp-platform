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

## Đường âm thanh và bảo vệ phiên

Web gửi PCM mono 16-bit 8 kHz qua API HTTPS/admin/CSRF hiện có. Backend tạo phiên UUID trong `/storage/.tenda-talk`; agent Windows xác minh generation, tuổi lệnh, ID và fingerprint trước khi mở SDK. SDK phải báo đầu camera sẵn sàng, recorder sẵn sàng và có callback PCM thì backend mới cho gửi tiếng.

Agent dùng nguồn PCM riêng trong process của nó để thay input thiết bị của SDK, cùng output sink im lặng. Phần thay factory COM chỉ áp dụng cho module SDK đã kiểm hash; không cài audio driver và không sửa DLL trên đĩa hay audio của ứng dụng khác. SDK vẫn thực hiện xác thực, kết nối, mã hóa và gửi âm thanh tới camera.

IPC không có listening port và không nằm dưới các alias HTTP `/live`, `/rec`, `/playback`, `/thumbs` hay `/events`. Gói mic tạm được xóa sau cuộc gọi; agent dọn phiên bỏ lại khi process/backend chết. Agent đóng loa khi heartbeat mất hơn 1,5 giây, SDK lỗi hoặc đạt giới hạn thời gian. Backend vẫn kiểm tra quyền đăng nhập/cấu hình camera trong suốt cuộc gọi.
