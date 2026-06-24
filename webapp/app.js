const { createApp, ref, computed } = Vue;

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

        const openSettings = () => {
            clientIdInput.value = clientId.value;
            showSettings.value = true;
        };

        const saveSettings = () => {
            clientId.value = clientIdInput.value.trim();
            localStorage.setItem('brain2_client_id', clientId.value);
            showSettings.value = false;
            if (clientId.value && !isAuthenticated.value) {
                initGoogleAuth();
            }
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
                        await loadNotebooks();
                    }
                },
            });
            tokenClient.requestAccessToken();
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

        const loadNotebooks = async () => {
            isLoading.value = true;
            try {
                let query = encodeURIComponent("name='Viwoods-Note' and mimeType='application/vnd.google-apps.folder' and trashed=false");
                let res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
                let data = await res.json();
                
                if (!data.files || data.files.length === 0) {
                    alert("Could not find 'Viwoods-Note' folder in your Google Drive.");
                    return;
                }
                const rootFolderId = data.files[0].id;

        const fetchAllMarkdown = async (parentId, path = "") => {
                    let collectedFiles = [];
                    let q = encodeURIComponent(`'${parentId}' in parents and (name contains '.md' or mimeType='application/vnd.google-apps.folder') and name != '_attachments' and trashed=false`);
                    // IMPORTANT: Added 'parents' to fields so we know where the file lives
                    let response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,parents)&orderBy=name`, {
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
                notes.value = allNotes;
                fileTree.value = buildTree(allNotes);
            } catch (err) {
                console.error(err);
                alert("Failed to load notebooks. Check console.");
            } finally {
                isLoading.value = false;
            }
        };

        const imageBlobUrls = ref({});
        const isContentLoading = ref(false);

        const selectNote = async (note) => {
            selectedNote.value = note;
            isContentLoading.value = true;
            imageBlobUrls.value = {}; // Reset images for new note
            
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
            }
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
                    <span class="tree-name">{{ child.name }}</span>
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
