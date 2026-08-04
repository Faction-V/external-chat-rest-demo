import { createRoot } from 'react-dom/client';

import './index.css';
import { App } from './App';

/**
 * No StrictMode here, deliberately. StrictMode double-invokes mount effects in
 * development, which would double every entry in the REST inspector — the one
 * thing this demo exists to show accurately. Turn it back on if you fork this
 * into a real app.
 */
createRoot(document.getElementById('root')!).render(<App />);
