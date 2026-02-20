// src/components/PhoneticView/PhoneticView.js

/**
 * PhoneticView - Handles phonetic breakdown display
 * Fetches from backend using eng_to_ipa
 */

const API_URL = 'http://localhost:8000/api/phonetics';

class PhoneticView {
  constructor() {
    this.wordsContainer = null;
    this.ipaToggle = null;
    this.currentWords = [];
    this.showIPA = true;
    this.initialized = false; // Track initialization
  }

  ensureInitialized() {
    if (!this.initialized) {
      return this.init();
    }
    return true;
  }
  /**
   * Initialize phonetic view
   */
  init() {
    console.log('🔤 Initializing PhoneticView...');
    
    // Get DOM elements
    this.wordsContainer = document.getElementById('phonetic-words');
    this.ipaToggle = document.getElementById('ipa-toggle');
    
    if (!this.wordsContainer || !this.ipaToggle) {
      console.error('❌ Phonetic elements not found in DOM');
      return false;
    }
    
    this.initialized = true; // Mark as initialized
    // Setup event listeners
    this.setupEventListeners();
    
    console.log('✅ PhoneticView initialized');
    return true;
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // IPA toggle
    this.ipaToggle.addEventListener('change', (e) => {
      this.showIPA = e.target.checked;
      this.toggleIPA(this.showIPA);
    });

    this.wordsContainer.addEventListener('click', (e) => {
      const button = e.target.closest('.word-btn');
      if (!button) return;

      const word = button.dataset.word;
      this.pronounceWord(word);

      button.classList.add('playing');
      setTimeout(() => button.classList.remove('playing'), 800);
    });
    
    console.log('✅ Event listeners attached');
  
  }

  /**
   * Load phonetics for text
   */
  async loadPhonetics(text) {
    if (!this.ensureInitialized()) {
      console.warn('⚠️ PhoneticView not ready, skipping phonetics load');
      return;
    }

    if (!text || !text.trim()) {
      this.showEmpty();
      return;
    }

    try {
      console.log(`🔤 Loading phonetics for: "${text}"`);
      
      // Show loading
      this.showLoading();

      // Fetch from backend
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          include_ipa: true,
          include_syllables: true
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      console.log(`✅ Got phonetics for ${data.word_count} words`);

      // Store and render
      this.currentWords = data.words || [];
      this.renderWords(this.currentWords);

      
      console.log('✅ Phonetics ready');

    } catch (error) {
      console.error('❌ Error loading phonetics:', error);
      this.showError('Failed to load phonetics');
      this.isReady = false;
    }
  }

  /**
   * Render phonetic words
   */
  renderWords(words) {
    if (!words || words.length === 0) {
      this.showEmpty();
      return;
    }

    // Clear container
    this.wordsContainer.innerHTML = '';
    this.wordsContainer.classList.remove('loading');

    // Apply IPA visibility
    if (!this.showIPA) {
      this.wordsContainer.classList.add('hide-ipa');
    } else {
      this.wordsContainer.classList.remove('hide-ipa');
    }

    // Create word buttons
    words.forEach(wordData => {
      const button = this.createWordButton(wordData);
      this.wordsContainer.appendChild(button);
    });
  
  console.log(`✅ Rendered ${words.length} phonetic words`);
}
  /**
   * Create word button element
   */
  createWordButton(wordData) {
    const button = document.createElement('button');
    button.className = 'word-btn';
    button.dataset.word = wordData.word;
    button.dataset.ipa = wordData.ipa || '';
    button.title = `Click to hear: ${wordData.word}`;

    // Word text
    const wordSpan = document.createElement('span');
    wordSpan.textContent = wordData.word;
    button.appendChild(wordSpan);

    // IPA text
    if (wordData.ipa) {
      const phoneticSpan = document.createElement('span');
      phoneticSpan.className = 'phonetic';
      phoneticSpan.textContent = wordData.ipa;
      button.appendChild(phoneticSpan);
    }

    return button;
  }

  /**
   * Toggle IPA display
   */
  toggleIPA(show) {
    if (show) {
      this.wordsContainer.classList.remove('hide-ipa');
    } else {
      this.wordsContainer.classList.add('hide-ipa');
    }
  }

  /**
   * Pronounce word using Web Speech API
   */
  async pronounceWord(word) {
    if (!('speechSynthesis' in window)) {
    console.warn('⚠️ Speech synthesis not supported');
        return;
    }

    const synth = window.speechSynthesis;

    // Cancel any ongoing speech
    if (synth.speaking) {
        synth.cancel();
    }

    // Create utterance
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-US';
    utterance.rate = 0.8;
    utterance.pitch = 1.0;
    // Speak
    synth.speak(utterance);
    console.log(`🔊 Pronouncing: ${word}`);
    
  }

  /**
   * Show loading state
   */
  showLoading() {
    this.wordsContainer.innerHTML = `
      <div class="empty-state">Loading phonetics...</div>
    `;
    this.wordsContainer.classList.add('loading');
  }

  /**
   * Show empty state
   */
  showEmpty() {
    this.wordsContainer.innerHTML = `
      <div class="empty-state">Select text to see phonetic breakdown</div>
    `;
    this.wordsContainer.classList.remove('loading');
  }


   // Show error state
  showError(message) {
    this.wordsContainer.innerHTML = `
      <div class="empty-state" style="color: #dc3545;">⚠️ ${message}</div>
    `;
    this.wordsContainer.classList.remove('loading');
  }

  
  // Clear phonetics   
  clear() {
    this.currentWords = [];
    this.showEmpty();
  }
}

// Create singleton instance
const phoneticView = new PhoneticView();

// Export for use in Panel.js
export { phoneticView };