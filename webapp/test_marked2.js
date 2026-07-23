const marked = require('marked');
marked.use({ breaks: true, gfm: true });
const md = `<div class="svg-container">\n<svg width="100" height="100">\n  <circle cx="50" cy="50" r="40" />\n</svg>\n</div>`;
console.log(marked.parse(md));
