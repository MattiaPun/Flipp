// Runs before first paint (CSP forbids inline scripts) so there is no theme flash.
try { const t = localStorage.getItem('flipp.theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
