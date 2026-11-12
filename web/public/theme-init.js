// Apply the saved choice before the first render, including the login page.
try {
  var cameraTheme = localStorage.getItem('camera-station.theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = cameraTheme;
  document.documentElement.style.colorScheme = cameraTheme;
  var cameraThemeMeta = document.querySelector('meta[name="theme-color"]');
  if (cameraThemeMeta) cameraThemeMeta.setAttribute('content', cameraTheme === 'dark' ? '#0e1725' : '#f5f8fc');
  var cameraTextSize = Number(localStorage.getItem('camera-station.text-size'));
  if ([100, 125, 150, 200].indexOf(cameraTextSize) === -1) cameraTextSize = 100;
  document.documentElement.dataset.textSize = String(cameraTextSize);
  document.documentElement.style.setProperty('--text-scale', String(cameraTextSize / 100));
} catch (_) {}
