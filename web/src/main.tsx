import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './theme';
import { DeviceProvider } from './device';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider><DeviceProvider><App /></DeviceProvider></ThemeProvider>
  </React.StrictMode>
);
