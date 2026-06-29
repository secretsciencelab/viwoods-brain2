// markdown.js - Pure function for parsing markdown with our custom rules

export function parseMarkdown(rawMd, reversePageOrder, imageBlobUrls) {
    if (!rawMd) return '';
    
    // Auto-detect dark mode and invert images dynamically
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    
    // Process all image links
    rawMd = rawMd.replace(/!\[([^\]]*)\]\((.*?)\)/g, (match, altText, src) => {
        const filename = src.split('/').pop();
        let finalSrc = src;
        
        if (imageBlobUrls && imageBlobUrls[filename]) {
            finalSrc = imageBlobUrls[filename];
        } else if (src.startsWith('_attachments/') || src.startsWith('Attachments/')) {
            // Legacy Obsidian file ID extraction (Only for valid 25+ char IDs, preventing "screenshotBmp" bugs)
            const idMatch = filename.match(/^([^_]+)_/);
            if (idMatch && idMatch[1].length >= 25) {
                finalSrc = `https://www.googleapis.com/drive/v3/files/${idMatch[1]}?alt=media`;
            } else {
                // Empty transparent placeholder if not found
                finalSrc = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            }
        }
        
        // Skip inversion logic if it's a completely external image
        if (finalSrc === src && src.startsWith('http') && !src.includes('googleapis.com') && !src.includes('googleusercontent.com')) {
            return `\n<img src="${finalSrc}" data-filename="${filename}" alt="${altText}" />`;
        }

        // Inline script injected to flip the image colors back if the stroke color matches the background
        const invertLogic = isDark ? `onload="
            const img = this;
            if(img.getAttribute('data-processed')) return;
            img.setAttribute('data-processed', 'true');
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.width || img.naturalWidth;
            canvas.height = img.height || img.naturalHeight;
            if(!canvas.width || !canvas.height) return;
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0,0, canvas.width, canvas.height).data;
            let darkPixels = 0; let lightPixels = 0;
            for(let i=0; i<data.length; i+=4) {
                if(data[i+3] < 128) continue; 
                const brightness = (data[i] + data[i+1] + data[i+2]) / 3;
                if(brightness < 50) darkPixels++;
                else if(brightness > 200) lightPixels++;
            }
            if(darkPixels > lightPixels) {
                img.style.filter = 'invert(1) hue-rotate(180deg)';
            }
        "` : `onload="
            const img = this;
            if(img.getAttribute('data-processed')) return;
            img.setAttribute('data-processed', 'true');
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.width || img.naturalWidth;
            canvas.height = img.height || img.naturalHeight;
            if(!canvas.width || !canvas.height) return;
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0,0, canvas.width, canvas.height).data;
            let darkPixels = 0; let lightPixels = 0;
            for(let i=0; i<data.length; i+=4) {
                if(data[i+3] < 128) continue; 
                const brightness = (data[i] + data[i+1] + data[i+2]) / 3;
                if(brightness < 50) darkPixels++;
                else if(brightness > 200) lightPixels++;
            }
            if(lightPixels > darkPixels && lightPixels > 100) {
                img.style.filter = 'invert(1) hue-rotate(180deg)';
            }
        "`;
        
        return `\n<img src="${finalSrc}" data-filename="${filename}" alt="${altText}" crossorigin="anonymous" ${invertLogic} />`;
    });

    // We convert these into internal links and reduce their size
    rawMd = rawMd.replace(/^##\s+Source:\s*\/?(.*?\.md)\s*$/gm, (match, path) => {
        return `#### Source: [[${path}]]`;
    });
    rawMd = rawMd.replace(/^##\s+\/?(.*?\.md)\s*$/gm, (match, path) => {
        return `#### [[${path}]]`;
    });
    
    // Replace [[Note Name]] with clickable internal links
    rawMd = rawMd.replace(/\[\[(.*?)\]\]/g, (match, noteName) => {
        return `<a href="#" class="internal-link" data-note="${noteName}">${noteName}</a>`;
    });
    
    // Extract tags and move them to the bottom of their respective page block, and enforce H1 rule
    rawMd = rawMd.replace(/<!-- PAGE_(.*?)_START -->([\s\S]*?)<!-- PAGE_\1_END -->/g, (match, pageId, content) => {
        let tags = [];
        // Extract lines that consist purely of tags (accounting for accidental '# ' prefixes from Gemini)
        content = content.replace(/^(?:#\s+)?((?:#[a-zA-Z0-9_\-\/]+[ \t]*)+)(?:\r?\n|$)/gm, (m, tagLine) => {
            tags.push(tagLine.trim());
            return ''; 
        });
        // Enforce strict H1 rule: Only allowed if it's the very first line of the actual note content.
        let lines = content.split(/\r?\n/);
        let ocrStarted = false;
        
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (!ocrStarted) {
                // Skip empty lines, images, and the auto-generated timestamp blockquote
                if (line.trim() === '' || line.startsWith('![') || line.startsWith('>')) {
                    continue;
                }
                ocrStarted = true;
                // If the very first line of text is an H1, allow it
                if (line.startsWith('# ')) {
                    continue; 
                }
            }
            
            // Once OCR has started, any H1 encountered must be demoted to H2
            if (ocrStarted && line.startsWith('# ')) {
                lines[i] = '## ' + line.substring(2);
            }
        }
        content = lines.join('\n');
        
        if (tags.length > 0) {
            content += `\n\n<div class="tags-container">\n\n${tags.join(' ')}\n\n</div>\n`;
        }
        
        return `<!-- PAGE_${pageId}_START -->\n${content}\n<!-- PAGE_${pageId}_END -->`;
    });
    
    // Subtly style inline #tags
    rawMd = rawMd.replace(/(^|\s)(#[a-zA-Z0-9_\-\/]+)/g, (match, space, tag) => {
        // Ensure it's not a markdown heading by checking if there's a space after the #
        return `${space}<span class="inline-tag">${tag}</span>`;
    });
    
    // Prevent Setext heading confusion by ensuring a blank line before horizontal rules
    rawMd = rawMd.replace(/([^\s])\s*\n---(?:\s*\n|$)/g, '$1\n\n---\n');
    
    let html = window.marked.parse(rawMd);
    
    // Post-process HTML to wrap pages and inject page numbers
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
    
    if (reversePageOrder) {
        pages.reverse();
    }
    
    let pageIndex = 0;
    html = html.replace(/<!-- PAGE_PLACEHOLDER -->/g, () => {
        return pages[pageIndex++];
    });
    
    // Post-process HTML to convert timestamp blockquotes into beautiful badges
    html = html.replace(/<blockquote>\s*<p><em>Last updated: (.*?)<\/em><\/p>\s*<\/blockquote>/g, (match, ts) => {
        let localStr = ts;
        const d = new Date(ts.replace(' at ', 'T') + 'Z');
        if (!isNaN(d.getTime())) {
            localStr = d.toLocaleString(undefined, { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        }
        return '<div class="page-timestamp"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ' + localStr + '</div>';
    });
    
    // Post-process HTML to inject id attributes into headings for the Document Outline
    html = html.replace(/<h([1-6])>(.*?)<\/h\1>/g, (match, level, text) => {
        const cleanText = text.replace(/<[^>]*>?/gm, ''); // strip inline HTML
        const id = cleanText.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        return `<h${level} id="${id}">${text}</h${level}>`;
    });
    
    return html;
}
