import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './style.css';
import './readability.css';
import './posting-detail.css';
import './focus-jobs.css';
import './mobile-layout.css';
import './theme-sage.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
