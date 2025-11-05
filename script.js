// SmartNotes - JavaScript Functionality

class SmartNotes {
    constructor() {
        this.notes = JSON.parse(localStorage.getItem('smartNotes')) || [];
        this.currentFilter = 'all';
        this.searchTerm = '';
        this.selectedColor = '#ffffff';
        this.editingNoteId = null;
        
        this.initializeEventListeners();
        this.renderNotes();
        this.updateEmptyState();
    }

    initializeEventListeners() {
        // New Note Button
        document.getElementById('newNoteBtn').addEventListener('click', () => this.openNoteModal());
        document.getElementById('createFirstNoteBtn').addEventListener('click', () => this.openNoteModal());

        // Save Note Button
        document.getElementById('saveNoteBtn').addEventListener('click', () => this.saveNote());

        // Search Functionality
        document.getElementById('searchInput').addEventListener('input', (e) => {
            this.searchTerm = e.target.value;
            this.renderNotes();
        });

        document.getElementById('clearSearchBtn').addEventListener('click', () => {
            document.getElementById('searchInput').value = '';
            this.searchTerm = '';
            this.renderNotes();
        });

        // Category Filtering
        document.querySelectorAll('.category-item').forEach(item => {
            item.addEventListener('click', (e) => {
                this.currentFilter = e.currentTarget.dataset.category;
                this.updateCategorySelection();
                this.renderNotes();
            });
        });

        // Color Picker
        document.querySelectorAll('.color-option').forEach(option => {
            option.addEventListener('click', (e) => {
                this.selectedColor = e.currentTarget.dataset.color;
                this.updateColorSelection();
            });
        });

        // Export and Clear All
        document.getElementById('exportBtn').addEventListener('click', () => this.exportNotes());
        document.getElementById('clearAllBtn').addEventListener('click', () => this.clearAllNotes());

        // Modal Events
        const noteModal = document.getElementById('noteModal');
        noteModal.addEventListener('hidden.bs.modal', () => this.resetModal());

        // Theme Switcher
        document.getElementById('themeSwitch').addEventListener('change', (e) => {
            this.setTheme(e.target.checked ? 'dark' : 'light');
        });

        this.loadTheme();
    }

    openNoteModal(noteId = null) {
        this.editingNoteId = noteId;
        const modal = new bootstrap.Modal(document.getElementById('noteModal'));
        
        if (noteId) {
            const note = this.notes.find(n => n.id === noteId);
            if (note) {
                document.getElementById('noteTitle').value = note.title;
                document.getElementById('noteCategory').value = note.category;
                document.getElementById('noteContent').value = note.content;
                this.selectedColor = note.color || '#ffffff';
                document.getElementById('modalTitle').innerHTML = '<i class="fas fa-edit me-2"></i>Edit Note';
            }
        } else {
            document.getElementById('modalTitle').innerHTML = '<i class="fas fa-edit me-2"></i>New Note';
        }
        
        this.updateColorSelection();
        modal.show();
    }

