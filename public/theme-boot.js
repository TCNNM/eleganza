// Apply the saved appearance before the stylesheet paints to avoid a style flash.
(function () {
  try {
    var raw = localStorage.getItem('eleganza.preferences');
    var prefs = raw ? JSON.parse(raw) : {};
    var root = document.documentElement;
    var themes = { cosmos: 'dark', paper: 'light', terminal: 'dark', gilded: 'dark' };
    var defaults = { cosmos: 'mint', paper: 'amber', terminal: 'lime', gilded: 'champagne' };
    var accents = ['mint', 'azure', 'violet', 'amber', 'rose', 'champagne', 'lime'];
    var style = themes[prefs.style] ? prefs.style : (prefs.theme === 'light' ? 'paper' : 'cosmos');
    root.dataset.style = style;
    root.dataset.theme = themes[style];
    root.dataset.accent = accents.indexOf(prefs.accent) >= 0 ? prefs.accent : defaults[style];
    root.dataset.density = prefs.density === 'compact' ? 'compact' : 'comfortable';
    root.dataset.effects = prefs.effects === false ? 'off' : 'on';
    root.dataset.motion = prefs.motion === false ? 'off' : 'on';
    root.style.colorScheme = themes[style];
  } catch (error) {
    // localStorage can be unavailable in hardened browsers; defaults still paint.
  }
})();
