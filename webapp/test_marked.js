const marked = require('marked');

const renderer = {
    code(token) {
        console.log("Renderer triggered:", token);
        if (token && (token.lang === 'xml' || token.lang === 'svg') && token.text && token.text.trim().startsWith('<svg') && token.text.trim().endsWith('</svg>')) {
            return `<div class="svg-container">${token.text}</div>`;
        }
        return false;
    }
};

marked.use({ renderer, breaks: true, gfm: true });

const md = "```xml\n<svg></svg>\n```";
console.log(marked.parse(md));
