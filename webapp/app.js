const { createApp, ref, computed, onMounted, onUnmounted, watch, nextTick } = Vue;

const SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/tasks.readonly";

marked.use({ breaks: true, gfm: true });

const app = createApp({
    setup() {
        const clientId = ref(localStorage.getItem('brain2_client_id') || '');
        const showSettings = ref(false);
        const clientIdInput = ref('');
        const widgetSettings = ref(JSON.parse(localStorage.getItem('brain2_widget_settings') || '{"showWeather": true, "showTasks": true, "excludedLists": "", "showNews": true, "newsTopics": "Technology, Artificial Intelligence", "customRss": "", "showStocks": true, "stockSymbols": "AAPL, GOOGL, MSFT", "finnhubApiKey": ""}'));
        if (widgetSettings.value.excludedLists === undefined) widgetSettings.value.excludedLists = "";
        if (widgetSettings.value.showNews === undefined) widgetSettings.value.showNews = true;
        if (widgetSettings.value.newsTopics === undefined) widgetSettings.value.newsTopics = "Technology, Artificial Intelligence";
        if (widgetSettings.value.customRss === undefined) widgetSettings.value.customRss = "";
        if (widgetSettings.value.showStocks === undefined) widgetSettings.value.showStocks = true;
        if (widgetSettings.value.stockSymbols === undefined) widgetSettings.value.stockSymbols = "AAPL, GOOGL, MSFT";
        if (widgetSettings.value.finnhubApiKey === undefined) widgetSettings.value.finnhubApiKey = "";
        if (widgetSettings.value.rss2jsonApiKey === undefined) widgetSettings.value.rss2jsonApiKey = "";
        
        const isDarkMode = ref(localStorage.getItem('brain2_theme') !== 'light');
        const toggleTheme = () => {
            isDarkMode.value = !isDarkMode.value;
            localStorage.setItem('brain2_theme', isDarkMode.value ? 'dark' : 'light');
            document.documentElement.setAttribute('data-theme', isDarkMode.value ? 'dark' : 'light');
        };
        
        const isHeaderHidden = ref(false);
        let lastScrollTop = 0;
        const handleScroll = (e) => {
            if (window.innerWidth > 768) {
                if (isHeaderHidden.value) isHeaderHidden.value = false;
                return;
            }
            const st = e.target.scrollTop;
            if (st > lastScrollTop && st > 50) {
                isHeaderHidden.value = true;
            } else if (st < lastScrollTop) {
                isHeaderHidden.value = false;
            }
            lastScrollTop = st;
        };

        onMounted(() => {
            document.documentElement.setAttribute('data-theme', isDarkMode.value ? 'dark' : 'light');
        });
        
        const isAuthenticated = ref(false);
        const isLoading = ref(false);
        const notes = ref([]);
        const selectedNote = ref(null);
        const markdownContent = ref('');
        let accessToken = null;
        let tokenClient = null;

        const searchQuery = ref('');
        const selectedTag = ref(null);
        const selectedDate = ref(null);
        const allTags = ref([]);
        const noteContents = ref({});
        const relatedNotes = ref([]);
        const showGraph = ref(false);
        const showMobileMenu = ref(false);

        const scrollToHeading = (id) => {
            const el = document.getElementById(id);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth' });
            }
        };

        const documentOutline = computed(() => {
            const html = parsedMarkdown.value;
            if (!html) return [];
            
            const outline = [];
            const regex = /<h([1-6])\s+id="([^"]+)">([\s\S]*?)<\/h\1>/g;
            let m;
            while ((m = regex.exec(html)) !== null) {
                const cleanText = m[3].replace(/<[^>]*>?/gm, '').trim();
                outline.push({
                    level: parseInt(m[1]),
                    title: cleanText,
                    id: m[2]
                });
            }
            return outline;
        });

        const getLocalDateStr = (dateObj) => {
            const d = new Date(dateObj);
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        };

        const dailyActivity = computed(() => {
            const counts = {};
            notes.value.forEach(note => {
                if (note.modifiedTime) {
                    const dateStr = getLocalDateStr(note.modifiedTime);
                    counts[dateStr] = (counts[dateStr] || 0) + 1;
                }
            });
            return counts;
        });

        const pastYearDays = computed(() => {
            const days = [];
            const today = new Date();
            
            // Go back 26 weeks (~6 months)
            const startDate = new Date(today);
            startDate.setDate(today.getDate() - (26 * 7));
            
            // Adjust to the Sunday of that week
            startDate.setDate(startDate.getDate() - startDate.getDay());
            
            const iterDate = new Date(startDate);
            while (iterDate <= today) {
                const dateStr = getLocalDateStr(iterDate);
                days.push({
                    date: dateStr,
                    count: dailyActivity.value[dateStr] || 0
                });
                iterDate.setDate(iterDate.getDate() + 1);
            }
            return days;
        });

        const heatmapWeeks = computed(() => {
            const weeks = [];
            let currentWeek = [];
            pastYearDays.value.forEach((day, index) => {
                currentWeek.push(day);
                if (currentWeek.length === 7 || index === pastYearDays.value.length - 1) {
                    weeks.push(currentWeek);
                    currentWeek = [];
                }
            });
            return weeks;
        });

        const isNewMonth = (week, index, weeks) => {
            if (index === 0) return true;
            const currentMonth = new Date(week[0].date).getMonth();
            const previousMonth = new Date(weeks[index - 1][0].date).getMonth();
            return currentMonth !== previousMonth;
        };

        const getMonthName = (week) => {
            const d = new Date(week[0].date);
            return d.toLocaleString('default', { month: 'short' });
        };

        const getHeatmapClass = (count) => {
            if (count === 0) return 'heat-0';
            if (count <= 2) return 'heat-1';
            if (count <= 5) return 'heat-2';
            if (count <= 10) return 'heat-3';
            return 'heat-4';
        };

        const checkExistingAuth = () => {
            const savedToken = localStorage.getItem('brain2_access_token');
            const expiresAt = localStorage.getItem('brain2_token_expires');
            
            if (savedToken && expiresAt && Date.now() < parseInt(expiresAt)) {
                accessToken = savedToken;
                isAuthenticated.value = true;
                loadNotebooks();
            } else {
                if (savedToken) {
                    // Clear expired token
                    localStorage.removeItem('brain2_access_token');
                    localStorage.removeItem('brain2_token_expires');
                }
                if (!clientId.value) {
                    openSettings();
                }
            }
        };

        onMounted(() => {
            checkExistingAuth();
        });

        const openSettings = () => {
            clientIdInput.value = clientId.value;
            showSettings.value = true;
        };

        const saveSettings = () => {
            if (clientIdInput.value) {
                clientId.value = clientIdInput.value.trim();
                localStorage.setItem('brain2_client_id', clientId.value);
            }
            localStorage.setItem('brain2_widget_settings', JSON.stringify(widgetSettings.value));
            showSettings.value = false;
            
            if (isAuthenticated.value) {
                fetchGoogleTasks();
                extractHandwrittenTasks();
            } else {
                initGoogleAuth();
            }
            if (widgetSettings.value.showNews) {
                fetchNews();
            }
            if (widgetSettings.value.showStocks) {
                fetchStocks();
            }
        };

        // Initialize Google Identity Services
        const initGoogleAuth = () => {
            if (!clientId.value) {
                openSettings();
                return;
            }
            
            if (!tokenClient) {
                tokenClient = google.accounts.oauth2.initTokenClient({
                    client_id: clientId.value,
                    scope: SCOPES,
                    callback: async (tokenResponse) => {
                        if (tokenResponse && tokenResponse.access_token) {
                            accessToken = tokenResponse.access_token;
                            isAuthenticated.value = true;
                            
                            const expiresIn = tokenResponse.expires_in || 3600;
                            const expiresAt = Date.now() + (expiresIn * 1000);
                            localStorage.setItem('brain2_access_token', accessToken);
                            localStorage.setItem('brain2_token_expires', expiresAt.toString());
                            
                            await loadNotebooks();
                            isRefreshing = false;
                        }
                    },
                    error_callback: (error) => {
                        console.error("Token request error:", error);
                        isRefreshing = false;
                    }
                });
            }
            tokenClient.requestAccessToken({prompt: ''});
        };

        let isRefreshing = false;
        
        // Auto-refresh token by piggybacking on user interactions to bypass popup blockers
        const autoRefreshToken = () => {
            if (!isAuthenticated.value || !accessToken || isRefreshing || !clientId.value) return;
            
            const expiresAt = parseInt(localStorage.getItem('brain2_token_expires') || '0');
            const timeRemaining = expiresAt - Date.now();
            
            // If token is expiring in less than 10 minutes, silently refresh it
            if (timeRemaining > 0 && timeRemaining < 600000) {
                isRefreshing = true;
                if (!tokenClient) {
                    initGoogleAuth(); // Will set tokenClient and call requestAccessToken
                } else {
                    tokenClient.requestAccessToken({prompt: ''});
                }
            }
        };

        onMounted(() => {
            window.addEventListener('click', autoRefreshToken, { capture: true });
            window.addEventListener('keydown', autoRefreshToken, { capture: true });
        });

        const extractTags = (content) => {
            if (!content) return { all: [] };
            
            // Preprocess content to catch spaced tags on their own line (e.g. "# GAMING")
            const normalized = content.replace(/(^|\n)#{1,3}\s+([a-zA-Z0-9_\-\/]+)\s*(\n|$)/g, '$1#$2$3');
            const tags = normalized.match(/#[a-zA-Z0-9_\-\/]+/g) || [];
            
            return {
                all: [...new Set(tags.map(t => t.toLowerCase()))]
            };
        };

        const fileTree = ref({ children: [] });

        const buildTree = (files) => {
            let tree = { name: "root", isFolder: true, expanded: true, children: [] };

            // Build hierarchy for files
            files.forEach(f => {
                let parts = f.displayName.split('/');
                let current = tree;
                for (let i = 0; i < parts.length - 1; i++) {
                    let part = parts[i];
                    let child = current.children.find(c => c.name === part && c.isFolder);
                    if (!child) {
                        child = { name: part, isFolder: true, expanded: false, children: [] };
                        current.children.push(child);
                    }
                    current = child;
                }
                current.children.push({ ...f, name: parts[parts.length - 1], isFolder: false });
            });

            // Recursively sort: folders first, then alphabetically
            const sortTree = (node) => {
                if (node.isFolder && node.children) {
                    node.children.sort((a, b) => {
                        if (a.isFolder === b.isFolder) {
                            return a.name.localeCompare(b.name);
                        }
                        return a.isFolder ? -1 : 1;
                    });
                    node.children.forEach(sortTree);
                }
            };
            sortTree(tree);

            return tree;
        };

        const loadNotebooks = async (isSilent = false) => {
            if (!isSilent) isLoading.value = true;
            try {
                let query = encodeURIComponent("name='Viwoods-Note' and mimeType='application/vnd.google-apps.folder' and trashed=false");
                let res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
                let data = await res.json();
                
                if (!data.files || data.files.length === 0) {
                    if (!isSilent) alert("Could not find 'Viwoods-Note' folder in your Google Drive.");
                    return;
                }
                const rootFolderId = data.files[0].id;
                
                // Preserve tree expansion state before fetching
                const oldExpandedState = {};
                const storeExpandedState = (node, path) => {
                    if (node.isFolder) {
                        oldExpandedState[path] = node.expanded;
                        node.children.forEach(c => storeExpandedState(c, path + '/' + c.name));
                    }
                };
                if (fileTree.value) storeExpandedState(fileTree.value, 'root');

                const restoreExpandedState = (node, path) => {
                    if (node.isFolder) {
                        if (oldExpandedState[path] !== undefined) {
                            node.expanded = oldExpandedState[path];
                        }
                        node.children.forEach(c => restoreExpandedState(c, path + '/' + c.name));
                    }
                };

                const allNotesList = [];
                
                const fetchAllMarkdown = async (parentId, path = "") => {
                    let q = encodeURIComponent(`'${parentId}' in parents and (name contains '.md' or mimeType='application/vnd.google-apps.folder') and name != '_attachments' and trashed=false`);
                    let response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,parents,modifiedTime)&orderBy=name`, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    });
                    
                    if (response.status === 401) {
                        isAuthenticated.value = false;
                        accessToken = null;
                        localStorage.removeItem('brain2_access_token');
                        localStorage.removeItem('brain2_token_expires');
                        throw new Error("Authentication expired");
                    }
                    
                    let result = await response.json();
                    
                    if (!result.files) return;

                    let folderPromises = [];

                    for (let file of result.files) {
                        if (file.mimeType === 'application/vnd.google-apps.folder') {
                            const subFolderPath = path ? `${path}/${file.name}` : file.name;
                            folderPromises.push(fetchAllMarkdown(file.id, subFolderPath));
                        } else if (file.name.endsWith('.md') && (!file.name.toLowerCase().endsWith('master.md') || file.name === 'TODO_Master.md')) {
                            file.displayName = path ? `${path}/${file.name}` : file.name;
                            allNotesList.push(file);
                        }
                    }
                    
                    // Progressively update the UI as soon as files from this directory are found
                    if (allNotesList.length > 0) {
                        const updatedTree = buildTree(allNotesList);
                        restoreExpandedState(updatedTree, 'root');
                        fileTree.value = updatedTree;
                        notes.value = [...allNotesList];
                    }

                    await Promise.all(folderPromises);
                };

                await fetchAllMarkdown(rootFolderId);
                const allNotes = allNotesList;
                
                const fetchAllNoteContents = async (files) => {
                    const contents = {};
                    const tagSet = new Set();
                    const batchSize = 10;
                    for (let i = 0; i < files.length; i += batchSize) {
                        const batch = files.slice(i, i + batchSize);
                        await Promise.all(batch.map(async (note) => {
                            try {
                                const res = await fetch(`https://www.googleapis.com/drive/v3/files/${note.id}?alt=media`, {
                                    headers: { Authorization: `Bearer ${accessToken}` }
                                });
                                const text = await res.text();
                                contents[note.id] = text;
                                
                                const titleMatch = text.match(/^#\s+(.+)$/m);
                                if (titleMatch) {
                                    note.displayTitle = titleMatch[1].trim();
                                }
                                
                                const extracted = extractTags(text);
                                extracted.explicit.forEach(t => tagSet.add(t));
                            } catch (e) {
                                // ignore
                            }
                        }));
                    }
                    noteContents.value = contents;
                    allTags.value = Array.from(tagSet).sort();
                };
                // Background fetch for contents
                fetchAllNoteContents(allNotes);

                notes.value = allNotes;
                fileTree.value = buildTree(allNotes);
                restoreExpandedState(fileTree.value, 'root');

                // Check if currently selected note got updated
                if (isSilent && selectedNote.value) {
                    const updatedNote = allNotes.find(n => n.id === selectedNote.value.id);
                    if (updatedNote && updatedNote.modifiedTime !== selectedNote.value.modifiedTime) {
                        selectNote(updatedNote, true); // true for isSilent mode
                    }
                }
            } catch (err) {
                console.error(err);
                if (!isSilent && err.message !== "Authentication expired") {
                    alert("Failed to load notebooks. Check console.");
                }
            } finally {
                if (!isSilent) isLoading.value = false;
            }
        };

        // Periodic background refresh every 60 seconds
        setInterval(() => {
            if (isAuthenticated.value) {
                loadNotebooks(true);
            }
        }, 60000);

        const filteredFileTree = computed(() => {
            if (!fileTree.value || !fileTree.value.children) return { children: [] };
            
            if (!searchQuery.value && !selectedTag.value && !selectedDate.value) {
                return fileTree.value;
            }
            
            const cloneTree = JSON.parse(JSON.stringify(fileTree.value));
            
            const filterNode = (node) => {
                if (!node.isFolder) {
                    let matches = true;
                    if (searchQuery.value) {
                        const query = searchQuery.value.toLowerCase();
                        const content = noteContents.value[node.id] || '';
                        if (!node.name.toLowerCase().includes(query) && !content.toLowerCase().includes(query)) {
                            matches = false;
                        }
                    }
                    if (selectedTag.value) {
                        const content = noteContents.value[node.id] || '';
                        const nodeTags = new Set(extractTags(content).all);
                        if (!nodeTags.has(selectedTag.value)) {
                            matches = false;
                        }
                    }
                    if (selectedDate.value) {
                        const note = notes.value.find(n => n.id === node.id);
                        if (!note || !note.modifiedTime || getLocalDateStr(note.modifiedTime) !== selectedDate.value) {
                            matches = false;
                        }
                    }
                    return matches;
                }
                
                if (node.children) {
                    node.children = node.children.filter(filterNode);
                    // Automatically expand folders if searching
                    if (searchQuery.value || selectedTag.value || selectedDate.value) {
                        node.expanded = true;
                    }
                    return node.children.length > 0;
                }
                return false;
            };
            
            cloneTree.children = cloneTree.children.filter(filterNode);
            return cloneTree;
        });

        const imageBlobUrls = ref({});
        const isContentLoading = ref(false);

        const selectNote = async (note, isSilent = false) => {
            selectedNote.value = note;
            if (!isSilent) {
                isContentLoading.value = true;
                imageBlobUrls.value = {}; // Reset images for new note
            }
            
            try {
                const res = await fetch(`https://www.googleapis.com/drive/v3/files/${note.id}?alt=media`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
                const text = await res.text();
                markdownContent.value = text;
                
                loadImagesForNote(note);
                
                // Calculate Related Notes based on Tag overlap
                let related = [];
                const currentContent = noteContents.value[note.id] || '';
                const currentTags = new Set(extractTags(currentContent).all);
                
                if (currentTags.size > 0) {
                    for (const n of notes.value) {
                        if (n.id === note.id) continue;
                        const content = noteContents.value[n.id];
                        if (content) {
                            const tags = new Set(extractTags(content).all);
                            
                            const shared = [...currentTags].filter(x => tags.has(x));
                            if (shared.length > 0) {
                                related.push({
                                    note: n,
                                    sharedTags: shared
                                });
                            }
                        }
                    }
                    related.sort((a, b) => b.sharedTags.length - a.sharedTags.length);
                }
                relatedNotes.value = related;
                
            } catch (err) {
                console.error(err);
                markdownContent.value = "Error loading file content.";
            } finally {
                isContentLoading.value = false;
            }
        };

        const loadImagesForNote = async (note) => {
            try {
                if (!note.parents || note.parents.length === 0) return;
                const parentId = note.parents[0];
                const noteBaseName = note.name.replace('.md', '');
                
                // 1. Find _attachments or Attachments in the same folder
                let q1 = encodeURIComponent(`'${parentId}' in parents and (name='_attachments' or name='Attachments') and mimeType='application/vnd.google-apps.folder' and trashed=false`);
                let res1 = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q1}`, { headers: { Authorization: `Bearer ${accessToken}` } });
                let data1 = await res1.json();
                if (!data1.files || data1.files.length === 0) return;
                let attFolderId = data1.files[0].id;
                
                // 2. Find noteBaseName folder inside _attachments
                let q2 = encodeURIComponent(`'${attFolderId}' in parents and name='${noteBaseName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
                let res2 = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q2}`, { headers: { Authorization: `Bearer ${accessToken}` } });
                let data2 = await res2.json();
                if (!data2.files || data2.files.length === 0) return;
                let specificAttFolderId = data2.files[0].id;
                
                // 3. Get all images in that folder
                let q3 = encodeURIComponent(`'${specificAttFolderId}' in parents and trashed=false`);
                let res3 = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q3}&fields=files(id,name,thumbnailLink)`, { headers: { Authorization: `Bearer ${accessToken}` } });
                let data3 = await res3.json();
                
                // 4. Use Google Drive's fast thumbnail links instead of downloading massive blobs
                for (let file of data3.files) {
                    if (file.thumbnailLink) {
                        // Upgrade the default s220 thumbnail to s800 for crisp but lightweight viewing
                        let fastImageUrl = file.thumbnailLink.replace(/=s\d+$/, '=s800');
                        imageBlobUrls.value[file.name] = fastImageUrl;
                    } else {
                        // Fallback to media blob if thumbnail is unavailable
                        fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
                            headers: { Authorization: `Bearer ${accessToken}` }
                        })
                        .then(r => r.blob())
                        .then(blob => {
                            imageBlobUrls.value[file.name] = URL.createObjectURL(blob);
                        });
                    }
                }
            } catch (err) {
                console.error("Error loading images:", err);
            }
        };

        const parsedMarkdown = computed(() => {
            if (!markdownContent.value) return '';
            
            let rawMd = markdownContent.value;
            
            // Fix Gemini wrapping the entire OCR response in ```markdown ... ``` blocks
            rawMd = rawMd.replace(/```(?:markdown|md)\n([\s\S]*?)\n```/gi, '$1');
            
            // Completely hide legacy SVG code blocks
            rawMd = rawMd.replace(/```(?:xml|svg|html)\n?[\s\S]*?<svg[\s\S]*?<\/svg>[\s\S]*?\n?```/gi, '');

            if (selectedNote.value && selectedNote.value.name.endsWith('Master.md')) {
                // The backend outputs `## Folder/Path/Note.md` (TODO) or `## Source: Folder/Path/Note.md`
                // We convert these into internal links and reduce their size
                rawMd = rawMd.replace(/^##\s+Source:\s*\/?(.*?\.md)\s*$/gm, (match, path) => {
                    return `#### Source: [[${path}]]`;
                });
                rawMd = rawMd.replace(/^##\s+\/?(.*?\.md)\s*$/gm, (match, path) => {
                    return `#### [[${path}]]`;
                });
            }

            // Bulletproof regex: matches ANY image link containing _attachments or Attachments anywhere in the path
            rawMd = rawMd.replace(/!\[(.*?)\]\(\s*.*?(?:_attachments|Attachments)\/.*?([^\/]+\.(?:png|jpg|jpeg|gif|bmp|webp))\s*\)/gi, (match, altText, filename) => {
                let src = imageBlobUrls.value[filename] || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                return `\n<img src="${src}" alt="${altText}" />`;
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
            
            let html = marked.parse(rawMd);
            
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
            
            if (reversePageOrder.value) {
                pages.reverse();
            }
            
            let pageIndex = 0;
            html = html.replace(/<!-- PAGE_PLACEHOLDER -->/g, () => {
                return pages[pageIndex++];
            });
            
            // Post-process HTML to convert timestamp blockquotes into beautiful badges
            html = html.replace(/<blockquote>\s*<p><em>Last updated: (.*?)<\/em><\/p>\s*<\/blockquote>/g, 
                '<div class="page-timestamp"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> $1</div>'
            );
            
            // Post-process HTML to inject id attributes into headings for the Document Outline
            html = html.replace(/<h([1-6])>(.*?)<\/h\1>/g, (match, level, text) => {
                const cleanText = text.replace(/<[^>]*>?/gm, ''); // strip inline HTML
                const id = cleanText.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                return `<h${level} id="${id}">${text}</h${level}>`;
            });
            
            return html;
        });

        // Lightbox Logic
        const lightboxImage = ref(null);
        
        // Reverse Page Order Logic per notebook
        const notebookOrders = ref(JSON.parse(localStorage.getItem('notebookOrders') || '{}'));
        watch(notebookOrders, (newVal) => {
            localStorage.setItem('notebookOrders', JSON.stringify(newVal));
        }, { deep: true });

        const reversePageOrder = computed({
            get: () => {
                if (!selectedNote.value) return false;
                return notebookOrders.value[selectedNote.value.id] || false;
            },
            set: (val) => {
                if (selectedNote.value) {
                    notebookOrders.value[selectedNote.value.id] = val;
                }
            }
        });

        // Dashboard Widgets Logic
        const weatherData = ref(null);
        const weatherHourly = ref([]);
        const weatherError = ref(null);
        const weatherZipInput = ref(localStorage.getItem('weatherZip') || '');
        
        const getWeatherIcon = (code) => {
            if (code === 0) return 'sunny';
            if (code <= 3) return 'partly_cloudy_day';
            if (code <= 48) return 'foggy';
            if (code <= 67) return 'rainy';
            if (code <= 77) return 'ac_unit'; // Snow
            if (code <= 82) return 'rainy';
            if (code <= 99) return 'thunderstorm';
            return 'cloud';
        };
        
        const fetchWeather = async (lat = 37.7749, lon = -122.4194) => {
            try {
                weatherError.value = null;
                const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&hourly=temperature_2m,precipitation_probability,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=2`);
                const data = await res.json();
                if (data.error) throw new Error(data.reason);
                weatherData.value = data;
                
                // Parse hourly forecast (next 24 hours starting from current hour)
                const currentHour = new Date().getHours();
                weatherHourly.value = [];
                // Open-Meteo returns 48 hours when forecast_days=2, index matches hour of the first day
                for (let i = currentHour; i < currentHour + 24 && i < data.hourly.time.length; i++) {
                    const date = new Date(data.hourly.time[i]);
                    weatherHourly.value.push({
                        time: data.hourly.time[i],
                        label: i === currentHour ? 'Now' : date.toLocaleTimeString([], { hour: 'numeric' }),
                        temp: data.hourly.temperature_2m[i],
                        rain: data.hourly.precipitation_probability[i],
                        code: data.hourly.weather_code[i]
                    });
                }
                
                nextTick(() => renderCharts());
            } catch (e) {
                console.error("Weather fetch failed", e);
                weatherError.value = "Failed to load weather data.";
            }
        };

        let comboChartInstance = null;
        
        const renderCharts = () => {
            const comboCtx = document.getElementById('comboChart');
            if (!comboCtx) return;
            
            if (comboChartInstance) comboChartInstance.destroy();
            
            const labels = weatherHourly.value.map(h => h.label);
            const temps = weatherHourly.value.map(h => h.temp);
            const rains = weatherHourly.value.map(h => h.rain);
            
            comboChartInstance = new Chart(comboCtx, {
                data: {
                    labels,
                    datasets: [
                        {
                            type: 'line',
                            label: 'Temperature (°F)',
                            data: temps,
                            borderColor: '#fbbf24',
                            backgroundColor: 'rgba(251, 191, 36, 0.2)',
                            fill: true,
                            tension: 0.4,
                            pointRadius: 2,
                            pointHoverRadius: 5,
                            yAxisID: 'yTemp'
                        },
                        {
                            type: 'bar',
                            label: 'Rain (%)',
                            data: rains,
                            backgroundColor: '#3b82f6',
                            borderRadius: 4,
                            yAxisID: 'yRain'
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { 
                        legend: { display: false },
                        tooltip: { mode: 'index', intersect: false }
                    },
                    scales: {
                        x: { 
                            display: true, 
                            ticks: { font: { size: 10 }, color: '#9ca3af', maxRotation: 45, minRotation: 45 }, 
                            grid: { display: false } 
                        },
                        yTemp: { 
                            type: 'linear',
                            display: true,
                            position: 'left',
                            ticks: { font: { size: 10 }, color: '#fbbf24' }, 
                            grid: { color: 'rgba(255,255,255,0.05)' } 
                        },
                        yRain: { 
                            type: 'linear',
                            display: true,
                            position: 'right',
                            min: 0,
                            max: 100,
                            ticks: { font: { size: 10 }, color: '#3b82f6' }, 
                            grid: { display: false } 
                        }
                    }
                }
            });
        };

        watch(selectedNote, (newVal) => {
            if (!newVal && weatherHourly.value.length > 0) {
                nextTick(() => renderCharts());
            }
        });

        const updateWeatherZip = async () => {
            if (!weatherZipInput.value.trim()) return;
            try {
                weatherData.value = null;
                weatherError.value = null;
                localStorage.setItem('weatherZip', weatherZipInput.value.trim());
                // Geocode zip
                const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(weatherZipInput.value)}&count=1&language=en&format=json`);
                const geo = await res.json();
                if (geo.results && geo.results.length > 0) {
                    fetchWeather(geo.results[0].latitude, geo.results[0].longitude);
                } else {
                    weatherError.value = "Location not found for this zip code.";
                }
            } catch (e) {
                weatherError.value = "Error looking up location.";
            }
        };

        // Try to get location
        if (weatherZipInput.value) {
            updateWeatherZip();
        } else if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => fetchWeather(pos.coords.latitude, pos.coords.longitude),
                () => fetchWeather() // fallback
            );
        } else {
            fetchWeather();
        }

        // Dashboard Tasks Logic
        const handwrittenTasks = ref([]);
        const googleTasks = ref([]);
        const combinedTasks = computed(() => {
            return [...googleTasks.value, ...handwrittenTasks.value];
        });

        const fetchGoogleTasks = async () => {
            if (!isAuthenticated.value || !accessToken) return;
            try {
                let res = await fetch(`https://tasks.googleapis.com/tasks/v1/users/@me/lists`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
                if (res.status === 401) return;
                
                let data = await res.json();
                if (data.items && data.items.length > 0) {
                    const groups = [];
                    const excludes = (widgetSettings.value.excludedLists || "").split(',').map(s => s.trim().toLowerCase()).filter(s => s);
                    
                    for (const taskList of data.items) {
                        if (excludes.some(ex => taskList.title.toLowerCase().includes(ex))) {
                            continue;
                        }
                        
                        let tasksRes = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${taskList.id}/tasks?showCompleted=false&maxResults=100`, {
                            headers: { Authorization: `Bearer ${accessToken}` }
                        });
                        let tasksData = await tasksRes.json();
                        
                        if (tasksData.items && tasksData.items.length > 0) {
                            const openTasks = tasksData.items.filter(t => t.status === 'needsAction');
                            if (openTasks.length > 0) {
                                groups.push({
                                    name: taskList.title,
                                    tasks: openTasks.map(t => ({
                                        id: t.id,
                                        title: t.title,
                                        icon: 'check_circle'
                                    }))
                                });
                            }
                        }
                    }
                    googleTasks.value = groups;
                }
            } catch (e) {
                console.error("Failed to fetch Google Tasks", e);
            }
        };

        const extractHandwrittenTasks = () => {
            const groups = [];
            let currentGroup = null;
            let idCounter = 0;
            
            const todoNote = notes.value.find(n => n.name === 'TODO_Master.md');
            if (!todoNote) return;
            
            const content = noteContents.value[todoNote.id];
            if (!content) return;
            
            const lines = content.split('\n');
            for (const line of lines) {
                if (line.trim().startsWith('## ')) {
                    const groupName = line.replace(/^##\s+/, '').trim();
                    currentGroup = { name: groupName, tasks: [] };
                    groups.push(currentGroup);
                } else if (line.trim().startsWith('- [ ] ')) {
                    if (!currentGroup) {
                        currentGroup = { name: 'Uncategorized', tasks: [] };
                        groups.push(currentGroup);
                    }
                    currentGroup.tasks.push({
                        id: `hw_${idCounter++}`,
                        title: line.replace(/^- \[ \] /, '').trim(),
                        icon: 'draw'
                    });
                }
            }
            
            const excludes = (widgetSettings.value.excludedLists || "").split(',').map(s => s.trim().toLowerCase()).filter(s => s);
            
            // Only keep groups that actually have tasks and are not excluded
            const filteredGroups = groups.filter(g => {
                if (g.tasks.length === 0) return false;
                if (excludes.some(ex => g.name.toLowerCase().includes(ex))) return false;
                return true;
            });
            
            // Sort to ensure 'TO DO' notebooks appear at the very top
            filteredGroups.sort((a, b) => {
                const aIsTodo = a.name.toLowerCase().includes('to do');
                const bIsTodo = b.name.toLowerCase().includes('to do');
                if (aIsTodo && !bIsTodo) return -1;
                if (!aIsTodo && bIsTodo) return 1;
                return 0; // maintain original relative order otherwise
            });
            
            handwrittenTasks.value = filteredGroups; 
        };

        const newsItems = ref([]);
        const isNewsLoading = ref(false);
        const newsError = ref('');

        const fetchNews = async () => {
            if (!widgetSettings.value.showNews) return;
            isNewsLoading.value = true;
            newsError.value = '';
            
            const topics = (widgetSettings.value.newsTopics || "").split(',').map(s => s.trim()).filter(s => s);
            const customRss = (widgetSettings.value.customRss || "").split(',').map(s => s.trim()).filter(s => s);
            
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
                isNewsLoading.value = false;
                newsItems.value = [];
                return;
            }

            try {
                const allItems = [];
                
                // Fetch each RSS feed via rss2json
                const promises = rssUrls.map(feedObj => {
                    const encodedUrl = encodeURIComponent(feedObj.url);
                    let url = `https://api.rss2json.com/v1/api.json?rss_url=${encodedUrl}`;
                    const apiKey = widgetSettings.value.rss2jsonApiKey?.trim();
                    if (apiKey) {
                        url += `&api_key=${apiKey}`;
                        // Increase count to 15 for custom feeds if we have an API key
                        if (feedObj.isCustom) {
                            url += `&count=15`;
                        }
                    }
                    
                    return fetch(url)
                        .then(res => res.json())
                        .then(data => {
                            if (data.status === 'ok' && data.items) {
                                // Inject source title and decode html entities
                                const decodeHtml = (html) => {
                                    const txt = document.createElement("textarea");
                                    txt.innerHTML = html;
                                    return txt.value;
                                };
                                
                                let redditSub = "";
                                if (feedObj.url.includes("reddit.com/r/")) {
                                    const match = feedObj.url.match(/reddit\.com\/r\/([^\/\.\?]+)/);
                                    if (match) redditSub = ` [r/${match[1]}]`;
                                }

                                data.items.forEach(item => {
                                    item.source = (data.feed.title || 'News');
                                    let itemRedditSub = "";
                                    if (item.link && item.link.includes("reddit.com/r/")) {
                                        const match = item.link.match(/reddit\.com\/r\/([^\/\.\?]+)/);
                                        if (match) itemRedditSub = ` [r/${match[1]}]`;
                                    } else {
                                        itemRedditSub = redditSub;
                                    }
                                    item.title = decodeHtml(item.title || '') + itemRedditSub;
                                    item.isCustom = feedObj.isCustom;
                                    allItems.push(item);
                                });
                            }
                        })
                        .catch(err => console.error("Error fetching RSS", feedObj.url, err));
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
                
                newsItems.value = groupsArr;
            } catch (err) {
                console.error("Failed to fetch news", err);
                newsError.value = "Unable to load news feeds.";
            } finally {
                isNewsLoading.value = false;
            }
        };

        const stockItems = ref([]);
        const isStocksLoading = ref(false);
        const stocksError = ref('');

        const fetchStocks = async () => {
            if (!widgetSettings.value.showStocks) return;
            const apiKey = widgetSettings.value.finnhubApiKey?.trim();
            if (!apiKey) {
                stocksError.value = "Please enter your free Finnhub API Key in Settings.";
                return;
            }

            isStocksLoading.value = true;
            stocksError.value = '';
            
            const symbols = (widgetSettings.value.stockSymbols || "").split(',').map(s => s.trim().toUpperCase()).filter(s => s);
            
            if (symbols.length === 0) {
                isStocksLoading.value = false;
                stockItems.value = [];
                return;
            }

            try {
                const results = [];
                const promises = symbols.map(async (symbol) => {
                    try {
                        const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`);
                        if (!res.ok) throw new Error(`Status ${res.status}`);
                        const data = await res.json();
                        if (data && data.c !== undefined && data.c !== 0) {
                            results.push({
                                symbol,
                                currentPrice: data.c,
                                change: data.d,
                                percentChange: data.dp
                            });
                        }
                    } catch (err) {
                        console.error(`Error fetching stock ${symbol}`, err);
                    }
                });
                
                await Promise.all(promises);
                
                stockItems.value = results.sort((a, b) => a.symbol.localeCompare(b.symbol));
            } catch (err) {
                console.error("Failed to fetch stocks", err);
                stocksError.value = "Unable to load stock data.";
            } finally {
                isStocksLoading.value = false;
            }
        };

        onMounted(() => {
            if (widgetSettings.value.showNews) {
                fetchNews();
            }
            if (widgetSettings.value.showStocks) {
                fetchStocks();
            }
        });

        watch(noteContents, () => {
            extractHandwrittenTasks();
        }, { deep: true });
        
        watch(isAuthenticated, (val) => {
            if (val) {
                fetchGoogleTasks();
            }
        });
        const closeLightbox = () => {
            lightboxImage.value = null;
        };

        onMounted(() => {
            window.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    if (lightboxImage.value) {
                        closeLightbox();
                    }
                    if (showGraph.value) {
                        showGraph.value = false;
                    }
                }
            });
        });
        
        const handleMarkdownClick = (e) => {
            if (e.target.tagName === 'IMG') {
                let src = e.target.src;
                // If it's an optimized Google thumbnail, upgrade it to ultra-high resolution for the lightbox
                if (src.includes('=s800')) {
                    src = src.replace('=s800', '=s2400');
                }
                lightboxImage.value = src;
            } else if (e.target.classList.contains('internal-link')) {
                e.preventDefault();
                const noteName = e.target.getAttribute('data-note').toLowerCase();
                const target = notes.value.find(n => 
                    n.name.replace('.md', '').toLowerCase() === noteName || 
                    (n.displayName && n.displayName.toLowerCase() === noteName) ||
                    (n.displayTitle && n.displayTitle.toLowerCase() === noteName)
                );
                if (target) {
                    selectNote(target);
                } else {
                    alert(`Note "${e.target.getAttribute('data-note')}" not found in knowledge base.`);
                }
            }
        };

        // Graph View Logic
        watch(showGraph, async (newVal) => {
            if (newVal) {
                await nextTick();
                initGraph();
            }
        });

        const initGraph = () => {
            const container = document.getElementById('graph-container');
            if (!container) return;

            const nodes = [];
            const edges = [];
            
            const tagNodesMap = new Map();
            const tagEdgesMap = new Map();

            // Build Tag Network from co-occurrences
            notes.value.forEach(n => {
                const content = noteContents.value[n.id] || '';
                const tags = extractTags(content).all;
                const uniqueTags = [...new Set(tags)];
                
                // Count occurrences for node size
                uniqueTags.forEach(t => {
                    tagNodesMap.set(t, (tagNodesMap.get(t) || 0) + 1);
                });
                
                // Count co-occurrences for edge thickness
                for (let i = 0; i < uniqueTags.length; i++) {
                    for (let j = i + 1; j < uniqueTags.length; j++) {
                        let t1 = uniqueTags[i];
                        let t2 = uniqueTags[j];
                        if (t1 > t2) { let temp = t1; t1 = t2; t2 = temp; }
                        
                        const edgeKey = t1 + '|' + t2;
                        tagEdgesMap.set(edgeKey, (tagEdgesMap.get(edgeKey) || 0) + 1);
                    }
                }
            });

            // Create vis.js nodes
            tagNodesMap.forEach((count, tag) => {
                nodes.push({
                    id: tag,
                    label: tag,
                    shape: 'dot',
                    size: 10 + Math.min(count * 2, 40),
                    color: '#a853ba',
                    font: { color: isDarkMode.value ? '#ededed' : '#18181b' },
                    title: `Used in ${count} notes`
                });
            });

            // Create vis.js edges
            tagEdgesMap.forEach((weight, edgeKey) => {
                const [t1, t2] = edgeKey.split('|');
                edges.push({
                    from: t1,
                    to: t2,
                    color: { color: '#38bdf8', opacity: Math.min(0.5 + (weight * 0.15), 1.0) },
                    value: Math.max(0.5, weight * 0.5),
                    title: `Co-occur in ${weight} notes`
                });
            });

            const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
            const options = {
                nodes: { font: { color: '#ededed' } },
                physics: { 
                    solver: 'forceAtlas2Based',
                    forceAtlas2Based: { 
                        gravitationalConstant: -100, 
                        centralGravity: 0.01, 
                        springConstant: 0.08, 
                        springLength: 100, 
                        damping: 0.4 
                    },
                    stabilization: { iterations: 150 }
                },
                interaction: { hover: true }
            };
            const network = new vis.Network(container, data, options);
            
            network.on("doubleClick", function (params) {
                if (params.nodes.length > 0) {
                    const tagId = params.nodes[0];
                    showGraph.value = false;
                    selectedTag.value = tagId;
                }
            });
        };

        return {
            isHeaderHidden,
            handleScroll,
            clientId,
            clientIdInput,
            showSettings,
            openSettings,
            saveSettings,
            isAuthenticated,
            isLoading,
            isContentLoading,
            notes,
            fileTree,
            filteredFileTree,
            searchQuery,
            selectedTag,
            selectedDate,
            allTags,
            relatedNotes,
            showGraph,
            showMobileMenu,
            selectedNote,
            selectNote,
            parsedMarkdown,
            initGoogleAuth,
            lightboxImage,
            reversePageOrder,
            closeLightbox,
            handleMarkdownClick,
            documentOutline,
            scrollToHeading,
            pastYearDays,
            heatmapWeeks,
            isNewMonth,
            weatherData,
            weatherHourly,
            weatherError,
            weatherZipInput,
            updateWeatherZip,
            getWeatherIcon,
            getMonthName,
            getHeatmapClass,
            isDarkMode,
            toggleTheme,
            googleTasks,
            handwrittenTasks,
            widgetSettings,
            newsItems,
            isNewsLoading,
            newsError,
            fetchNews,
            stockItems,
            isStocksLoading,
            stocksError,
            fetchStocks
        }
    }
});

// Register Recursive Tree Component
app.component('tree-node', {
    name: 'TreeNode',
    template: `
        <ul class="tree-list">
            <li v-for="child in node.children" :key="child.id || child.name">
                <div class="tree-item" @click.stop="toggleOrSelect(child)" :class="{ active: selectedNote && selectedNote.id === child.id, 'is-folder': child.isFolder }">
                    <span class="icon material-symbols-outlined" style="font-size: 1.2rem; vertical-align: bottom;">{{ child.isFolder ? (child.expanded ? 'folder_open' : 'folder') : 'description' }}</span> 
                    <span class="tree-name">{{ child.displayTitle || child.name }}</span>
                </div>
                <tree-node v-if="child.isFolder" v-show="child.expanded" :node="child" :selectedNote="selectedNote" @select="$emit('select', $event)"></tree-node>
            </li>
        </ul>
    `,
    props: ['node', 'selectedNote'],
    methods: {
        toggleOrSelect(child) {
            if (child.isFolder) {
                child.expanded = !child.expanded;
            } else {
                this.$emit('select', child);
            }
        }
    }
});

app.mount('#app');
