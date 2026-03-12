// src/components/MediaPlayer/MediaPlayer.js - WITH DELETE

const API_URL = 'http://localhost:8000/api/audio';

class MediaPlayer {
  constructor() {
    this.audio = new Audio();
    this.currentText = null;
    this.currentFilename = null;
    this.isLoading = false;

    this.playBtn = null;
    this.stopBtn = null;
    this.repeatBtn = null;
    this.volumeSlider = null;

    console.log("✅ MediaPlayer created");
  }

  init(panelRoot) {
    console.log("🔧 MediaPlayer init");
    
    this.playBtn = panelRoot.querySelector("#play-tts-btn");
    this.stopBtn = panelRoot.querySelector("#stop-tts-btn");
    this.repeatBtn = panelRoot.querySelector("#repeat-tts-btn");
    this.volumeSlider = panelRoot.querySelector("#volume-slider");

    if (!this.playBtn || !this.stopBtn || !this.repeatBtn || !this.volumeSlider) {
      console.error("❌ Missing DOM elements");
      return false;
    }

    this.playBtn.addEventListener("click", () => this.handlePlay());
    this.stopBtn.addEventListener("click", () => this.stop());
    this.repeatBtn.addEventListener("click", () => this.replay());
    
    this.volumeSlider.addEventListener("input", (e) => {
      this.audio.volume = e.target.value / 100;
    });

    this.audio.onended = () => {
      console.log("✅ Playback ended");
      this.setPlayingUI(false);
    };

    this.audio.onerror = (e) => {
      console.error("❌ Audio error:", e);
    };
    
    this.voiceSelect = panelRoot.querySelector("#voice-select");
  
    if (this.voiceSelect) {
        // ✅ Add extensive logging
      console.log("🎤 Voice selector found");
      console.log("   Initial value:", this.voiceSelect.value);
      
      this.voiceSelect.addEventListener("change", async (e) => {
        console.log("\n🔔 VOICE CHANGED EVENT");
        console.log("   Old voice:", this.voicePreset);
        console.log("   New voice:", e.target.value);

        await this.deleteOldAudio();
        
        this.voicePreset = e.target.value;
        
        console.log("   Updated voicePreset:", this.voicePreset);
        
        // ✅ CRITICAL: Clear old audio
        console.log("   Clearing old audio...");
        this.audio.pause();
        this.audio.src = "";
        this.currentFilename = null;
        //this.currentText = null;  // ✅ Also clear text to force regeneration
        
        console.log("   ✅ Old audio cleared");
      });
      
      // Set initial value
      this.voicePreset = this.voiceSelect.value;
      console.log("   voicePreset set to:", this.voicePreset);
    } else {
      console.error("❌ Voice selector NOT found!");
    }
  }

