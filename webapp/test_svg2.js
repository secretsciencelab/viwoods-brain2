let rawMd = ````xml
<?xml version="1.0" encoding="UTF-8"?>
<svg width="100" height="100">
  <circle cx="50" cy="50" r="40" stroke="green" stroke-width="4" fill="yellow" />
</svg>
<!-- end of svg -->
````;

rawMd = rawMd.replace(/```(?:xml|svg|html)[\s\S]*?(<svg[\s\S]*?<\/svg>)[\s\S]*?```/gi, '\n<div class="svg-container" style="display: flex; justify-content: center; margin: 20px 0; max-width: 100%; overflow: hidden;">\n$1\n</div>\n');
console.log(rawMd);
