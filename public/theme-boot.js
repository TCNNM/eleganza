// Apply the saved appearance before the stylesheet paints to avoid a style flash.
(function () {
  try {
    var raw = localStorage.getItem('eleganza.preferences');
    var prefs = raw ? JSON.parse(raw) : {};
    var root = document.documentElement;
    var themes = {
      cosmos: 'dark', paper: 'light', terminal: 'dark', gilded: 'dark',
      popipa: 'dark', afterglow: 'dark', pasupare: 'light', roselia: 'dark',
      hhw: 'light', morfonica: 'light', ras: 'dark', mewtype: 'light'
    };
    var defaults = {
      cosmos: 'mint', paper: 'amber', terminal: 'lime', gilded: 'champagne',
      popipa: 'popipa-pink', afterglow: 'afterglow-red', pasupare: 'pasupare-pink', roselia: 'roselia-violet',
      hhw: 'hhw-yellow', morfonica: 'morfonica-blue', ras: 'ras-yellow', mewtype: 'mewtype-pink'
    };
    var accents = [
      'mint', 'azure', 'violet', 'amber', 'rose', 'champagne', 'lime',
      'popipa-pink', 'afterglow-red', 'pasupare-pink', 'roselia-violet',
      'hhw-yellow', 'morfonica-blue', 'ras-yellow', 'mewtype-pink'
    ];
    var style = themes[prefs.style] ? prefs.style : (prefs.theme === 'light' ? 'paper' : 'cosmos');
    root.dataset.style = style;
    root.dataset.theme = themes[style];
    root.dataset.accent = accents.indexOf(prefs.accent) >= 0 ? prefs.accent : defaults[style];
    root.dataset.band = ['popipa', 'afterglow', 'pasupare', 'roselia', 'hhw', 'morfonica', 'ras', 'mewtype'].indexOf(style) >= 0 ? 'true' : 'false';
    root.dataset.density = prefs.density === 'compact' ? 'compact' : 'comfortable';
    root.dataset.effects = prefs.effects === false ? 'off' : 'on';
    root.dataset.motion = prefs.motion === false ? 'off' : 'on';
    root.style.colorScheme = themes[style];
  } catch (error) {
    // localStorage can be unavailable in hardened browsers; defaults still paint.
  }
})();