    saveNote() {
        const title = document.getElementById('noteTitle').value.trim();
        const category = document.getElementById('noteCategory').value;
        const content = document.getElementById('noteContent').value.trim();

        if (!title || !content) {
            this.showToast('Please fill in both title and content!', 'warning');
            return;
        }

        const noteData = {
            title,
            category,
            content,
            color: this.selectedColor,
            createdAt: this.editingNoteId ? this.notes.find(n => n.id === this.editingNoteId).createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        if (this.editingNoteId) {
            // Update existing note
            const index = this.notes.findIndex(n => n.id === this.editingNoteId);
            if (index !== -1) {
                this.notes[index] = { ...this.notes[index], ...noteData };
            }
        } else {
            // Create new note
            noteData.id = Date.now().toString();
            this.notes.unshift(noteData);
        }

        this.saveToLocalStorage();
        this.renderNotes();
        this.updateEmptyState();
        
        const modal = bootstrap.Modal.getInstance(document.getElementById('noteModal'));
        modal.hide();
        
        this.showToast(
            this.editingNoteId ? 'Note updated successfully!' : 'Note created successfully!',
            'success'
        );
    }

    deleteNote(noteId) {
        if (confirm('Are you sure you want to delete this note?')) {
            this.notes = this.notes.filter(note => note.id !== noteId);
            this.saveToLocalStorage();
            this.renderNotes();
            this.updateEmptyState();
            this.showToast('Note deleted successfully!', 'info');
        }
    }

    renderNotes() {
        const container = document.getElementById('notesContainer');
        const filteredNotes = this.getFilteredNotes();
        
        if (filteredNotes.length === 0) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = filteredNotes.map(note => this.createNoteCard(note)).join('');
        
        // Add event listeners to new note cards
        container.querySelectorAll('.edit-note').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const noteId = e.currentTarget.dataset.noteId;
                this.openNoteModal(noteId);
            });
        });

        container.querySelectorAll('.delete-note').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const noteId = e.currentTarget.dataset.noteId;
                this.deleteNote(noteId);
            });
        });
    }

    createNoteCard(note) {
        const content = this.searchTerm ? this.highlightSearchTerm(note.content) : note.content;
        const date = new Date(note.updatedAt || note.createdAt).toLocaleDateString();
        
        return `
            <div class="col-md-6 col-lg-4">
                <div class="note-card ${note.category}" style="background-color: ${note.color};">
                    <div class="note-header">
                        <div class="note-title">${this.searchTerm ? this.highlightSearchTerm(note.title) : note.title}</div>
                        <div class="note-meta">
                            <span class="note-category">${this.getCategoryIcon(note.category)} ${note.category}</span>
                            <small>${date}</small>
                        </div>
                    </div>
                    <div class="note-content">
                        ${content}
                    </div>
                    <div class="note-actions">
                        <button class="btn btn-outline-primary btn-sm edit-note" data-note-id="${note.id}">
                            <i class="fas fa-edit"></i> Edit
                        </button>
                        <button class="btn btn-outline-danger btn-sm delete-note" data-note-id="${note.id}">
                            <i class="fas fa-trash"></i> Delete
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    getFilteredNotes() {
        let filtered = this.notes;
        
        // Filter by category
        if (this.currentFilter !== 'all') {
            filtered = filtered.filter(note => note.category === this.currentFilter);
        }
        
        // Filter by search term
        if (this.searchTerm) {
            const term = this.searchTerm.toLowerCase();
            filtered = filtered.filter(note => 
                note.title.toLowerCase().includes(term) || 
                note.content.toLowerCase().includes(term)
            );
        }
        
        return filtered;
    }

    highlightSearchTerm(text) {
        if (!this.searchTerm) return text;
        const regex = new RegExp(`(${this.searchTerm})`, 'gi');
        return text.replace(regex, '<span class="search-highlight">$1</span>');
    }

    getCategoryIcon(category) {
        const icons = {
            work: 'fas fa-briefcase',
            personal: 'fas fa-user',
            ideas: 'fas fa-lightbulb',
            todo: 'fas fa-tasks'
        };
        return `<i class="${icons[category] || 'fas fa-sticky-note'}"></i>`;
    }

    updateCategorySelection() {
        document.querySelectorAll('.category-item').forEach(item => {
            item.classList.remove('active');
            if (item.dataset.category === this.currentFilter) {
                item.classList.add('active');
            }
        });
    }

    updateColorSelection() {
        document.querySelectorAll('.color-option').forEach(option => {
            option.classList.remove('selected');
            if (option.dataset.color === this.selectedColor) {
                option.classList.add('selected');
            }
        });
    }

    updateEmptyState() {
        const emptyState = document.getElementById('emptyState');
        const notesContainer = document.getElementById('notesContainer');
        
        if (this.notes.length === 0) {
            emptyState.style.display = 'block';
            notesContainer.style.display = 'none';
        } else {
            emptyState.style.display = 'none';
            notesContainer.style.display = 'flex';
        }
    }

    resetModal() {
        document.getElementById('noteTitle').value = '';
        document.getElementById('noteCategory').value = 'work';
        document.getElementById('noteContent').value = '';
        this.selectedColor = '#ffffff';
        this.editingNoteId = null;
        this.updateColorSelection();
    }

    exportNotes() {
        const dataStr = JSON.stringify(this.notes, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        
        const link = document.createElement('a');
        link.href = url;
        link.download = `smartnotes-${new Date().toISOString().split('T')[0]}.json`;
        link.click();
        
        URL.revokeObjectURL(url);
        this.showToast('Notes exported successfully!', 'success');
    }

    clearAllNotes() {
        if (confirm('Are you sure you want to delete all notes? This action cannot be undone.')) {
            this.notes = [];
            this.saveToLocalStorage();
            this.renderNotes();
            this.updateEmptyState();
            this.showToast('All notes cleared!', 'info');
        }
    }

    saveToLocalStorage() {
        localStorage.setItem('smartNotes', JSON.stringify(this.notes));
    }

    showToast(message, type = 'info') {
        // Create toast container if it doesn't exist
        let toastContainer = document.querySelector('.toast-container');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.className = 'toast-container';
            document.body.appendChild(toastContainer);
        }

        const toast = document.createElement('div');
        toast.className = `toast align-items-center text-white bg-${type} border-0`;
        toast.setAttribute('role', 'alert');
        toast.innerHTML = `
            <div class="d-flex">
                <div class="toast-body">
                    ${message}
                </div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
            </div>
        `;

        toastContainer.appendChild(toast);
        const bsToast = new bootstrap.Toast(toast);
        bsToast.show();

        // Remove toast after it's hidden
        toast.addEventListener('hidden.bs.toast', () => {
            toast.remove();
        });
    }

    setTheme(theme) {
        if (theme === 'dark') {
            document.body.classList.add('dark-mode');
            localStorage.setItem('smartNotesTheme', 'dark');
            document.getElementById('themeSwitch').checked = true;
        } else {
            document.body.classList.remove('dark-mode');
            localStorage.setItem('smartNotesTheme', 'light');
            document.getElementById('themeSwitch').checked = false;
        }
    }

    loadTheme() {
        const savedTheme = localStorage.getItem('smartNotesTheme') || 'light';
        this.setTheme(savedTheme);
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SmartNotes();
}); 