let rawMd = ````xml
<svg width="100" height="100">
  <circle cx="50" cy="50" r="40" stroke="green" stroke-width="4" fill="yellow" />
</svg>
````;
rawMd = rawMd.replace(/```(?:xml|svg|html)\n?([\s\S]*?<svg[\s\S]*?<\/svg>)\n?```/gi, '\n<div class="svg-container">\n$1\n</div>\n');
console.log(rawMd);
