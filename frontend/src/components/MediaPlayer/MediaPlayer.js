// src/components/MediaPlayer/MediaPlayer.js - NEW FILE

const API_URL = 'http://localhost:8000/api/audio';

class MediaPlayer {
  constructor() {
    // Audio player
    this.audioPlayer = null;
    
    // Control buttons
    this.playBtn = null;
    this.stopBtn = null;
    this.repeatBtn = null;
    this.volumeSlider = null;
    this.speedLabel = null;
    
    // Settings
    this.voiceSelect = null;
    this.languageSelect = null;
    
    // State
    this.currentText = '';
    this.currentAudioUrl = '';
    this.isPlaying = false;
    this.volume = 0.8;
    this.playbackRate = 1.0;
    
    // Bark settings
    this.voicePreset = 'v2/en_speaker_6';
    this.language = 'en';
  }

  /**
   * Initialize media player
   */
  init() {
    console.log('🎵 Initializing MediaPlayer...');
    
    // Get DOM elements
    this.audioPlayer = document.getElementById('tts-audio-player');
    this.playBtn = document.getElementById('play-tts-btn');
    this.stopBtn = document.getElementById('stop-tts-btn');
    this.repeatBtn = document.getElementById('repeat-tts-btn');
    this.volumeSlider = document.getElementById('volume-slider');
    this.speedLabel = document.getElementById('speed-label');
    this.voiceSelect = document.getElementById('voice-select');
    this.languageSelect = document.getElementById('language-select');

    if (!this.audioPlayer) {
      console.error('❌ Audio player element not found');
      return false;
    }

    // Setup event listeners
    this.setupEventListeners();
    
    // Initialize audio player
    this.audioPlayer.volume = this.volume;
    
    console.log('✅ MediaPlayer initialized');
    return true;
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Play button
    this.playBtn?.addEventListener('click', () => {
      this.play();
    });

    // Stop button
    this.stopBtn?.addEventListener('click', () => {
      this.stop();
    });

    // Repeat button
    this.repeatBtn?.addEventListener('click', () => {
      this.repeat();
    });

    // Volume slider
    this.volumeSlider?.addEventListener('input', (e) => {
      this.setVolume(e.target.value / 100);
    });

    // Voice select
    this.voiceSelect?.addEventListener('change', (e) => {
      this.voicePreset = e.target.value;
      console.log('🎤 Voice changed to:', this.voicePreset);
    });

    // Language select
    this.languageSelect?.addEventListener('change', (e) => {
      this.language = e.target.value;
      console.log('🌐 Language changed to:', this.language);
    });

    // Audio player events
    this.audioPlayer.addEventListener('play', () => {
      this.onPlayStart();
    });

    this.audioPlayer.addEventListener('pause', () => {
      this.onPlayPause();
    });

    this.audioPlayer.addEventListener('ended', () => {
      this.onPlayEnd();
    });

    this.audioPlayer.addEventListener('error', (e) => {
      console.error('❌ Audio error:', e);
      this.onPlayError(e);
    });

    this.audioPlayer.addEventListener('timeupdate', () => {
      this.onTimeUpdate();
    });
  }

  /**
   * Set text to play
   */
  setText(text) {
    this.currentText = text;
    console.log('📝 Text set:', text);
  }

  /**
   * Play audio
   */
  async play() {
    if (!this.currentText) {
      console.warn('⚠️ No text to play');
      return;
    }

    try {
      console.log('▶️ Playing:', this.currentText.substring(0, 50));

      // Show loading
      this.playBtn.disabled = true;
      this.playBtn.classList.add('loading');

      // Check if we already have audio for this text
      if (this.currentAudioUrl && this.audioPlayer.src) {
        // Just play existing audio
        await this.audioPlayer.play();
        return;
      }

      // Generate new audio
      const audioData = await this.generateAudio(this.currentText);
      
      // Set audio source
      this.currentAudioUrl = audioData.audio_url;
      this.audioPlayer.src = `${API_URL}${audioData.audio_url}`;

      // Play
      await this.audioPlayer.play();

    } catch (error) {
      console.error('❌ Error playing audio:', error);
      this.showError('Failed to play audio');
    } finally {
      this.playBtn.disabled = false;
      this.playBtn.classList.remove('loading');
    }
  }

  /**
   * Stop audio
   */
  stop() {
    console.log('⏹️ Stopping audio');
    this.audioPlayer.pause();
    this.audioPlayer.currentTime = 0;
    this.isPlaying = false;
    this.updatePlayButton();
  }

  /**
   * Repeat audio
   */
  async repeat() {
    console.log('🔁 Repeating audio');
    this.audioPlayer.currentTime = 0;
    await this.audioPlayer.play();
  }

  /**
   * Set volume (0 to 1)
   */
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    this.audioPlayer.volume = this.volume;
    console.log('🔊 Volume:', Math.round(this.volume * 100) + '%');
  }

  /**
   * Set playback rate
   */
  setPlaybackRate(rate) {
    this.playbackRate = rate;
    this.audioPlayer.playbackRate = rate;
    this.speedLabel.textContent = `${rate.toFixed(1)}×`;
    console.log('⚡ Speed:', rate);
  }

  /**
   * Generate audio using Bark
   */
  async generateAudio(text) {
    console.log('🎙️ Generating audio with Bark...');

    const response = await fetch(`${API_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text,
        voice_preset: this.voicePreset
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log('✅ Audio generated:', data);

    return data;
  }

  /**
   * Event: Play started
   */
  onPlayStart() {
    console.log('▶️ Playback started');
    this.isPlaying = true;
    this.updatePlayButton();
  }

  /**
   * Event: Play paused
   */
  onPlayPause() {
    console.log('⏸️ Playback paused');
    this.isPlaying = false;
    this.updatePlayButton();
  }

  /**
   * Event: Play ended
   */
  onPlayEnd() {
    console.log('✅ Playback finished');
    this.isPlaying = false;
    this.updatePlayButton();
  }

  /**
   * Event: Play error
   */
  onPlayError(error) {
    console.error('❌ Playback error:', error);
    this.isPlaying = false;
    this.updatePlayButton();
    this.showError('Audio playback failed');
  }

  /**
   * Event: Time update
   */
  onTimeUpdate() {
    // Could add progress bar here
    const current = this.audioPlayer.currentTime;
    const duration = this.audioPlayer.duration;
    
    if (duration > 0) {
      const percent = (current / duration) * 100;
      // Update progress bar if you have one
    }
  }

  /**
   * Update play button state
   */
  updatePlayButton() {
    if (this.isPlaying) {
      // Change to pause icon
      this.playBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
        </svg>
      `;
      this.playBtn.title = 'Pause';
    } else {
      // Change to play icon
      this.playBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
      `;
      this.playBtn.title = 'Play';
    }
  }

  /**
   * Show error message
   */
  showError(message) {
    console.error('❌', message);
    // Could show toast notification here
  }

  /**
   * Clear current audio
   */
  clear() {
    this.stop();
    this.currentText = '';
    this.currentAudioUrl = '';
    this.audioPlayer.src = '';
  }
}

// Create singleton instance
const mediaPlayer = new MediaPlayer();

// Export for use in Panel.js
export { mediaPlayer };