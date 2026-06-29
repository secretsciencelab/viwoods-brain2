// api.js - Pure functions for external data fetching

export async function fetchWeather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&hourly=temperature_2m,precipitation_probability,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=2`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Weather API error');
    return await response.json();
}

export async function fetchNews(widgetSettings) {
    if (!widgetSettings.showNews) return [];
    
    const topics = (widgetSettings.newsTopics || "").split(',').map(s => s.trim()).filter(s => s);
    const customRss = (widgetSettings.customRss || "").split(',').map(s => s.trim()).filter(s => s);
    
    const rssUrls = [];
    
    // Map topics to Google News RSS
    topics.forEach(topic => {
        const encodedTopic = encodeURIComponent(topic);
        rssUrls.push({ url: `https://news.google.com/rss/search?q=${encodedTopic}&hl=en-US&gl=US&ceid=US:en`, isCustom: false });
    });
    
    // Add custom RSS
    customRss.forEach(url => {
        if (url.startsWith('http')) rssUrls.push({ url, isCustom: true });
    });
    
    if (rssUrls.length === 0) {
        return [];
    }

    const allItems = [];
    
    const decodeHtml = (html) => {
        const txt = document.createElement("textarea");
        txt.innerHTML = html;
        return txt.value;
    };

    const processRedditSub = (url, link, fallbackSub) => {
        let sub = fallbackSub || "";
        if (link && link.includes("reddit.com/r/")) {
            const match = link.match(/reddit\.com\/r\/([^\/\.\?]+)/);
            if (match) sub = ` [r/${match[1]}]`;
        } else if (url && url.includes("reddit.com/r/")) {
            const match = url.match(/reddit\.com\/r\/([^\/\.\?]+)/);
            if (match) sub = ` [r/${match[1]}]`;
        }
        return sub;
    };

    const fetchViaCorsProxy = async (targetUrl) => {
        const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error(`corsproxy.io returned status ${res.status}`);
        const text = await res.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, "text/xml");
        if (xmlDoc.querySelector("parsererror")) throw new Error("XML Parsing Error");
        
        let feedTitle = "News";
        const channelTitleNode = xmlDoc.querySelector("channel > title") || xmlDoc.querySelector("feed > title");
        if (channelTitleNode) feedTitle = channelTitleNode.textContent;
        
        const itemNodes = Array.from(xmlDoc.querySelectorAll("item, entry"));
        return { feedTitle, items: itemNodes, format: 'xml' };
    };



    // Fetch each RSS feed with proxy architecture
    const promises = rssUrls.map(async feedObj => {
        try {
            let result;
            try {
                // Primary: corsproxy.io (Native XML parsing)
                result = await fetchViaCorsProxy(feedObj.url);
            } catch (err1) {
                console.warn(`Proxy failed for ${feedObj.url}:`, err1);
                throw err1; // Throw to be caught by the outer block
            }
            
            const maxItems = feedObj.isCustom ? 15 : 10;
            const itemsToProcess = result.items.slice(0, maxItems);
            const baseRedditSub = processRedditSub(feedObj.url, null, "");
            
            if (result.format === 'xml') {
                itemsToProcess.forEach(item => {
                    const title = item.querySelector("title")?.textContent || "";
                    let link = "";
                    const linkNode = item.querySelector("link");
                    if (linkNode) {
                        if (linkNode.textContent) link = linkNode.textContent;
                        else if (linkNode.getAttribute("href")) link = linkNode.getAttribute("href");
                    }
                    const pubDate = item.querySelector("pubDate, published, updated")?.textContent || "";
                    
                    allItems.push({
                        title: decodeHtml(title) + processRedditSub(null, link, baseRedditSub),
                        link: link,
                        pubDate: pubDate,
                        source: result.feedTitle,
                        isCustom: feedObj.isCustom
                    });
                });
            } else if (result.format === 'json') {
                itemsToProcess.forEach(item => {
                    const title = item.title || "";
                    const link = item.url || item.id || "";
                    const pubDate = item.date_published || item.date_modified || "";
                    
                    allItems.push({
                        title: decodeHtml(title) + processRedditSub(null, link, baseRedditSub),
                        link: link,
                        pubDate: pubDate,
                        source: result.feedTitle,
                        isCustom: feedObj.isCustom
                    });
                });
            }
        } catch (err) {
            console.error("All proxies failed for RSS:", feedObj.url, err);
        }
    });
    
    await Promise.all(promises);
    
    // Sort combined items by date descending
    allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    
    // Group by source
    const grouped = {};
    allItems.forEach(item => {
        const sourceName = item.source.replace(/["']/g, '').replace(/\s*-\s*Google News/ig, '').trim();
        if (!grouped[sourceName]) {
            grouped[sourceName] = { source: sourceName, articles: [], isCustom: item.isCustom };
        }
        grouped[sourceName].articles.push(item);
    });
    
    // Convert to array and sort custom feeds first
    const groupsArr = Object.values(grouped);
    groupsArr.sort((a, b) => {
        if (a.isCustom && !b.isCustom) return -1;
        if (!a.isCustom && b.isCustom) return 1;
        return 0;
    });
    
    // Slice items per group based on feed type
    groupsArr.forEach(group => {
        const maxItems = group.isCustom ? 15 : 5;
        group.articles = group.articles.slice(0, maxItems);
    });
    
    return groupsArr;
}

export async function fetchStocks(widgetSettings) {
    if (!widgetSettings.showStocks) return [];
    
    const symbols = (widgetSettings.stockSymbols || "").split(',').map(s => s.trim().toUpperCase()).filter(s => s);
    if (symbols.length === 0) return [];
    
    const finnhubKey = widgetSettings.finnhubApiKey?.trim();
    const twelveDataKey = widgetSettings.twelveDataApiKey?.trim();
    
    if (!finnhubKey && !twelveDataKey) {
        throw new Error('API Key required');
    }

    const stockData = [];

    // Prioritize TwelveData if available (better data)
    if (twelveDataKey) {
        const symbolsParam = symbols.join(',');
        const url = `https://api.twelvedata.com/quote?symbol=${symbolsParam}&apikey=${twelveDataKey}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.status === "error") {
            throw new Error(data.message || 'API Error');
        }
        
        if (symbols.length === 1) {
            if (data.symbol) {
                const close = parseFloat(data.close);
                const prevClose = parseFloat(data.previous_close);
                const change = close - prevClose;
                const changeP = (change / prevClose) * 100;
                stockData.push({
                    symbol: data.symbol,
                    currentPrice: close,
                    change: change,
                    percentChange: changeP
                });
            }
        } else {
            for (const sym of symbols) {
                if (data[sym] && data[sym].symbol) {
                    const close = parseFloat(data[sym].close);
                    const prevClose = parseFloat(data[sym].previous_close);
                    const change = close - prevClose;
                    const changeP = (change / prevClose) * 100;
                    stockData.push({
                        symbol: data[sym].symbol,
                        currentPrice: close,
                        change: change,
                        percentChange: changeP
                    });
                }
            }
        }
    } else if (finnhubKey) {
        // Fallback to Finnhub
        const promises = symbols.map(sym => {
            return fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${finnhubKey}`)
                .then(r => r.json())
                .then(data => {
                    if (data && data.c !== undefined && data.c !== null && data.c !== 0) {
                        return {
                            symbol: sym,
                            currentPrice: data.c,
                            change: data.d,
                            percentChange: data.dp
                        };
                    }
                    return null;
                })
                .catch(err => null);
        });
        
        const results = await Promise.all(promises);
        results.forEach(res => {
            if (res) stockData.push(res);
        });
    }
    
    return stockData;
}
