import { useEffect, useState } from 'react';

const time = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const date = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });

export default function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <time className="mi-live-clock" dateTime={now.toISOString()} title="Giờ Việt Nam (UTC+7)"><strong>{time.format(now)}</strong><span>{date.format(now)}</span></time>;
}
