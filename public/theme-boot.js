// Apply the saved appearance before the stylesheet paints to avoid a theme flash.
(function () {
  try {
    var raw = localStorage.getItem('eleganza.preferences');
    var prefs = raw ? JSON.parse(raw) : {};
    var root = document.documentElement;
    var accents = ['mint', 'azure', 'violet', 'amber', 'rose', 'champagne'];
    root.dataset.theme = prefs.theme === 'light' ? 'light' : 'dark';
    root.dataset.accent = accents.indexOf(prefs.accent) >= 0 ? prefs.accent : 'mint';
    root.dataset.density = prefs.density === 'compact' ? 'compact' : 'comfortable';
    root.dataset.effects = prefs.effects === false ? 'off' : 'on';
    root.dataset.motion = prefs.motion === false ? 'off' : 'on';
    root.style.colorScheme = root.dataset.theme;
  } catch (error) {
    // localStorage can be unavailable in hardened browsers; defaults still paint.
  }
})();
