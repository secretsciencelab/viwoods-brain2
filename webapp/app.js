const { createApp, ref, computed, onMounted, watch, nextTick } = Vue;

const SCOPES = "https://www.googleapis.com/auth/drive.readonly";

const app = createApp({
    setup() {
        const clientId = ref(localStorage.getItem('brain2_client_id') || '');
        const showSettings = ref(false);
        const clientIdInput = ref('');
        
        const isAuthenticated = ref(false);
        const isLoading = ref(false);
        const notes = ref([]);
        const selectedNote = ref(null);
        const markdownContent = ref('');
        let accessToken = null;
        let tokenClient = null;

        const searchQuery = ref('');
        const selectedTag = ref(null);
        const allTags = ref([]);
        const noteContents = ref({});
        const relatedNotes = ref([]);
        const showGraph = ref(false);

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
            clientId.value = clientIdInput.value.trim();
            localStorage.setItem('brain2_client_id', clientId.value);
            showSettings.value = false;
        };

        // Initialize Google Identity Services
        const initGoogleAuth = () => {
            if (!clientId.value) {
                openSettings();
                return;
            }
            
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
                    }
                },
            });
            tokenClient.requestAccessToken();
        };

        const extractTags = (content) => {
            if (!content) return [];
            const tags = content.match(/#[\w-]+/g) || [];
            const headings = content.match(/^#{1,6}\s+(.+)$/gm) || [];
            headings.forEach(h => {
                const rawHeading = h.replace(/^#{1,6}\s+/, '').trim();
                const normalized = '#' + rawHeading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                tags.push(normalized);
            });
            return tags.map(t => t.toLowerCase());
        };

        const fileTree = ref({ children: [] });

        const buildTree = (files) => {
            let tree = { name: "root", isFolder: true, expanded: true, children: [] };
            
            // Put Master files directly at root
            let masters = files.filter(f => f.name.includes("Master"));
            let normalFiles = files.filter(f => !f.name.includes("Master"));
            
            masters.forEach(f => {
                tree.children.push({ ...f, isFolder: false });
            });

            // Build hierarchy for normal files
            normalFiles.forEach(f => {
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

                const fetchAllMarkdown = async (parentId, path = "") => {
                    let collectedFiles = [];
                    let q = encodeURIComponent(`'${parentId}' in parents and (name contains '.md' or mimeType='application/vnd.google-apps.folder') and name != '_attachments' and trashed=false`);
                    // IMPORTANT: Added 'parents' and 'modifiedTime' to fields
                    let response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,parents,modifiedTime)&orderBy=name`, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    });
                    let result = await response.json();
                    
                    if (!result.files) return collectedFiles;

                    for (let file of result.files) {
                        if (file.mimeType === 'application/vnd.google-apps.folder') {
                            const subFolderPath = path ? `${path}/${file.name}` : file.name;
                            const subFiles = await fetchAllMarkdown(file.id, subFolderPath);
                            collectedFiles = collectedFiles.concat(subFiles);
                        } else if (file.name.endsWith('.md')) {
                            file.displayName = path ? `${path}/${file.name}` : file.name;
                            collectedFiles.push(file);
                        }
                    }
                    return collectedFiles;
                };

                const allNotes = await fetchAllMarkdown(rootFolderId);
                
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
                                extracted.forEach(t => tagSet.add(t));
                            } catch (e) {
                                // ignore
                            }
                        }));
                    }
                    noteContents.value = contents;
                    allTags.value = Array.from(tagSet).sort();
                };
                // Background fetch
                fetchAllNoteContents(allNotes);
                
                // Preserve tree expansion state
                const oldExpandedState = {};
                const storeExpandedState = (node, path) => {
                    if (node.isFolder) {
                        oldExpandedState[path] = node.expanded;
                        node.children.forEach(c => storeExpandedState(c, path + '/' + c.name));
                    }
                };
                if (fileTree.value) storeExpandedState(fileTree.value, 'root');

                const newTree = buildTree(allNotes);

                const restoreExpandedState = (node, path) => {
                    if (node.isFolder) {
                        if (oldExpandedState[path] !== undefined) {
                            node.expanded = oldExpandedState[path];
                        }
                        node.children.forEach(c => restoreExpandedState(c, path + '/' + c.name));
                    }
                };
                restoreExpandedState(newTree, 'root');

                notes.value = allNotes;
                fileTree.value = newTree;

                // Check if currently selected note got updated
                if (isSilent && selectedNote.value) {
                    const updatedNote = allNotes.find(n => n.id === selectedNote.value.id);
                    if (updatedNote && updatedNote.modifiedTime !== selectedNote.value.modifiedTime) {
                        selectNote(updatedNote, true); // true for isSilent mode
                    }
                }
            } catch (err) {
                console.error(err);
                if (!isSilent) alert("Failed to load notebooks. Check console.");
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
            
            if (!searchQuery.value && !selectedTag.value) {
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
                        const nodeTags = new Set(extractTags(content));
                        if (!nodeTags.has(selectedTag.value)) {
                            matches = false;
                        }
                    }
                    return matches;
                }
                
                if (node.children) {
                    node.children = node.children.filter(filterNode);
                    // Automatically expand folders if searching
                    if (searchQuery.value || selectedTag.value) {
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
                
                // If it's a Master file, it contains content from many subdirectories.
                // We parse the "## Source: path/to/file.md" headers to find the original notes,
                // and then fetch the images for all of them!
                if (note.name.includes("Master.md")) {
                    const sourceRegex = /## Source:\s*(.*?\.md)/g;
                    let match;
                    let uniqueSources = new Set();
                    while ((match = sourceRegex.exec(text)) !== null) {
                        uniqueSources.add(match[1].trim());
                    }
                    
                    for (let source of uniqueSources) {
                        let cleanSource = source.startsWith('/') ? source.substring(1) : source;
                        let sourceNote = notes.value.find(n => {
                            let cleanDisplayName = (n.displayName || "").startsWith('/') ? n.displayName.substring(1) : n.displayName;
                            return cleanDisplayName === cleanSource || n.name === cleanSource;
                        });
                        
                        if (sourceNote) {
                            loadImagesForNote(sourceNote);
                        }
                    }
                } else {
                    // Normal note
                    loadImagesForNote(note);
                }
                
                // Calculate Related Notes based on Tag overlap
                let related = [];
                const currentContent = noteContents.value[note.id] || '';
                const currentTags = new Set(extractTags(currentContent));
                
                if (currentTags.size > 0) {
                    for (const n of notes.value) {
                        if (n.id === note.id) continue;
                        const content = noteContents.value[n.id];
                        if (content) {
                            const tags = new Set(extractTags(content));
                            
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
                let res3 = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q3}&fields=files(id,name)`, { headers: { Authorization: `Bearer ${accessToken}` } });
                let data3 = await res3.json();
                
                // 4. Download each image as a Blob and create ObjectURL
                for (let file of data3.files) {
                    fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    })
                    .then(r => r.blob())
                    .then(blob => {
                        // Vue's reactivity will instantly update the computed markdown!
                        imageBlobUrls.value[file.name] = URL.createObjectURL(blob);
                    });
                }
            } catch (err) {
                console.error("Error loading images:", err);
            }
        };

        const parsedMarkdown = computed(() => {
            if (!markdownContent.value) return '';
            
            let rawMd = markdownContent.value;
            
            // Bulletproof regex: matches ANY image link containing _attachments or Attachments anywhere in the path
            rawMd = rawMd.replace(/!\[(.*?)\]\(\s*.*?(?:_attachments|Attachments)\/.*?([^\/]+\.(?:png|jpg|jpeg|gif|bmp|webp))\s*\)/gi, (match, altText, filename) => {
                let imgTag = '';
                if (imageBlobUrls.value[filename]) {
                    imgTag = `![${altText}](${imageBlobUrls.value[filename]})`;
                } else {
                    imgTag = `![Loading ${filename}...](https://via.placeholder.com/800x400/171717/38bdf8?text=Loading+Image...)`;
                }
                
                return `\n<div style="clear: both; margin-top: 32px; border-top: 1px solid var(--border-color); padding-top: 32px;"></div>\n\n${imgTag}`;
            });
            
            // Replace [[Note Name]] with clickable internal links
            rawMd = rawMd.replace(/\[\[(.*?)\]\]/g, (match, noteName) => {
                return `<a href="#" class="internal-link" data-note="${noteName}">${noteName}</a>`;
            });
            
            return marked.parse(rawMd);
        });

        // Lightbox Logic
        const lightboxImage = ref(null);
        
        const closeLightbox = () => {
            lightboxImage.value = null;
        };
        
        const handleMarkdownClick = (e) => {
            if (e.target.tagName === 'IMG') {
                lightboxImage.value = e.target.src;
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
            const nodeMap = {};

            notes.value.forEach(n => {
                const title = n.displayTitle || n.name.replace('.md', '');
                nodes.push({ id: n.id, label: title, shape: 'dot', size: 12, color: '#38bdf8' });
                nodeMap[title.toLowerCase()] = n.id;
                nodeMap[n.name.replace('.md', '').toLowerCase()] = n.id;
            });

            notes.value.forEach(n => {
                const content = noteContents.value[n.id];
                if (content) {
                    const regex = /\[\[(.*?)\]\]/g;
                    let match;
                    while ((match = regex.exec(content)) !== null) {
                        const targetName = match[1].toLowerCase();
                        if (nodeMap[targetName]) {
                            edges.push({ from: n.id, to: nodeMap[targetName], color: { color: '#262626' } });
                        }
                    }
                }
            });

            const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
            const options = {
                nodes: { font: { color: '#ededed' } },
                physics: { barnesHut: { gravitationalConstant: -2000, centralGravity: 0.3 } },
                interaction: { hover: true }
            };
            const network = new vis.Network(container, data, options);
            
            network.on("doubleClick", function (params) {
                if (params.nodes.length > 0) {
                    const nodeId = params.nodes[0];
                    const target = notes.value.find(n => n.id === nodeId);
                    if (target) {
                        showGraph.value = false;
                        selectNote(target);
                    }
                }
            });
        };

        return {
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
            allTags,
            relatedNotes,
            showGraph,
            selectedNote,
            selectNote,
            parsedMarkdown,
            initGoogleAuth,
            lightboxImage,
            closeLightbox,
            handleMarkdownClick
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
                    <span class="icon">{{ child.isFolder ? (child.expanded ? '📂' : '📁') : '📄' }}</span> 
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
