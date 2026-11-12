// Apply the saved choice before the first render, including the login page.
try {
  var cameraTheme = localStorage.getItem('camera-station.theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = cameraTheme;
  document.documentElement.style.colorScheme = cameraTheme;
  var cameraThemeMeta = document.querySelector('meta[name="theme-color"]');
  if (cameraThemeMeta) cameraThemeMeta.setAttribute('content', cameraTheme === 'dark' ? '#0e1725' : '#f5f8fc');
} catch (_) {}
