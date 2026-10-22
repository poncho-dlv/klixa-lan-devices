// Conversion Hex #RRGGBB -> Hue/Saturation (modèle HSI natif des RM75, cf. lq-protocol.js
// #encodeHsi). Pure et testée, même esprit que hue.js#hexToXy : encode uniquement la
// chromaticité, l'intensité reste un paramètre séparé (cohérent avec l'API `color`
// partagée entre intégrations — cf. index.js).
export function hexToHueSat(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
  }
  const sat = max === 0 ? 0 : Math.round((delta / max) * 100);

  return { hue: Math.round(hue), sat };
}
