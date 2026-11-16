// A small picture of a workshop's mind map (SVG) for the workshop list, used when the
// workshop has no generated image yet. Returns null when there is nothing to draw.
const palette = [
  '#f3e9c6',
  '#dfeccf',
  '#f6dccf',
  '#d9e6f2',
  '#e6dcf0',
  '#f6d9e2',
  '#f4cfcf',
  '#e3e3e3',
];
const xml = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cut = (v, max) => {
  const chars = [...String(v || '').replace(/\s+/g, ' ').trim()];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
};
export function mapThumbnail(ws) {
  // The team with the largest map represents the workshop.
  const team = Object.values(ws.teams || {}).sort((a, b) => b.nodes.length - a.nodes.length)[0];
  if (!team?.nodes.length) return null;
  const kids = (parent) =>
    team.nodes.filter((n) =>
      parent === 'theme' ? n.parent === 'theme' || n.parent === null : n.parent === parent,
    );
  const first = kids('theme').slice(0, 7);
  if (!first.length) return null;
  const size = 400,
    step = Math.min(52, (size - 40) / first.length),
    top = (size - step * first.length) / 2;
  let links = '',
    boxes = '';
  first.forEach((n, i) => {
    const y = top + step * i + step / 2;
    links += `<path d="M118 200 C136 200 132 ${y} 150 ${y}" />`;
    boxes += `<rect x="150" y="${y - 14}" width="118" height="28" rx="7" fill="${palette[n.group % palette.length] || palette[0]}"/><text x="158" y="${y + 4}" font-size="12">${xml(cut(n.text, 9))}</text>`;
    kids(n.id)
      .slice(0, 2)
      .forEach((c, j, list) => {
        const cy = y + (j - (list.length - 1) / 2) * Math.min(22, step / 2);
        links += `<path d="M268 ${y} C282 ${y} 280 ${cy} 294 ${cy}" />`;
        boxes += `<rect x="294" y="${cy - 9}" width="96" height="18" rx="5" fill="#fff" stroke="#d5dccf"/><text x="300" y="${cy + 4}" font-size="10">${xml(cut(c.text, 8))}</text>`;
      });
  });
  const root = cut(team.rootText || ws.theme || ws.name, 14);
  const lines = [...root].length > 7 ? [[...root].slice(0, 7).join(''), [...root].slice(7).join('')] : [root];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" font-family="'Yu Gothic','Hiragino Kaku Gothic ProN',Meiryo,sans-serif" fill="#254537"><rect width="${size}" height="${size}" fill="#fffaea"/><g fill="none" stroke="#b9c4b4" stroke-width="1.5">${links}</g><rect x="10" y="${200 - 24}" width="108" height="48" rx="9" fill="#35309a"/>${lines
    .map(
      (line, i) =>
        `<text x="64" y="${200 + 4 + (i - (lines.length - 1) / 2) * 15}" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">${xml(line)}</text>`,
    )
    .join('')}${boxes}</svg>`;
}
