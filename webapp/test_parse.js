const fs = require('fs');
const marked = require('marked');

let rawMd = `<!-- PAGE_123_START -->
# Better Mousetrap
#idea #design

The body of the note
<!-- PAGE_123_END -->`;

rawMd = rawMd.replace(/<!-- PAGE_(.*?)_START -->([\s\S]*?)<!-- PAGE_\1_END -->/g, (match, pageId, content) => {
    let tags = [];
    content = content.replace(/^(?:#\s+)?((?:#[a-zA-Z0-9_-]+[ \t]*)+)(?:\r?\n|$)/gm, (m, tagLine) => {
        tags.push(tagLine.trim());
        return ''; 
    });
    
    if (tags.length > 0) {
        content += `\n\n<div class="tags-container">\n\n${tags.join(' ')}\n\n</div>\n`;
    }
    
    return `<!-- PAGE_${pageId}_START -->\n${content}\n<!-- PAGE_${pageId}_END -->`;
});

rawMd = rawMd.replace(/(^|\s)(#[a-zA-Z0-9_-]+)/g, (match, space, tag) => {
    return `${space}<span class="inline-tag">${tag}</span>`;
});

console.log("rawMd before marked:");
console.log(rawMd);

let html = marked.parse(rawMd);

console.log("HTML after marked:");
console.log(html);

let pageCounter = 1;
let pages = [];
html = html.replace(/<!-- PAGE_(.*?)_START -->([\s\S]*?)<!-- PAGE_\1_END -->/g, (match, pageId, content) => {
    let wrapped = `
        <div class="page-block" data-page-id="${pageId}">
            <div class="page-number-indicator">Page ${pageCounter}</div>
            ${content}
        </div>
    `;
    pages.push(wrapped);
    pageCounter++;
    return `<!-- PAGE_PLACEHOLDER -->`;
});

let pageIndex = 0;
html = html.replace(/<!-- PAGE_PLACEHOLDER -->/g, () => {
    return pages[pageIndex++];
});

console.log("FINAL HTML:");
console.log(html);
