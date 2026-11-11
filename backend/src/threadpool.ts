// Docker Desktop bind mount (Windows -> Linux) làm mỗi lần stat là một round-trip
// chậm. Tăng libuv threadpool để các fs.promises.stat chạy song song nhiều hơn.
// Phải import file này TRƯỚC mọi module khác, vì threadpool khởi tạo ở lần dùng đầu.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

export {};