  // ✅ NEW: Delete old audio file from server
  async deleteOldAudio() {
    if (!this.currentFilename) {
      console.log("No old audio to delete");
      return;
    }

    try {
      console.log("🗑️ Deleting old audio:", this.currentFilename);

      const response = await fetch(`${API_URL}/files/${this.currentFilename}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        const data = await response.json();
        console.log("✅ Deleted:", data.message);
      } else {
        console.warn("⚠️ Delete failed:", response.status);
      }

    } catch (error) {
      console.error("❌ Delete error:", error);
      // Don't show error to user, it's not critical
    }
  }

  // ✅ UPDATED: Delete old audio when text changes
  async setText(text) {
    if (this.currentText !== text) {
      console.log("📝 Text changed:");
      console.log("  From:", this.currentText?.substring(0, 30));
      console.log("  To:", text?.substring(0, 30));
      
      // ✅ Delete old audio file from server
      await this.deleteOldAudio();
      
      // Clear old audio from player
      this.audio.pause();
      this.audio.src = "";
      this.currentFilename = null;
      this.setPlayingUI(false);
      
      console.log("🗑️ Cleared old audio");
    }
    
    this.currentText = text;
  }

  async handlePlay() {
    console.log("\n🎮 PLAY CLICKED");

    const text = this.currentText || window.getSelection().toString().trim();

    if (!text) {
      alert("Please select text first");
      return;
    }

    if (this.isLoading) {
      console.warn("⏳ Already loading");
      return;
    }

    // Only reuse if text matches AND audio exists
    const textMatches = this.currentText === text;
    const hasAudio = this.audio.src && this.audio.readyState >= 3;

    if (textMatches && hasAudio) {
      console.log("▶️ Playing existing audio");
      this.play();
      return;
    }
    // Generate new
    console.log("🎙️ Generating new audio");
    await this.generate(text);
    
    if (this.audio.src && this.audio.readyState > 0) {
      this.play();
    }
  }

  async generate(text) {
    console.log("\n📡 GENERATING");

    try {
      this.isLoading = true;
      this.setLoadingUI(true);
      
      // ✅ Delete old audio file before generating new one
      await this.deleteOldAudio();
      
      // Clear audio player
      this.audio.pause();
      this.audio.src = "";

      const requestBody = {
        text: text,
        voice_preset: this.voicePreset
      };
      const response = await fetch(`${API_URL}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      }); 
      
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const filename = data.audio_url.split('/').pop();

      console.log("📄 New audio file:", filename);

      this.currentText = text;
      this.currentFilename = filename;

      const audioUrl = `http://localhost:8000/api/audio/files/${filename}`;
      console.log("🔊 Audio URL:", audioUrl);

      this.audio.src = audioUrl;

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);

        this.audio.addEventListener('canplaythrough', () => {
          console.log("✅ Audio loaded");
          clearTimeout(timeout);
          resolve();
        }, { once: true });

        this.audio.addEventListener('error', (e) => {
          console.error("❌ Load error");
          clearTimeout(timeout);
          reject(new Error("Load failed"));
        }, { once: true });

        this.audio.load();
      });

      console.log("✅ Generation complete");

    } catch (error) {
      console.error("❌ Error:", error);
      alert("Failed: " + error.message);
    } finally {
      this.isLoading = false;
      this.setLoadingUI(false);
    }
  }

  play() {
    console.log("\n▶️ PLAY");

    if (!this.audio.src) {
      alert("No audio");
      return;
    }

    if (this.audio.readyState < 3) {
      alert("Still loading");
      return;
    }

    this.audio.currentTime = 0;
    this.audio.play()
      .then(() => {
        console.log("✅ Playing!");
        this.setPlayingUI(true);
      })
      .catch(err => {
        console.error("❌ Error:", err);
        alert("Play failed: " + err.message);
      });
  }

  stop() {
    console.log("⏹️ Stop");
    this.audio.pause();
    this.audio.currentTime = 0;
    this.setPlayingUI(false);
  }

  replay() {
    console.log("🔁 Replay");
    if (!this.audio.src) {
      alert("No audio");
      return;
    }
    this.audio.currentTime = 0;
    this.audio.play()
      .then(() => this.setPlayingUI(true))
      .catch(err => alert("Failed: " + err.message));
  }

  setLoadingUI(state) {
    if (!this.playBtn) return;
    this.playBtn.disabled = state;
    if (state) {
      this.playBtn.classList.add("loading");
    } else {
      this.playBtn.classList.remove("loading");
    }
  }

  setPlayingUI(state) {
    if (!this.playBtn) return;
    if (state) {
      this.playBtn.classList.add("active");
    } else {
      this.playBtn.classList.remove("active");
    }
  }

  // ✅ NEW: Cleanup when panel closes
  async cleanup() {
    console.log("🧹 Cleanup");
    await this.deleteOldAudio();
    this.audio.pause();
    this.audio.src = "";
    this.currentText = null;
    this.currentFilename = null;
  }
}

const mediaPlayer = new MediaPlayer();
export { mediaPlayer };