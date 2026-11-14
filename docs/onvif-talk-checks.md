# Kiểm tra đàm thoại local Tenda — 14/11/2026

**Chưa xác nhận được tiếng phát qua ONVIF/RTSP local.** Giữ nguyên đường SDK hiện tại; chưa chuyển mic trên web sang các track audio suy đoán. API báo thành công không thay thế xác nhận nghe tại loa.

## Thiết bị đã kiểm tra

| Camera trong DB | Firmware | Kết quả đọc ONVIF/RTSP |
| --- | --- | --- |
| 1 — RH7V2.0 | V25.4.30.93 | Media2 không liệt kê AudioOutput/AudioDecoder trong ConfigurationsSupported; các truy vấn output/decoder không trả cấu hình dùng được. DESCRIBE thường và backchannel không cung cấp track nhận tiếng rõ ràng. |
| 2 — CT3V1.0 ngoài sân | 2311090955 | Có AudioOutput, decoder G.711 8 kHz và tuỳ chọn SendPrimacy; SDP không có `a=sendonly` hoặc track backchannel riêng. Đã nghe thử các lượt local bên dưới, đều chưa nghe tiếng. |
| 3 — CT3V1.0 trong nhà | 2311090955 | Các khả năng và SDP tương tự camera 2. Lần kiểm tra này chỉ đọc cấu hình, chưa nghe thử âm local tại camera 3. |

## Các lượt thử

- TCP trong LAN, PCMA: gắn output/decoder vào profile phụ, SETUP/PLAY trả 200, gửi 250 frame trong 5 giây. Người dùng không nghe tiếng.
- TCP với `mode=record`, PCMU: SETUP/PLAY trả 200, gửi đủ 5 giây. Người dùng không nghe tiếng.
- Thử trực tiếp từ Mac cùng LAN để loại trừ ảnh hưởng của Docker/VPN: TCP SETUP trả 200; UDP dạng `RTP/AVP` và `RTP/AVP/UDP` đều trả **461 Unsupported Transport**. Không gửi âm thanh trong lượt kiểm tra transport này.
- Tạo profile riêng có VideoSource/VideoEncoder + AudioOutput/AudioDecoder, **không có AudioSource/AudioEncoder**. Camera trả URI riêng `/profile2`; SDP vẫn không khai báo hướng backchannel. Gửi PCMA 5 giây qua TCP trực tiếp từ Mac, không gọi SDK. Người dùng vẫn không nghe tiếng. Profile tạm đã được xoá và đối chiếu lại danh sách profile gốc.
- DeviceIO được kiểm tra bằng đúng `AudioOutputToken`, đọc trường `AudioOutputConfiguration`. Đổi thử OutputLevel 100 → 99 đọc lại đúng, sau đó trả về 100 và xác minh. Gửi SendPrimacy `HalfDuplex/Client` được ACK nhưng không đọc lại được giá trị này; chưa coi là chế độ đã áp dụng.
- Web camera CT3 dùng một số API PSIA. Đăng nhập bằng tài khoản camera và đọc `/PSIA/System/deviceInfo` thành công. Những endpoint audio/đàm thoại PSIA/ISAPI phổ biến đã kiểm tra trả 404; chưa tìm được kênh HTTP audio local hoạt động.

Các lượt phát thử dùng chương trình chẩn đoán riêng, có suy đoán track chỉ cho mục đích kiểm chứng tương thích. **Không đưa cách suy đoán này vào transport của ứng dụng.** Không phát còi, không thay mật khẩu, không flash/reset firmware.

## Cấu hình còn lại

- Các profile thử không cố định đã được xoá; camera 2 hiện có hai profile gốc `PROFILE_000` và `PROFILE_001`.
- `PROFILE_001` của camera 2 còn liên kết `AudioOutputConfiguration=AOUT_CFG_000` từ lượt thử đầu. Decoder tạm đã gỡ. Firmware từ chối gỡ output khỏi profile cố định với lỗi `Deleting Fixed Profile`.
- Cùng thao tác RemoveAudioOutputConfiguration trên profile tạm không cố định hoạt động bình thường. Không xoá/reset profile cố định để ép hoàn trả. Profile chính `PROFILE_000` và RTSP URL dùng ghi hình được giữ nguyên; cấu hình mức loa đã hoàn trả.

## Chạy lại kiểm tra chỉ đọc

Script [probe-onvif-talk.cjs](../backend/scripts/probe-onvif-talk.cjs) đọc DB hiện có, truy vấn khả năng ONVIF và gọi trực tiếp RtspTalk để DESCRIBE. Nó không đi qua TalkManager nên không bị chọn nhầm adapter SDK. Không tạo/sửa profile, không SETUP/PLAY, không gửi audio.

```powershell
Get-Content -Raw .\backend\scripts\probe-onvif-talk.cjs | docker compose exec -T backend node -
```

Mã web/backend đã sửa cách đọc hướng SDP và phân biệt lỗi RTSP 551. Điều này sửa lỗi tuân thủ chuẩn, **chưa làm firmware Tenda tự có backchannel hoạt động**. Muốn xác nhận bỏ được cloud cần mở kênh LAN, nghe được tại loa và sau đó kiểm chứng khi không có phiên/dịch vụ cloud; các điều kiện này chưa đạt trong những lượt thử trên.

Nguồn giao thức: [ONVIF Streaming 21.06, mục 5.3.2](https://www.onvif.org/specs/2106/ONVIF-Streaming-Spec-v2106.pdf), [Media WSDL](https://www.onvif.org/ver10/media/wsdl/media.wsdl), [DeviceIO WSDL](https://www.onvif.org/ver10/deviceio.wsdl). Các kết quả firmware trong báo cáo lấy từ camera thực tế, không suy rộng sang model/phiên bản khác.
