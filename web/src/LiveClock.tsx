import { useEffect, useState } from 'react';

const time = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const date = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });

export default function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const formattedTime = time.format(now), formattedDate = date.format(now);
  return <time className="mi-live-clock" dateTime={now.toISOString()} title={`Giờ Việt Nam: ${formattedTime} · ${formattedDate}`} aria-label={`${formattedTime}, ${formattedDate}`}><strong>{formattedTime.slice(0, 5)}<span className="mi-live-clock-seconds">{formattedTime.slice(5)}</span></strong><span>{formattedDate.slice(0, 5)}<span className="mi-live-clock-year">{formattedDate.slice(5)}</span></span></time>;
}
