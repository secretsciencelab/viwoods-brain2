import { parseMarkdown } from './markdown.js?v=89';
import { fetchWeather as apiFetchWeather, fetchNews as apiFetchNews, fetchStocks as apiFetchStocks } from './api.js';

const { createApp, ref, computed, onMounted, onUnmounted, watch, nextTick } = Vue;

const SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/tasks.readonly";

marked.use({ breaks: true, gfm: true });

const app = createApp({
    setup() {
        const clientId = ref(localStorage.getItem('brain2_client_id') || '');
        const githubPat = ref(localStorage.getItem('brain2_github_pat') || '');
        const githubRepo = ref(localStorage.getItem('brain2_github_repo') || '');
        const showSettings = ref(false);
        const clientIdInput = ref('');
        const githubPatInput = ref('');
        const githubRepoInput = ref('');
        const widgetSettings = ref(JSON.parse(localStorage.getItem('brain2_widget_settings') || '{"showWeather": true, "showTasks": true, "excludedLists": "", "showNews": true, "newsTopics": "Technology, Artificial Intelligence", "customRss": "", "showStocks": true, "stockSymbols": "AAPL, GOOGL, MSFT", "finnhubApiKey": "", "widgetOrder": ["weather", "tasks", "news", "stocks"]}'));
        if (widgetSettings.value.excludedLists === undefined) widgetSettings.value.excludedLists = "";
        if (widgetSettings.value.showNews === undefined) widgetSettings.value.showNews = true;
        if (widgetSettings.value.newsTopics === undefined) widgetSettings.value.newsTopics = "Technology, Artificial Intelligence";
        if (widgetSettings.value.customRss === undefined) widgetSettings.value.customRss = "";
        if (widgetSettings.value.showStocks === undefined) widgetSettings.value.showStocks = true;
        if (widgetSettings.value.stockSymbols === undefined) widgetSettings.value.stockSymbols = "AAPL, GOOGL, MSFT";
        if (widgetSettings.value.finnhubApiKey === undefined) widgetSettings.value.finnhubApiKey = "";
        if (widgetSettings.value.rss2jsonApiKey === undefined) widgetSettings.value.rss2jsonApiKey = "";
        if (widgetSettings.value.twelveDataApiKey === undefined) widgetSettings.value.twelveDataApiKey = widgetSettings.value.alphaVantageApiKey || "";
        if (!widgetSettings.value.widgetOrder || widgetSettings.value.widgetOrder.length === 0) {
            widgetSettings.value.widgetOrder = ['weather', 'tasks', 'news', 'stocks'];
        }

        const getWidgetIndex = (id) => {
            return widgetSettings.value.widgetOrder.indexOf(id);
        };

        const moveWidget = (id, direction) => {
            const arr = [...widgetSettings.value.widgetOrder];
            const index = arr.indexOf(id);
            if (index < 0) return;
            const newIndex = index + direction;
            if (newIndex >= 0 && newIndex < arr.length) {
                const temp = arr[index];
                arr[index] = arr[newIndex];
                arr[newIndex] = temp;
                widgetSettings.value.widgetOrder = arr;
            }
        };

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
            // Track updates for individual pages inside notebooks
            Object.values(noteContents.value).forEach(text => {
                if (!text) return;
                const regex = /> \*Last updated: (.*?)\*/g;
                let m;
                while ((m = regex.exec(text)) !== null) {
                    const dateStr = m[1].replace(' at ', ' ') + ' UTC';
                    const d = new Date(dateStr);
                    if (!isNaN(d)) {
                        const localStr = getLocalDateStr(d);
                        counts[localStr] = (counts[localStr] || 0) + 1;
                    }
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
            // Reverse so that the newest weeks are displayed at the top
            return weeks.reverse();
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
            } else {
                if (savedToken) {
                    // Clear expired token
                    localStorage.removeItem('brain2_access_token');
                    localStorage.removeItem('brain2_token_expires');
                }
                if (!clientId.value && (!githubPat.value || !githubRepo.value)) {
                    openSettings();
                }
            }

            if (githubPat.value && githubRepo.value) {
                loadNotebooks();
            }
        };

        onMounted(() => {
            checkExistingAuth();
        });

        const openSettings = () => {
            clientIdInput.value = clientId.value;
            githubPatInput.value = githubPat.value;
            githubRepoInput.value = githubRepo.value;
            showSettings.value = true;
        };

        const saveSettings = () => {
            if (clientIdInput.value) {
                clientId.value = clientIdInput.value.trim();
                localStorage.setItem('brain2_client_id', clientId.value);
            }
            if (githubPatInput.value !== undefined) {
                githubPat.value = githubPatInput.value.trim();
                localStorage.setItem('brain2_github_pat', githubPat.value);
            }
            if (githubRepoInput.value !== undefined) {
                githubRepo.value = githubRepoInput.value.trim();
                localStorage.setItem('brain2_github_repo', githubRepo.value);
            }
            localStorage.setItem('brain2_widget_settings', JSON.stringify(widgetSettings.value));
            showSettings.value = false;
            
            if (isAuthenticated.value) {
                fetchGoogleTasks();
                extractHandwrittenTasks();
            } else {
                initGoogleAuth();
            }
            
            if (githubPat.value && githubRepo.value) {
                loadNotebooks();
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
            if (!githubPat.value || !githubRepo.value) return;
            if (!isSilent) isLoading.value = true;
            try {
                const treeUrl = `https://api.github.com/repos/${githubRepo.value}/git/trees/main?recursive=1`;
                const headers = { Authorization: `Bearer ${githubPat.value}` };
                let res = await fetch(treeUrl, { headers });
                if (!res.ok) throw new Error("Failed to fetch repository tree");
                let data = await res.json();
                
                const allNotesList = [];
                const treeFiles = data.tree || [];
                
                for (let file of treeFiles) {
                    if (file.type === 'blob' && file.path.endsWith('.md') && (!file.path.toLowerCase().endsWith('master.md') || file.path.endsWith('TODO_Master.md')) && !file.path.includes('_attachments/')) {
                        const parts = file.path.split('/');
                        allNotesList.push({
                            id: file.sha,
                            name: parts[parts.length - 1],
                            displayName: file.path,
                            path: file.path
                        });
                    }
                }

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

                const fetchAllNoteContents = async (files) => {
                    const contents = {};
                    const tagSet = new Set();
                    const batchSize = 10;
                    for (let i = 0; i < files.length; i += batchSize) {
                        const batch = files.slice(i, i + batchSize);
                        await Promise.all(batch.map(async (note) => {
                            try {
                                const res = await fetch(`https://api.github.com/repos/${githubRepo.value}/contents/${note.path}`, {
                                    headers: { 
                                        Authorization: `Bearer ${githubPat.value}`,
                                        Accept: 'application/vnd.github.v3.raw'
                                    }
                                });
                                const text = await res.text();
                                contents[note.id] = text;
                                
                                const titleMatch = text.match(/^#\s+(.+)$/m);
                                if (titleMatch) {
                                    note.displayTitle = titleMatch[1].trim();
                                }
                                
                                const extracted = extractTags(text);
                                extracted.all.forEach(t => tagSet.add(t));
                            } catch (e) {
                                // ignore
                            }
                        }));
                    }
                    noteContents.value = contents;
                    allTags.value = Array.from(tagSet).sort();
                };

                window._githubTreeCache = treeFiles;
                fetchAllNoteContents(allNotesList);

                notes.value = allNotesList;
                fileTree.value = buildTree(allNotesList);
                restoreExpandedState(fileTree.value, 'root');

                if (isSilent && selectedNote.value) {
                    const updatedNote = allNotesList.find(n => n.path === selectedNote.value.path);
                    if (updatedNote && updatedNote.id !== selectedNote.value.id) {
                        selectNote(updatedNote, true);
                    }
                }
            } catch (err) {
                console.error(err);
                if (!isSilent) {
                    alert("Failed to load notebooks. Check console.");
                }
            } finally {
                if (!isSilent) isLoading.value = false;
            }
        };

        // Periodic background refresh every 60 seconds
        setInterval(() => {
            if (githubPat.value && githubRepo.value) {
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
                        const content = noteContents.value[node.id] || '';
                        
                        let foundDateMatch = false;
                        
                        // Check notebook timestamp
                        if (note && note.modifiedTime && getLocalDateStr(note.modifiedTime) === selectedDate.value) {
                            foundDateMatch = true;
                        }
                        
                        // Check page timestamps
                        if (!foundDateMatch) {
                            const regex = /> \*Last updated: (.*?)\*/g;
                            let m;
                            while ((m = regex.exec(content)) !== null) {
                                const dateStr = m[1].replace(' at ', ' ') + ' UTC';
                                const d = new Date(dateStr);
                                if (!isNaN(d) && getLocalDateStr(d) === selectedDate.value) {
                                    foundDateMatch = true;
                                    break;
                                }
                            }
                        }
                        
                        if (!foundDateMatch) {
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
                const res = await fetch(`https://api.github.com/repos/${githubRepo.value}/contents/${note.path}`, {
                    headers: { 
                        Authorization: `Bearer ${githubPat.value}`,
                        Accept: 'application/vnd.github.v3.raw'
                    }
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
                const noteBaseName = note.name.replace('.md', '');
                const treeFiles = window._githubTreeCache || [];
                const imageFiles = treeFiles.filter(f => f.type === 'blob' && f.path.includes(`_attachments/${noteBaseName}/`));

                for (let file of imageFiles) {
                    fetch(`https://api.github.com/repos/${githubRepo.value}/contents/${file.path}`, {
                        headers: { 
                            Authorization: `Bearer ${githubPat.value}`,
                            Accept: 'application/vnd.github.v3.raw'
                        }
                    })
                    .then(r => r.blob())
                    .then(blob => {
                        const parts = file.path.split('/');
                        const filename = parts[parts.length - 1];
                        imageBlobUrls.value[filename] = URL.createObjectURL(blob);
                    })
                    .catch(err => {
                        console.error("Error fetching media blob for", file.path, err);
                    });
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
            
            // We NO LONGER pass imageBlobUrls.value here to prevent full DOM re-renders every time an image loads!
            // Images will initially render with placeholders and be surgically updated via the watcher below.
            return parseMarkdown(rawMd, reversePageOrder.value, {}, searchQuery.value, selectedTag.value);
        });

        // Surgically patch image src attributes directly in the DOM as they finish downloading
        // This completely eliminates the severe "flashing" caused by destroying the DOM repeatedly.
        watch(imageBlobUrls, (newUrls) => {
            Vue.nextTick(() => {
                const imgs = document.querySelectorAll('.markdown-body img[data-filename]');
                imgs.forEach(img => {
                    const filename = img.getAttribute('data-filename');
                    if (filename && newUrls[filename] && img.src !== newUrls[filename]) {
                        // Reset inversion processing flag so dark mode logic runs again on the new image
                        img.removeAttribute('data-processed');
                        img.style.filter = '';
                        img.src = newUrls[filename];
                    }
                });
            });
        }, { deep: true });

        // When parsedMarkdown re-evaluates (e.g., during a search), the DOM is replaced and images revert to placeholders.
        // We need to re-apply the already downloaded image URLs.
        watch(parsedMarkdown, () => {
            Vue.nextTick(() => {
                const markdownBody = document.querySelector('.markdown-body');
                if (!markdownBody) return;

                // Restore images
                const imgs = markdownBody.querySelectorAll('img[data-filename]');
                imgs.forEach(img => {
                    const filename = img.getAttribute('data-filename');
                    if (filename && imageBlobUrls.value[filename] && !img.src.includes('blob:')) {
                        img.removeAttribute('data-processed');
                        img.style.filter = '';
                        img.src = imageBlobUrls.value[filename];
                    }
                });

                // Highlight text
                const termToHighlight = searchQuery.value || selectedTag.value;
                if (termToHighlight) {
                    const escapeHtml = (unsafe) => {
                        return unsafe
                             .replace(/&/g, "&amp;")
                             .replace(/</g, "&lt;")
                             .replace(/>/g, "&gt;")
                             .replace(/"/g, "&quot;")
                             .replace(/'/g, "&#039;");
                    };
                    
                    const regex = new RegExp(`(${termToHighlight.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')})`, 'gi');
                    const walk = document.createTreeWalker(markdownBody, NodeFilter.SHOW_TEXT, null, false);
                    let node;
                    const nodesToReplace = [];
                    while (node = walk.nextNode()) {
                        if (node.parentNode.nodeName !== 'SCRIPT' && node.parentNode.nodeName !== 'STYLE' && !node.parentNode.classList.contains('search-highlight')) {
                            const pageBlock = node.parentNode.closest('.page-block');
                            if (pageBlock && pageBlock.style.display === 'none') continue;
                            
                            if (regex.test(node.nodeValue)) {
                                nodesToReplace.push(node);
                            }
                        }
                    }
                    
                    nodesToReplace.forEach(node => {
                        const span = document.createElement('span');
                        const escapedText = escapeHtml(node.nodeValue);
                        span.innerHTML = escapedText.replace(regex, '<mark class="search-highlight">$1</mark>');
                        node.parentNode.replaceChild(span, node);
                    });
                }
            });
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
                if (notebookOrders.value[selectedNote.value.id] !== undefined) {
                    return notebookOrders.value[selectedNote.value.id];
                }
                return true; // Default to newest first
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
                const data = await apiFetchWeather(lat, lon);
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
            try {
                newsItems.value = await apiFetchNews(widgetSettings.value);
            } catch (err) {
                console.error("Failed to fetch news", err);
                newsError.value = 'Could not load news feed.';
            }
            isNewsLoading.value = false;
        };

        const stockItems = ref([]);
        const isStocksLoading = ref(false);
        const stocksError = ref('');

        const fetchStocks = async () => {
            if (!widgetSettings.value.showStocks) return;
            isStocksLoading.value = true;
            stocksError.value = '';
            try {
                const newStocks = await apiFetchStocks(widgetSettings.value);
                if (newStocks && newStocks.length > 0) {
                    stockItems.value = newStocks;
                }
            } catch (err) {
                console.error("Failed to fetch stocks", err);
                
                // If we ran out of credits but already have data loaded, just keep showing the old data
                if (err.message && err.message.toLowerCase().includes('credits') && stockItems.value.length > 0) {
                    stocksError.value = '';
                } else {
                    stocksError.value = err.message || 'Could not load stock data.';
                }
            }
            isStocksLoading.value = false;
        };

        let newsInterval = null;
        let stocksInterval = null;

        onMounted(() => {
            if (widgetSettings.value.showNews) {
                fetchNews();
            }
            if (widgetSettings.value.showStocks) {
                fetchStocks();
            }
            
            // Auto-refresh every 15 minutes
            newsInterval = setInterval(() => {
                if (widgetSettings.value.showNews) fetchNews();
            }, 15 * 60 * 1000);
            
            stocksInterval = setInterval(() => {
                if (widgetSettings.value.showStocks) fetchStocks();
            }, 15 * 60 * 1000);
        });

        onUnmounted(() => {
            if (newsInterval) clearInterval(newsInterval);
            if (stocksInterval) clearInterval(stocksInterval);
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
                if (weight < 2) return; // Only show edges for tags that co-occur in multiple notes
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
            githubPat,
            githubPatInput,
            githubRepo,
            githubRepoInput,
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
            fetchStocks,
            getWidgetIndex,
            moveWidget
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
        autoExpandIfNoFiles(node) {
            if (!node.children || node.children.length === 0) return;
            const hasFiles = node.children.some(c => !c.isFolder);
            if (!hasFiles) {
                node.children.forEach(c => {
                    if (c.isFolder) {
                        c.expanded = true;
                        this.autoExpandIfNoFiles(c);
                    }
                });
            }
        },
        toggleOrSelect(child) {
            if (child.isFolder) {
                child.expanded = !child.expanded;
                if (child.expanded) {
                    this.autoExpandIfNoFiles(child);
                }
            } else {
                this.$emit('select', child);
            }
        }
    }
});

app.mount('#app');
